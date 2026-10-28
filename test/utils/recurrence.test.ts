import { describe, expect, test } from 'bun:test';
import { parseRecurrence } from '../../src/utils/date.ts';

describe('parseRecurrence', () => {
  // Daily
  test('parses "daily"', () => {
    expect(parseRecurrence('daily')).toEqual({ freq: 'DAILY', interval: 1 });
  });
  test('parses "every day"', () => {
    expect(parseRecurrence('every day')).toEqual({ freq: 'DAILY', interval: 1 });
  });
  test('parses "каждый день"', () => {
    expect(parseRecurrence('каждый день')).toEqual({ freq: 'DAILY', interval: 1 });
  });
  test('parses "ежедневно"', () => {
    expect(parseRecurrence('ежедневно')).toEqual({ freq: 'DAILY', interval: 1 });
  });

  // Weekly
  test('parses "weekly"', () => {
    expect(parseRecurrence('weekly')).toEqual({ freq: 'WEEKLY', interval: 1 });
  });
  test('parses "every week"', () => {
    expect(parseRecurrence('every week')).toEqual({ freq: 'WEEKLY', interval: 1 });
  });
  test('parses "каждую неделю"', () => {
    expect(parseRecurrence('каждую неделю')).toEqual({ freq: 'WEEKLY', interval: 1 });
  });
  test('parses "еженедельно"', () => {
    expect(parseRecurrence('еженедельно')).toEqual({ freq: 'WEEKLY', interval: 1 });
  });

  // Monthly
  test('parses "monthly"', () => {
    expect(parseRecurrence('monthly')).toEqual({ freq: 'MONTHLY', interval: 1 });
  });
  test('parses "every month"', () => {
    expect(parseRecurrence('every month')).toEqual({ freq: 'MONTHLY', interval: 1 });
  });
  test('parses "каждый месяц"', () => {
    expect(parseRecurrence('каждый месяц')).toEqual({ freq: 'MONTHLY', interval: 1 });
  });
  test('parses "ежемесячно"', () => {
    expect(parseRecurrence('ежемесячно')).toEqual({ freq: 'MONTHLY', interval: 1 });
  });

  // Yearly
  test('parses "yearly"', () => {
    expect(parseRecurrence('yearly')).toEqual({ freq: 'YEARLY', interval: 1 });
  });
  test('parses "every year"', () => {
    expect(parseRecurrence('every year')).toEqual({ freq: 'YEARLY', interval: 1 });
  });
  test('parses "каждый год"', () => {
    expect(parseRecurrence('каждый год')).toEqual({ freq: 'YEARLY', interval: 1 });
  });
  test('parses "ежегодно"', () => {
    expect(parseRecurrence('ежегодно')).toEqual({ freq: 'YEARLY', interval: 1 });
  });

  // With interval
  test('parses "every 2 weeks"', () => {
    expect(parseRecurrence('every 2 weeks')).toEqual({ freq: 'WEEKLY', interval: 2 });
  });
  test('parses "каждые 2 недели"', () => {
    expect(parseRecurrence('каждые 2 недели')).toEqual({ freq: 'WEEKLY', interval: 2 });
  });
  test('parses "через неделю"', () => {
    expect(parseRecurrence('через неделю')).toEqual({ freq: 'WEEKLY', interval: 2 });
  });
  test('parses "every 3 days"', () => {
    expect(parseRecurrence('every 3 days')).toEqual({ freq: 'DAILY', interval: 3 });
  });
  test('parses "каждые 3 дня"', () => {
    expect(parseRecurrence('каждые 3 дня')).toEqual({ freq: 'DAILY', interval: 3 });
  });
  test('parses "every 2 months"', () => {
    expect(parseRecurrence('every 2 months')).toEqual({ freq: 'MONTHLY', interval: 2 });
  });
  test('parses "каждые 2 месяца"', () => {
    expect(parseRecurrence('каждые 2 месяца')).toEqual({ freq: 'MONTHLY', interval: 2 });
  });

  // Invalid
  test('returns null for empty', () => {
    expect(parseRecurrence('')).toBeNull();
  });
  test('returns null for gibberish', () => {
    expect(parseRecurrence('asdfgh')).toBeNull();
  });
  test('returns null for whitespace only', () => {
    expect(parseRecurrence('   ')).toBeNull();
  });

  // Normalisation and fixed phrases
  test('trims and lowercases before matching', () => {
    expect(parseRecurrence('  Daily ')).toEqual({ freq: 'DAILY', interval: 1 });
    expect(parseRecurrence('ЕЖЕНЕДЕЛЬНО')).toEqual({ freq: 'WEEKLY', interval: 1 });
    expect(parseRecurrence('Every Month')).toEqual({ freq: 'MONTHLY', interval: 1 });
    expect(parseRecurrence('EVERY 2 DAYS')).toEqual({ freq: 'DAILY', interval: 2 });
  });
  test('returns a fresh object per call', () => {
    const first = parseRecurrence('daily');
    first!.interval = 99;
    expect(parseRecurrence('daily')).toEqual({ freq: 'DAILY', interval: 1 });
  });

  // "every N <unit>"
  test('parses every N for each English unit, singular and plural', () => {
    expect(parseRecurrence('every 1 day')).toEqual({ freq: 'DAILY', interval: 1 });
    expect(parseRecurrence('every 10 days')).toEqual({ freq: 'DAILY', interval: 10 });
    expect(parseRecurrence('every 1 week')).toEqual({ freq: 'WEEKLY', interval: 1 });
    expect(parseRecurrence('every 3 weeks')).toEqual({ freq: 'WEEKLY', interval: 3 });
    expect(parseRecurrence('every 1 month')).toEqual({ freq: 'MONTHLY', interval: 1 });
    expect(parseRecurrence('every 6 months')).toEqual({ freq: 'MONTHLY', interval: 6 });
    expect(parseRecurrence('every 1 year')).toEqual({ freq: 'YEARLY', interval: 1 });
    expect(parseRecurrence('every 10 years')).toEqual({ freq: 'YEARLY', interval: 10 });
  });
  test('every N tolerates repeated spaces and does not validate N', () => {
    expect(parseRecurrence('every  3   weeks')).toEqual({ freq: 'WEEKLY', interval: 3 });
    expect(parseRecurrence('every 0 weeks')).toEqual({ freq: 'WEEKLY', interval: 0 });
  });
  test('rejects malformed every N phrases', () => {
    expect(parseRecurrence('every 2 fortnights')).toBeNull();
    expect(parseRecurrence('every two days')).toBeNull();
    expect(parseRecurrence('every day 2')).toBeNull();
    expect(parseRecurrence('every 2')).toBeNull();
    expect(parseRecurrence('every -2 days')).toBeNull();
  });

  // "каждые N <unit>"
  test('parses каждый/каждую/каждые/каждое N for each Russian unit form', () => {
    expect(parseRecurrence('каждый 1 день')).toEqual({ freq: 'DAILY', interval: 1 });
    expect(parseRecurrence('каждые 3 дня')).toEqual({ freq: 'DAILY', interval: 3 });
    expect(parseRecurrence('каждые 5 дней')).toEqual({ freq: 'DAILY', interval: 5 });
    expect(parseRecurrence('каждую 1 неделю')).toEqual({ freq: 'WEEKLY', interval: 1 });
    expect(parseRecurrence('каждые 2 недели')).toEqual({ freq: 'WEEKLY', interval: 2 });
    expect(parseRecurrence('каждые 3 недель')).toEqual({ freq: 'WEEKLY', interval: 3 });
    expect(parseRecurrence('каждое 1 месяц')).toEqual({ freq: 'MONTHLY', interval: 1 });
    expect(parseRecurrence('каждые 2 месяца')).toEqual({ freq: 'MONTHLY', interval: 2 });
    expect(parseRecurrence('каждые 6 месяцев')).toEqual({ freq: 'MONTHLY', interval: 6 });
    expect(parseRecurrence('каждый 1 год')).toEqual({ freq: 'YEARLY', interval: 1 });
    expect(parseRecurrence('каждые 2 года')).toEqual({ freq: 'YEARLY', interval: 2 });
  });
  test('rejects malformed Russian phrases', () => {
    expect(parseRecurrence('каждые 5 лет')).toBeNull();
    expect(parseRecurrence('каждые 2 минуты')).toBeNull();
    expect(parseRecurrence('каждые два дня')).toBeNull();
    expect(parseRecurrence('каждые 2')).toBeNull();
  });
  test('keeps the two languages separate', () => {
    expect(parseRecurrence('every 2 недели')).toBeNull();
    expect(parseRecurrence('каждые 2 weeks')).toBeNull();
  });
  test('object prototype names are no recurrence phrase', () => {
    for (const word of ['constructor', 'toString', '__proto__', 'hasOwnProperty'])
      expect(parseRecurrence(word), word).toBeNull();
  });
});
