// get_events range helpers: zone-aware day edges, DST boundary days, UTC-day-edge normalization and
// the validation order that decides whether a bound is an instant, a local day or invalid.
import { describe, expect, test } from 'bun:test';
import {
  expandDateOnly,
  isRealCalendarDate,
  localDaysForUtcDayEdges,
  parseRangeBound,
  resolveRangeInterval,
} from '../../../../src/services/ai/tool-handlers/events/range.ts';

describe('isRealCalendarDate', () => {
  test('rejects dates `new Date` would roll over into the next month', () => {
    expect(isRealCalendarDate('2026-02-28')).toBe(true);
    expect(isRealCalendarDate('2026-02-29')).toBe(false);
    expect(isRealCalendarDate('2026-02-30')).toBe(false);
    expect(isRealCalendarDate('2026-04-31')).toBe(false);
    expect(isRealCalendarDate('2026-13-01')).toBe(false);
  });

  test('accepts the leap day of a leap year', () => {
    expect(isRealCalendarDate('2028-02-29')).toBe(true);
  });
});

describe('expandDateOnly', () => {
  test('a UTC day is the plain 24 hours', () => {
    expect(expandDateOnly('2026-03-15', 'UTC')).toEqual({
      start: '2026-03-15T00:00:00.000Z',
      end: '2026-03-15T23:59:59.999Z',
    });
  });

  test('a positive-offset zone starts the day on the previous UTC date', () => {
    expect(expandDateOnly('2026-01-10', 'Asia/Tokyo')).toEqual({
      start: '2026-01-09T15:00:00.000Z',
      end: '2026-01-10T14:59:59.999Z',
    });
  });

  test('UTC+14 is read as that local day, not shifted by the host zone', () => {
    expect(expandDateOnly('2026-01-10', 'Pacific/Kiritimati')).toEqual({
      start: '2026-01-09T10:00:00.000Z',
      end: '2026-01-10T09:59:59.999Z',
    });
  });

  test('the spring-forward day is 23 hours long', () => {
    const { start, end } = expandDateOnly('2026-03-29', 'Europe/Berlin');
    expect(start).toBe('2026-03-28T23:00:00.000Z');
    expect(end).toBe('2026-03-29T21:59:59.999Z');
    expect(Date.parse(end) - Date.parse(start) + 1).toBe(23 * 3_600_000);
  });

  test('the fall-back day is 25 hours long', () => {
    const { start, end } = expandDateOnly('2026-10-25', 'Europe/Berlin');
    expect(start).toBe('2026-10-24T22:00:00.000Z');
    expect(end).toBe('2026-10-25T22:59:59.999Z');
    expect(Date.parse(end) - Date.parse(start) + 1).toBe(25 * 3_600_000);
  });

  test('a US zone springs forward on its own date, not the European one', () => {
    expect(expandDateOnly('2026-03-08', 'America/New_York')).toEqual({
      start: '2026-03-08T05:00:00.000Z',
      end: '2026-03-09T03:59:59.999Z',
    });
  });

  test('throws on an impossible date, which is why callers validate first', () => {
    expect(() => expandDateOnly('2026-02-30', 'UTC')).toThrow();
  });
});

describe('parseRangeBound', () => {
  test('a date-only bound is the matching edge of that local day', () => {
    expect(parseRangeBound('2026-03-29', 'Europe/Berlin', 'start')?.toISOString()).toBe('2026-03-28T23:00:00.000Z');
    expect(parseRangeBound('2026-03-29', 'Europe/Berlin', 'end')?.toISOString()).toBe('2026-03-29T21:59:59.999Z');
  });

  test('a datetime without an offset is UTC whatever the user zone is', () => {
    expect(parseRangeBound('2026-03-29T10:00:00', 'Europe/Berlin', 'start')?.toISOString()).toBe(
      '2026-03-29T10:00:00.000Z',
    );
    expect(parseRangeBound('2026-03-29 10:00', 'Asia/Tokyo', 'end')?.toISOString()).toBe('2026-03-29T10:00:00.000Z');
  });

  test('an explicit offset is honoured in both the colon and the compact spelling', () => {
    expect(parseRangeBound('2026-03-15T10:00:00+03:00', 'UTC', 'start')?.toISOString()).toBe(
      '2026-03-15T07:00:00.000Z',
    );
    expect(parseRangeBound('2026-03-15T10:00:00+0300', 'UTC', 'start')?.toISOString()).toBe('2026-03-15T07:00:00.000Z');
    expect(parseRangeBound('2026-03-15T10:00:00Z', 'Asia/Tokyo', 'start')?.toISOString()).toBe(
      '2026-03-15T10:00:00.000Z',
    );
  });

  test('fractional seconds beyond milliseconds are truncated, not rejected', () => {
    expect(parseRangeBound('2026-03-15T10:00:00.123456789Z', 'UTC', 'start')?.toISOString()).toBe(
      '2026-03-15T10:00:00.123Z',
    );
  });

  test('the date part is validated before the datetime shape, for both bound forms', () => {
    expect(parseRangeBound('2026-02-30', 'UTC', 'start')).toBeNull();
    expect(parseRangeBound('2026-02-30T10:00:00Z', 'UTC', 'start')).toBeNull();
  });

  test('anything that is not an ISO date or timestamp is null', () => {
    expect(parseRangeBound('tomorrow', 'UTC', 'start')).toBeNull();
    expect(parseRangeBound('2026-03-15T25:00:00Z', 'UTC', 'start')).toBeNull();
    expect(parseRangeBound('2026-03-15T10', 'UTC', 'start')).toBeNull();
  });
});

describe('localDaysForUtcDayEdges', () => {
  const utcDay = { start_date: '2026-03-15T00:00:00Z', end_date: '2026-03-15T23:59:59Z' };

  test('a UTC day-edge pair outside UTC is read as that local day', () => {
    expect(localDaysForUtcDayEdges(utcDay, 'Europe/Berlin')).toEqual({
      start_date: '2026-03-15',
      end_date: '2026-03-15',
    });
  });

  test('the millisecond spellings of the edges are the same pair', () => {
    const withMs = { start_date: '2026-03-15T00:00:00.000Z', end_date: '2026-03-15T23:59:59.999Z' };
    expect(localDaysForUtcDayEdges(withMs, 'Asia/Tokyo')).toEqual({ start_date: '2026-03-15', end_date: '2026-03-15' });
  });

  test('a zone that is at UTC on those days keeps the exact input', () => {
    expect(localDaysForUtcDayEdges(utcDay, 'UTC')).toBe(utcDay);
    expect(
      localDaysForUtcDayEdges(
        { start_date: '2026-01-15T00:00:00Z', end_date: '2026-01-15T23:59:59Z' },
        'Europe/London',
      ),
    ).toEqual({
      start_date: '2026-01-15T00:00:00Z',
      end_date: '2026-01-15T23:59:59Z',
    });
  });

  test('the same zone is converted on a summer day, when it is no longer at UTC', () => {
    const summer = { start_date: '2026-07-15T00:00:00Z', end_date: '2026-07-15T23:59:59Z' };
    expect(localDaysForUtcDayEdges(summer, 'Europe/London')).toEqual({
      start_date: '2026-07-15',
      end_date: '2026-07-15',
    });
  });

  test('half a pair, another instant, an offset or an impossible day stays verbatim', () => {
    const half = { start_date: '2026-03-15T00:00:00Z', end_date: '2026-03-15' };
    const offset = { start_date: '2026-03-15T00:00:00+00:00', end_date: '2026-03-15T23:59:59+00:00' };
    const midday = { start_date: '2026-03-15T12:00:00Z', end_date: '2026-03-15T23:59:59Z' };
    const impossible = { start_date: '2026-02-30T00:00:00Z', end_date: '2026-02-30T23:59:59Z' };
    for (const input of [half, offset, midday, impossible]) {
      expect(localDaysForUtcDayEdges(input, 'Europe/Berlin')).toBe(input);
    }
  });

  test('a multi-day pair becomes the first and last local day', () => {
    expect(
      localDaysForUtcDayEdges(
        { start_date: '2026-03-28T00:00:00Z', end_date: '2026-03-30T23:59:59Z' },
        'Europe/Berlin',
      ),
    ).toEqual({ start_date: '2026-03-28', end_date: '2026-03-30' });
  });
});

describe('resolveRangeInterval', () => {
  test('UTC day edges in Berlin cover the whole local day, including its early hours', () => {
    const interval = resolveRangeInterval(
      { start_date: '2026-03-15T00:00:00Z', end_date: '2026-03-15T23:59:59Z' },
      'Europe/Berlin',
    );
    expect(interval?.start.toISOString()).toBe('2026-03-14T23:00:00.000Z');
    expect(interval?.end.toISOString()).toBe('2026-03-15T22:59:59.999Z');
  });

  test('two dates spanning a DST change keep the real local edges', () => {
    const interval = resolveRangeInterval({ start_date: '2026-03-28', end_date: '2026-03-30' }, 'Europe/Berlin');
    expect(interval?.start.toISOString()).toBe('2026-03-27T23:00:00.000Z');
    expect(interval?.end.toISOString()).toBe('2026-03-30T21:59:59.999Z');
  });

  test('a single local day is a valid interval', () => {
    const interval = resolveRangeInterval({ start_date: '2026-03-15', end_date: '2026-03-15' }, 'Asia/Tokyo');
    expect(interval?.start.toISOString()).toBe('2026-03-14T15:00:00.000Z');
    expect(interval?.end.toISOString()).toBe('2026-03-15T14:59:59.999Z');
  });

  test('a start at or after the end is invalid', () => {
    expect(resolveRangeInterval({ start_date: '2026-03-16', end_date: '2026-03-15' }, 'UTC')).toBeNull();
    expect(
      resolveRangeInterval({ start_date: '2026-03-15T10:00:00Z', end_date: '2026-03-15T10:00:00Z' }, 'UTC'),
    ).toBeNull();
  });

  test('either bound being invalid makes the whole range invalid', () => {
    expect(resolveRangeInterval({ start_date: '2026-02-30', end_date: '2026-03-15' }, 'UTC')).toBeNull();
    expect(resolveRangeInterval({ start_date: '2026-03-01', end_date: 'next week' }, 'UTC')).toBeNull();
  });
});
