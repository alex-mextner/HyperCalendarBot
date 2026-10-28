// calculate tool handler.
import { describe, expect, test } from 'bun:test';
import { handleCalculate } from '../../../../src/services/ai/tool-handlers/calculate.ts';

describe('handleCalculate', () => {
  test('adds two integers', async () => {
    const r = handleCalculate({ expression: '2 + 31' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('33');
  });

  test('complex arithmetic expression', async () => {
    const r = handleCalculate({ expression: '22 * 60 + 34' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('1354');
  });

  test('adds minutes to HH:MM', async () => {
    const r = handleCalculate({ expression: '22:34 + 31min' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('23:05');
  });

  test('HH:MM wraps around midnight', async () => {
    const r = handleCalculate({ expression: '23:50 + 30min' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('00:20');
  });

  test('subtracts minutes from HH:MM', async () => {
    const r = handleCalculate({ expression: '22:34 - 10min' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('22:24');
  });

  test('adds hours to HH:MM', async () => {
    const r = handleCalculate({ expression: '09:00 + 2h' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('11:00');
  });

  test('adds minutes to ISO datetime', async () => {
    const r = handleCalculate({ expression: '2026-03-18T22:34:00Z + 31min' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('2026-03-18T23:05:00.000Z');
  });

  test('ISO datetime crosses midnight', async () => {
    const r = handleCalculate({ expression: '2026-03-18T23:50:00Z + 20min' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('2026-03-19T00:10:00.000Z');
  });

  test('adds hours to ISO datetime', async () => {
    const r = handleCalculate({ expression: '2026-03-18T22:34:00Z + 2hours' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('2026-03-19T00:34:00.000Z');
  });

  test('subtracts from ISO datetime', async () => {
    const r = handleCalculate({ expression: '2026-03-19T00:05:00Z - 1hour' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('2026-03-18T23:05:00.000Z');
  });

  test('requires an explicit timezone for datetime arithmetic', () => {
    const r = handleCalculate({ expression: '2026-09-16T17:40 - 2hours' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('explicit Z/offset');
    expect(r.error).toContain('2026-09-17T10:49:00+02:00 + 2hours');
  });

  test('converts dated local IANA time to UTC with the event-date DST offset', () => {
    expect(handleCalculate({ expression: '2026-07-15 12:30 Europe/Belgrade to UTC' })).toMatchObject({
      success: true,
      output: '2026-07-15T10:30:00.000Z',
    });
    expect(handleCalculate({ expression: '2026-01-15 12:30 Europe/Belgrade to UTC' })).toMatchObject({
      success: true,
      output: '2026-01-15T11:30:00.000Z',
    });
  });

  test('accepts explicit UTC offsets including the historical prompt form', () => {
    expect(handleCalculate({ expression: '2026-09-23 12:30 UTC+2 to UTC' })).toMatchObject({
      success: true,
      output: '2026-09-23T10:30:00.000Z',
    });
    expect(handleCalculate({ expression: '12:30 UTC+2 to UTC' })).toMatchObject({ success: true, output: '10:30' });
    expect(handleCalculate({ expression: '12:30 UTC-5 to UTC' })).toMatchObject({ success: true, output: '17:30' });
  });

  test('rejects DST gaps and folds instead of silently picking a different instant', () => {
    const gap = handleCalculate({ expression: '2026-03-29 02:30 Europe/Belgrade to UTC' });
    expect(gap.success).toBe(false);
    expect(gap.error).toContain('does not exist');

    const fold = handleCalculate({ expression: '2026-10-25 02:30 Europe/Belgrade to UTC' });
    expect(fold.success).toBe(false);
    expect(fold.error).toContain('ambiguous');
  });

  test('validates fixed-offset calendar dates and the UTC+14 boundary', () => {
    expect(handleCalculate({ expression: '2026-02-31 12:30 UTC+2 to UTC' }).success).toBe(false);
    expect(handleCalculate({ expression: '2026-09-23 12:30 UTC+14:30 to UTC' }).success).toBe(false);
    expect(handleCalculate({ expression: '12:30:45 UTC+2 to UTC' })).toMatchObject({
      success: true,
      output: '10:30:45',
    });
  });

  test('production-invalid datetime forms return a self-correcting ISO example', () => {
    const invalid = ['2026-09-16 17:40 - 2 hours', '2026-09-17 18:30 - 2 hours', '2026-09-17 10:49 + 2 hours to UTC'];
    for (const expression of invalid) {
      const r = handleCalculate({ expression });
      expect(r.success).toBe(false);
      expect(r.error).toContain('explicit Z/offset');
      expect(r.error).toContain('Local-to-UTC conversion accepts');
    }
  });

  test('canonical local datetime arithmetic uses the explicit offset and returns UTC', () => {
    const r = handleCalculate({ expression: '2026-09-17T10:49:00+02:00 + 2hours' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('2026-09-17T10:49:00.000Z');
  });

  test('adds days to ISO date', async () => {
    const r = handleCalculate({ expression: '2026-03-18 + 7days' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('2026-03-25');
  });

  test('returns error for unparseable expression', async () => {
    const r = handleCalculate({ expression: 'hello world' });
    expect(r.success).toBe(false);
    expect(r.error).toBeDefined();
  });

  test('adds weeks to ISO datetime', async () => {
    const r = handleCalculate({ expression: '2026-03-18T22:34:00Z + 2weeks' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('2026-04-01T22:34:00.000Z');
  });

  test('adds 1 month to ISO datetime (end-of-month clamp)', async () => {
    const r = handleCalculate({ expression: '2026-01-31T12:00:00Z + 1month' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('2026-02-28T12:00:00.000Z');
  });

  test('subtracts 1 month from ISO datetime', async () => {
    const r = handleCalculate({ expression: '2026-03-31T12:00:00Z - 1month' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('2026-02-28T12:00:00.000Z');
  });

  test('adds 1 year to ISO datetime', async () => {
    const r = handleCalculate({ expression: '2026-03-18T22:34:00Z + 1year' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('2027-03-18T22:34:00.000Z');
  });

  test('adds weeks to date-only', async () => {
    const r = handleCalculate({ expression: '2026-03-18 + 2weeks' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('2026-04-01');
  });

  test('adds months to date-only', async () => {
    const r = handleCalculate({ expression: '2026-03-18 + 1month' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('2026-04-18');
  });

  test('adds years to date-only', async () => {
    const r = handleCalculate({ expression: '2026-03-18 + 1year' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('2027-03-18');
  });

  test('datetime diff less than 60 min', async () => {
    const r = handleCalculate({ expression: '2026-03-21T17:31:07Z - 2026-03-21T17:00:07Z' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('31 min');
  });

  test('datetime diff exact hours', async () => {
    const r = handleCalculate({ expression: '2026-03-21T18:00:00Z - 2026-03-21T17:00:00Z' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('1h');
  });

  test('datetime diff hours and minutes', async () => {
    const r = handleCalculate({ expression: '2026-03-21T19:30:00Z - 2026-03-21T17:00:00Z' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('2h 30min');
  });

  test('datetime diff in days', async () => {
    const r = handleCalculate({ expression: '2026-03-25T12:00:00Z - 2026-03-21T12:00:00Z' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('4 days');
  });

  test('datetime diff 1 day (singular)', async () => {
    const r = handleCalculate({ expression: '2026-03-22T12:00:00Z - 2026-03-21T12:00:00Z' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('1 day');
  });

  test('datetime diff days and hours', async () => {
    const r = handleCalculate({ expression: '2026-03-22T18:00:00Z - 2026-03-21T12:00:00Z' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('1 day 6h');
  });

  test('date-only diff', async () => {
    const r = handleCalculate({ expression: '2026-04-10 - 2026-03-21' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('20 days');
  });
});
