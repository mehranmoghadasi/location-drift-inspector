import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, toCsv } from '../extension/lib/csv.js';
import { parseClock, normalizeIntervals, addDays, weekdayOf, normalizeIsoDate, describeIntervals } from '../extension/lib/hours.js';
import { parseGbpSheet, mapColumns } from '../extension/lib/gbp-sheet.js';
import { extractJsonLd, visibleText } from '../extension/lib/html.js';
import { findLocalBusinesses, readSchemaHours } from '../extension/lib/jsonld.js';
import { normalizePhone, phonesMatch, compareAddress, normalizeUrl, findPhones } from '../extension/lib/normalize.js';

test('csv: BOM, CRLF, quoted commas, escaped quotes and embedded newlines', () => {
  const text = '﻿a,b,c\r\n"x, y","say ""hi""","line1\nline2"\r\n\r\nlast,,\r\n';
  assert.deepEqual(parseCsv(text), [['a', 'b', 'c'], ['x, y', 'say "hi"', 'line1\nline2'], ['last', '', '']]);
  assert.deepEqual(parseCsv(toCsv([['x, y', 'say "hi"', 'line1\nline2']])), [['x, y', 'say "hi"', 'line1\nline2']]);
  assert.throws(() => parseCsv('a,"unclosed'), /unbalanced/);
});

test('clock parsing: 24 h, 12 h, seconds, invalid and ambiguous inputs', () => {
  assert.equal(parseClock('09:00'), 540);
  assert.equal(parseClock('9:30 pm'), 1290);
  assert.equal(parseClock('12:00AM'), 0);
  assert.equal(parseClock('12:00 PM'), 720);
  assert.equal(parseClock('9am'), 540);
  assert.equal(parseClock('9 a.m.'), 540);
  assert.equal(parseClock('17:30:00'), 1050);
  assert.equal(parseClock('24:00'), 1440);
  assert.equal(parseClock('9'), null, 'a bare hour is ambiguous');
  assert.equal(parseClock('25:00'), null);
  assert.equal(parseClock('13:00 PM'), null);
  assert.equal(parseClock('9:75'), null);
});

test('calendar helpers cross month and year boundaries in UTC', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(weekdayOf('2026-12-25'), 5); // Friday
  assert.equal(normalizeIsoDate('2016-1-1'), '2016-01-01');
  assert.equal(normalizeIsoDate('2026-02-30'), null);
  assert.deepEqual(normalizeIntervals([{ start: 600, end: 700 }, { start: 540, end: 620 }]), [{ start: 540, end: 700 }]);
  assert.equal(describeIntervals([{ start: 1080, end: 1560 }]), '18:00–02:00 (+1)');
  assert.equal(describeIntervals(null), 'unknown');
});

test('sheet: header aliases, store code required, duplicates skipped, all-empty hours = unknown', () => {
  const cols = mapColumns(['Business code', 'Name', 'Monday', 'Tuesday hours', 'Address line 2', 'Address line 1']);
  assert.equal(cols.storeCode, 0);
  assert.equal(cols.days[1], 2);
  assert.equal(cols.days[2], 3);
  assert.deepEqual(cols.addressLines, [5, 4], 'address lines are ordered by their number');

  const csv = [
    'Store code,Business name,Monday hours,Tuesday hours,Special hours',
    'A1,Alpha,09:00-17:00,x,',
    'A1,Alpha again,09:00-17:00,x,',
    'B2,Beta,,,',
    'C3,Gamma,9 to 5,09:00-17:00,2026-13-01: x',
    ',No code,09:00-17:00,,',
  ].join('\n');
  const { locations, warnings } = parseGbpSheet(csv);
  assert.deepEqual(locations.map((l) => l.storeCode), ['A1', 'B2', 'C3']);
  assert.deepEqual(locations[0].hours.weekly.slice(1, 3), [[{ start: 540, end: 1020 }], []]);
  assert.deepEqual(locations[1].hours.weekly, [null, null, null, null, null, null, null]);
  assert.equal(locations[2].cellErrors.length, 2, 'unreadable Monday cell and impossible special date');
  assert.ok(warnings.some((w) => /duplicate store code "A1"/.test(w)));
  assert.ok(warnings.some((w) => /B2.*no hours provided/.test(w)));
  assert.ok(warnings.some((w) => /empty store code/.test(w)));
  assert.throws(() => parseGbpSheet('Name,Monday\nX,09:00-17:00'), /Store code/);
});

test('html: JSON-LD blocks parsed, broken blocks reported, visible text excludes scripts and keeps tel: links', () => {
  const html = `<html><head><title>T</title><script type="application/ld+json">{"@type":"Store","name":"S"}</script></head>
  <body><script type='application/ld+json'>{ broken</script><style>.x{}</style><!-- hidden -->
  <p>Open&nbsp;daily &amp; late</p><a href="tel:%2B1-403-555-0101">Call</a><script>var hidden = "Monday 1-2pm";</script></body></html>`;
  const { blocks, errors } = extractJsonLd(html);
  assert.equal(blocks.length, 1);
  assert.equal(errors.length, 1);
  const vis = visibleText(html);
  assert.ok(vis.text.includes('Open daily & late'));
  assert.ok(!vis.text.includes('hidden'));
  assert.ok(!vis.text.includes('Monday 1-2pm'));
  assert.deepEqual(vis.telLinks, ['+1-403-555-0101']);
});

test('jsonld: finds LocalBusiness in @graph, array @type, subtype and nested nodes; flags unscoped specs', () => {
  const blocks = [
    { '@graph': [{ '@type': 'WebPage' }, { '@type': ['Thing', 'Dentist'], name: 'D', department: { '@type': 'Pharmacy', name: 'P' } }] },
    [{ '@type': 'Organization', name: 'Org', address: { streetAddress: 'x' }, openingHoursSpecification: [] }],
  ];
  const names = findLocalBusinesses(blocks).map((e) => e.name);
  assert.deepEqual(names, ['D', 'P', 'Org']);
  const { errors } = readSchemaHours({ openingHoursSpecification: [{ opens: '09:00', closes: '17:00' }, { dayOfWeek: 'Funday', opens: '09:00', closes: '17:00' }] });
  assert.equal(errors.length, 2);
});

test('jsonld: expired date-scoped rules are listed relative to asOf', () => {
  const { expired } = readSchemaHours({ openingHoursSpecification: [{ opens: '00:00', closes: '00:00', validFrom: '2026-01-01', validThrough: '2026-01-02' }] }, '2026-06-01');
  assert.deepEqual(expired, [{ from: '2026-01-01', through: '2026-01-02' }]);
});

test('phones: country code, punctuation, extensions and suffix rule', () => {
  assert.equal(normalizePhone('+1 (403) 555-0110 ext. 12'), '4035550110');
  assert.equal(normalizePhone('0044 20 7946 0000'), '442079460000');
  assert.ok(phonesMatch('+1-403-555-0110', '403.555.0110'));
  assert.ok(phonesMatch('+44 20 7946 0000', '020 7946 0000') === false, 'trunk 0 is not stripped — reported, not guessed');
  assert.ok(phonesMatch('442079460000', '2079460000'), 'suffix of ≥9 digits matches');
  assert.ok(!phonesMatch('555-0110', '403-555-0110'), 'a 7-digit local number is too short to match by suffix');
  assert.deepEqual(findPhones('Call 403.555.0129 or (403) 555-0120, unit 12'), ['403.555.0129', '(403) 555-0120']);
});

test('addresses: abbreviations, region names and postal spacing; mismatches named by part', () => {
  const gbp = { lines: ['1010 Sample Ave SW', 'Suite 200'], locality: 'Calgary', region: 'AB', postalCode: 'T2R 0A1', country: 'CA' };
  const same = compareAddress(gbp, { street: '1010 Sample Avenue Southwest, Ste 200', locality: 'calgary', region: 'Alberta', postalCode: 't2r0a1' });
  assert.ok(same.every((p) => p.status === 'match'), JSON.stringify(same));
  const diff = compareAddress(gbp, { street: '1012 Sample Ave SW #200', locality: 'Calgary', region: '', postalCode: 'T2R 0A1' });
  assert.deepEqual(diff.map((p) => [p.part, p.status]), [['street', 'mismatch'], ['locality', 'match'], ['region', 'missing'], ['postalCode', 'match']]);
});

test('urls: www, scheme, trailing slash, query and fragment are ignored; path case is kept', () => {
  assert.equal(normalizeUrl('https://www.Example.com/Locations/Beltline/?utm_source=gbp#map'), 'example.com/Locations/Beltline');
  assert.equal(normalizeUrl('http://example.com/'), 'example.com');
  assert.equal(normalizeUrl('not a url'), null);
});
