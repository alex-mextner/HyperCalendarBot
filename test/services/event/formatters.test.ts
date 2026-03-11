// test/services/event/formatters.test.ts
import { describe, expect, test } from 'bun:test';
import type { CalendarEvent, EventOccurrence } from '../../../src/database/types.ts';
import { formatDayAgenda, formatEventDetail } from '../../../src/services/event/formatters.ts';

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
