/**
 * visible-hours.js — HEURISTIC reader for hours written as text on a page.
 *
 * Recognised line shapes (one schedule per line; "|" and ";" also split):
 *   "Monday – Friday: 9:00 AM – 5:00 PM"     day range + time range
 *   "Mon, Wed & Fri 9am-1pm, 2pm-6pm"        day list + several sets
 *   "Sat: Closed"                             closed
 *   "Weekdays 08:00–18:00" / "Weekends" / "Daily" / "Every day"
 *   "Open 24 hours" / "Open 24/7"             all days 24 h
 *   "December 25: Closed", "Dec 24, 2026: 9am–1pm", "2026-12-31: 10:00-15:00"
 *                                             dated entries (holiday hours)
 *
 * Meridiem inference: a start time without am/pm takes the end time's meridiem, unless
 * that would put the start after the end, in which case it is "am" ("9 - 5pm" → 09:00–17:00,
 * "1 - 5pm" → 13:00–17:00). A bare number range with no meridiem and no colon ("9-5") is
 * not read — it is ambiguous.
 *
 * Dated entries without a year take the first occurrence on or after `asOf`.
 *
 * The result is used only for WARN-level findings, never FAIL: free text is written in too
 * many ways for a reader like this to be certain. Lines it cannot read are ignored; if no
 * line is read at all the visible hours are "unknown", not "closed".
 */

import { emptyModel, parseClock, normalizeIsoDate, FULL_DAY } from './hours.js';

const DAY_TOKENS = [
  ['sunday', 0], ['sun', 0], ['monday', 1], ['mon', 1], ['tuesday', 2], ['tues', 2], ['tue', 2],
  ['wednesday', 3], ['wed', 3], ['thursday', 4], ['thurs', 4], ['thur', 4], ['thu', 4],
  ['friday', 5], ['fri', 5], ['saturday', 6], ['sat', 6],
];
const GROUPS = { weekdays: [1, 2, 3, 4, 5], weekends: [0, 6], daily: [0, 1, 2, 3, 4, 5, 6], 'every day': [0, 1, 2, 3, 4, 5, 6], 'seven days a week': [0, 1, 2, 3, 4, 5, 6] };
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

const DAY_WORD = '(?:sunday|sun|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat)\\.?s?';
const DAY_SPEC_RE = new RegExp(`^((?:${DAY_WORD}|weekdays|weekends|daily|every day|seven days a week)(?:\\s*(?:-|–|—|to|through|thru|,|&|and|/)\\s*(?:${DAY_WORD}))*)\\s*:?\\s*(.*)$`, 'i');
const TIME = '(\\d{1,2}(?::\\d{2})?\\s*(?:a\\.?m\\.?|p\\.?m\\.?)?)';
const RANGE_RE = new RegExp(`${TIME}\\s*(?:-|–|—|to|until)\\s*${TIME}`, 'gi');

function dayIndex(word) {
  let w = word.toLowerCase().trim().replace(/\.$/, '');
  if (w.endsWith('s') && !['tues', 'thurs'].includes(w)) w = w.slice(0, -1); // "Mondays"
  const hit = DAY_TOKENS.find(([name]) => name === w);
  return hit ? hit[1] : null;
}

/** Expand "Mon - Fri", "Mon, Wed & Fri", "Weekdays" … into weekday indexes. */
export function parseDaySpec(spec) {
  const s = spec.toLowerCase().trim();
  if (GROUPS[s]) return GROUPS[s].slice();
  const tokens = s.split(/\s*(,|&|\band\b|\/)\s*/).filter((t) => t && !/^(,|&|and|\/)$/.test(t));
  const days = [];
  for (const tok of tokens) {
    const range = tok.split(/\s*(?:-|–|—|\bto\b|\bthrough\b|\bthru\b)\s*/);
    if (range.length === 2) {
      const a = dayIndex(range[0]);
      const b = dayIndex(range[1]);
      if (a === null || b === null) return null;
      for (let d = a; ; d = (d + 1) % 7) {
        days.push(d);
        if (d === b) break;
      }
    } else {
      const d = dayIndex(tok);
      if (d === null) return null;
      days.push(d);
    }
  }
  return [...new Set(days)].sort((x, y) => x - y);
}

function hasMeridiem(t) {
  return /[ap]\.?m\.?$/i.test(t.trim());
}

/** Read all time ranges in a string. Returns null when none can be read. */
export function parseTimeRanges(text) {
  const out = [];
  RANGE_RE.lastIndex = 0;
  let m;
  while ((m = RANGE_RE.exec(text)) !== null) {
    let a = m[1].trim();
    const b = m[2].trim();
    if (!hasMeridiem(a) && hasMeridiem(b)) {
      const endMer = /p/i.test(b) ? 'pm' : 'am';
      const candidate = parseClock(`${a} ${endMer}`);
      const end = parseClock(b);
      a = candidate !== null && end !== null && candidate > end ? `${a} am` : `${a} ${endMer}`;
    }
    const start = parseClock(a);
    let end = parseClock(b);
    if (start === null || end === null) continue;
    if (start === 0 && (end === 0 || end === FULL_DAY || end === 1439)) {
      out.push({ start: 0, end: FULL_DAY });
      continue;
    }
    if (end === 0) end = FULL_DAY;
    if (end <= start) end += FULL_DAY;
    out.push({ start, end });
  }
  return out.length > 0 ? out : null;
}

function readSchedule(rest) {
  const r = rest.trim().toLowerCase();
  if (/^(closed|close|by appointment only|by appointment)\b/.test(r)) return r.startsWith('closed') || r.startsWith('close') ? [] : null;
  if (/open 24 hours|24\/7|24 hours/.test(r)) return [{ start: 0, end: FULL_DAY }];
  return parseTimeRanges(rest);
}

/** Next occurrence of month/day on or after asOf (both ISO). */
function nextOccurrence(month, day, asOf) {
  const year = Number(asOf.slice(0, 4));
  for (const y of [year, year + 1]) {
    const iso = normalizeIsoDate(`${y}-${month}-${day}`);
    if (iso && iso >= asOf) return iso;
  }
  return null;
}

function parseDatePrefix(line, asOf) {
  const iso = /^(\d{4}-\d{1,2}-\d{1,2})\s*:?\s*(.*)$/.exec(line);
  if (iso) {
    const date = normalizeIsoDate(iso[1]);
    return date ? { date, rest: iso[2] } : null;
  }
  const named = /^(?:[a-z]+day,?\s+)?([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?\s*:?\s*(.*)$/i.exec(line);
  if (!named) return null;
  const monthIdx = MONTHS.findIndex((mo) => mo.startsWith(named[1].toLowerCase()) && named[1].length >= 3);
  if (monthIdx === -1) return null;
  const day = Number(named[2]);
  const date = named[3]
    ? normalizeIsoDate(`${named[3]}-${monthIdx + 1}-${day}`)
    : asOf
      ? nextOccurrence(monthIdx + 1, day, asOf)
      : null;
  return date ? { date, rest: named[4] } : null;
}

/**
 * @param {string[]} lines visible text lines
 * @param {string} asOf ISO date used to resolve year-less dates
 * @returns {{model: object|null, matchedLines: string[]}}
 */
export function parseVisibleHours(lines, asOf) {
  const model = emptyModel();
  const matchedLines = [];
  let found = false;
  const pieces = lines
    .flatMap((l) => l.split(/\s*[|;]\s*/))
    .map((l) => l.trim().replace(/^(?:(?:opening|business|store|office|regular|holiday)\s+)?hours\s*:\s*/i, ''))
    .filter(Boolean);
  for (let i = 0; i < pieces.length; i += 1) {
    let line = pieces[i];
    if (line.length > 160) continue;
    // Table layouts put the day and the hours in separate cells, i.e. separate lines.
    const next = pieces[i + 1];
    const joinNext = () => {
      if (next === undefined) return false;
      line = `${line}: ${next}`;
      i += 1;
      return true;
    };
    const bareDay = DAY_SPEC_RE.exec(line);
    if ((bareDay && bareDay[2].trim() === '') || /^(\d{4}-\d{1,2}-\d{1,2}|[a-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s*\d{4})?)\s*:?$/i.test(line)) {
      if (next !== undefined && readSchedule(next) !== null) joinNext();
    }
    if (/^open 24 hours$|^open 24\/7$/i.test(line)) {
      for (let d = 0; d < 7; d += 1) model.weekly[d] = [{ start: 0, end: FULL_DAY }];
      matchedLines.push(line);
      found = true;
      continue;
    }
    const dated = parseDatePrefix(line, asOf);
    if (dated) {
      const sched = readSchedule(dated.rest);
      if (sched !== null) {
        model.overrides.push({ from: dated.date, through: dated.date, weekdays: null, intervals: sched, source: 'visible-dated' });
        matchedLines.push(line);
        found = true;
      }
      continue;
    }
    const m = DAY_SPEC_RE.exec(line);
    if (!m) continue;
    const days = parseDaySpec(m[1]);
    if (!days || days.length === 0) continue;
    const sched = readSchedule(m[2]);
    if (sched === null) continue;
    days.forEach((d) => {
      model.weekly[d] = (model.weekly[d] ?? []).concat(sched);
    });
    matchedLines.push(line);
    found = true;
  }
  return { model: found ? model : null, matchedLines };
}
