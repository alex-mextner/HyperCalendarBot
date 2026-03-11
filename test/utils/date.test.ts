import { describe, expect, test } from 'bun:test';
import {
  formatDateHeader,
  formatTime,
  getDayRangeUtc,
  getWeekRangeUtc,
  parseDuration,
  parseSimpleDate,
  toUserTime,
} from '../../src/utils/date.ts';

describe('toUserTime', () => {
  test('formats UTC to user timezone', () => {
    const result = toUserTime('2026-03-11T12:00:00Z', 'Europe/Moscow');
    expect(result).toBe('15:00');
  });
  test('handles UTC timezone', () => {
    const result = toUserTime('2026-03-11T12:00:00Z', 'UTC');
    expect(result).toBe('12:00');
  });
});

describe('getDayRangeUtc', () => {
  test('returns start/end of day in UTC for given timezone', () => {
    const { start, end } = getDayRangeUtc(new Date('2026-03-11T15:00:00Z'), 'Europe/Moscow');
    expect(start).toBe('2026-03-10T21:00:00.000Z');
    expect(end).toBe('2026-03-11T20:59:59.999Z');
  });
  test('handles UTC timezone', () => {
    const { start, end } = getDayRangeUtc(new Date('2026-03-11T15:00:00Z'), 'UTC');
    expect(start).toBe('2026-03-11T00:00:00.000Z');
    expect(end).toBe('2026-03-11T23:59:59.999Z');
  });
});

describe('getWeekRangeUtc', () => {
  test('returns Monday-Sunday range in UTC', () => {
    const { start, end } = getWeekRangeUtc(new Date('2026-03-11T12:00:00Z'), 'UTC');
    expect(start).toContain('2026-03-09');
    expect(end).toContain('2026-03-15');
  });
});

describe('parseSimpleDate', () => {
  test('parses "tomorrow HH:MM"', () => {
    const ref = new Date('2026-03-11T12:00:00Z');
    const result = parseSimpleDate('tomorrow 15:00', 'UTC', ref);
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toContain('2026-03-12T15:00');
  });
  test('parses "today HH:MM"', () => {
    const ref = new Date('2026-03-11T12:00:00Z');
    const result = parseSimpleDate('today 18:00', 'UTC', ref);
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toContain('2026-03-11T18:00');
  });
  test('returns null for unparseable input', () => {
    const result = parseSimpleDate('gibberish', 'UTC');
    expect(result).toBeNull();
  });
});

describe('parseDuration', () => {
  test('parses "1h"', () => expect(parseDuration('1h')).toBe(60));
  test('parses "30m"', () => expect(parseDuration('30m')).toBe(30));
  test('parses "2h30m"', () => expect(parseDuration('2h30m')).toBe(150));
  test('returns null for invalid', () => expect(parseDuration('abc')).toBeNull());
});

describe('formatTime', () => {
  test('formats ISO to HH:MM in timezone', () => {
    expect(formatTime('2026-03-11T12:00:00Z', 'UTC')).toBe('12:00');
  });
});

describe('formatDateHeader', () => {
  test('formats date with weekday', () => {
    const result = formatDateHeader('2026-03-11T12:00:00Z', 'UTC', 'en');
    expect(result).toContain('Wednesday');
    expect(result).toContain('March');
    expect(result).toContain('11');
  });
});
