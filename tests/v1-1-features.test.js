import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseGbpSheet, mapColumns } from '../extension/lib/gbp-sheet.js';
import { auditLocation } from '../extension/lib/audit.js';
import { readSchemaHours, parseOpeningHoursText } from '../extension/lib/jsonld.js';
import { extractJsonLd } from '../extension/lib/html.js';
import { toGoogleUpdatesCsv, stringifyCompact } from '../extension/lib/report.js';
import { renderIcon } from '../extension/lib/icon.js';
import { encodePng } from '../scripts/package-extension.mjs';

const fixture = (p) => readFileSync(new URL(`../examples/${p}`, import.meta.url), 'utf8');
const sheet = parseGbpSheet(fixture('gbp-locations.csv'));
const loc = (code) => sheet.locations.find((l) => l.storeCode === code);
const WINDOW = { asOf: '2026-11-20', horizonDays: 45 };
const audit = (code, file) => auditLocation(loc(code), { url: `https://yourdomain.com/locations/${file.replace('.html', '')}`, html: fixture(`pages/${file}`), mode: 'raw' }, WINDOW);
const byId = (r, id) => r.checks.find((c) => c.id === id);
const asScript = (block) => `<script type="application/ld+json">${JSON.stringify(block)}</script>`;

const MAHG = audit('NG-MAHG', 'mahogany.html');
const KENS = audit('NG-KENS', 'kensington.html');
const AIRP = audit('NG-AIRP', 'airport-storage.html');

// ---------------------------------------------------------------- non-destructive fix
test('JSON-LD fix is a patch: every property the fix does not own survives, inside the same @graph', () => {
  const original = extractJsonLd(fixture('pages/mahogany.html')).blocks[0];
  const patch = MAHG.fixes.jsonLd;
  assert.equal(patch.mode, 'patch');
  assert.equal(patch.blockIndex, 0);
  assert.deepEqual(patch.block['@graph'][0], original['@graph'][0], 'Organization node untouched');
  const before = original['@graph'][1];
  const after = patch.block['@graph'][1];
  for (const key of ['@id', 'image', 'geo', 'aggregateRating', 'priceRange', 'parentOrganization', 'telephone', 'address', 'url', 'name']) {
    assert.deepEqual(after[key], before[key], key);
  }
  assert.equal(after.openingHours, undefined, 'contradicting text hours removed');
  assert.ok(patch.changes.some((c) => c.startsWith('removed openingHours')));
  assert.ok(patch.kept.includes('aggregateRating'));
});

test('patch changes only the drifted telephone and leaves the rest of the @graph alone', () => {
  const patch = KENS.fixes.jsonLd;
  const node = patch.block['@graph'][1];
  assert.equal(node.telephone, '403-555-0120');
  assert.deepEqual(patch.block['@graph'][0], { '@type': 'WebPage', '@id': 'https://yourdomain.com/locations/kensington#page', name: 'Kensington office' });
  assert.ok(patch.changes.includes('telephone: 403-555-0129 → 403-555-0120'));
});

test('re-auditing the patched page: hours, holidays and phone all pass; rating still present', () => {
  for (const [r, code] of [[MAHG, 'NG-MAHG'], [AIRP, 'NG-AIRP']]) {
    const again = auditLocation(loc(code), { url: r.pageUrl, html: asScript(r.fixes.jsonLd.block), mode: 'raw' }, WINDOW);
    assert.equal(again.metrics.driftDays, 0, code);
    assert.equal(byId(again, 'HOURS_WEEKLY_SCHEMA').severity, 'pass', code);
    assert.equal(byId(again, 'SPECIAL_UNDECLARED'), undefined, code);
    assert.equal(byId(again, 'PHONE_SCHEMA').severity, 'pass', code);
  }
  assert.equal(MAHG.fixes.jsonLd.block['@graph'][1].aggregateRating.reviewCount, '112');
});

test('page-only holidays are kept by the patch; patch + Special hours cell together reach zero drift', () => {
  const patch = KENS.fixes.jsonLd;
  assert.ok(patch.changes.some((c) => c.startsWith('kept 3 dated rule(s) only the page has (2026-12-24, 2026-12-25, 2026-12-26)')));
  assert.ok(patch.changes.includes('dropped 1 dated rule(s) that ended before 2026-11-20'));
  const html = asScript(patch.block);
  const url = KENS.pageUrl;
  const afterPatch = auditLocation(loc('NG-KENS'), { url, html }, WINDOW);
  assert.equal(afterPatch.metrics.driftDays, 3, 'only the three page-only holiday dates still differ');
  assert.equal(byId(afterPatch, 'HOURS_WEEKLY_SCHEMA').severity, 'pass');
  const csv = `Store code,Business name,Primary phone,Monday hours,Tuesday hours,Wednesday hours,Thursday hours,Friday hours,Saturday hours,Sunday hours,Special hours
NG-KENS,Northgate Rentals Kensington,403-555-0120,09:00-17:00,09:00-17:00,09:00-17:00,09:00-17:00,09:00-17:00,10:00-14:00,x,"${KENS.fixes.specialHours.cell}"`;
  const fixedProfile = parseGbpSheet(csv).locations[0];
  assert.equal(auditLocation(fixedProfile, { url, html }, WINDOW).metrics.driftDays, 0);
});

test('page without LocalBusiness JSON-LD gets a new minimal block (mode "new")', () => {
  const r = auditLocation(loc('NG-DTWN'), { url: 'https://yourdomain.com/locations/downtown', html: fixture('pages/downtown.html') }, WINDOW);
  assert.equal(r.fixes.jsonLd.mode, 'new');
  assert.equal(r.fixes.jsonLd.block['@type'], 'LocalBusiness');
});

test('fix carries profile holidays beyond the audit window (2027-03-26 is outside 45 days)', () => {
  const dated = MAHG.fixes.jsonLd.node.openingHoursSpecification.filter((s) => s.validFrom).map((s) => s.validFrom);
  assert.deepEqual(dated, ['2026-12-24', '2026-12-25', '2026-12-26', '2027-03-26']);
});

// ---------------------------------------------------------------- more hours formats
test('openingHours text: schema.org forms, full names, past midnight, all-day and errors', () => {
  const w = (v) => parseOpeningHoursText(v).model.weekly;
  assert.deepEqual(w('Tu,Th 16:00-20:00')[2], [{ start: 960, end: 1200 }]);
  assert.equal(w('Tu,Th 16:00-20:00')[3], null, 'Wednesday unknown, not closed');
  assert.deepEqual(w('Mo-Su')[0], [{ start: 0, end: 1440 }]);
  assert.deepEqual(w('Monday-Friday 9:00-17:00, Sat 10:00-14:00')[6], [{ start: 600, end: 840 }]);
  assert.deepEqual(w('Fr-Sa 18:00-02:00')[5], [{ start: 1080, end: 1560 }]);
  assert.deepEqual(w('Sa-Mo 10:00-12:00').map((x) => x !== null), [true, true, false, false, false, false, true]);
  assert.match(parseOpeningHoursText('Mo 00:00-00:00').errors[0], /ambiguous/);
  assert.match(parseOpeningHoursText('Total 09:00-10:00').errors[0], /not in the/);
});

test('specialOpeningHoursSpecification is read as dated overrides; undated entries are errors', () => {
  const r = readSchemaHours({
    openingHoursSpecification: [{ dayOfWeek: 'Monday', opens: '09:00', closes: '17:00' }],
    specialOpeningHoursSpecification: [
      { opens: '00:00', closes: '00:00', validFrom: '2026-12-25', validThrough: '2026-12-25' },
      { opens: '10:00', closes: '12:00' },
    ],
  }, '2026-11-20');
  assert.equal(r.model.overrides.length, 1);
  assert.deepEqual(r.model.overrides[0].intervals, []);
  assert.match(r.errors[0], /need dates/);
});

test('openingHoursSpecification wins over openingHours text; disagreement becomes PAGE_CONSISTENCY', () => {
  const r = readSchemaHours({
    openingHoursSpecification: [{ dayOfWeek: ['Monday', 'Tuesday'], opens: '09:00', closes: '17:00' }],
    openingHours: 'Mo-Tu 09:00-18:00',
  });
  assert.equal(r.weeklySource, 'specification');
  assert.deepEqual(r.conflicts.map((c) => c.day), ['Monday', 'Tuesday']);
  assert.equal(byId(MAHG, 'HOURS_SCHEMA_SOURCE').severity, 'info');
  assert.equal(byId(MAHG, 'PAGE_CONSISTENCY').detail.length, 5, 'JSON-LD 9–5 vs visible 9–6, Mon–Fri');
});

// ---------------------------------------------------------------- holiday wording
test('undeclared holidays are a warning; contradicting dated rules stay a fail', () => {
  assert.equal(byId(MAHG, 'SPECIAL_UNDECLARED').severity, 'warn');
  assert.match(byId(MAHG, 'SPECIAL_UNDECLARED').message, /no dated hours at all/);
  assert.equal(byId(MAHG, 'SPECIAL_SCHEMA'), undefined);
  assert.equal(byId(KENS, 'SPECIAL_SCHEMA').severity, 'fail');
  assert.equal(MAHG.metrics.driftDays, 3, 'still counted as drift days');
});

// ---------------------------------------------------------------- Google updates
test('[UPDATED] columns map separately from the owner columns', () => {
  const cols = mapColumns(['Store code', 'Sunday hours', '[UPDATED] Sunday hours', 'Primary phone', '[UPDATED] Primary phone', 'Google updates']);
  assert.equal(cols.days[0], 1);
  assert.equal(cols.updated.days[0], 2);
  assert.equal(cols.primaryPhone, 3);
  assert.equal(cols.updated.primaryPhone, 4);
  assert.equal(cols.googleUpdates, 5);
});

test('Google updates: empty = no update, [DELETED] = closed, rows without updates are null', () => {
  assert.deepEqual(loc('NG-AIRP').googleUpdates.weekly[0], []);
  assert.equal(loc('NG-AIRP').googleUpdates.weekly[1], null);
  assert.equal(loc('NG-AIRP').hours.weekly[0][0].end, 1440, 'owner value still 24 h');
  assert.equal(loc('NG-DTWN').googleUpdates, null);
  assert.equal(loc('NG-BELT').googleUpdates, null);
});

test('triage: the 00:00 trap makes the page back Google\'s wrong "closed" update', () => {
  assert.deepEqual(AIRP.googleUpdates, [{ field: 'Sunday hours', profile: 'Open 24 hours', google: 'Closed ([DELETED])', page: 'Closed', verdict: 'page-backs-google' }]);
  assert.equal(byId(AIRP, 'GOOGLE_UPDATES').severity, 'fail');
  assert.equal(KENS.googleUpdates[0].verdict, 'page-backs-google', 'page shows the number Google proposes');
  assert.equal(MAHG.googleUpdates[0].verdict, 'page-backs-profile');
  assert.equal(byId(MAHG, 'GOOGLE_UPDATES_REJECT').severity, 'warn');
});

test('google-updates.csv lists every pending update with an action', () => {
  const csv = toGoogleUpdatesCsv([KENS, AIRP, MAHG]);
  const lines = csv.trim().split(/\r?\n/);
  assert.equal(lines.length, 4);
  assert.match(lines[2], /NG-AIRP.*page-backs-google,"?Accept the update in the profile, or fix the page first/);
});

// ---------------------------------------------------------------- icon
test('icon renders deterministically with transparent corners and encodes as a valid PNG', () => {
  const a = renderIcon(32);
  assert.deepEqual(a, renderIcon(32));
  assert.equal(a[3], 0, 'top-left corner transparent');
  const centre = (16 * 32 + 16) * 4;
  assert.equal(a[centre + 3], 255);
  const png = encodePng(renderIcon(16), 16);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.readUInt32BE(16), 16);
});

test('compact JSON report parses back to exactly the same data and keeps raw UTF-8', () => {
  const data = { a: [{ b: { c: { d: [1, 'é – ✓'] } } }], e: [], f: {}, g: null };
  const text = stringifyCompact(data);
  assert.deepEqual(JSON.parse(text), data);
  assert.match(text, /é – ✓/);
  assert.match(text, /^ {8}"c": \{"d":\[1,"é – ✓"\]\}$/m, 'values four levels deep are written on one line');
});
