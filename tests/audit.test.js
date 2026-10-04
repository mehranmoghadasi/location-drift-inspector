import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseGbpSheet } from '../extension/lib/gbp-sheet.js';
import { auditLocation } from '../extension/lib/audit.js';
import { parseVisibleHours, parseDaySpec, parseTimeRanges } from '../extension/lib/visible-hours.js';

const fixture = (p) => readFileSync(new URL(`../examples/${p}`, import.meta.url), 'utf8');
const sheet = parseGbpSheet(fixture('gbp-locations.csv'));
const loc = (code) => sheet.locations.find((l) => l.storeCode === code);
const page = (file, url) => ({ url, html: fixture(`pages/${file}`), mode: 'raw' });
const byId = (result, id) => result.checks.find((c) => c.id === id);

const KENS = auditLocation(loc('NG-KENS'), page('kensington.html', 'https://yourdomain.com/locations/kensington'), { asOf: '2026-11-20', horizonDays: 45 });

test('driftDays is hand-countable: Kensington, 2026-11-20 + 45 days', () => {
  // Window = 2026-11-20 … 2027-01-03. JSON-LD differs from the profile on:
  //   every Saturday (10–16 vs 10–14): Nov 21, 28, Dec 5, 12, 19, 26, Jan 2  → 7 days
  //   Dec 24 (Thu, 09–12 vs 09–17) and Dec 25 (Fri, closed vs 09–17)       → 2 days
  //   (Dec 26 is a Saturday, already counted)                                  = 9
  assert.equal(KENS.metrics.comparedDays, 45);
  assert.equal(KENS.metrics.driftDays, 9);
  const driftDates = KENS.calendar.filter((c) => c.schemaStatus === 'drift').map((c) => c.date);
  assert.deepEqual(driftDates, ['2026-11-21', '2026-11-28', '2026-12-05', '2026-12-12', '2026-12-19', '2026-12-24', '2026-12-25', '2026-12-26', '2027-01-02']);
});

test('fail/warn labels each count exactly one thing', () => {
  assert.equal(KENS.counts.fail, KENS.checks.filter((c) => c.severity === 'fail').length);
  assert.equal(KENS.status, 'fail');
  assert.equal(byId(KENS, 'PHONE_SCHEMA').severity, 'fail');
  assert.equal(byId(KENS, 'HOURS_WEEKLY_SCHEMA').severity, 'fail');
  assert.equal(byId(KENS, 'SPECIAL_SCHEMA').detail.length, 3);
  // Visible-text findings are heuristic and must never be fails.
  assert.ok(KENS.checks.filter((c) => /VISIBLE/.test(c.id)).every((c) => c.severity !== 'fail'));
});

test('special hours the site announces but the profile lacks become a Special hours cell', () => {
  assert.deepEqual(KENS.fixes.specialHours.addedDates, ['2026-12-24', '2026-12-25', '2026-12-26']);
  assert.equal(KENS.fixes.specialHours.cell, '2026-12-24: 09:00-12:00, 2026-12-25: x, 2026-12-26: x');
});

test('the 00:00–00:00 trap is named in the finding', () => {
  const r = auditLocation(loc('NG-AIRP'), page('airport-storage.html', 'https://yourdomain.com/locations/airport-storage'), { asOf: '2026-11-20', horizonDays: 45 });
  const c = byId(r, 'HOURS_WEEKLY_SCHEMA');
  assert.equal(c.severity, 'fail');
  assert.match(c.message, /7 day/);
  assert.match(c.detail[0], /00:00–00:00 trap/);
  assert.equal(r.metrics.driftDays, 45);
  assert.equal(byId(r, 'HOURS_WEEKLY_VISIBLE').severity, 'pass', 'visible "Open 24 hours" agrees with the profile');
});

test('a consistent page passes every check, including dated holiday hours', () => {
  const r = auditLocation(loc('NG-BELT'), page('beltline.html', 'https://yourdomain.com/locations/beltline'), { asOf: '2026-11-20', horizonDays: 45 });
  assert.equal(r.status, 'pass');
  assert.equal(r.metrics.driftDays, 0);
  assert.equal(r.metrics.visibleDriftDays, 0);
  assert.ok(r.calendar.find((c) => c.date === '2027-01-01').special);
});

test('no JSON-LD: structured-data checks are skipped, not failed; drift is "0 of 0", not "0 of 45"', () => {
  const r = auditLocation(loc('NG-DTWN'), page('downtown.html', 'https://yourdomain.com/locations/downtown'), { asOf: '2026-11-20', horizonDays: 45 });
  assert.equal(byId(r, 'LD_ENTITY').severity, 'warn');
  assert.equal(r.metrics.comparedDays, 0);
  assert.equal(byId(r, 'URL_PROFILE').severity, 'info');
  assert.deepEqual(byId(r, 'SPECIAL_VISIBLE').detail, ['2026-12-25 (Fri): profile Closed vs page 08:30–17:00']);
});

test('additional phone in JSON-LD is info, an unknown phone is fail; best of several entities is compared', () => {
  const l = loc('NG-KENS');
  const html = `<script type="application/ld+json">[
    {"@type":"LocalBusiness","name":"Other branch","telephone":"403-555-0199","address":{"postalCode":"T9X 9X9"}},
    {"@type":"LocalBusiness","name":"Northgate Rentals Kensington","telephone":"403-555-0121","address":{"streetAddress":"220 Example St NW","addressLocality":"Calgary","addressRegion":"AB","postalCode":"T2N0B2"}}
  ]</script><p>220 Example St NW T2N 0B2 · 403-555-0120</p>`;
  const r = auditLocation(l, { url: 'https://yourdomain.com/locations/kensington', html }, { asOf: '2026-11-20', horizonDays: 7 });
  assert.equal(byId(r, 'LD_ENTITY').severity, 'info');
  assert.equal(byId(r, 'PHONE_SCHEMA').severity, 'info');
  assert.equal(byId(r, 'ADDRESS_SCHEMA').severity, 'pass');
  assert.throws(() => auditLocation(l, { url: 'x', html: '' }, { asOf: '20-11-2026' }), /asOf/);
});

test('visible hours: ranges, lists, table cells, meridiem inference, ambiguity and dated lines', () => {
  assert.deepEqual(parseDaySpec('Mon - Fri'), [1, 2, 3, 4, 5]);
  assert.deepEqual(parseDaySpec('Fri-Mon'), [0, 1, 5, 6]);
  assert.deepEqual(parseDaySpec('Sat & Sun'), [0, 6]);
  assert.deepEqual(parseDaySpec('Weekdays'), [1, 2, 3, 4, 5]);
  assert.deepEqual(parseTimeRanges('9 - 5pm'), [{ start: 540, end: 1020 }]);
  assert.deepEqual(parseTimeRanges('1 - 5pm'), [{ start: 780, end: 1020 }]);
  assert.equal(parseTimeRanges('9-5'), null, 'no meridiem, no colon: ambiguous, not read');
  const { model, matchedLines } = parseVisibleHours([
    'Store hours: Mondays – Thursdays 8am–6pm', 'Friday', '8:00 AM – 9:00 PM', 'Sat: 10am-2pm, 3pm-5pm', 'Sunday Closed',
    'Dec 31: 10am – 3pm', 'Christmas Eve we close at noon',
  ], '2026-11-20');
  assert.deepEqual(model.weekly[1], [{ start: 480, end: 1080 }]);
  assert.deepEqual(model.weekly[5], [{ start: 480, end: 1260 }]);
  assert.deepEqual(model.weekly[6], [{ start: 600, end: 840 }, { start: 900, end: 1020 }]);
  assert.deepEqual(model.weekly[0], []);
  assert.deepEqual(model.overrides.map((o) => o.from), ['2026-12-31']);
  assert.equal(matchedLines.length, 5);
  assert.equal(parseVisibleHours(['Welcome to our office'], '2026-11-20').model, null, 'nothing read → unknown, not closed');
});

test('year-less dated lines roll over to next year when the date has passed', () => {
  const { model } = parseVisibleHours(['January 1: Closed'], '2026-11-20');
  assert.equal(model.overrides[0].from, '2027-01-01');
});
