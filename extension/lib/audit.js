/**
 * audit.js — three-way comparison of one location:
 *   A. the Business Profile spreadsheet row (the intended truth),
 *   B. the LocalBusiness JSON-LD on the location page,
 *   C. the visible text of the same page.
 *
 * Severity, and what each label counts (every label maps to exactly one quantity):
 *   fail — a machine-readable contradiction between A and B (or a spreadsheet cell that
 *          cannot be read). These are certain.
 *   warn — something missing on the page, or a contradiction between A and C. C comes from
 *          a heuristic text reader (visible-hours.js), so it never produces a fail.
 *   info — context that needs no action by itself.
 *   pass — the check ran and found agreement.
 *   counts.fail = number of checks whose severity is "fail" (likewise warn/info/pass).
 *
 * Calendar metrics over the audit window W = [asOf, asOf + horizonDays − 1]:
 *   comparedDays      = |{ d ∈ W : hoursA(d) known AND hoursB(d) known }|
 *   driftDays         = |{ d ∈ W : hoursA(d) known AND hoursB(d) known AND hoursA(d) ≠ hoursB(d) }|
 *   visibleCompared / visibleDriftDays — the same with C instead of B.
 * hoursX(d) is resolveDate() from hours.js: date overrides first, then the weekly hours.
 * Two days are equal when their merged interval lists are identical to the minute.
 *
 * Special dates are split by who is speaking:
 *   SPECIAL_SCHEMA     fail — the page declares a dated rule for that date and it disagrees
 *                      with the profile (two explicit, contradictory statements);
 *   SPECIAL_UNDECLARED warn — the profile has special hours for that date but the page has
 *                      no dated rule, so its regular hours apply to the date. Still counted
 *                      as drift days; worded as a missing declaration, not a contradiction.
 *
 * PAGE_CONSISTENCY (warn) compares the page with itself, independent of the profile:
 * JSON-LD weekly hours vs the visible text, and openingHoursSpecification vs the text
 * property openingHours. A page that contradicts itself is weak evidence for any edit.
 *
 * GOOGLE_UPDATES triages Google's pending updates (download with "Include Google updates",
 * see gbp-sheet.js) against the page. Google's help page on suggested edits says edits
 * that are not reviewed may be published, and names the business website among the
 * sources it checks (https://support.google.com/business/answer/3480441). For each field
 * with a pending update the verdict is:
 *   page-backs-google  fail — the page agrees with Google, not with the profile: accept the
 *                      update or fix the page, otherwise the page supports the edit;
 *   page-backs-profile warn — the page supports the owner's value: reject the update;
 *   page-silent / page-differs  warn — the page cannot settle it either way.
 */

import { extractJsonLd, visibleText } from './html.js';
import { findLocalBusinesses, readSchemaHours, readSchemaAddress } from './jsonld.js';
import { parseVisibleHours } from './visible-hours.js';
import {
  compareAddress, findPhones, foldText, normalizeName, normalizePhone, normalizePostal, normalizeStreet,
  normalizeUrl, phonesMatch,
} from './normalize.js';
import {
  DAY_NAMES, FULL_DAY, dateRange, describeIntervals, hasOverride, resolveDate, sameIntervals, weekdayOf,
} from './hours.js';
import { patchLocalBusinessJsonLd, buildSpecialHoursCell } from './fixes.js';

export const DEFAULT_HORIZON_DAYS = 45;

/** Score how well a JSON-LD entity matches a spreadsheet row (higher is better). */
function entityScore(entity, location, pageUrl) {
  let score = 0;
  if (entity.telephone && phonesMatch(entity.telephone, location.primaryPhone)) score += 2;
  const addr = readSchemaAddress(entity.address);
  if (addr && location.address.postalCode && normalizePostal(addr.postalCode) === normalizePostal(location.address.postalCode)) score += 2;
  if (entity.url && normalizeUrl(entity.url) === normalizeUrl(pageUrl)) score += 2;
  if (entity.name && normalizeName(entity.name) === normalizeName(location.name)) score += 1;
  return score;
}

function is24h(intervals) {
  return Array.isArray(intervals) && intervals.length === 1 && intervals[0].start === 0 && intervals[0].end >= FULL_DAY;
}

/**
 * @param {object} location  one entry from parseGbpSheet().locations
 * @param {{url:string, html:string, mode?:'rendered'|'raw'}} page
 * @param {{asOf:string, horizonDays?:number}} options
 */
export function auditLocation(location, page, options) {
  const asOf = options.asOf;
  const horizonDays = options.horizonDays ?? DEFAULT_HORIZON_DAYS;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(asOf))) throw new Error('options.asOf must be YYYY-MM-DD');
  if (!Number.isInteger(horizonDays) || horizonDays < 1 || horizonDays > 366) throw new Error('horizonDays must be 1–366');

  const checks = [];
  const add = (id, field, severity, message, detail = null) => checks.push({ id, field, severity, message, detail });

  // ---- spreadsheet ---------------------------------------------------------------
  if (location.cellErrors.length > 0) {
    add('SHEET_CELLS', 'spreadsheet', 'fail',
      `${location.cellErrors.length} spreadsheet cell(s) could not be read`,
      location.cellErrors.map((e) => `${e.column}: ${e.message}`));
  }

  // ---- JSON-LD -------------------------------------------------------------------
  const ld = extractJsonLd(page.html);
  if (ld.errors.length > 0) {
    add('LD_PARSE', 'structured data', 'warn', `${ld.errors.length} JSON-LD block(s) are not valid JSON and were skipped`,
      ld.errors.map((e) => `block ${e.index}: ${e.message}`));
  }
  const entities = findLocalBusinesses(ld.blocks);
  let entity = null;
  if (entities.length === 0) {
    add('LD_ENTITY', 'structured data', 'warn', 'No LocalBusiness JSON-LD on this page — structured-data comparisons skipped');
  } else {
    const ranked = entities
      .map((e, idx) => ({ e, idx, s: entityScore(e, location, page.url) }))
      .sort((a, b) => b.s - a.s || a.idx - b.idx);
    entity = ranked[0].e;
    add('LD_ENTITY', 'structured data', entities.length > 1 ? 'info' : 'pass',
      entities.length > 1
        ? `${entities.length} LocalBusiness entities found; compared the one that best matches this location`
        : 'LocalBusiness JSON-LD found');
  }
  const schemaHours = entity ? readSchemaHours(entity, asOf) : null;
  const schemaModel = schemaHours && schemaHours.hasHours ? schemaHours.model : null;

  // ---- visible text --------------------------------------------------------------
  const vis = visibleText(page.html);
  const folded = foldText(vis.text);
  const visParsed = parseVisibleHours(vis.lines, asOf);
  const visibleModel = visParsed.model;

  // ---- name ----------------------------------------------------------------------
  const gName = normalizeName(location.name);
  if (entity) {
    const sName = normalizeName(entity.name ?? '');
    if (sName === '') add('NAME_SCHEMA', 'name', 'warn', 'JSON-LD has no name');
    else if (sName === gName) add('NAME_SCHEMA', 'name', 'pass', 'Name matches');
    else if (sName.includes(gName) || gName.includes(sName)) {
      add('NAME_SCHEMA', 'name', 'warn', `Name differs partially: profile "${location.name}" vs JSON-LD "${entity.name}"`);
    } else add('NAME_SCHEMA', 'name', 'fail', `Name differs: profile "${location.name}" vs JSON-LD "${entity.name}"`);
  }
  if (gName !== '') {
    add('NAME_VISIBLE', 'name', folded.includes(gName) ? 'pass' : 'warn',
      folded.includes(gName) ? 'Profile name appears in the page text' : `Profile name "${location.name}" does not appear in the page text`);
  }

  // ---- phone ---------------------------------------------------------------------
  const primary = location.primaryPhone;
  if (primary) {
    if (entity) {
      if (!entity.telephone) add('PHONE_SCHEMA', 'phone', 'warn', 'JSON-LD has no telephone');
      else if (phonesMatch(entity.telephone, primary)) add('PHONE_SCHEMA', 'phone', 'pass', 'Telephone matches the primary phone');
      else if (location.additionalPhones.some((p) => phonesMatch(entity.telephone, p))) {
        add('PHONE_SCHEMA', 'phone', 'info', `JSON-LD telephone ${entity.telephone} is one of the profile's additional phones, not the primary ${primary}`);
      } else add('PHONE_SCHEMA', 'phone', 'fail', `Telephone differs: profile ${primary} vs JSON-LD ${entity.telephone}`);
    }
    // One entry per distinct number (a tel: link and its label are the same number).
    const candidates = [...new Map([...vis.telLinks, ...findPhones(vis.text)].map((p) => [normalizePhone(p), p])).values()];
    const known = [primary, ...location.additionalPhones];
    const unknown = candidates.filter((c) => !known.some((k) => phonesMatch(c, k)));
    if (candidates.some((c) => phonesMatch(c, primary))) {
      add('PHONE_VISIBLE', 'phone', unknown.length > 0 ? 'info' : 'pass',
        unknown.length > 0 ? `Primary phone is visible; other numbers also shown: ${unknown.join(', ')}` : 'Primary phone is visible');
    } else if (candidates.length > 0) {
      add('PHONE_VISIBLE', 'phone', 'warn', `Primary phone ${primary} is not visible; page shows ${candidates.join(', ')}`);
    } else add('PHONE_VISIBLE', 'phone', 'warn', 'No phone number visible on the page');
  }

  // ---- address -------------------------------------------------------------------
  if (entity) {
    const parts = compareAddress(location.address, readSchemaAddress(entity.address));
    const bad = parts.filter((p) => p.status === 'mismatch');
    const missing = parts.filter((p) => p.status === 'missing');
    if (bad.length > 0) {
      add('ADDRESS_SCHEMA', 'address', 'fail', `Address differs in: ${bad.map((p) => p.part).join(', ')}`,
        bad.map((p) => `${p.part}: profile "${p.gbp}" vs JSON-LD "${p.site}"`));
    } else if (missing.length > 0) {
      add('ADDRESS_SCHEMA', 'address', 'warn', `JSON-LD address is missing: ${missing.map((p) => p.part).join(', ')}`);
    } else if (parts.length > 0) add('ADDRESS_SCHEMA', 'address', 'pass', 'Address matches');
  }
  if (location.address.postalCode || location.address.lines.length > 0) {
    const flat = folded.replace(/\s+/g, '');
    const postalOk = !location.address.postalCode || flat.includes(normalizePostal(location.address.postalCode));
    const street = normalizeStreet(location.address.lines[0] ?? '');
    const streetOk = street === '' || normalizeStreet(vis.text).includes(street);
    add('ADDRESS_VISIBLE', 'address', postalOk && streetOk ? 'pass' : 'warn',
      postalOk && streetOk ? 'Street and postal code are visible'
        : `Not visible on the page: ${[!streetOk && 'street line', !postalOk && 'postal code'].filter(Boolean).join(' and ')}`);
  }

  // ---- URL -----------------------------------------------------------------------
  const pageKey = normalizeUrl(page.url);
  if (location.website) {
    const same = normalizeUrl(location.website) === pageKey;
    add('URL_PROFILE', 'url', same ? 'pass' : 'info',
      same ? 'Profile website points to this page' : `Profile website points to ${location.website}, not to this page`);
  }
  if (entity && entity.url && normalizeUrl(entity.url) !== pageKey) {
    add('URL_SCHEMA', 'url', 'warn', `JSON-LD url ${entity.url} is not this page (Google: "The fully-qualified URL of the specific business location")`);
  }

  // ---- weekly hours ----------------------------------------------------------------
  // Days with the same disagreement are reported on one line ("Monday, Tuesday: …").
  const weeklyCompare = (model) => {
    const groups = new Map();
    const missing = [];
    let days = 0;
    for (const d of [1, 2, 3, 4, 5, 6, 0]) {
      const g = location.hours.weekly[d];
      if (g === null) continue;
      const s = model.weekly[d];
      if (s === null) missing.push(DAY_NAMES[d]);
      else if (!sameIntervals(g, s)) {
        const trap = is24h(g) && s.length === 0 ? ' — looks like the 00:00–00:00 trap: in the profile it means open 24 hours, in JSON-LD it means closed' : '';
        const key = `profile ${describeIntervals(g)} vs page ${describeIntervals(s)}${trap}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(DAY_NAMES[d]);
        days += 1;
      }
    }
    const mismatch = [...groups.entries()].map(([key, names]) => `${names.join(', ')}: ${key}`);
    return { mismatch, missing, days };
  };
  if (location.hours.weekly.some((w) => w !== null)) {
    if (schemaModel) {
      const { mismatch, missing, days } = weeklyCompare(schemaModel);
      if (schemaHours.errors.length > 0) {
        add('HOURS_SCHEMA_ERRORS', 'hours', 'warn', `${schemaHours.errors.length} openingHoursSpecification entr(y/ies) could not be read`, schemaHours.errors);
      }
      if (mismatch.length > 0) add('HOURS_WEEKLY_SCHEMA', 'hours', 'fail', `Weekly hours differ on ${days} day(s)`, mismatch);
      else if (missing.length > 0) add('HOURS_WEEKLY_SCHEMA', 'hours', 'warn', `JSON-LD has no hours for: ${missing.join(', ')}`);
      else add('HOURS_WEEKLY_SCHEMA', 'hours', 'pass', 'Weekly hours match');
    } else if (entity) {
      add('HOURS_WEEKLY_SCHEMA', 'hours', 'warn', 'JSON-LD has no hours (no openingHoursSpecification or openingHours)');
    }
    if (schemaModel && schemaHours.weeklySource === 'openingHours') {
      add('HOURS_SCHEMA_SOURCE', 'hours', 'info',
        'Weekly hours were read from the text property "openingHours"; Google documents openingHoursSpecification, which the fix below writes');
    }
    if (visibleModel) {
      const { mismatch, missing, days } = weeklyCompare(visibleModel);
      if (mismatch.length > 0) add('HOURS_WEEKLY_VISIBLE', 'hours', 'warn', `Visible weekly hours differ on ${days} day(s) (text reader is heuristic)`, mismatch);
      else if (missing.length > 0) add('HOURS_WEEKLY_VISIBLE', 'hours', 'info', `No visible hours read for: ${missing.join(', ')}`);
      else add('HOURS_WEEKLY_VISIBLE', 'hours', 'pass', 'Visible weekly hours match');
    } else {
      add('HOURS_WEEKLY_VISIBLE', 'hours', 'info', 'No hours could be read from the visible text');
    }
  }

  // ---- calendar (dated / special hours) ------------------------------------------
  const dates = dateRange(asOf, horizonDays);
  const calendar = dates.map((date) => {
    const gbp = resolveDate(location.hours, date);
    const schema = schemaModel ? resolveDate(schemaModel, date) : null;
    const visible = visibleModel ? resolveDate(visibleModel, date) : null;
    const special = hasOverride(location.hours, date)
      || Boolean(schemaModel && hasOverride(schemaModel, date))
      || Boolean(visibleModel && hasOverride(visibleModel, date));
    const pair = (x) => (gbp === null || x === null ? 'unknown' : sameIntervals(gbp, x) ? 'match' : 'drift');
    return { date, weekday: DAY_NAMES[weekdayOf(date)].slice(0, 3), special, gbp, schema, visible, schemaStatus: pair(schema), visibleStatus: pair(visible) };
  });
  const line = (c, key) => `${c.date} (${c.weekday}): profile ${describeIntervals(c.gbp)} vs page ${describeIntervals(c[key])}`;
  const specialDrift = (key) => calendar.filter((c) => c.special && c[`${key}Status`] === 'drift').map((c) => line(c, key));
  const schemaSpecial = calendar.filter((c) => c.special && c.schemaStatus === 'drift');
  const declared = schemaSpecial.filter((c) => hasOverride(schemaModel, c.date));
  const undeclared = schemaSpecial.filter((c) => !hasOverride(schemaModel, c.date));
  if (declared.length > 0) {
    add('SPECIAL_SCHEMA', 'special hours', 'fail',
      `The page's dated hours contradict the profile on ${declared.length} date(s) in the next ${horizonDays} days`,
      declared.map((c) => line(c, 'schema')));
  }
  if (undeclared.length > 0) {
    const noRules = schemaModel.overrides.length === 0;
    add('SPECIAL_UNDECLARED', 'special hours', 'warn',
      `${undeclared.length} profile holiday/special date(s) are not declared on the page${noRules ? ' (it has no dated hours at all)' : ''}, so its regular hours apply to them`,
      undeclared.map((c) => line(c, 'schema')));
  }
  if (schemaSpecial.length === 0 && schemaModel && calendar.some((c) => c.special)) {
    add('SPECIAL_SCHEMA', 'special hours', 'pass', 'Special/holiday dates agree');
  }
  const vd = specialDrift('visible');
  if (vd.length > 0) add('SPECIAL_VISIBLE', 'special hours', 'warn', `Visible holiday hours differ on ${vd.length} date(s) (text reader is heuristic)`, vd);
  if (schemaHours && schemaHours.expired.length > 0) {
    add('SCHEMA_EXPIRED', 'special hours', 'info', `${schemaHours.expired.length} date-scoped JSON-LD rule(s) ended before ${asOf}`,
      schemaHours.expired.map((e) => `${e.from} → ${e.through}`));
  }

  // ---- page vs itself -------------------------------------------------------------
  const selfConflicts = [];
  if (schemaHours) {
    schemaHours.conflicts.forEach((c) => selfConflicts.push(
      `${c.day}: openingHoursSpecification ${describeIntervals(c.specification)} vs openingHours text ${describeIntervals(c.text)}`));
  }
  if (schemaModel && visibleModel) {
    for (const d of [1, 2, 3, 4, 5, 6, 0]) {
      const a = schemaModel.weekly[d];
      const b = visibleModel.weekly[d];
      if (a === null || b === null || sameIntervals(a, b)) continue;
      selfConflicts.push(`${DAY_NAMES[d]}: JSON-LD ${describeIntervals(a)} vs visible text ${describeIntervals(b)}`);
    }
  }
  if (selfConflicts.length > 0) {
    add('PAGE_CONSISTENCY', 'hours', 'warn', `The page contradicts itself on ${selfConflicts.length} weekday(s) — fix this whatever the profile says`, selfConflicts);
  }

  // ---- Google's pending updates ----------------------------------------------------
  const googleUpdates = triageGoogleUpdates(location, entity, schemaModel, visibleModel, vis, asOf, horizonDays);
  if (googleUpdates.length > 0) {
    const backsGoogle = googleUpdates.filter((u) => u.verdict === 'page-backs-google');
    const backsProfile = googleUpdates.filter((u) => u.verdict === 'page-backs-profile');
    const rest = googleUpdates.filter((u) => u.verdict !== 'page-backs-google' && u.verdict !== 'page-backs-profile');
    const fmt = (u) => `${u.field}: profile ${u.profile} · Google ${u.google} · page ${u.page}`;
    if (backsGoogle.length > 0) {
      add('GOOGLE_UPDATES', 'google updates', 'fail',
        `${backsGoogle.length} pending Google update(s) are backed by this page — accept them in the profile or fix the page`,
        backsGoogle.map(fmt));
    }
    if (backsProfile.length > 0) {
      add('GOOGLE_UPDATES_REJECT', 'google updates', 'warn',
        `${backsProfile.length} pending Google update(s) contradict this page — the page supports your values, so review and reject them`,
        backsProfile.map(fmt));
    }
    if (rest.length > 0) {
      add('GOOGLE_UPDATES_OPEN', 'google updates', 'warn',
        `${rest.length} pending Google update(s) this page cannot settle — check them by hand`, rest.map(fmt));
    }
  }

  const counts = { fail: 0, warn: 0, info: 0, pass: 0 };
  checks.forEach((c) => { counts[c.severity] += 1; });
  const comparedDays = calendar.filter((c) => c.schemaStatus !== 'unknown').length;
  const driftDays = calendar.filter((c) => c.schemaStatus === 'drift').length;
  const visibleCompared = calendar.filter((c) => c.visibleStatus !== 'unknown').length;
  const visibleDriftDays = calendar.filter((c) => c.visibleStatus === 'drift').length;
  const window = { asOf, horizonDays };
  const siteModelForCell = schemaModel ?? visibleModel;

  return {
    storeCode: location.storeCode,
    name: location.name,
    pageUrl: page.url,
    mode: page.mode ?? 'raw',
    status: counts.fail > 0 ? 'fail' : counts.warn > 0 ? 'warn' : 'pass',
    counts,
    metrics: { comparedDays, driftDays, visibleCompared, visibleDriftDays },
    checks,
    calendar,
    visibleHoursLines: visParsed.matchedLines,
    googleUpdates,
    fixes: {
      jsonLd: patchLocalBusinessJsonLd({
        location,
        entity,
        blocks: ld.blocks,
        window,
        drift: {
          phone: checks.some((c) => c.id === 'PHONE_SCHEMA' && c.severity === 'fail'),
          addressParts: entity ? compareAddress(location.address, readSchemaAddress(entity.address))
            .filter((p) => p.status === 'mismatch' || p.status === 'missing').map((p) => p.part) : [],
        },
      }),
      specialHours: buildSpecialHoursCell(location.hours, siteModelForCell, window),
    },
  };
}

const FIELD_LABEL = { name: 'Name', primaryPhone: 'Primary phone', website: 'Website', postalCode: 'Postal code', locality: 'Locality' };

/**
 * Compare each pending Google update with what the page says.
 * @returns {Array<{field:string, profile:string, google:string, page:string, verdict:string}>}
 */
export function triageGoogleUpdates(location, entity, schemaModel, visibleModel, vis, asOf, horizonDays) {
  const gu = location.googleUpdates;
  if (!gu) return [];
  const out = [];
  const verdict = (pageVal, profileVal, googleVal, eq) => {
    if (pageVal === null || pageVal === undefined) return 'page-silent';
    const g = eq(pageVal, googleVal);
    const p = eq(pageVal, profileVal);
    if (g && !p) return 'page-backs-google';
    if (p && !g) return 'page-backs-profile';
    return g && p ? 'page-backs-profile' : 'page-differs';
  };
  const site = schemaModel ?? visibleModel;
  gu.weekly.forEach((google, d) => {
    if (google === null) return;
    const profile = location.hours.weekly[d];
    const page = site ? site.weekly[d] : null;
    out.push({
      field: `${DAY_NAMES[d]} hours`,
      profile: describeIntervals(profile),
      google: google.length === 0 ? 'Closed ([DELETED])' : describeIntervals(google),
      page: describeIntervals(page),
      verdict: verdict(page, profile, google, (a, b) => b !== null && sameIntervals(a, b)),
    });
  });
  if (gu.special) {
    const gModel = { weekly: location.hours.weekly, overrides: gu.special };
    for (const date of dateRange(asOf, horizonDays)) {
      if (!hasOverride(gModel, date) && !hasOverride(location.hours, date)) continue;
      const google = resolveDate(gModel, date);
      const profile = resolveDate(location.hours, date);
      if (google === null || (profile !== null && sameIntervals(google, profile))) continue;
      const page = site ? resolveDate(site, date) : null;
      out.push({
        field: `Special hours ${date}`,
        profile: describeIntervals(profile),
        google: describeIntervals(google),
        page: describeIntervals(page),
        verdict: verdict(page, profile, google, (a, b) => b !== null && sameIntervals(a, b)),
      });
    }
  }
  for (const [field, raw] of Object.entries(gu.fields)) {
    const deleted = raw.toLowerCase() === '[deleted]';
    const profile = field === 'primaryPhone' ? location.primaryPhone : field === 'website' ? location.website
      : field === 'name' ? location.name : location.address[field];
    let page = null;
    let eq = (a, b) => foldText(a) === foldText(b);
    if (field === 'primaryPhone') {
      const phones = [...(entity?.telephone ? [entity.telephone] : []), ...vis.telLinks, ...findPhones(vis.text)];
      const hasG = !deleted && phones.some((p) => phonesMatch(p, raw));
      const hasP = Boolean(profile) && phones.some((p) => phonesMatch(p, profile));
      page = phones.length === 0 ? null : hasG && !hasP ? raw : hasP ? profile : phones[0];
      eq = (a, b) => Boolean(a) && Boolean(b) && phonesMatch(a, b);
    } else if (field === 'name') {
      page = entity?.name ?? null;
      eq = (a, b) => normalizeName(a) === normalizeName(b ?? '');
    } else if (field === 'website') {
      page = entity?.url ?? null;
      eq = (a, b) => Boolean(b) && normalizeUrl(a) === normalizeUrl(b);
    } else if (field === 'postalCode') {
      page = readSchemaAddress(entity?.address)?.postalCode || null;
      eq = (a, b) => Boolean(b) && normalizePostal(a) === normalizePostal(b);
    } else if (field === 'locality') {
      page = readSchemaAddress(entity?.address)?.locality || null;
    }
    out.push({
      field: FIELD_LABEL[field] ?? field,
      profile: profile || '(empty)',
      google: deleted ? '(removed)' : raw,
      page: page ?? '(not on page)',
      verdict: deleted ? (page === null ? 'page-backs-google' : 'page-backs-profile') : verdict(page, profile, raw, eq),
    });
  }
  return out;
}
