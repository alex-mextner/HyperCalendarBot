import { describe, expect, test } from 'bun:test';
import {
  formatDateHeader,
  formatTime,
  formatTimeWithTimezones,
  getDayRangeUtc,
  getWeekRangeUtc,
  localCalendarWeekDays,
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

  test('rejects impossible bare times instead of rolling them into the next day', () => {
    const ref = new Date('2026-03-11T05:00:00Z');
    expect(parseSimpleDate('25', 'UTC', ref)).toBeNull();
    expect(parseSimpleDate('23:99', 'UTC', ref)).toBeNull();
  });

  test('rejects impossible month dates instead of rolling them into another month', () => {
    const ref = new Date('2026-03-11T05:00:00Z');
    expect(parseSimpleDate('32 мар', 'UTC', ref)).toBeNull();
    expect(parseSimpleDate('31 апр', 'UTC', ref)).toBeNull();
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

  // Normalisation and special-form precedence
  test('trims and lowercases before matching', () => {
    expect(parseDuration('  1H  ')).toBe(60);
    expect(parseDuration('ПОЛЧАСА')).toBe(30);
    expect(parseDuration('  Half Hour ')).toBe(30);
    expect(parseDuration('Полтора Часа')).toBe(90);
  });

  // Suffix format edge cases
  test('parses a zero-valued unit next to a non-zero one', () => {
    expect(parseDuration('0h 30m')).toBe(30);
    expect(parseDuration('1 hour 0 min')).toBe(60);
    expect(parseDuration('2 часа 0 мин')).toBe(120);
  });
  test('returns null when every suffix part is zero', () => {
    expect(parseDuration('0h')).toBeNull();
    expect(parseDuration('0 min')).toBeNull();
    expect(parseDuration('00:00')).toBeNull();
  });
  test('parses Russian "минуту" and single-letter units', () => {
    expect(parseDuration('45 минуту')).toBe(45);
    expect(parseDuration('5 m')).toBe(5);
    expect(parseDuration('5 м')).toBe(5);
  });
  test('rejects malformed input', () => {
    expect(parseDuration('1.5h')).toBeNull();
    expect(parseDuration('90 mins')).toBeNull();
    expect(parseDuration('1h30')).toBeNull();
    expect(parseDuration('h')).toBeNull();
    expect(parseDuration('1:5')).toBeNull();
    expect(parseDuration('1:30:00')).toBeNull();
    expect(parseDuration('-30')).toBeNull();
  });
  test('colon format does not cap minutes at 59', () => {
    expect(parseDuration('1:99')).toBe(159);
  });
});

describe('parseSimpleDate — characterization', () => {
  const ref = new Date('2026-03-11T12:00:00Z'); // Wednesday
  const iso = (input: string, tz = 'UTC', at: Date = ref) => parseSimpleDate(input, tz, at)?.toISOString() ?? null;

  test('normalises whitespace and case', () => {
    expect(iso('  TOMORROW 10:00 ')).toBe('2026-03-12T10:00:00.000Z');
    expect(iso('Next Monday 10')).toBe('2026-03-16T10:00:00.000Z');
  });

  describe('bare time', () => {
    test('accepts hour-only, H:MM and the at/в preposition', () => {
      expect(iso('0')).toBe('2026-03-11T00:00:00.000Z');
      expect(iso('7:05')).toBe('2026-03-11T07:05:00.000Z');
      expect(iso('at 23:59')).toBe('2026-03-11T23:59:00.000Z');
    });
    test('rejects out-of-range hours and minutes', () => {
      expect(iso('24')).toBeNull();
      expect(iso('at 24:00')).toBeNull();
      expect(iso('12:60')).toBeNull();
    });
    test('rejects malformed clocks', () => {
      expect(iso('7:5')).toBeNull();
      expect(iso('123')).toBeNull();
    });
    test('is anchored to the local day of the reference in the given timezone', () => {
      // 2026-03-11T22:30Z is already Thursday 07:30 in Tokyo
      const lateUtc = new Date('2026-03-11T22:30:00Z');
      expect(iso('15:30', 'Asia/Tokyo', lateUtc)).toBe('2026-03-12T06:30:00.000Z');
      expect(iso('15:30', 'UTC', lateUtc)).toBe('2026-03-11T15:30:00.000Z');
    });
  });

  describe('today', () => {
    test('accepts both languages with and without preposition', () => {
      expect(iso('today 9')).toBe('2026-03-11T09:00:00.000Z');
      expect(iso('сегодня 18:05')).toBe('2026-03-11T18:05:00.000Z');
      expect(iso('today at 7:30')).toBe('2026-03-11T07:30:00.000Z');
    });
    test('requires a time', () => {
      expect(iso('today')).toBeNull();
      expect(iso('сегодня')).toBeNull();
    });
    test('rejects invalid clocks', () => {
      expect(iso('today 25')).toBeNull();
      expect(iso('сегодня 10:75')).toBeNull();
    });
    test('uses the local day in the given timezone', () => {
      const lateUtc = new Date('2026-03-11T22:30:00Z');
      expect(iso('today 8', 'Asia/Tokyo', lateUtc)).toBe('2026-03-11T23:00:00.000Z');
    });
  });

  describe('tomorrow', () => {
    test('without a time means local midnight', () => {
      expect(iso('tomorrow')).toBe('2026-03-12T00:00:00.000Z');
      expect(iso('завтра')).toBe('2026-03-12T00:00:00.000Z');
    });
    test('rejects invalid clocks', () => {
      expect(iso('tomorrow 24:00')).toBeNull();
      expect(iso('завтра в 9:99')).toBeNull();
    });
    test('crosses a month boundary', () => {
      expect(iso('tomorrow 08:00', 'UTC', new Date('2026-03-31T12:00:00Z'))).toBe('2026-04-01T08:00:00.000Z');
      expect(iso('завтра', 'UTC', new Date('2026-02-28T12:00:00Z'))).toBe('2026-03-01T00:00:00.000Z');
    });
    test('uses the local day in the given timezone', () => {
      const lateUtc = new Date('2026-03-11T22:30:00Z');
      expect(iso('tomorrow', 'Asia/Tokyo', lateUtc)).toBe('2026-03-12T15:00:00.000Z');
    });
  });

  describe('day after tomorrow', () => {
    test('accepts both languages, with optional preposition and time', () => {
      expect(iso('day after tomorrow')).toBe('2026-03-13T00:00:00.000Z');
      expect(iso('послезавтра')).toBe('2026-03-13T00:00:00.000Z');
      expect(iso('day after tomorrow at 7')).toBe('2026-03-13T07:00:00.000Z');
      expect(iso('послезавтра в 9:30')).toBe('2026-03-13T09:30:00.000Z');
      expect(iso('послезавтра 21')).toBe('2026-03-13T21:00:00.000Z');
    });
    test('rejects invalid clocks', () => {
      expect(iso('послезавтра 25')).toBeNull();
      expect(iso('day after tomorrow 10:61')).toBeNull();
    });
    test('crosses a month and year boundary', () => {
      expect(iso('послезавтра 10', 'UTC', new Date('2026-12-31T12:00:00Z'))).toBe('2027-01-02T10:00:00.000Z');
      expect(iso('day after tomorrow', 'UTC', new Date('2026-02-27T12:00:00Z'))).toBe('2026-03-01T00:00:00.000Z');
    });
  });

  describe('weekday', () => {
    test('picks the next occurrence of English short and full names', () => {
      expect(iso('fri 9')).toBe('2026-03-13T09:00:00.000Z');
      expect(iso('friday at 9:15')).toBe('2026-03-13T09:15:00.000Z');
      expect(iso('next monday 8')).toBe('2026-03-16T08:00:00.000Z');
      expect(iso('sun 9')).toBe('2026-03-15T09:00:00.000Z');
      expect(iso('sat 5')).toBe('2026-03-14T05:00:00.000Z');
    });
    test('picks the next occurrence of Russian short and full names', () => {
      expect(iso('воскресенье в 11')).toBe('2026-03-15T11:00:00.000Z');
      expect(iso('пт 10:30')).toBe('2026-03-13T10:30:00.000Z');
      expect(iso('вторник 7')).toBe('2026-03-17T07:00:00.000Z');
    });
    test('the same weekday means next week, not today', () => {
      expect(iso('wed 10')).toBe('2026-03-18T10:00:00.000Z');
      expect(iso('среда 10')).toBe('2026-03-18T10:00:00.000Z');
    });
    test('a known weekday with an invalid clock is null', () => {
      expect(iso('mon 25')).toBeNull();
      expect(iso('пн 9:75')).toBeNull();
    });
    test('an unknown word is not a weekday', () => {
      expect(iso('foo 10')).toBeNull();
      expect(iso('next 10')).toBeNull();
    });
    test('crosses a month boundary', () => {
      expect(iso('mon 9', 'UTC', new Date('2026-03-30T12:00:00Z'))).toBe('2026-04-06T09:00:00.000Z');
      expect(iso('fri 9', 'UTC', new Date('2026-03-30T12:00:00Z'))).toBe('2026-04-03T09:00:00.000Z');
    });
    test('reads the current weekday in the given timezone', () => {
      // Wednesday 22:30Z is Thursday in Tokyo: "thu" is a week away, "fri" tomorrow.
      const lateUtc = new Date('2026-03-11T22:30:00Z');
      expect(iso('thu 10', 'Asia/Tokyo', lateUtc)).toBe('2026-03-19T01:00:00.000Z');
      expect(iso('пт 10', 'Asia/Tokyo', lateUtc)).toBe('2026-03-13T01:00:00.000Z');
      expect(iso('thu 10', 'UTC', lateUtc)).toBe('2026-03-12T10:00:00.000Z');
    });
  });

  describe('month and day', () => {
    test('month-first with English abbreviations and full names', () => {
      expect(iso('mar 15 19:30')).toBe('2026-03-15T19:30:00.000Z');
      expect(iso('march 15')).toBe('2026-03-15T00:00:00.000Z');
      expect(iso('dec 31 23:59')).toBe('2026-12-31T23:59:00.000Z');
      expect(iso('may 5')).toBe('2026-05-05T00:00:00.000Z');
      expect(iso('june 7')).toBe('2026-06-07T00:00:00.000Z');
    });
    test('day-first with English names', () => {
      expect(iso('15 march')).toBe('2026-03-15T00:00:00.000Z');
      expect(iso('1 jan 06:05')).toBe('2026-01-01T06:05:00.000Z');
    });
    test('Russian abbreviations, nominative and genitive forms in either order', () => {
      expect(iso('5 января')).toBe('2026-01-05T00:00:00.000Z');
      expect(iso('сентября 5 09:05')).toBe('2026-09-05T09:05:00.000Z');
      expect(iso('май 3')).toBe('2026-05-03T00:00:00.000Z');
      expect(iso('3 мая')).toBe('2026-05-03T00:00:00.000Z');
      expect(iso('июнь 7')).toBe('2026-06-07T00:00:00.000Z');
      expect(iso('7 декабря 18:00')).toBe('2026-12-07T18:00:00.000Z');
      expect(iso('окт 1')).toBe('2026-10-01T00:00:00.000Z');
    });
    test('uses the reference year even when the date is already past', () => {
      expect(iso('jan 5')).toBe('2026-01-05T00:00:00.000Z');
    });
    test('rejects dates that do not exist instead of rolling over', () => {
      expect(iso('feb 29')).toBeNull(); // 2026 is not a leap year
      expect(iso('feb 30')).toBeNull();
      expect(iso('apr 31')).toBeNull();
      expect(iso('mar 0')).toBeNull();
    });
    test('accepts a leap day in a leap year and the last day of a month', () => {
      const leap = new Date('2028-03-11T12:00:00Z');
      expect(iso('feb 29', 'UTC', leap)).toBe('2028-02-29T00:00:00.000Z');
      expect(iso('jan 31')).toBe('2026-01-31T00:00:00.000Z');
    });
    test('rejects invalid clocks', () => {
      expect(iso('mar 15 25:00')).toBeNull();
      expect(iso('15 мар 10:60')).toBeNull();
    });
    test('rejects unknown month names', () => {
      expect(iso('xyz 15')).toBeNull();
      expect(iso('15 xyz')).toBeNull();
      expect(iso('15 пн')).toBeNull();
    });
    test('interprets the clock in the given timezone', () => {
      expect(iso('mar 15 19:30', 'Europe/Belgrade')).toBe('2026-03-15T18:30:00.000Z');
      expect(iso('15 июля 09:00', 'Europe/Belgrade')).toBe('2026-07-15T07:00:00.000Z');
    });
    test('takes the year from the reference in the given timezone', () => {
      // 2026-12-31T23:30Z is already 2027-01-01 in Tokyo.
      const newYearsEve = new Date('2026-12-31T23:30:00Z');
      expect(iso('jan 5', 'Asia/Tokyo', newYearsEve)).toBe('2027-01-04T15:00:00.000Z');
      expect(iso('jan 5', 'UTC', newYearsEve)).toBe('2026-01-05T00:00:00.000Z');
    });
  });

  test('returns null for text matching no format', () => {
    expect(iso('')).toBeNull();
    expect(iso('next')).toBeNull();
    expect(iso('tomorrow morning')).toBeNull();
  });
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

describe('formatTimeWithTimezones', () => {
  const startAt = '2026-03-11T12:00:00Z'; // 15:00 Moscow, 14:00 Kyiv
  const endAt = '2026-03-11T13:00:00Z';

  test('same timezone — shows range once with sender timezone', () => {
    const result = formatTimeWithTimezones(startAt, endAt, 'Europe/Moscow', 'Europe/Moscow', true, 'en');
    expect(result).toBe('15:00–16:00 (Europe/Moscow)');
  });

  test('different timezones, recipient onboarded — shows both ranges', () => {
    const result = formatTimeWithTimezones(startAt, endAt, 'Europe/Moscow', 'Europe/Kyiv', true, 'en');
    expect(result).toBe('15:00–16:00 (Europe/Moscow) / 14:00–15:00 (Europe/Kyiv)');
  });

  test('no end time — shows start times only', () => {
    const result = formatTimeWithTimezones(startAt, null, 'Europe/Moscow', 'Europe/Kyiv', true, 'en');
    expect(result).toBe('15:00 (Europe/Moscow) / 14:00 (Europe/Kyiv)');
  });

  test('end on another local day — names the end day in that zone only', () => {
    // 20:00Z–22:30Z: Moscow 23:00 → 01:30 next day, Lisbon 20:00–22:30 same day
    const result = formatTimeWithTimezones(
      '2026-03-11T20:00:00Z',
      '2026-03-11T22:30:00Z',
      'Europe/Moscow',
      'Europe/Lisbon',
      true,
      'en',
    );
    expect(result).toBe('23:00 – Thu 12, 01:30 (Europe/Moscow) / 20:00–22:30 (Europe/Lisbon)');
  });

  test('recipient not onboarded — shows only sender timezone', () => {
    const result = formatTimeWithTimezones(startAt, endAt, 'Europe/Moscow', 'Europe/Kyiv', false, 'en');
    expect(result).toBe('15:00–16:00 (Europe/Moscow)');
  });

  test('recipient timezone null — shows only sender timezone', () => {
    const result = formatTimeWithTimezones(startAt, endAt, 'Europe/Moscow', null, true, 'en');
    expect(result).toBe('15:00–16:00 (Europe/Moscow)');
  });

  test('recipient timezone null and not onboarded — shows only sender timezone', () => {
    const result = formatTimeWithTimezones(startAt, endAt, 'UTC', null, false, 'en');
    expect(result).toBe('12:00–13:00 (UTC)');
  });
});

describe('localCalendarWeekDays', () => {
  test('returns 7 consecutive local calendar dates starting from the UTC week start', () => {
    // Mon 16 Mar 2026 00:00 Europe/Kyiv = 2026-03-15T22:00:00Z
    const days = localCalendarWeekDays('2026-03-15T22:00:00.000Z', 'Europe/Kyiv');
    expect(days).toHaveLength(7);
    expect(days[0]).toBe('2026-03-16');
    expect(days[6]).toBe('2026-03-22');
  });

  test('handles UTC-5: Mon 16 00:00 local = 2026-03-16T05:00:00Z', () => {
    const days = localCalendarWeekDays('2026-03-16T05:00:00Z', 'America/New_York');
    expect(days[0]).toBe('2026-03-16');
    expect(days[6]).toBe('2026-03-22');
  });

  test('consecutive days increment correctly', () => {
    const days = localCalendarWeekDays('2026-03-15T22:00:00Z', 'Europe/Kyiv');
    for (let i = 1; i < 7; i++) {
      const prev = new Date(`${days[i - 1]}T12:00:00Z`);
      const curr = new Date(`${days[i]}T12:00:00Z`);
      expect(curr.getTime() - prev.getTime()).toBe(86400000);
    }
  });
});
