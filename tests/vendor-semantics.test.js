// Tests whose expected values come from the vendors' own wording, not from fixtures.
// Each test quotes the sentence it encodes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGbpDayCell, parseGbpSpecialHours } from '../extension/lib/gbp-sheet.js';
import { schemaInterval, readSchemaHours } from '../extension/lib/jsonld.js';
import { resolveDate } from '../extension/lib/hours.js';

const H24 = [{ start: 0, end: 1440 }];

test('GBP sheet: "Open 24 hours: 12:00AM-12:00AM / 00:00-00:00 or 00:00-24:00"', () => {
  assert.deepEqual(parseGbpDayCell('12:00AM-12:00AM'), H24);
  assert.deepEqual(parseGbpDayCell('00:00-00:00'), H24);
  assert.deepEqual(parseGbpDayCell('00:00-24:00'), H24);
});

test('GBP sheet: "Closes at midnight: 09:00AM-12:00AM / 09:00-00:00"', () => {
  assert.deepEqual(parseGbpDayCell('09:00AM-12:00AM'), [{ start: 540, end: 1440 }]);
  assert.deepEqual(parseGbpDayCell('09:00-00:00'), [{ start: 540, end: 1440 }]);
});

test('GBP sheet: "Closed all day: X / Leave the spreadsheet cell empty"', () => {
  assert.deepEqual(parseGbpDayCell('X'), []);
  assert.deepEqual(parseGbpDayCell(''), []);
});

test('GBP sheet: "Open past midnight ... 06:00PM-02:00AM / 18:00-02:00" belongs to the day the set begins', () => {
  assert.deepEqual(parseGbpDayCell('06:00PM-02:00AM'), [{ start: 1080, end: 1560 }]);
  assert.deepEqual(parseGbpDayCell('18:00-02:00'), [{ start: 1080, end: 1560 }]);
});

test('GBP sheet: "Open for two sets of hours in one day: 11:30AM-02:00PM, 05:00PM-10:00PM"', () => {
  assert.deepEqual(parseGbpDayCell('11:30AM-02:00PM, 05:00PM-10:00PM'), [{ start: 690, end: 840 }, { start: 1020, end: 1320 }]);
});

test('GBP special hours: Google\'s own example string parses as documented', () => {
  // "2015-11-26: x, 2015-12-25: x, 2015-12-26: 10:00-16:00, 2015-12-26: 17:00-18:00, 2016-1-1: 00:00-00:00"
  const { overrides, errors } = parseGbpSpecialHours('2015-11-26: x, 2015-12-25: x, 2015-12-26: 10:00-16:00, 2015-12-26: 17:00-18:00, 2016-1-1: 00:00-00:00');
  assert.deepEqual(errors, []);
  assert.deepEqual(overrides.map((o) => [o.from, o.intervals]), [
    ['2015-11-26', []],
    ['2015-12-25', []],
    ['2015-12-26', [{ start: 600, end: 960 }, { start: 1020, end: 1080 }]],
    ['2016-01-01', H24],
  ]);
});

test('GBP special hours: "AM or PM format: YYYY-MM-DD: HH:MM AM-HH:MM PM"', () => {
  const { overrides } = parseGbpSpecialHours('2026-12-24: 09:00 AM-01:00 PM');
  assert.deepEqual(overrides[0].intervals, [{ start: 540, end: 780 }]);
});

test('Google JSON-LD: "To show a business is closed all day, set both opens and closes properties to 00:00"', () => {
  assert.deepEqual(schemaInterval('00:00', '00:00'), []);
});

test('Google JSON-LD: open 24 hours is opens "00:00" and closes "23:59"', () => {
  assert.deepEqual(schemaInterval('00:00', '23:59'), H24);
});

test('Google JSON-LD: late night "hours from Saturday at 6pm until Sunday at 3am" (opens 18:00, closes 03:00)', () => {
  assert.deepEqual(schemaInterval('18:00', '03:00'), [{ start: 1080, end: 1620 }]);
});

test('Google JSON-LD: opens/closes "in hh:mm:ss format" are accepted', () => {
  assert.deepEqual(schemaInterval('09:00:00', '17:30:00'), [{ start: 540, end: 1050 }]);
});

test('Google JSON-LD: seasonal example without dayOfWeek closes every day from validFrom to validThrough', () => {
  const entity = {
    openingHoursSpecification: [
      { dayOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'], opens: '09:00', closes: '21:00' },
      { opens: '00:00', closes: '00:00', validFrom: '2015-12-23', validThrough: '2016-01-05' },
    ],
  };
  const { model, errors } = readSchemaHours(entity, '2015-12-01');
  assert.deepEqual(errors, []);
  assert.deepEqual(resolveDate(model, '2015-12-22'), [{ start: 540, end: 1260 }]); // Tuesday before
  assert.deepEqual(resolveDate(model, '2015-12-23'), []); // Wednesday, in range
  assert.deepEqual(resolveDate(model, '2016-01-05'), []); // last day, inclusive
  assert.deepEqual(resolveDate(model, '2016-01-06'), [{ start: 540, end: 1260 }]);
});

test('Google JSON-LD: dayOfWeek accepts https://schema.org/Monday and the short name Monday', () => {
  const { model } = readSchemaHours({
    openingHoursSpecification: [
      { dayOfWeek: 'https://schema.org/Monday', opens: '08:00', closes: '12:00' },
      { dayOfWeek: 'Tuesday', opens: '08:00', closes: '12:00' },
    ],
  });
  assert.deepEqual(model.weekly[1], [{ start: 480, end: 720 }]);
  assert.deepEqual(model.weekly[2], [{ start: 480, end: 720 }]);
  assert.equal(model.weekly[3], null);
});

test('THE TRAP: the same "00:00 to 00:00" means opposite things in the two sources', () => {
  assert.deepEqual(parseGbpDayCell('00:00-00:00'), H24);
  assert.deepEqual(schemaInterval('00:00', '00:00'), []);
});
