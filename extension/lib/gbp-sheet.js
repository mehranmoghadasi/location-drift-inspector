/**
 * gbp-sheet.js — read the Business Profile Manager bulk spreadsheet (CSV) into locations.
 *
 * Vendor definitions, quoted verbatim from "Create a bulk upload spreadsheet for Business
 * Profiles", https://support.google.com/business/answer/3370250 (fetched 2026-10-01):
 *
 *   Hours — "In the 'Each day's' column, add the hours for that day."
 *     "24-hour format: HH:MM-HH:MM"  /  "AM or PM format: HH:MMAM-HH:MMPM"
 *     "Closes at midnight: 09:00AM-12:00AM / 09:00-00:00"
 *     "Open 24 hours: 12:00AM-12:00AM / 00:00-00:00 or 00:00-24:00"
 *     "Closed all day: X / Leave the spreadsheet cell empty"
 *     "Open past midnight: Include these hours in the column for the day when the set
 *      begins. 06:00PM-02:00AM / 18:00-02:00"
 *     "Open for two sets of hours in one day: 11:30AM-02:00PM, 05:00PM-10:00PM"
 *   Business code — "A business code is required for each business in your spreadsheet."
 *   Additional phones — "You can add up to 2 mobile or landline numbers ..."
 *
 * Special hours, quoted verbatim from "How to set Special hours",
 * https://support.google.com/business/answer/6303076 (fetched 2026-10-01):
 *   "Enter the affected days and their special hours with 'x' to designate an all-day
 *    closure ... 24-hour format: YYYY-MM-DD: HH:MM-HH:MM / AM or PM format:
 *    YYYY-MM-DD: HH:MM AM-HH:MM PM"
 *   "To enter multiple sets of opening hours in one day, separate the sets into 2 entries
 *    with a comma." Example: "2015-11-26: x, 2015-12-25: x, 2015-12-26: 10:00-16:00,
 *    2015-12-26: 17:00-18:00, 2016-1-1: 00:00-00:00"
 *   The same page sends readers to 3370250#hours ("Learn how to format hours"), so the
 *   time grammar above (including "00:00-00:00" = open 24 hours) is applied to special
 *   hours too.
 *
 * The CRITICAL difference from schema.org (see jsonld.js): in this spreadsheet
 * "00:00-00:00" means OPEN 24 HOURS; in Google's LocalBusiness structured data
 * opens "00:00" + closes "00:00" means CLOSED ALL DAY.
 *
 * One deliberate deviation: when ALL seven day cells of a row are empty the row is treated
 * as "no hours provided" (unknown) rather than "closed seven days a week", because the help
 * page also says "You don't have to include business hours". A warning is recorded.
 *
 * Column headers are matched case-insensitively against aliases. The help page names the
 * fields (Business code / store code, Business name, Primary phone, Additional phones,
 * Website, Locality, Administrative area, Special hours). The per-day header text is
 * confirmed by "Download your Business Profiles to a spreadsheet",
 * https://support.google.com/business/answer/3478406 (fetched 2026-10-04), which names
 * "a column labeled 'Sunday hours'"; plain "Sunday" is accepted too.
 *
 * Google updates — the same page, verbatim:
 *   "[UPDATED]: Shows Google-updated info next to the info you provided. For example, if
 *    you have Google updates to your Sunday business hours, you'll see a column labeled
 *    '[UPDATED] Sunday hours' containing the Google-updated hours next to a column labeled
 *    'Sunday hours' containing the hours you provided. An empty cell means there are no
 *    updates for the field."
 *   "[DELETED]: Indicates that there was a Google update removing the info you provided.
 *    For example, if you entered that your business is open from 9:00AM - 2:00PM on
 *    Tuesdays and Google finds data that you're closed on Tuesdays, you'll see the value
 *    '[DELETED]' in a cell of the column labeled '[UPDATED] Tuesday hours'."
 *   "Google updates: Shows the field groups that have Google updates, like 'Address' or
 *    'Phone numbers'."
 * So in an [UPDATED] hours column: empty = no update, "[DELETED]" = Google thinks the
 * location is closed that day, anything else = Google's proposed hours (same grammar).
 * Note the asymmetry with the owner's own day cells, where empty means closed.
 */

import { parseCsv } from './csv.js';
import { DAY_NAMES, emptyModel, normalizeIsoDate, parseClock, FULL_DAY, ParseError } from './hours.js';

const FIELD_ALIASES = {
  storeCode: ['store code', 'business code', 'storecode'],
  name: ['business name', 'name'],
  locality: ['locality', 'city'],
  region: ['administrative area', 'state', 'province', 'region'],
  postalCode: ['postal code', 'zip', 'zip code', 'postcode'],
  country: ['country / region', 'country/region', 'country', 'country code'],
  primaryPhone: ['primary phone', 'main phone', 'phone'],
  additionalPhones: ['additional phones', 'additional phone'],
  website: ['website', 'website url', 'url'],
  specialHours: ['special hours'],
};

/**
 * Work out which column holds which field.
 * @param {string[]} header
 * @param {Record<string,string>} [overrides] field → exact header text
 */
export function mapColumns(header, overrides = {}) {
  const all = header.map((h) => String(h).trim().toLowerCase().replace(/\s+/g, ' '));
  // Owner columns and Google's "[UPDATED] …" columns are mapped separately.
  const isUpdated = (h) => h.startsWith('[updated]');
  const norm = all.map((h) => (isUpdated(h) ? '\u0000' : h));
  const columns = { addressLines: [], days: [null, null, null, null, null, null, null] };
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    const wanted = overrides[field] ? [overrides[field].trim().toLowerCase()] : aliases;
    const idx = norm.findIndex((h) => wanted.includes(h));
    columns[field] = idx === -1 ? null : idx;
  }
  columns.googleUpdates = norm.indexOf('google updates');
  if (columns.googleUpdates === -1) columns.googleUpdates = null;
  columns.updated = { days: [null, null, null, null, null, null, null] };
  all.forEach((h, idx) => {
    if (!isUpdated(h)) return;
    const inner = h.replace(/^\[updated\]\s*/, '');
    DAY_NAMES.forEach((day, d) => {
      const lower = day.toLowerCase();
      if (inner === lower || inner === `${lower} hours`) columns.updated.days[d] = idx;
    });
    for (const field of ['name', 'primaryPhone', 'website', 'specialHours', 'postalCode', 'locality']) {
      if (FIELD_ALIASES[field].includes(inner)) columns.updated[field] = idx;
    }
  });
  norm.forEach((h, idx) => {
    const line = /^address(?: line)?\s*(\d)?$/.exec(h);
    if (line) columns.addressLines.push({ order: Number(line[1] ?? 0), idx });
    DAY_NAMES.forEach((day, d) => {
      const lower = day.toLowerCase();
      if (h === lower || h === `${lower} hours`) columns.days[d] = idx;
    });
  });
  columns.addressLines.sort((a, b) => a.order - b.order);
  columns.addressLines = columns.addressLines.map((x) => x.idx);
  return columns;
}

/**
 * Parse one time-range set such as "09:00AM-05:00PM", "18:00-02:00" or "10:00 AM-2:00 PM".
 * Applies the spreadsheet rules: end 00:00 = closes at midnight, end < start = past
 * midnight, 00:00-00:00 / 00:00-24:00 / 12:00AM-12:00AM = open 24 hours.
 * @returns {{start:number,end:number}}
 */
export function parseGbpRange(raw) {
  const m = /^\s*(.+?)\s*-\s*(.+?)\s*$/.exec(String(raw));
  if (!m) throw new ParseError(`"${raw}" is not a HH:MM-HH:MM range`);
  const start = parseClock(m[1]);
  let end = parseClock(m[2]);
  if (start === null || end === null) throw new ParseError(`"${raw}" has an unreadable time`);
  // Stated explicitly for readability; the two general rules below give the same result.
  if (start === 0 && (end === 0 || end === FULL_DAY)) return { start: 0, end: FULL_DAY };
  if (end === 0) end = FULL_DAY;
  if (end <= start) end += FULL_DAY;
  return { start, end };
}

/**
 * Parse one day cell. "" or "x" → closed ([]).
 * @returns {Array<{start:number,end:number}>}
 */
export function parseGbpDayCell(raw) {
  const s = String(raw ?? '').trim();
  if (s === '' || s.toLowerCase() === 'x') return [];
  return s.split(',').map((part) => parseGbpRange(part));
}

/**
 * Parse the "Special hours" cell into date overrides.
 * @returns {{overrides: Array<object>, errors: string[]}}
 */
export function parseGbpSpecialHours(raw) {
  const s = String(raw ?? '').trim();
  const overrides = [];
  const errors = [];
  if (s === '') return { overrides, errors };
  const byDate = new Map();
  for (const piece of s.split(',')) {
    const p = piece.trim();
    if (p === '') continue;
    const m = /^(\d{4}-\d{1,2}-\d{1,2})\s*:\s*(.+)$/.exec(p);
    if (!m) {
      errors.push(`special hours entry "${p}" is not "YYYY-MM-DD: hours"`);
      continue;
    }
    const date = normalizeIsoDate(m[1]);
    if (!date) {
      errors.push(`special hours date "${m[1]}" is not a real date`);
      continue;
    }
    try {
      const value = m[2].trim();
      const intervals = value.toLowerCase() === 'x' ? [] : [parseGbpRange(value)];
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push(...intervals);
    } catch (err) {
      if (!(err instanceof ParseError)) throw err;
      errors.push(`special hours ${date}: ${err.message}`);
    }
  }
  for (const [date, intervals] of [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    overrides.push({ from: date, through: date, weekdays: null, intervals, source: 'gbp-special' });
  }
  return { overrides, errors };
}

const DELETED = '[deleted]';

/**
 * Read Google's proposed values for one row (only present in a download made with
 * "Include Google updates"). Returns null when the row has no update at all.
 * @returns {null | {groups: string, weekly: Array<Array|null>, special: Array<object>|null,
 *   fields: Record<string, string>}}  fields values are the raw cell or "[DELETED]"
 */
export function readGoogleUpdates(row, columns, cellErrors = []) {
  const u = columns.updated;
  if (!u) return null;
  const weekly = [null, null, null, null, null, null, null];
  let any = false;
  u.days.forEach((idx, d) => {
    const value = cell(row, idx);
    if (value === '') return;
    any = true;
    if (value.toLowerCase() === DELETED) {
      weekly[d] = [];
      return;
    }
    try {
      weekly[d] = parseGbpDayCell(value);
    } catch (err) {
      if (!(err instanceof ParseError)) throw err;
      cellErrors.push({ column: `[UPDATED] ${DAY_NAMES[d]} hours`, value, message: err.message });
    }
  });
  let special = null;
  const sp = cell(row, u.specialHours);
  if (sp !== '') {
    any = true;
    if (sp.toLowerCase() === DELETED) special = [];
    else {
      const parsed = parseGbpSpecialHours(sp);
      special = parsed.overrides;
      parsed.errors.forEach((message) => cellErrors.push({ column: '[UPDATED] Special hours', value: sp, message }));
    }
  }
  const fields = {};
  for (const field of ['name', 'primaryPhone', 'website', 'postalCode', 'locality']) {
    const value = cell(row, u[field]);
    if (value !== '') {
      fields[field] = value;
      any = true;
    }
  }
  const groups = cell(row, columns.googleUpdates);
  if (!any && groups === '') return null;
  return { groups, weekly, special, fields };
}

function cell(row, idx) {
  return idx === null || idx === undefined ? '' : String(row[idx] ?? '').trim();
}

/**
 * Parse spreadsheet text into locations.
 * @param {string} csvText
 * @param {{columns?: Record<string,string>}} [options]
 * @returns {{locations: Array<object>, warnings: string[], columns: object}}
 */
export function parseGbpSheet(csvText, options = {}) {
  const rows = parseCsv(csvText);
  const warnings = [];
  if (rows.length < 2) {
    return { locations: [], warnings: ['spreadsheet has no data rows'], columns: null };
  }
  const columns = mapColumns(rows[0], options.columns);
  if (columns.storeCode === null) {
    throw new Error('no "Store code" / "Business code" column found — it is required by Google and used to match pages');
  }
  if (columns.days.every((d) => d === null)) {
    warnings.push('no per-day hours columns found; weekly hours will be "unknown"');
  }
  const locations = [];
  const seen = new Set();
  rows.slice(1).forEach((row, i) => {
    const rowNumber = i + 2;
    const storeCode = cell(row, columns.storeCode);
    if (storeCode === '') {
      warnings.push(`row ${rowNumber}: empty store code — row skipped`);
      return;
    }
    if (seen.has(storeCode)) {
      warnings.push(`row ${rowNumber}: duplicate store code "${storeCode}" — row skipped`);
      return;
    }
    seen.add(storeCode);
    const cellErrors = [];
    const hours = emptyModel();
    const dayCells = columns.days.map((idx) => (idx === null ? null : cell(row, idx)));
    const allEmpty = dayCells.every((c) => c === null || c === '');
    if (allEmpty && dayCells.some((c) => c !== null)) {
      warnings.push(`row ${rowNumber} (${storeCode}): all day cells empty — treated as "no hours provided"`);
    } else {
      dayCells.forEach((value, d) => {
        if (value === null) return;
        try {
          hours.weekly[d] = parseGbpDayCell(value);
        } catch (err) {
          if (!(err instanceof ParseError)) throw err;
          cellErrors.push({ column: DAY_NAMES[d], value, message: err.message });
        }
      });
    }
    const special = parseGbpSpecialHours(cell(row, columns.specialHours));
    hours.overrides.push(...special.overrides);
    special.errors.forEach((message) =>
      cellErrors.push({ column: 'Special hours', value: cell(row, columns.specialHours), message }),
    );
    const googleUpdates = readGoogleUpdates(row, columns, cellErrors);
    locations.push({
      rowNumber,
      storeCode,
      name: cell(row, columns.name),
      address: {
        lines: columns.addressLines.map((idx) => cell(row, idx)).filter((x) => x !== ''),
        locality: cell(row, columns.locality),
        region: cell(row, columns.region),
        postalCode: cell(row, columns.postalCode),
        country: cell(row, columns.country),
      },
      primaryPhone: cell(row, columns.primaryPhone),
      additionalPhones: cell(row, columns.additionalPhones)
        .split(',')
        .map((p) => p.trim())
        .filter((p) => p !== ''),
      website: cell(row, columns.website),
      hours,
      googleUpdates,
      cellErrors,
    });
  });
  return { locations, warnings, columns };
}
