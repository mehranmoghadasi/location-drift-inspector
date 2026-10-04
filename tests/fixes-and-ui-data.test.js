import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseGbpSheet, parseGbpSpecialHours } from '../extension/lib/gbp-sheet.js';
import { readSchemaHours } from '../extension/lib/jsonld.js';
import { buildOpeningHoursSpecification, buildSpecialHoursCell } from '../extension/lib/fixes.js';
import { dateRange, emptyModel, resolveDate } from '../extension/lib/hours.js';
import { toCsv } from '../extension/lib/csv.js';
import { toFindingsCsv, escapeHtml } from '../extension/lib/report.js';
import { driftChartSvg } from '../extension/lib/chart.js';
import { buildRows, filterRows, sortRows, originsFor } from '../extension/lib/view-model.js';
import { createStore, memoryAdapter, HISTORY_LIMIT } from '../extension/lib/store.js';
import { matchLocation } from '../extension/lib/matcher.js';

const sheet = parseGbpSheet(readFileSync(new URL('../examples/gbp-locations.csv', import.meta.url), 'utf8'));

test('round trip: JSON-LD built from every sample row resolves to the profile hours on every day of the window', () => {
  const window = { asOf: '2026-11-20', horizonDays: 60 };
  for (const loc of sheet.locations) {
    const specs = buildOpeningHoursSpecification(loc.hours, window);
    const { model, errors } = readSchemaHours({ openingHoursSpecification: specs }, window.asOf);
    assert.deepEqual(errors, [], loc.storeCode);
    for (const date of dateRange(window.asOf, window.horizonDays)) {
      assert.deepEqual(resolveDate(model, date), resolveDate(loc.hours, date), `${loc.storeCode} ${date}`);
    }
  }
});

test('JSON-LD fix uses Google spellings for 24 h, closed, past midnight and dated rules', () => {
  const m = emptyModel();
  m.weekly[1] = [{ start: 0, end: 1440 }];
  m.weekly[2] = [];
  m.weekly[6] = [{ start: 1080, end: 1560 }];
  m.overrides.push({ from: '2026-12-25', through: '2026-12-25', weekdays: null, intervals: [], source: 'gbp-special' });
  m.overrides.push({ from: '2025-01-01', through: '2025-01-01', weekdays: null, intervals: [], source: 'gbp-special' });
  const specs = buildOpeningHoursSpecification(m, { asOf: '2026-12-01', horizonDays: 31 });
  assert.deepEqual(specs.map(({ dayOfWeek, opens, closes, validFrom }) => [dayOfWeek ?? validFrom, opens, closes]), [
    ['Monday', '00:00', '23:59'],
    ['Tuesday', '00:00', '00:00'],
    ['Saturday', '18:00', '02:00'],
    ['2026-12-25', '00:00', '00:00'],
  ]);
});

test('Special hours cell keeps existing profile dates and splits sets that pass midnight', () => {
  const gbp = emptyModel();
  gbp.overrides.push(...parseGbpSpecialHours('2026-12-31: 10:00-15:00').overrides);
  const site = emptyModel();
  site.overrides.push({ from: '2026-12-24', through: '2026-12-24', weekdays: null, intervals: [{ start: 1140, end: 1560 }], source: 'schema-dated' });
  site.overrides.push({ from: '2026-12-31', through: '2026-12-31', weekdays: null, intervals: [], source: 'schema-dated' });
  const { cell, addedDates } = buildSpecialHoursCell(gbp, site, { asOf: '2026-12-01', horizonDays: 45 });
  assert.deepEqual(addedDates, ['2026-12-24'], 'Dec 31 already exists in the profile and is not overwritten');
  assert.equal(cell, '2026-12-24: 19:00-00:00, 2026-12-25: 00:00-02:00, 2026-12-31: 10:00-15:00');
  assert.deepEqual(buildSpecialHoursCell(gbp, null, { asOf: '2026-12-01', horizonDays: 45 }), { cell: '', addedDates: [] });
});

test('findings CSV escapes commas, quotes and newlines; HTML escaping covers the five characters', () => {
  const csv = toFindingsCsv([{ storeCode: 'A,1', pageUrl: 'u', checks: [
    { id: 'X', field: 'f', severity: 'fail', message: 'say "hi"', detail: ['a', 'b\nc'] },
    { id: 'Y', field: 'f', severity: 'pass', message: 'ok', detail: null },
  ] }]);
  assert.equal(csv, toCsv([['store_code', 'page_url', 'check', 'field', 'severity', 'message', 'detail'], ['A,1', 'u', 'X', 'f', 'fail', 'say "hi"', 'a | b\nc']]));
  assert.equal(escapeHtml(`<a href="x" title='y'>&</a>`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
});

test('chart: "n/a" when nothing was compared (never a zero bar), widths proportional to drift days', () => {
  const svg = driftChartSvg([
    { storeCode: 'A', metrics: { driftDays: 9, comparedDays: 45, visibleDriftDays: 0, visibleCompared: 45 } },
    { storeCode: '<B>', metrics: { driftDays: 0, comparedDays: 0, visibleDriftDays: 0, visibleCompared: 0 } },
  ], { horizonDays: 45, width: 546 }); // plot width = 546 − 96 − 64 = 386
  assert.match(svg, /class="bar"[^>]*width="77"|width="77"[^>]*class="bar"/, '9/45 of 386 px = 77.2 → 77');
  assert.match(svg, />n\/a</);
  assert.match(svg, /&lt;B&gt;/);
  assert.doesNotMatch(svg, /<B>/);
});

test('table rows: status sort puts fail first and never-scanned last in both directions; filter matches URL', () => {
  const latest = [null, { status: 'pass', counts: { fail: 0, warn: 0 }, metrics: { driftDays: 0, comparedDays: 45 } }, { status: 'fail', counts: { fail: 2, warn: 1 }, metrics: { driftDays: 9, comparedDays: 45 } }, null];
  const rows = buildRows(sheet.locations.slice(0, 4), latest, { 'NG-DTWN': 'https://yourdomain.com/locations/downtown' }, { 'NG-DTWN': 'Could not scan: HTTP 404' });
  assert.deepEqual(sortRows(rows, 'status', 'asc').map((r) => r.status), ['fail', 'pass', 'error', 'none']);
  assert.deepEqual(sortRows(rows, 'fails', 'desc').map((r) => r.storeCode), ['NG-AIRP', 'NG-KENS', 'NG-BELT', 'NG-DTWN']);
  assert.deepEqual(filterRows(rows, 'downtown').map((r) => r.storeCode), ['NG-DTWN']);
  assert.deepEqual(originsFor(['https://a.example/x', 'https://a.example/y', 'http://b.example/', 'ftp://c', 'nope']), ['http://b.example/*', 'https://a.example/*']);
});

test('store: history is capped, newest first; mappings can be set and removed', async () => {
  const store = createStore(memoryAdapter());
  const result = { storeCode: 'A', pageUrl: 'u', status: 'pass', counts: { fail: 0, warn: 0, info: 0, pass: 1 }, metrics: { driftDays: 0, comparedDays: 1, visibleDriftDays: 0 } };
  for (let i = 0; i < HISTORY_LIMIT + 3; i += 1) await store.saveScan(result, `2026-11-${String(i + 1).padStart(2, '0')}T00:00:00Z`);
  const history = await store.getHistory('A');
  assert.equal(history.length, HISTORY_LIMIT);
  assert.equal(history[0].scannedAt, '2026-11-13T00:00:00Z');
  assert.deepEqual(await store.setMapping('A', 'https://x.example/a'), { A: 'https://x.example/a' });
  assert.deepEqual(await store.setMapping('A', ''), {});
  await store.clearScans(['A']);
  assert.equal(await store.getLatest('A'), null);
});

test('page matching: saved mapping wins, unique Website matches, shared homepage is ambiguous', () => {
  const locs = [
    { storeCode: 'A', website: 'https://example.com/' },
    { storeCode: 'B', website: 'https://www.example.com' },
    { storeCode: 'C', website: 'https://example.com/c' },
  ];
  assert.equal(matchLocation(locs, 'https://example.com/c/?utm_source=gbp').location.storeCode, 'C');
  assert.deepEqual(matchLocation(locs, 'https://example.com/').candidates, ['A', 'B']);
  assert.equal(matchLocation(locs, 'https://example.com/', { B: 'https://example.com' }).location.storeCode, 'B');
  assert.equal(matchLocation(locs, 'https://other.example/').reason, 'none');
});
