/**
 * fixes.js — turn a drift finding into something a person can paste.
 *
 * Direction 1, Business Profile → website: buildOpeningHoursSpecification() writes the
 * spreadsheet's weekly hours and every special-hours date from the audit start onward
 * (not only the dates inside the window, so a holiday six months out is not lost) as
 * Google-style openingHoursSpecification, using Google's spellings:
 *   closed all day → opens "00:00", closes "00:00"
 *   open 24 hours  → opens "00:00", closes "23:59"
 *   past midnight  → one specification with closes < opens
 *   a dated rule   → validFrom = validThrough = the date, no dayOfWeek
 * Round-trip guarantee (tested): reading the output with jsonld.js and resolving any date
 * gives the same intervals as the spreadsheet.
 *
 * The fix is a PATCH, never a rebuild. patchLocalBusinessJsonLd() copies the page's own
 * JSON-LD block, finds the LocalBusiness node that was audited, and changes only:
 *   - openingHoursSpecification (replaced with the profile's hours; future dated rules that
 *     exist only on the page are carried over, because the profile may be the side that
 *     is missing them, see buildSpecialHoursCell; past dated rules are dropped),
 *   - openingHours / specialOpeningHoursSpecification (removed, because they would now
 *     contradict the new specification; both are listed in `changes`),
 *   - telephone, and the PostalAddress parts that were reported as a mismatch.
 * Everything else — @id, image, logo, geo, aggregateRating, review, sameAs, priceRange,
 * department, other nodes in an @graph — is carried over untouched, and the result says
 * which keys were kept. Only when the page has no LocalBusiness node at all is a new,
 * minimal block written (mode "new").
 *
 * Direction 2, website → Business Profile: buildSpecialHoursCell() writes the "Special
 * hours" cell for dates the website announces but the profile does not have. It always
 * contains the profile's EXISTING special hours as well, because the help page warns that
 * "If you include columns with headings but no information beneath them, existing
 * information for those columns will be erased" and does not say whether a non-empty cell
 * merges with or replaces existing special hours — the merged cell is right either way.
 * Sets that run past midnight are split at 00:00, as the special-hours help page requires
 * ("A set of special hours can't exceed 24 hours ... break the hours into multiple sets").
 */

import { DAY_NAMES, FULL_DAY, addDays, formatClock, hasOverride, normalizeIntervals, resolveDate, dateRange } from './hours.js';
import { readSchemaHours } from './jsonld.js';

const MONDAY_FIRST = [1, 2, 3, 4, 5, 6, 0];

function spec(fields) {
  return { '@type': 'OpeningHoursSpecification', ...fields };
}

function intervalSpecs(intervals, scope) {
  const n = normalizeIntervals(intervals);
  if (n.length === 0) return [spec({ ...scope, opens: '00:00', closes: '00:00' })];
  return n.map((i) => {
    if (i.start === 0 && i.end >= FULL_DAY) return spec({ ...scope, opens: '00:00', closes: '23:59' });
    return spec({ ...scope, opens: formatClock(i.start), closes: formatClock(i.end) });
  });
}

/**
 * @param {{weekly:Array, overrides:Array}} model Business Profile hours
 * @param {{asOf:string, horizonDays:number}} window
 * @returns {Array<object>}
 */
export function buildOpeningHoursSpecification(model, { asOf, horizonDays }) {
  const groups = new Map();
  for (const d of MONDAY_FIRST) {
    const w = model.weekly[d];
    if (w === null) continue;
    const key = JSON.stringify(normalizeIntervals(w));
    if (!groups.has(key)) groups.set(key, { days: [], intervals: w });
    groups.get(key).days.push(DAY_NAMES[d]);
  }
  const out = [];
  for (const { days, intervals } of groups.values()) {
    out.push(...intervalSpecs(intervals, { dayOfWeek: days.length === 1 ? days[0] : days }));
  }
  // Every dated rule from asOf onward (capped at one year so a typo cannot explode the
  // snippet). horizonDays only bounds the comparison, not the fix.
  void horizonDays;
  const last = addDays(asOf, 365);
  for (const o of model.overrides) {
    if (o.through < asOf || o.from > last) continue;
    // Expand to single dates; past dates are dropped.
    for (const date of dateRange(o.from, 1 + Math.round((Date.parse(o.through) - Date.parse(o.from)) / 86400000))) {
      if (date < asOf || date > last) continue;
      const intervals = resolveDate(model, date);
      if (intervals === null) continue;
      if (out.some((s) => s.validFrom === date)) continue;
      out.push(...intervalSpecs(intervals, { validFrom: date, validThrough: date }));
    }
  }
  return out;
}

/**
 * Minimal LocalBusiness JSON-LD built from one spreadsheet row — only used when the page
 * has no LocalBusiness block to patch.
 * @returns {object}
 */
export function buildLocalBusinessJsonLd(location, window, type = 'LocalBusiness') {
  const node = {
    '@context': 'https://schema.org',
    '@type': type,
    name: location.name,
  };
  if (location.website) node.url = location.website;
  if (location.primaryPhone) node.telephone = location.primaryPhone;
  node.address = postalAddress(location);
  node.openingHoursSpecification = buildOpeningHoursSpecification(location.hours, window);
  return node;
}

function postalAddress(location) {
  return {
    '@type': 'PostalAddress',
    streetAddress: location.address.lines.join(', '),
    addressLocality: location.address.locality,
    addressRegion: location.address.region,
    postalCode: location.address.postalCode,
    addressCountry: location.address.country,
  };
}

const ADDRESS_KEYS = {
  street: 'streetAddress', locality: 'addressLocality', region: 'addressRegion', postalCode: 'postalCode', country: 'addressCountry',
};

/** Deep-copy `value`, substituting `target` (matched by identity) with `replacement`. */
function copyReplacing(value, target, replacement) {
  if (value === target) return replacement;
  if (Array.isArray(value)) return value.map((v) => copyReplacing(v, target, replacement));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = copyReplacing(v, target, replacement);
    return out;
  }
  return value;
}

function containsNode(value, target) {
  if (value === target) return true;
  if (Array.isArray(value)) return value.some((v) => containsNode(v, target));
  if (value && typeof value === 'object') return Object.values(value).some((v) => containsNode(v, target));
  return false;
}

/**
 * Non-destructive fix for the website side.
 *
 * @param {object} args
 * @param {object} args.location   spreadsheet row
 * @param {object|null} args.entity the audited LocalBusiness node (null → mode "new")
 * @param {Array<any>} args.blocks  every parsed JSON-LD block of the page
 * @param {{asOf:string, horizonDays:number}} args.window
 * @param {{phone?: boolean, addressParts?: string[]}} [args.drift] what the audit found wrong
 * @returns {{mode:'patch'|'new', blockIndex:number|null, block:any, node:object, changes:string[], kept:string[]}}
 */
export function patchLocalBusinessJsonLd({ location, entity, blocks, window, drift = {} }) {
  const hours = buildOpeningHoursSpecification(location.hours, window);
  if (!entity) {
    const node = buildLocalBusinessJsonLd(location, window);
    return { mode: 'new', blockIndex: null, block: node, node, changes: ['new LocalBusiness block (the page had none)'], kept: [] };
  }
  const changes = [];
  const node = {};
  for (const [k, v] of Object.entries(entity)) node[k] = copyReplacing(v, null, null);
  const before = Array.isArray(entity.openingHoursSpecification) ? entity.openingHoursSpecification.length
    : entity.openingHoursSpecification ? 1 : 0;
  // Dated rules only the page has: keep them (the profile may be the side that is wrong).
  const page = readSchemaHours(entity, window.asOf);
  const pageOnly = [];
  const lastDay = addDays(window.asOf, 365);
  for (const o of page.model.overrides) {
    if (o.through < window.asOf) continue;
    const days = 1 + Math.round((Date.parse(o.through) - Date.parse(o.from)) / 86400000);
    for (const date of dateRange(o.from, Math.min(days, 367))) {
      if (date < window.asOf || date > lastDay || !hasOverride(page.model, date)) continue;
      if (hasOverride(location.hours, date) || pageOnly.includes(date)) continue;
      const intervals = resolveDate(page.model, date);
      if (intervals !== null) pageOnly.push(date);
    }
  }
  const merged = hours.concat(...pageOnly.map((date) => intervalSpecs(resolveDate(page.model, date), { validFrom: date, validThrough: date })));
  node.openingHoursSpecification = merged;
  changes.push(`openingHoursSpecification: ${before} → ${merged.length} entr${merged.length === 1 ? 'y' : 'ies'}, hours from the profile`);
  if (pageOnly.length > 0) {
    changes.push(`kept ${pageOnly.length} dated rule(s) only the page has (${pageOnly.join(', ')}): add them to the profile with the Special hours cell, or delete them if they are wrong`);
  }
  if (page.expired.length > 0) changes.push(`dropped ${page.expired.length} dated rule(s) that ended before ${window.asOf}`);
  if (node.openingHours !== undefined) {
    delete node.openingHours;
    changes.push('removed openingHours (text) — it would contradict the new openingHoursSpecification');
  }
  if (node.specialOpeningHoursSpecification !== undefined) {
    delete node.specialOpeningHoursSpecification;
    changes.push('removed specialOpeningHoursSpecification — its dates are now inside openingHoursSpecification');
  }
  if (drift.phone && location.primaryPhone) {
    changes.push(`telephone: ${entity.telephone ?? '(none)'} → ${location.primaryPhone}`);
    node.telephone = location.primaryPhone;
  }
  const parts = drift.addressParts ?? [];
  if (parts.length > 0) {
    const fresh = postalAddress(location);
    const current = Array.isArray(node.address) ? node.address[0] : node.address;
    if (current && typeof current === 'object') {
      for (const part of parts) {
        const key = ADDRESS_KEYS[part];
        if (!key) continue;
        changes.push(`address.${key}: "${current[key] ?? ''}" → "${fresh[key]}"`);
        current[key] = fresh[key];
      }
    } else {
      changes.push('address: text address replaced with a PostalAddress from the profile');
      node.address = fresh;
    }
  }
  const touched = new Set(['openingHoursSpecification', 'openingHours', 'specialOpeningHoursSpecification', 'telephone', 'address']);
  const kept = Object.keys(entity).filter((k) => !touched.has(k) || (k === 'address' && parts.length === 0) || (k === 'telephone' && !drift.phone));
  const blockIndex = blocks.findIndex((b) => containsNode(b, entity));
  if (blockIndex === -1) {
    return { mode: 'patch', blockIndex: null, block: { '@context': 'https://schema.org', ...node }, node, changes, kept };
  }
  const block = copyReplacing(blocks[blockIndex], entity, node);
  return { mode: 'patch', blockIndex, block, node, changes, kept };
}

function gbpRange(start, end) {
  return `${formatClock(start)}-${end >= FULL_DAY && start === 0 ? '00:00' : formatClock(end)}`;
}

/** Spreadsheet entries for one date, splitting sets that run past midnight. */
function entriesForDate(date, intervals) {
  const n = normalizeIntervals(intervals);
  if (n.length === 0) return [`${date}: x`];
  const out = [];
  for (const i of n) {
    if (i.start === 0 && i.end >= FULL_DAY) {
      out.push(`${date}: 00:00-00:00`);
    } else if (i.end > FULL_DAY) {
      out.push(`${date}: ${formatClock(i.start)}-00:00`);
      out.push(`${addDays(date, 1)}: 00:00-${formatClock(i.end - FULL_DAY)}`);
    } else {
      out.push(`${date}: ${gbpRange(i.start, i.end)}`);
    }
  }
  return out;
}

/**
 * @param {object} gbpModel   Business Profile hours
 * @param {object|null} siteModel  website hours (schema or visible) — the side that has the extra dates
 * @param {{asOf:string, horizonDays:number}} window
 * @returns {{cell: string, addedDates: string[]}} cell is '' when nothing is missing
 */
export function buildSpecialHoursCell(gbpModel, siteModel, { asOf, horizonDays }) {
  const addedDates = [];
  const entries = [];
  for (const o of gbpModel.overrides) {
    entries.push(...entriesForDate(o.from, o.intervals));
  }
  if (siteModel) {
    for (const date of dateRange(asOf, horizonDays)) {
      if (!hasOverride(siteModel, date) || hasOverride(gbpModel, date)) continue;
      const intervals = resolveDate(siteModel, date);
      if (intervals === null) continue;
      addedDates.push(date);
      entries.push(...entriesForDate(date, intervals));
    }
  }
  if (addedDates.length === 0) return { cell: '', addedDates };
  const sorted = entries.sort((a, b) => a.slice(0, 10).localeCompare(b.slice(0, 10)));
  return { cell: sorted.join(', '), addedDates };
}
