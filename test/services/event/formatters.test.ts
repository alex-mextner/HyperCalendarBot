// test/services/event/formatters.test.ts
import { describe, expect, test } from 'bun:test';
import type { CalendarEvent, EventOccurrence } from '../../../src/database/types.ts';
import { formatDayAgenda, formatEventDetail, formatRecurrenceHuman } from '../../../src/services/event/formatters.ts';

function makeOccurrence(title: string, startUtc: string, endUtc: string | null = null): EventOccurrence {
  return {
    event: {
      id: 1,
      user_id: 123,
      title,
      description: null,
      category: null,
      start_at: startUtc,
      end_at: endUtc,
      all_day: 0,
      timezone: 'UTC',
      location: null,
      recurrence_rule: null,
      recurrence_end_at: null,
      parent_event_id: null,
      original_start_at: null,
      is_cancelled: 0,
      reminder_overrides: null,
      google_event_id: null,
      google_calendar_id: null,
      last_synced_at: null,
      created_at: '',
      updated_at: '',
    },
    occurrence_start: startUtc,
    occurrence_end: endUtc,
    is_exception: false,
  };
}

describe('formatDayAgenda', () => {
  test('formats empty day', () => {
    const result = formatDayAgenda([], '2026-03-11T12:00:00Z', 'UTC', 'en');
    expect(result).toContain('No events');
  });

  test('formats day with events', () => {
    const events = [
      makeOccurrence('Standup', '2026-03-11T09:00:00Z', '2026-03-11T09:30:00Z'),
      makeOccurrence('Lunch', '2026-03-11T12:00:00Z', '2026-03-11T13:00:00Z'),
    ];
    const result = formatDayAgenda(events, '2026-03-11T12:00:00Z', 'UTC', 'en');
    expect(result).toContain('Standup');
    expect(result).toContain('09:00');
    expect(result).toContain('Lunch');
  });
});

describe('formatEventDetail', () => {
  test('includes title and time', () => {
    const event: CalendarEvent = {
      id: 1,
      user_id: 123,
      title: 'Dentist',
      description: 'Cleaning',
      category: 'health',
      start_at: '2026-03-12T12:00:00Z',
      end_at: '2026-03-12T13:00:00Z',
      all_day: 0,
      timezone: 'UTC',
      location: 'Clinic',
      recurrence_rule: null,
      recurrence_end_at: null,
      parent_event_id: null,
      original_start_at: null,
      is_cancelled: 0,
      reminder_overrides: null,
      google_event_id: null,
      google_calendar_id: null,
      last_synced_at: null,
      created_at: '',
      updated_at: '',
    };
    const result = formatEventDetail(event, 'UTC', 'en');
    expect(result).toContain('Dentist');
    expect(result).toContain('12:00');
    expect(result).toContain('Clinic');
  });
});

describe('formatRecurrenceHuman', () => {
  test('FREQ=DAILY → "Daily"', () => {
    expect(formatRecurrenceHuman('FREQ=DAILY', 'en')).toBe('Daily');
  });
  test('FREQ=WEEKLY → "Еженедельно"', () => {
    expect(formatRecurrenceHuman('FREQ=WEEKLY', 'ru')).toBe('Еженедельно');
  });
  test('FREQ=WEEKLY;INTERVAL=2 → "Every 2 weeks"', () => {
    expect(formatRecurrenceHuman('FREQ=WEEKLY;INTERVAL=2', 'en')).toBe('Every 2 weeks');
  });
  test('FREQ=DAILY;INTERVAL=3 → "Каждые 3 дня"', () => {
    expect(formatRecurrenceHuman('FREQ=DAILY;INTERVAL=3', 'ru')).toBe('Каждые 3 дня');
  });
  test('FREQ=WEEKLY;COUNT=10 → "Weekly, 10 times"', () => {
    expect(formatRecurrenceHuman('FREQ=WEEKLY;COUNT=10', 'en')).toBe('Weekly, 10 times');
  });
  test('FREQ=DAILY;UNTIL=20260330T000000Z → "Daily until Mar 30"', () => {
    expect(formatRecurrenceHuman('FREQ=DAILY;UNTIL=20260330T000000Z', 'en')).toBe('Daily until Mar 30');
  });
  test('FREQ=MONTHLY;COUNT=5 → "Ежемесячно, 5 раз"', () => {
    expect(formatRecurrenceHuman('FREQ=MONTHLY;COUNT=5', 'ru')).toBe('Ежемесячно, 5 раз');
  });
  test('FREQ=DAILY;UNTIL=20260330T000000Z in RU → "Ежедневно до 30 мар"', () => {
    expect(formatRecurrenceHuman('FREQ=DAILY;UNTIL=20260330T000000Z', 'ru')).toBe('Ежедневно до 30 мар');
  });
});
