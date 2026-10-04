/**
 * jsonld.js — find LocalBusiness entities in JSON-LD and read their hours.
 *
 * Vendor definitions, quoted verbatim from "Local Business (LocalBusiness) Structured
 * Data", https://developers.google.com/search/docs/appearance/structured-data/local-business
 * (page "Last updated 2026-09-08 UTC", fetched 2026-10-01):
 *
 *   openingHoursSpecification.opens  — "The time the business location opens, in hh:mm:ss format."
 *   openingHoursSpecification.closes — "The time the business location closes, in hh:mm:ss format."
 *   openingHoursSpecification.dayOfWeek — "One or more of the following values:
 *       https://schema.org/Monday ... We also support the short names without the URL
 *       prefix (for example, Monday)."
 *   openingHoursSpecification.validFrom — "The start date of a seasonal business closure,
 *       in YYYY-MM-DD format."
 *   openingHoursSpecification.validThrough — "The end date of a seasonal business closure,
 *       in YYYY-MM-DD format."
 *   Standard hours — "Excluding the validFrom and validThrough properties signify that the
 *       hours are valid year-round."
 *   Late night hours — "For hours past midnight, define opening and closing hours using a
 *       single OpeningHoursSpecification property. This example defines hours from Saturday
 *       at 6pm until Sunday at 3am." (opens "18:00", closes "03:00")
 *   All-day hours — "To show a business as open 24 hours a day, set the open property to
 *       "00:00" and the closes property to "23:59". To show a business is closed all day,
 *       set both opens and closes properties to "00:00"."
 *   Seasonal hours — example with opens "00:00", closes "00:00", validFrom "2015-12-23",
 *       validThrough "2016-01-05" and NO dayOfWeek: "a business closed for winter holidays".
 *       → a date-scoped specification without dayOfWeek applies to every day in the range.
 *   telephone — "A business phone number meant to be the primary contact method for
 *       customers. Be sure to include the country code and area code in the phone number."
 *   url — "The fully-qualified URL of the specific business location."
 *
 * Note the trap: opens 00:00 + closes 00:00 = CLOSED here, but "00:00-00:00" in the
 * Business Profile spreadsheet = OPEN 24 HOURS (see gbp-sheet.js).
 *
 * A specification with neither dayOfWeek nor validFrom/validThrough has no scope and is
 * reported as an error rather than guessed at.
 *
 * Also read (not documented by Google, but common on real pages): schema.org's text
 * property openingHours and specialOpeningHoursSpecification. See readSchemaHours().
 */

import { emptyModel, normalizeIntervals, normalizeIsoDate, parseClock, DAY_NAMES, FULL_DAY, ParseError } from './hours.js';

/** Common LocalBusiness subtypes; any node with an address + hours is also accepted. */
const LOCAL_TYPES = new Set([
  'localbusiness', 'store', 'restaurant', 'foodestablishment', 'dentist', 'medicalbusiness',
  'medicalclinic', 'physician', 'realestateagent', 'professionalservice', 'automotivebusiness',
  'autorepair', 'homeandconstructionbusiness', 'plumber', 'electrician', 'hvacbusiness',
  'financialservice', 'lodgingbusiness', 'hotel', 'legalservice', 'attorney',
  'healthandbeautybusiness', 'sportsactivitylocation', 'entertainmentbusiness',
  'governmentoffice', 'childcare', 'drycleaningorlaundry', 'emergencyservice',
  'employmentagency', 'travelagency', 'selfstorage', 'animalshelter', 'library',
  'recyclingcenter', 'shoppingcenter', 'tourisminformationcenter', 'radiostation',
  'televisionstation', 'internetcafe', 'archiveorganization', 'cafeorcoffeeshop', 'bakery',
  'barorpub', 'clothingstore', 'grocerystore', 'hardwarestore', 'pharmacy', 'optician',
]);

function typesOf(node) {
  const t = node['@type'];
  const list = Array.isArray(t) ? t : t ? [t] : [];
  return list.map((x) => String(x).replace(/^https?:\/\/schema\.org\//i, '').toLowerCase());
}

function isLocalBusiness(node) {
  const types = typesOf(node);
  if (types.some((t) => LOCAL_TYPES.has(t))) return true;
  return Boolean(node.address && typeof node.address === 'object' && node.openingHoursSpecification);
}

/**
 * Walk any JSON-LD structure (arrays, @graph, nested properties) and collect
 * LocalBusiness-like nodes. Nested nodes are still visited once a match is found
 * (e.g. a "department" inside a store).
 * @param {Array<any>} blocks
 * @returns {Array<object>}
 */
export function findLocalBusinesses(blocks) {
  const found = [];
  const seen = new Set();
  const visit = (node) => {
    if (node === null || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (isLocalBusiness(node)) found.push(node);
    Object.entries(node).forEach(([key, value]) => {
      if (key !== 'openingHoursSpecification' && key !== 'address') visit(value);
    });
  };
  blocks.forEach(visit);
  return found;
}

function readDayOfWeek(value) {
  const list = Array.isArray(value) ? value : [value];
  const days = [];
  const bad = [];
  for (const v of list) {
    const name = String(v).replace(/^https?:\/\/schema\.org\//i, '').trim().toLowerCase();
    const idx = DAY_NAMES.findIndex((d) => d.toLowerCase() === name);
    if (idx === -1) bad.push(String(v));
    else days.push(idx);
  }
  return { days, bad };
}

/**
 * Convert opens/closes to an interval list using Google's rules.
 * @returns {Array<{start:number,end:number}>}
 */
export function schemaInterval(opens, closes) {
  const start = parseClock(opens);
  const end = parseClock(closes);
  if (start === null || end === null) {
    throw new ParseError(`opens "${opens}" / closes "${closes}" is not hh:mm[:ss]`);
  }
  if (start === 0 && end === 0) return []; // closed all day (Google)
  if (start === 0 && (end === 1439 || end === FULL_DAY)) return [{ start: 0, end: FULL_DAY }]; // 24 h
  if (end === start) throw new ParseError(`opens and closes are both "${opens}" — ambiguous`);
  return [{ start, end: end < start ? end + FULL_DAY : end }];
}

const TEXT_DAYS = { mo: 1, tu: 2, we: 3, th: 4, fr: 5, sa: 6, su: 0 };

function textDay(token) {
  const t = token.trim().toLowerCase().replace(/\.$/, '');
  if (t.length < 2) return null;
  const key = t.slice(0, 2);
  if (!(key in TEXT_DAYS)) return null;
  // Accept "Mo", "Mon", "Monday"; reject words that only share two letters ("Total").
  const full = DAY_NAMES[TEXT_DAYS[key]].toLowerCase();
  return full.startsWith(t) ? TEXT_DAYS[key] : null;
}

function textDayList(raw) {
  const days = [];
  for (const part of raw.split(',')) {
    const range = part.split('-').map((x) => x.trim()).filter(Boolean);
    if (range.length === 1) {
      const d = textDay(range[0]);
      if (d === null) return null;
      days.push(d);
    } else if (range.length === 2) {
      const a = textDay(range[0]);
      const b = textDay(range[1]);
      if (a === null || b === null) return null;
      // Monday-first walk so "Mo-Su" covers the whole week and "Sa-Mo" wraps.
      const order = [1, 2, 3, 4, 5, 6, 0];
      let i = order.indexOf(a);
      for (let guard = 0; guard < 7; guard += 1) {
        days.push(order[i]);
        if (order[i] === b) break;
        i = (i + 1) % 7;
      }
    } else return null;
  }
  return [...new Set(days)];
}

/**
 * Read the schema.org text property openingHours into weekly hours.
 *
 * schema.org/openingHours (fetched 2026-10-04): "Days are specified using the following
 * two-letter combinations: Mo, Tu, We, Th, Fr, Sa, Su." "Times are specified using 24:00
 * format." Example "Tu,Th 16:00-20:00"; "If a business is open 7 days a week, then it can
 * be specified as ... Mo-Su" (no time = all day). The value may be one string or an array.
 * Three-letter and full English day names are accepted as well, because real pages use them.
 *
 * Closing time 00:00 or 24:00 means midnight; a closing time before the opening time runs
 * past midnight. "00:00-00:00" is reported as ambiguous instead of guessed.
 * @returns {{model: object, errors: string[], groups: number}}
 */
export function parseOpeningHoursText(value) {
  const model = emptyModel();
  const errors = [];
  let groups = 0;
  const items = (Array.isArray(value) ? value : [value]).map((v) => String(v ?? '').trim()).filter(Boolean);
  const seen = [false, false, false, false, false, false, false];
  const DAY = '[A-Za-z]{2,9}\\.?';
  const DAYS = `${DAY}(?:\\s*[-,]\\s*${DAY})*`;
  const TIME = '\\d{1,2}:\\d{2}(?::\\d{2})?';
  const RANGE = `${TIME}\\s*-\\s*${TIME}`;
  const GROUP = new RegExp(`(${DAYS})(?:\\s+(${RANGE}(?:\\s*,\\s*${RANGE})*))?`, 'g');
  for (const item of items) {
    let matched = false;
    for (const m of item.matchAll(GROUP)) {
      const days = textDayList(m[1]);
      if (days === null) continue;
      matched = true;
      let intervals;
      if (m[2] === undefined) {
        intervals = [{ start: 0, end: FULL_DAY }];
      } else {
        intervals = [];
        for (const r of m[2].split(',')) {
          const [a, b] = r.split('-').map((x) => parseClock(x.trim()));
          if (a === null || b === null) {
            errors.push(`openingHours "${item}": unreadable time "${r.trim()}"`);
            continue;
          }
          if (a === 0 && b === 0) {
            errors.push(`openingHours "${item}": "00:00-00:00" is ambiguous (closed, or open all day?)`);
            continue;
          }
          if (a === 0 && (b === FULL_DAY || b === 1439)) intervals.push({ start: 0, end: FULL_DAY });
          else if (b === 0 || b === FULL_DAY) intervals.push({ start: a, end: FULL_DAY });
          else intervals.push({ start: a, end: b <= a ? b + FULL_DAY : b });
        }
        if (intervals.length === 0) continue;
      }
      groups += 1;
      for (const d of days) {
        model.weekly[d] = seen[d] ? model.weekly[d].concat(intervals) : intervals.slice();
        seen[d] = true;
      }
    }
    if (!matched) errors.push(`openingHours "${item}" is not in the "Mo-Fr 09:00-17:00" format`);
  }
  return { model, errors, groups };
}

function readSpecList(raw, label, model, errors, expired, asOf, { requireDates }) {
  const specs = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  const weeklySeen = [false, false, false, false, false, false, false];
  specs.forEach((spec, i) => {
    if (!spec || typeof spec !== 'object') {
      errors.push(`${label}[${i}] is not an object`);
      return;
    }
    let intervals;
    try {
      intervals = schemaInterval(spec.opens, spec.closes);
    } catch (err) {
      if (!(err instanceof ParseError)) throw err;
      errors.push(`${label}[${i}]: ${err.message}`);
      return;
    }
    const hasDays = spec.dayOfWeek !== undefined;
    const { days, bad } = hasDays ? readDayOfWeek(spec.dayOfWeek) : { days: [], bad: [] };
    bad.forEach((b) => errors.push(`${label}[${i}]: unknown dayOfWeek "${b}"`));
    const hasRange = spec.validFrom !== undefined || spec.validThrough !== undefined;
    if (hasRange) {
      const from = normalizeIsoDate(spec.validFrom ?? spec.validThrough);
      const through = normalizeIsoDate(spec.validThrough ?? spec.validFrom);
      if (!from || !through || through < from) {
        errors.push(`${label}[${i}]: validFrom/validThrough is not a valid YYYY-MM-DD range`);
        return;
      }
      if (asOf && through < asOf) expired.push({ from, through });
      model.overrides.push({ from, through, weekdays: hasDays ? days : null, intervals, source: `schema-${label}` });
      return;
    }
    if (requireDates) {
      errors.push(`${label}[${i}] has no validFrom/validThrough — special hours need dates`);
      return;
    }
    if (!hasDays) {
      errors.push(`${label}[${i}] has neither dayOfWeek nor validFrom/validThrough`);
      return;
    }
    days.forEach((d) => {
      // Several specifications for one weekday (split shifts) add up; an explicit closed
      // spec ([]) does not erase hours declared by another spec.
      model.weekly[d] = weeklySeen[d] ? model.weekly[d].concat(intervals) : intervals.slice();
      weeklySeen[d] = true;
    });
  });
  return specs.length;
}

/**
 * Read every hours property of one entity into a HoursModel.
 *
 * Sources, in order of authority:
 *   1. openingHoursSpecification — the property Google documents;
 *   2. specialOpeningHoursSpecification — schema.org's property for dated exceptions,
 *      read as date overrides (each entry needs validFrom/validThrough);
 *   3. openingHours (text) — used for weekly hours only when (1) is absent.
 * When (1) and (3) are both present and disagree on a weekday, the page contradicts
 * itself; the disagreement is returned in `conflicts` and (1) wins.
 *
 * @returns {{model: object, errors: string[], expired: Array<{from:string,through:string}>,
 *   hasHours: boolean, weeklySource: 'specification'|'openingHours'|null,
 *   conflicts: Array<{day:string, specification:Array, text:Array}>}}
 */
export function readSchemaHours(entity, asOf) {
  const model = emptyModel();
  const errors = [];
  const expired = [];
  const nSpec = readSpecList(entity.openingHoursSpecification, 'openingHoursSpecification', model, errors, expired, asOf, { requireDates: false });
  const nSpecial = readSpecList(entity.specialOpeningHoursSpecification, 'specialOpeningHoursSpecification', model, errors, expired, asOf, { requireDates: true });
  let weeklySource = model.weekly.some((w) => w !== null) ? 'specification' : null;
  const conflicts = [];
  let nText = 0;
  if (entity.openingHours !== undefined) {
    const text = parseOpeningHoursText(entity.openingHours);
    nText = text.groups;
    if (weeklySource === null) {
      text.errors.forEach((e) => errors.push(e));
      if (text.groups > 0) {
        model.weekly = text.model.weekly;
        weeklySource = 'openingHours';
      }
    } else {
      for (let d = 0; d < 7; d += 1) {
        const a = model.weekly[d];
        const b = text.model.weekly[d];
        if (a === null || b === null) continue;
        if (JSON.stringify(normalizeIntervals(a)) !== JSON.stringify(normalizeIntervals(b))) {
          conflicts.push({ day: DAY_NAMES[d], specification: a, text: b });
        }
      }
    }
  }
  // Weekdays not mentioned by any year-round specification are unknown, not closed —
  // Google's own examples always list closed days explicitly.
  return {
    model,
    errors,
    expired,
    hasHours: nSpec + nSpecial + nText > 0,
    weeklySource,
    conflicts,
  };
}

/** Flatten a schema.org PostalAddress (or a plain string) into comparable parts. */
export function readSchemaAddress(address) {
  if (!address) return null;
  if (typeof address === 'string') return { street: address, locality: '', region: '', postalCode: '', country: '' };
  const a = Array.isArray(address) ? address[0] : address;
  if (!a || typeof a !== 'object') return null;
  const country = typeof a.addressCountry === 'object' && a.addressCountry ? a.addressCountry.name ?? '' : a.addressCountry ?? '';
  return {
    street: String(a.streetAddress ?? ''),
    locality: String(a.addressLocality ?? ''),
    region: String(a.addressRegion ?? ''),
    postalCode: String(a.postalCode ?? ''),
    country: String(country),
  };
}
