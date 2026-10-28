import { describe, expect, test } from 'bun:test';
import { applyFilters, parseFilterChain } from '../../../src/services/intent/filter-parser.ts';
import { humanDuration } from '../../../src/services/intent/human-time.ts';

describe('humanDuration', () => {
  test.each([
    [1, 'ru', '1 минуту'],
    [2, 'ru', '2 минуты'],
    [5, 'ru', '5 минут'],
    [11, 'ru', '11 минут'],
    [21, 'ru', '21 минуту'],
    [60, 'ru', '1 час'],
    [120, 'ru', '2 часа'],
    [90, 'ru', '1 час 30 минут'],
    [300, 'ru', '5 часов'],
    [1440, 'ru', '1 день'],
    [10080, 'ru', '7 дней'],
    [1, 'en', '1 minute'],
    [20, 'en', '20 minutes'],
    [90, 'en', '1 hour 30 minutes'],
    [1500, 'en', '1 day 1 hour'],
  ])('%d minutes in %s is "%s"', (minutes, language, text) => {
    expect(humanDuration(minutes, language)).toBe(text);
  });

  test('the human_duration filter reads a number of minutes in the reader’s language', () => {
    const context = { now: new Date('2026-09-19T08:00:00Z'), timezone: 'UTC', language: 'ru' };
    expect(applyFilters(45, parseFilterChain('human_duration'), context)).toBe('45 минут');
    expect(() => applyFilters('soon', parseFilterChain('human_duration'), context)).toThrow();
  });
});
