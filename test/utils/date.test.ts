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

  test('parses "завтра в 10:00" (with preposition)', () => {
    const ref = new Date('2026-03-11T12:00:00Z');
    const result = parseSimpleDate('Завтра в 10:00', 'UTC', ref);
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toContain('2026-03-12T10:00');
  });

  test('parses "today at 14:00" (with preposition)', () => {
    const ref = new Date('2026-03-11T12:00:00Z');
    const result = parseSimpleDate('today at 14:00', 'UTC', ref);
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toContain('2026-03-11T14:00');
  });

  test('parses "сегодня в 18:30" (with preposition)', () => {
    const ref = new Date('2026-03-11T12:00:00Z');
    const result = parseSimpleDate('сегодня в 18:30', 'UTC', ref);
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toContain('2026-03-11T18:30');
  });

  test('parses "tomorrow at 9:00" (with preposition)', () => {
    const ref = new Date('2026-03-11T12:00:00Z');
    const result = parseSimpleDate('tomorrow at 9:00', 'UTC', ref);
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toContain('2026-03-12T09:00');
  });

  test('parses "15 мар 19:30" (day-first month format)', () => {
    const ref = new Date('2026-03-11T12:00:00Z');
    const result = parseSimpleDate('15 мар 19:30', 'UTC', ref);
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toContain('2026-03-15T19:30');
  });

  test('parses "пн в 10:00" (weekday with preposition)', () => {
    const ref = new Date('2026-03-11T12:00:00Z'); // Wednesday
    const result = parseSimpleDate('пн в 10:00', 'UTC', ref);
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toContain('2026-03-16T10:00');
  });

  // Hour-only (no minutes)
  test('parses "сегодня в 12" (hour without minutes)', () => {
    const ref = new Date('2026-03-11T08:00:00Z');
    const result = parseSimpleDate('сегодня в 12', 'UTC', ref);
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toContain('2026-03-11T12:00');
  });

  test('parses "today 9" (hour without minutes)', () => {
    const ref = new Date('2026-03-11T08:00:00Z');
    const result = parseSimpleDate('today 9', 'UTC', ref);
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toContain('2026-03-11T09:00');
  });

  test('parses "завтра 14" (tomorrow hour-only)', () => {
    const ref = new Date('2026-03-11T08:00:00Z');
    const result = parseSimpleDate('завтра 14', 'UTC', ref);
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toContain('2026-03-12T14:00');
  });

  test('parses "пн 10" (weekday hour-only)', () => {
    const ref = new Date('2026-03-11T08:00:00Z'); // Wednesday
    const result = parseSimpleDate('пн 10', 'UTC', ref);
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toContain('2026-03-16T10:00');
  });

  // Bare time (implies today)
  test('parses "15:30" (bare time, implies today)', () => {
    const ref = new Date('2026-03-11T08:00:00Z');
    const result = parseSimpleDate('15:30', 'UTC', ref);
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toContain('2026-03-11T15:30');
  });

  test('parses "в 19:00" (bare time with preposition)', () => {
    const ref = new Date('2026-03-11T08:00:00Z');
    const result = parseSimpleDate('в 19:00', 'UTC', ref);
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toContain('2026-03-11T19:00');
  });

  test('parses "at 8" (bare hour with preposition)', () => {
    const ref = new Date('2026-03-11T05:00:00Z');
    const result = parseSimpleDate('at 8', 'UTC', ref);
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toContain('2026-03-11T08:00');
  });

  // Date without time (defaults to 00:00)
  test('parses "15 мар" (date without time)', () => {
    const ref = new Date('2026-03-11T08:00:00Z');
    const result = parseSimpleDate('15 мар', 'UTC', ref);
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toContain('2026-03-15T00:00');
  });

  // Full Russian weekdays
  test('parses "понедельник 10:00"', () => {
    const ref = new Date('2026-03-11T12:00:00Z'); // Wednesday
    const result = parseSimpleDate('понедельник 10:00', 'UTC', ref);
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toContain('2026-03-16T10:00');
  });

  test('parses "пятница 18:00"', () => {
    const ref = new Date('2026-03-11T12:00:00Z'); // Wednesday
    const result = parseSimpleDate('пятница 18:00', 'UTC', ref);
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toContain('2026-03-13T18:00');
  });

  test('parses "среда 9:00" (next occurrence)', () => {
    const ref = new Date('2026-03-11T12:00:00Z'); // Wednesday → next Wednesday
    const result = parseSimpleDate('среда 9:00', 'UTC', ref);
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toContain('2026-03-18T09:00');
  });

  // "Day after tomorrow"
  test('parses "послезавтра 15:00"', () => {
    const ref = new Date('2026-03-11T12:00:00Z');
    const result = parseSimpleDate('послезавтра 15:00', 'UTC', ref);
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toContain('2026-03-13T15:00');
  });

  test('parses "day after tomorrow 10:00"', () => {
    const ref = new Date('2026-03-11T12:00:00Z');
    const result = parseSimpleDate('day after tomorrow 10:00', 'UTC', ref);
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toContain('2026-03-13T10:00');
  });

  test('parses "послезавтра" without time (defaults to 00:00)', () => {
    const ref = new Date('2026-03-11T12:00:00Z');
    const result = parseSimpleDate('послезавтра', 'UTC', ref);
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toContain('2026-03-13T00:00');
  });

  test('parses "day after tomorrow" without time (defaults to 00:00)', () => {
    const ref = new Date('2026-03-11T12:00:00Z');
    const result = parseSimpleDate('day after tomorrow', 'UTC', ref);
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toContain('2026-03-13T00:00');
  });

  // Full Russian months
  test('parses "15 января 19:30"', () => {
    const ref = new Date('2026-03-11T12:00:00Z');
    const result = parseSimpleDate('15 января 19:30', 'UTC', ref);
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toContain('2026-01-15T19:30');
  });

  test('parses "1 февраля 10:00"', () => {
    const ref = new Date('2026-03-11T12:00:00Z');
    const result = parseSimpleDate('1 февраля 10:00', 'UTC', ref);
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toContain('2026-02-01T10:00');
  });

  test('parses "25 декабря"', () => {
    const ref = new Date('2026-03-11T12:00:00Z');
    const result = parseSimpleDate('25 декабря', 'UTC', ref);
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toContain('2026-12-25T00:00');
  });

  test('parses "март 20 14:00" (nominative month name)', () => {
    const ref = new Date('2026-03-11T12:00:00Z');
    const result = parseSimpleDate('март 20 14:00', 'UTC', ref);
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toContain('2026-03-20T14:00');
  });

  // "tomorrow" / "завтра" without time
  test('parses "tomorrow" without time (defaults to 00:00)', () => {
    const ref = new Date('2026-03-11T12:00:00Z');
    const result = parseSimpleDate('tomorrow', 'UTC', ref);
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toContain('2026-03-12T00:00');
  });

  test('parses "завтра" without time (defaults to 00:00)', () => {
    const ref = new Date('2026-03-11T12:00:00Z');
    const result = parseSimpleDate('завтра', 'UTC', ref);
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toContain('2026-03-12T00:00');
  });
});

describe('parseDuration', () => {
  // Latin suffixes
  test('parses "1h"', () => expect(parseDuration('1h')).toBe(60));
  test('parses "30m"', () => expect(parseDuration('30m')).toBe(30));
  test('parses "2h30m"', () => expect(parseDuration('2h30m')).toBe(150));
  test('parses "1h 30m"', () => expect(parseDuration('1h 30m')).toBe(90));
  test('parses "2h 15m"', () => expect(parseDuration('2h 15m')).toBe(135));

  // Russian suffixes
  test('parses "1ч"', () => expect(parseDuration('1ч')).toBe(60));
  test('parses "30м"', () => expect(parseDuration('30м')).toBe(30));
  test('parses "1ч 30м"', () => expect(parseDuration('1ч 30м')).toBe(90));
  test('parses "2ч30м"', () => expect(parseDuration('2ч30м')).toBe(150));

  // Colon format — "H:MM"
  test('parses "1:30" as 90 minutes', () => expect(parseDuration('1:30')).toBe(90));
  test('parses "0:45" as 45 minutes', () => expect(parseDuration('0:45')).toBe(45));
  test('parses "2:00" as 120 minutes', () => expect(parseDuration('2:00')).toBe(120));
  test('parses "0:15" as 15 minutes', () => expect(parseDuration('0:15')).toBe(15));
  test('parses "10:30" as 630 minutes', () => expect(parseDuration('10:30')).toBe(630));

  // Plain number — treat as minutes
  test('parses "30" as 30 minutes', () => expect(parseDuration('30')).toBe(30));
  test('parses "90" as 90 minutes', () => expect(parseDuration('90')).toBe(90));
  test('parses "60" as 60 minutes', () => expect(parseDuration('60')).toBe(60));

  // Full-word English suffixes
  test('parses "1 hour"', () => expect(parseDuration('1 hour')).toBe(60));
  test('parses "2 hours"', () => expect(parseDuration('2 hours')).toBe(120));
  test('parses "1 hr"', () => expect(parseDuration('1 hr')).toBe(60));
  test('parses "30 minutes"', () => expect(parseDuration('30 minutes')).toBe(30));
  test('parses "45 minute"', () => expect(parseDuration('45 minute')).toBe(45));
  test('parses "15 min"', () => expect(parseDuration('15 min')).toBe(15));
  test('parses "2 hours 15 min"', () => expect(parseDuration('2 hours 15 min')).toBe(135));
  test('parses "1hr 30min"', () => expect(parseDuration('1hr 30min')).toBe(90));

  // Full-word Russian suffixes
  test('parses "1 час"', () => expect(parseDuration('1 час')).toBe(60));
  test('parses "2 часа"', () => expect(parseDuration('2 часа')).toBe(120));
  test('parses "5 часов"', () => expect(parseDuration('5 часов')).toBe(300));
  test('parses "30 минут"', () => expect(parseDuration('30 минут')).toBe(30));
  test('parses "45 минуты"', () => expect(parseDuration('45 минуты')).toBe(45));
  test('parses "15 мин"', () => expect(parseDuration('15 мин')).toBe(15));
  test('parses "1 минута"', () => expect(parseDuration('1 минута')).toBe(1));
  test('parses "1 час 30 минут"', () => expect(parseDuration('1 час 30 минут')).toBe(90));
  test('parses "2 часа 15 мин"', () => expect(parseDuration('2 часа 15 мин')).toBe(135));
  test('parses "12 часов"', () => expect(parseDuration('12 часов')).toBe(720));

  // Special forms
  test('parses "полчаса"', () => expect(parseDuration('полчаса')).toBe(30));
  test('parses "полтора часа"', () => expect(parseDuration('полтора часа')).toBe(90));
  test('parses "half an hour"', () => expect(parseDuration('half an hour')).toBe(30));
  test('parses "half hour"', () => expect(parseDuration('half hour')).toBe(30));

  // Invalid
  test('returns null for "abc"', () => expect(parseDuration('abc')).toBeNull());
  test('returns null for empty', () => expect(parseDuration('')).toBeNull());
  test('returns null for "hello"', () => expect(parseDuration('hello')).toBeNull());
  test('returns null for "0"', () => expect(parseDuration('0')).toBeNull());
  test('returns null for "0:00"', () => expect(parseDuration('0:00')).toBeNull());
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
