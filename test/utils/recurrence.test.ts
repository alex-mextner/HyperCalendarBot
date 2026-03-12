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
});
