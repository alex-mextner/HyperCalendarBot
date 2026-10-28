// Pins every expression form of handleCalculate (result and error text, byte for byte)
// so the form-per-function structure of calculate.ts can be refactored safely.
import { describe, expect, test } from 'bun:test';
import { handleCalculate } from '../../../src/services/ai/tool-handlers/calculate.ts';
import type { ToolResult } from '../../../src/services/ai/types.ts';

const CASES: ReadonlyArray<readonly [string, ToolResult]> = [
  ['2026-09-28 day_of_week', { success: true, output: 'Monday' }],
  [
    'weekday 2026-9-1',
    {
      success: false,
      error:
        'Weekday needs the local calendar date as YYYY-MM-DD, e.g. "2026-09-28 day_of_week". For a datetime, first convert it with "<datetime> to <user IANA timezone>" and pass the local date it returns.',
    },
  ],
  ['weekday(2026-02-31)', { success: false, error: 'Invalid date: 2026-02-31' }],
  [
    'weekday 2026-09-28T10:00:00Z',
    {
      success: false,
      error:
        'Weekday needs the local calendar date as YYYY-MM-DD, e.g. "2026-09-28 day_of_week". For a datetime, first convert it with "<datetime> to <user IANA timezone>" and pass the local date it returns.',
    },
  ],
  ['12:30 UTC+2 to UTC', { success: true, output: '10:30' }],
  ['00:10 UTC+5:30 to UTC', { success: true, output: '18:40' }],
  ['10:00:07 UTC+0 to UTC', { success: true, output: '10:00:07' }],
  ['10:00 UTC+15 to UTC', { success: false, error: 'Invalid fixed-offset datetime: 10:00 UTC+15 to UTC' }],
  ['25:00 UTC+2 to UTC', { success: false, error: 'Invalid fixed-offset datetime: 25:00 UTC+2 to UTC' }],
  ['2026-09-23 12:30 Europe/Belgrade to UTC', { success: true, output: '2026-09-23T10:30:00.000Z' }],
  ['2026-09-27 10:30 UTC to Europe/Belgrade', { success: true, output: '2026-09-27T12:30:00+02:00' }],
  ['2026-09-23T12:30:00Z to Nope/Zone', { success: false, error: 'Invalid timezone: Nope/Zone' }],
  [
    '2026-10-25 02:30 Europe/Belgrade to UTC',
    {
      success: false,
      error: 'Local time is ambiguous in Europe/Belgrade because of a clock change; specify an explicit UTC offset.',
    },
  ],
  [
    '2026-03-29 02:30 Europe/Belgrade to UTC',
    { success: false, error: 'Local time does not exist in Europe/Belgrade because of a clock change.' },
  ],
  [
    '2026-02-30 10:00 Europe/Belgrade to UTC',
    { success: false, error: 'Invalid local datetime: 2026-02-30 10:00 Europe/Belgrade' },
  ],
  ['2026-09-23 12:30 A/B to UTC', { success: false, error: 'Invalid timezone: A/B' }],
  [
    '12:30 Europe/Belgrade to UTC',
    {
      success: false,
      error:
        'Conversion with an IANA timezone needs the calendar date because the UTC offset depends on DST on that date. Put the event\'s date first, e.g. "2026-09-23 12:30 Europe/Belgrade to UTC".',
    },
  ],
  [
    '12:30 UTC to Europe/Belgrade',
    {
      success: false,
      error:
        'Conversion with an IANA timezone needs the calendar date because the UTC offset depends on DST on that date. Put the event\'s date first, e.g. "2026-09-23 12:30 UTC to Europe/Belgrade".',
    },
  ],
  [
    '12:30 UTC to UTC',
    {
      success: false,
      error:
        'Cannot parse: "12:30 UTC to UTC". Supported: numbers (+,-,*,/), HH:MM ± N min/hours, ISO datetime ± N min/hours/days/weeks/months/years, YYYY-MM-DD ± N days/weeks/months/years, ISO datetime - ISO datetime, "YYYY-MM-DD HH:MM <zone> to UTC", "<UTC instant> to <IANA zone>", "YYYY-MM-DD day_of_week"',
    },
  ],
  ['2026-09-23T12:30:00+02:00 to UTC', { success: true, output: '2026-09-23T10:30:00.000Z' }],
  ['2026-09-17T10:49:00+02:00', { success: true, output: '2026-09-17T08:49:00.000Z' }],
  ['2026-02-31T10:00:00Z', { success: false, error: 'Invalid datetime: 2026-02-31T10:00:00Z' }],
  ['2026-09-17T10:49:00.123456+02:00', { success: true, output: '2026-09-17T08:49:00.123Z' }],
  ['2026-03-21T18:00:00Z - 2026-03-20T17:30:00Z', { success: true, output: '1 day' }],
  ['2026-03-24T18:00:00Z - 2026-03-21T17:00:00Z', { success: true, output: '3 days 1h' }],
  [
    '2026-02-31T18:00:00Z - 2026-03-21T17:00:00Z',
    { success: false, error: 'Cannot parse datetime: 2026-02-31T18:00:00Z' },
  ],
  [
    '2026-03-21T18:00:00Z - 2026-02-31T17:00:00Z',
    { success: false, error: 'Cannot parse datetime: 2026-02-31T17:00:00Z' },
  ],
  ['2026-04-10 - 2026-03-21', { success: true, output: '20 days' }],
  ['2026-04-10 - 2026-02-31', { success: false, error: 'Invalid date: 2026-02-31' }],
  ['2026-02-31 - 2026-03-21', { success: false, error: 'Invalid date: 2026-02-31' }],
  ['2026-01-31T22:34:00Z + 1mo', { success: true, output: '2026-02-28T22:34:00.000Z' }],
  ['2026-01-31T22:34:00Z + 1.7months', { success: true, output: '2026-02-28T22:34:00.000Z' }],
  ['2026-01-31T22:34:00Z - 1y', { success: true, output: '2025-01-31T22:34:00.000Z' }],
  ['2026-03-18T22:34:00Z + 1.7months', { success: true, output: '2026-04-18T22:34:00.000Z' }],
  ['2026-03-18T22:34:00Z + 0.3w', { success: true, output: '2026-03-21T00:58:00.000Z' }],
  ['2026-03-18T22:34:00Z + 1.5days', { success: true, output: '2026-03-20T10:34:00.000Z' }],
  ['2026-03-18T22:34:00Z - 31 minutes', { success: true, output: '2026-03-18T22:03:00.000Z' }],
  ['2026-03-18T22:34:00Z + 1.5h', { success: true, output: '2026-03-19T00:04:00.000Z' }],
  [
    '2026-09-19T13:00:00+02:00 - 2hours',
    {
      success: false,
      error:
        'The +02:00 offset is already applied: 2026-09-19T13:00:00+02:00 is 2026-09-19T11:00:00.000Z. Subtracting 2 hours again would give 2026-09-19T09:00:00.000Z (11:00 local) — a double conversion. To convert local time to UTC send "2026-09-19T13:00:00+02:00" alone. If you really need 2 hours earlier, restate in UTC: "2026-09-19T11:00:00Z - 2hours".',
    },
  ],
  [
    '2026-09-19T13:00:00-05:00 + 5h',
    {
      success: false,
      error:
        'The -05:00 offset is already applied: 2026-09-19T13:00:00-05:00 is 2026-09-19T18:00:00.000Z. Adding 5 hours again would give 2026-09-19T23:00:00.000Z (18:00 local) — a double conversion. To convert local time to UTC send "2026-09-19T13:00:00-05:00" alone. If you really need 5 hours later, restate in UTC: "2026-09-19T18:00:00Z + 5h".',
    },
  ],
  [
    '2026-09-19T13:00:00+05:30 - 330min',
    {
      success: false,
      error:
        'The +05:30 offset is already applied: 2026-09-19T13:00:00+05:30 is 2026-09-19T07:30:00.000Z. Subtracting 330 minutes again would give 2026-09-19T02:00:00.000Z (07:30 local) — a double conversion. To convert local time to UTC send "2026-09-19T13:00:00+05:30" alone. If you really need 330 minutes earlier, restate in UTC: "2026-09-19T07:30:00Z - 330min".',
    },
  ],
  ['2026-09-19T13:00:00+02:00 + 2hours', { success: true, output: '2026-09-19T13:00:00.000Z' }],
  ['2026-09-19T13:00:00+02:00 - 2days', { success: true, output: '2026-09-17T11:00:00.000Z' }],
  ['2026-02-31T13:00:00Z + 2h', { success: false, error: 'Cannot parse datetime: 2026-02-31T13:00:00Z' }],
  ['2026-01-31 + 1month', { success: true, output: '2026-02-28' }],
  ['2026-03-18 - 1y', { success: true, output: '2025-03-18' }],
  ['2026-03-18 + 2weeks', { success: true, output: '2026-04-01' }],
  ['2026-03-18 - 7 days', { success: true, output: '2026-03-11' }],
  ['2026-02-31 + 1day', { success: false, error: 'Invalid date: 2026-02-31' }],
  ['2026-03-18 + 3w', { success: true, output: '2026-04-08' }],
  ['22:34 + 31min', { success: true, output: '23:05' }],
  ['1:05 - 2h', { success: true, output: '23:05' }],
  ['22:34 + 1.5h', { success: true, output: '00:04' }],
  ['09:00 + 25 hours', { success: true, output: '10:00' }],
  ['00:00 - 1min', { success: true, output: '23:59' }],
  [
    '2026-09-24',
    {
      success: false,
      error:
        'A YYYY-MM-DD date is not a number. Date forms: weekday "2026-09-28 day_of_week", shift "2026-09-28 + 7days", days between "2026-10-10 - 2026-09-28", dated conversion "2026-09-28 12:30 Europe/Belgrade to UTC".',
    },
  ],
  [
    '2026-09-24 12:30',
    {
      success: false,
      error:
        'Datetime arithmetic requires ISO 8601 with T and an explicit Z/offset, e.g. "2026-09-17T10:49:00+02:00 + 2hours". Local-to-UTC conversion accepts a dated IANA zone, e.g. "2026-09-23 12:30 Europe/Belgrade to UTC", or an explicit fixed UTC offset. UTC to local: "2026-09-27 10:30 UTC to Europe/Belgrade". Weekday of a date: "2026-09-28 day_of_week". For arithmetic forms, do not append "to UTC".',
    },
  ],
  [
    '2026-9-24 + 1',
    {
      success: false,
      error:
        'A YYYY-MM-DD date is not a number. Date forms: weekday "2026-09-28 day_of_week", shift "2026-09-28 + 7days", days between "2026-10-10 - 2026-09-28", dated conversion "2026-09-28 12:30 Europe/Belgrade to UTC".',
    },
  ],
  [
    '1 + 2026-09-24',
    {
      success: false,
      error:
        'A YYYY-MM-DD date is not a number. Date forms: weekday "2026-09-28 day_of_week", shift "2026-09-28 + 7days", days between "2026-10-10 - 2026-09-28", dated conversion "2026-09-28 12:30 Europe/Belgrade to UTC".',
    },
  ],
  ['2+3*4', { success: true, output: '14' }],
  ['(1+2)*3', { success: true, output: '9' }],
  ['1/0', { success: false, error: 'Result is not a finite number' }],
  ['(1', { success: false, error: 'Cannot evaluate: (1' }],
  ['1..2', { success: false, error: 'Cannot evaluate: 1..2' }],
  [
    'hello',
    {
      success: false,
      error:
        'Cannot parse: "hello". Supported: numbers (+,-,*,/), HH:MM ± N min/hours, ISO datetime ± N min/hours/days/weeks/months/years, YYYY-MM-DD ± N days/weeks/months/years, ISO datetime - ISO datetime, "YYYY-MM-DD HH:MM <zone> to UTC", "<UTC instant> to <IANA zone>", "YYYY-MM-DD day_of_week"',
    },
  ],
];

describe('handleCalculate expression forms', () => {
  for (const [expression, expected] of CASES) {
    test(expression, () => {
      expect(handleCalculate({ expression })).toEqual(expected);
    });
  }

  test('rejects an expression over the 500 character limit', () => {
    expect(handleCalculate({ expression: 'x'.repeat(501) })).toEqual({
      success: false,
      error: 'Expression exceeds the 500 character limit',
    });
  });
});
