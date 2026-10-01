// test/services/calendar/wall-clock.test.ts
//
// Pure calendar-day/instant arithmetic used by the shared wall-time parser (GH-650).
// These tests pin the DST gap/fold classification independently of the higher-level
// parser so a future change to the parser's vocabulary can't accidentally hide a
// regression in the instant-resolution math.

import { describe, expect, setSystemTime, test } from 'bun:test';
import { addOneDay, isoDay, resolveWallInstant, validCalendarDay } from '../../../src/services/calendar/wall-clock.ts';

describe('validCalendarDay', () => {
  test('accepts real calendar dates including leap day', () => {
    expect(validCalendarDay({ y: 2026, m: 9, d: 29 })).toBe(true);
    expect(validCalendarDay({ y: 2028, m: 2, d: 29 })).toBe(true); // 2028 is a leap year
  });

  test('rejects dates that do not exist rather than letting them roll over', () => {
    expect(validCalendarDay({ y: 2026, m: 2, d: 30 })).toBe(false); // Feb has 28 days in 2026
    expect(validCalendarDay({ y: 2027, m: 2, d: 29 })).toBe(false); // 2027 is not a leap year
    expect(validCalendarDay({ y: 2026, m: 13, d: 1 })).toBe(false);
    expect(validCalendarDay({ y: 2026, m: 4, d: 31 })).toBe(false); // April has 30 days
    expect(validCalendarDay({ y: 2026, m: 1, d: 0 })).toBe(false);
  });
});

describe('addOneDay / isoDay', () => {
  test('advances across month and year boundaries on the proleptic calendar, not local wall clock', () => {
    expect(isoDay(addOneDay({ y: 2026, m: 9, d: 29 }))).toBe('2026-09-30');
    expect(isoDay(addOneDay({ y: 2026, m: 9, d: 30 }))).toBe('2026-10-01');
    expect(isoDay(addOneDay({ y: 2026, m: 12, d: 31 }))).toBe('2027-01-01');
    expect(isoDay(addOneDay({ y: 2028, m: 2, d: 28 }))).toBe('2028-02-29'); // leap year
  });
});

describe('resolveWallInstant — DST gap (spring forward)', () => {
  // Europe/Belgrade moves clocks from 02:00 to 03:00 on the last Sunday of March;
  // 2026-03-29 02:00-02:59 local time never happens that day.
  test('a wall time inside the gap has zero instants', () => {
    const result = resolveWallInstant({ y: 2026, m: 3, d: 29 }, 2, 0, 'Europe/Belgrade');
    expect(result.kind).toBe('gap');
  });

  test('a wall time outside the gap resolves uniquely', () => {
    const result = resolveWallInstant({ y: 2026, m: 3, d: 29 }, 4, 0, 'Europe/Belgrade');
    expect(result.kind).toBe('unique');
  });
});

describe('resolveWallInstant — DST fold (fall back)', () => {
  // Europe/Belgrade moves clocks from 03:00 back to 02:00 on the last Sunday of October;
  // 2026-10-25 02:00-02:59 local time happens twice (once at UTC+2, once at UTC+1).
  test('a wall time inside the fold has two distinct instants', () => {
    const result = resolveWallInstant({ y: 2026, m: 10, d: 25 }, 2, 0, 'Europe/Belgrade');
    expect(result.kind).toBe('fold');
    if (result.kind !== 'fold') throw new Error('unreachable');
    const [first, second] = result.instants;
    expect(first.ms).toBeLessThan(second.ms);
    expect(first.offsetMinutes).not.toBe(second.offsetMinutes);
    expect(second.ms - first.ms).toBe(60 * 60 * 1000); // exactly one hour apart
  });

  test('a wall time outside the fold resolves uniquely', () => {
    const result = resolveWallInstant({ y: 2026, m: 10, d: 25 }, 4, 0, 'Europe/Belgrade');
    expect(result.kind).toBe('unique');
  });
});

describe('resolveWallInstant — ordinary days', () => {
  test('resolves the expected UTC instant outside any transition', () => {
    // 2026-09-29 12:00 local in Belgrade (UTC+2 in September) is 10:00 UTC.
    const result = resolveWallInstant({ y: 2026, m: 9, d: 29 }, 12, 0, 'Europe/Belgrade');
    expect(result.kind).toBe('unique');
    if (result.kind !== 'unique') throw new Error('unreachable');
    expect(new Date(result.ms).toISOString()).toBe('2026-09-29T10:00:00.000Z');
  });

  test('never reads the system clock — same inputs give the same output regardless of the current instant', () => {
    setSystemTime(new Date('2026-09-28T10:00:00Z'));
    const before = resolveWallInstant({ y: 2026, m: 9, d: 29 }, 12, 0, 'Europe/Belgrade');
    setSystemTime(new Date('2099-01-01T00:00:00Z'));
    try {
      const after = resolveWallInstant({ y: 2026, m: 9, d: 29 }, 12, 0, 'Europe/Belgrade');
      expect(after).toEqual(before);
    } finally {
      setSystemTime();
    }
  });
});
