import { describe, expect, test } from 'bun:test';
import { resolveWallClock, toLocalDateKey, wallClockFromFakeUtc } from '../../../src/services/event/wall-clock.ts';

describe('resolveWallClock', () => {
  describe('unambiguous local times', () => {
    test('winter (CET, UTC+1) resolves to the correct UTC instant', () => {
      const result = resolveWallClock({ y: 2026, mo: 1, d: 5, h: 12, mi: 30, s: 0 }, 'Europe/Belgrade');
      expect(result.kind).toBe('unique');
      if (result.kind === 'unique') expect(result.instant.toISOString()).toBe('2026-01-05T11:30:00.000Z');
    });

    test('summer (CEST, UTC+2) resolves to the correct UTC instant', () => {
      const result = resolveWallClock({ y: 2026, mo: 6, d: 5, h: 12, mi: 30, s: 0 }, 'Europe/Belgrade');
      expect(result.kind).toBe('unique');
      if (result.kind === 'unique') expect(result.instant.toISOString()).toBe('2026-06-05T10:30:00.000Z');
    });

    test('UTC timezone is a no-op offset', () => {
      const result = resolveWallClock({ y: 2026, mo: 3, d: 15, h: 9, mi: 0, s: 0 }, 'UTC');
      expect(result.kind).toBe('unique');
      if (result.kind === 'unique') expect(result.instant.toISOString()).toBe('2026-03-15T09:00:00.000Z');
    });

    test('a day with no DST transition on either side stays unique', () => {
      const result = resolveWallClock({ y: 2026, mo: 7, d: 15, h: 3, mi: 0, s: 0 }, 'Europe/Belgrade');
      expect(result.kind).toBe('unique');
    });
  });

  describe('spring-forward gap (Europe/Belgrade, clocks 02:00 → 03:00 on 2026-03-29)', () => {
    test('02:30 does not exist and reports a gap, not a silent shift', () => {
      const result = resolveWallClock({ y: 2026, mo: 3, d: 29, h: 2, mi: 30, s: 0 }, 'Europe/Belgrade');
      expect(result.kind).toBe('gap');
    });

    test('02:00 exactly (the first skipped instant) also reports a gap', () => {
      const result = resolveWallClock({ y: 2026, mo: 3, d: 29, h: 2, mi: 0, s: 0 }, 'Europe/Belgrade');
      expect(result.kind).toBe('gap');
    });

    test('01:59 (just before the gap) is unique', () => {
      const result = resolveWallClock({ y: 2026, mo: 3, d: 29, h: 1, mi: 59, s: 0 }, 'Europe/Belgrade');
      expect(result.kind).toBe('unique');
    });

    test('03:00 (just after the gap) is unique', () => {
      const result = resolveWallClock({ y: 2026, mo: 3, d: 29, h: 3, mi: 0, s: 0 }, 'Europe/Belgrade');
      expect(result.kind).toBe('unique');
    });

    test('US spring-forward gap (America/New_York, 2026-03-08 02:30)', () => {
      const result = resolveWallClock({ y: 2026, mo: 3, d: 8, h: 2, mi: 30, s: 0 }, 'America/New_York');
      expect(result.kind).toBe('gap');
    });
  });

  describe('fall-back repeat (Europe/Belgrade, clocks 03:00 → 02:00 on 2026-10-25)', () => {
    test('02:30 happens twice; both candidates are returned with the correct offsets', () => {
      const result = resolveWallClock({ y: 2026, mo: 10, d: 25, h: 2, mi: 30, s: 0 }, 'Europe/Belgrade');
      expect(result.kind).toBe('ambiguous');
      if (result.kind !== 'ambiguous') throw new Error('unreachable');
      expect(result.first.toISOString()).toBe('2026-10-25T00:30:00.000Z'); // CEST, UTC+2
      expect(result.second.toISOString()).toBe('2026-10-25T01:30:00.000Z'); // CET, UTC+1
      expect(result.first.getTime()).toBeLessThan(result.second.getTime());
    });

    test('01:59 (just before the repeated hour) is unique', () => {
      const result = resolveWallClock({ y: 2026, mo: 10, d: 25, h: 1, mi: 59, s: 0 }, 'Europe/Belgrade');
      expect(result.kind).toBe('unique');
    });

    test('03:00 (just after the repeated hour) is unique', () => {
      const result = resolveWallClock({ y: 2026, mo: 10, d: 25, h: 3, mi: 0, s: 0 }, 'Europe/Belgrade');
      expect(result.kind).toBe('unique');
    });

    test('US fall-back repeat (America/New_York, 2026-11-01 01:30)', () => {
      const result = resolveWallClock({ y: 2026, mo: 11, d: 1, h: 1, mi: 30, s: 0 }, 'America/New_York');
      expect(result.kind).toBe('ambiguous');
      if (result.kind !== 'ambiguous') throw new Error('unreachable');
      expect(result.first.getTime()).toBeLessThan(result.second.getTime());
    });
  });

  describe('Southern Hemisphere DST (Australia/Sydney, opposite-season transitions)', () => {
    // Sydney: spring-forward first Sunday of October, fall-back first Sunday of April.
    test('spring-forward gap on 2026-10-04 02:30', () => {
      const result = resolveWallClock({ y: 2026, mo: 10, d: 4, h: 2, mi: 30, s: 0 }, 'Australia/Sydney');
      expect(result.kind).toBe('gap');
    });

    test('fall-back repeat on 2026-04-05 02:30', () => {
      const result = resolveWallClock({ y: 2026, mo: 4, d: 5, h: 2, mi: 30, s: 0 }, 'Australia/Sydney');
      expect(result.kind).toBe('ambiguous');
    });
  });
});

describe('wallClockFromFakeUtc', () => {
  test('extracts UTC getters as the intended local wall-clock reading', () => {
    const wall = wallClockFromFakeUtc(new Date('2026-03-15T09:30:45.000Z'));
    expect(wall).toEqual({ y: 2026, mo: 3, d: 15, h: 9, mi: 30, s: 45 });
  });
});

describe('toLocalDateKey', () => {
  test('returns the local calendar date for a UTC instant', () => {
    // 23:30 UTC on Jan 5 is 00:30 Jan 6 in Belgrade (UTC+1)
    expect(toLocalDateKey(new Date('2026-01-05T23:30:00Z'), 'Europe/Belgrade')).toBe('2026-01-06');
    expect(toLocalDateKey(new Date('2026-01-05T23:30:00Z'), 'UTC')).toBe('2026-01-05');
  });

  test('pads single-digit month/day', () => {
    expect(toLocalDateKey(new Date('2026-01-05T10:00:00Z'), 'UTC')).toBe('2026-01-05');
  });
});
