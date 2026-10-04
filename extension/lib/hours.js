/**
 * hours.js — one canonical model for "when is this location open on a given date".
 *
 * Every source (Business Profile spreadsheet, JSON-LD, visible page text) is parsed
 * into the same HoursModel so that they can be compared date by date:
 *
 *   HoursModel = {
 *     weekly: Array(7) of (Interval[] | null),   // index 0 = Sunday … 6 = Saturday; null = unknown
 *     overrides: Override[]                       // date-scoped rules (special / seasonal / holiday)
 *   }
 *   Interval = { start, end }   minutes after midnight of the day the set BEGINS;
 *                               end may exceed 1440 for sets that run past midnight.
 *   Override = { from: 'YYYY-MM-DD', through: 'YYYY-MM-DD', weekdays: number[] | null,
 *                intervals: Interval[], source: string }
 *
 * An empty Interval[] means "closed all day". `null` means "this source says nothing".
 * Open 24 hours is represented as [{ start: 0, end: 1440 }] regardless of how the source
 * spelled it — the source-specific spellings are handled in the parsers, because the two
 * vendors use OPPOSITE meanings for "00:00 to 00:00" (see gbp-sheet.js and jsonld.js).
 *
 * Effective hours for a date (resolveDate):
 *   1. every override whose [from, through] contains the date and whose weekdays (if any)
 *      include the date's weekday → union of their intervals;
 *   2. otherwise the weekly entry for that weekday;
 *   3. otherwise null (unknown).
 */

/** Thrown by the parsers for input that does not follow the documented format. */
export class ParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ParseError';
  }
}

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const FULL_DAY = 1440;

/** @returns {{weekly: (Array<Array<{start:number,end:number}>|null>), overrides: Array<object>}} */
export function emptyModel() {
  return { weekly: [null, null, null, null, null, null, null], overrides: [] };
}

/**
 * Parse a clock string to minutes after midnight.
 * Accepts 24-hour ("09:00", "9:00", "17:30:00", "24:00") and 12-hour forms
 * ("09:00AM", "9:00 PM", "9am", "9 a.m.", "12:00AM" = 0, "12:00PM" = 720).
 * @param {string} raw
 * @returns {number|null}
 */
export function parseClock(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ');
  const m = /^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(am|pm|a|p)?$/.exec(s);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] === undefined ? 0 : Number(m[2]);
  const meridiem = m[4] ? m[4][0] : null;
  if (minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (hour === 12) hour = 0;
    if (meridiem === 'p') hour += 12;
  } else {
    // Without a meridiem only colon forms are unambiguous ("9" alone could be 9 am or 9 pm).
    if (m[2] === undefined) return null;
    if (hour > 24 || (hour === 24 && minute !== 0)) return null;
  }
  return hour * 60 + minute;
}

/** Format minutes as HH:MM (24-hour). Values ≥ 1440 wrap ("26:00" → "02:00"). */
export function formatClock(minutes) {
  const m = ((minutes % FULL_DAY) + FULL_DAY) % FULL_DAY;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** Sort and merge overlapping or touching intervals. Returns a new array. */
export function normalizeIntervals(intervals) {
  const sorted = intervals
    .map((i) => ({ start: i.start, end: i.end }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [];
  for (const cur of sorted) {
    const last = out[out.length - 1];
    if (last && cur.start <= last.end) {
      last.end = Math.max(last.end, cur.end);
    } else {
      out.push(cur);
    }
  }
  return out;
}

/** Equality of two interval lists after normalisation. null only equals null. */
export function sameIntervals(a, b) {
  if (a === null || b === null) return a === b;
  const na = normalizeIntervals(a);
  const nb = normalizeIntervals(b);
  if (na.length !== nb.length) return false;
  return na.every((x, i) => x.start === nb[i].start && x.end === nb[i].end);
}

/** Human-readable form: "Closed", "Open 24 hours", "09:00–17:00, 18:00–02:00 (+1)", "unknown". */
export function describeIntervals(intervals) {
  if (intervals === null || intervals === undefined) return 'unknown';
  const n = normalizeIntervals(intervals);
  if (n.length === 0) return 'Closed';
  if (n.length === 1 && n[0].start === 0 && n[0].end >= FULL_DAY) return 'Open 24 hours';
  return n
    .map((i) => `${formatClock(i.start)}–${formatClock(i.end)}${i.end > FULL_DAY ? ' (+1)' : ''}`)
    .join(', ');
}

// ---------------------------------------------------------------------------
// Calendar helpers. All dates are plain 'YYYY-MM-DD' strings handled in UTC so the
// result never depends on the machine's time zone.
// ---------------------------------------------------------------------------

const ISO_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;

/** Normalise "2016-1-1" → "2016-01-01"; returns null for invalid dates. */
export function normalizeIsoDate(raw) {
  const m = ISO_RE.exec(String(raw ?? '').trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${m[1]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Weekday index (0 = Sunday) of an ISO date. */
export function weekdayOf(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** ISO date plus n days. */
export function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

/** Inclusive list of `count` consecutive ISO dates starting at `start`. */
export function dateRange(start, count) {
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(addDays(start, i));
  return out;
}

/**
 * Effective intervals for one date (see module docstring for precedence).
 * @param {{weekly: Array, overrides: Array}} model
 * @param {string} iso
 * @returns {Array<{start:number,end:number}>|null}
 */
export function resolveDate(model, iso) {
  const wd = weekdayOf(iso);
  const hits = model.overrides.filter(
    (o) => o.from <= iso && iso <= o.through && (o.weekdays === null || o.weekdays.includes(wd)),
  );
  if (hits.length > 0) {
    return normalizeIntervals(hits.flatMap((o) => o.intervals));
  }
  const weekly = model.weekly[wd];
  return weekly === null ? null : normalizeIntervals(weekly);
}

/** True when at least one override touches a date. */
export function hasOverride(model, iso) {
  const wd = weekdayOf(iso);
  return model.overrides.some(
    (o) => o.from <= iso && iso <= o.through && (o.weekdays === null || o.weekdays.includes(wd)),
  );
}
