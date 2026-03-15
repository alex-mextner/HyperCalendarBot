import { describe, expect, test } from 'bun:test';
import type { CalendarEvent, EventOccurrence } from '../../../src/database/types.ts';
import {
  mapDailyAgendaData,
  mapEventCardData,
  mapWeeklyOverviewData,
} from '../../../src/services/image/data-mapper.ts';
import { THEME_LIGHT } from '../../../src/worker/templates/themes.ts';

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 1,
    user_id: 123,
    title: 'Test Event',
    description: null,
    category: null,
    start_at: '2026-03-11T09:00:00Z',
    end_at: '2026-03-11T10:00:00Z',
    all_day: 0,
    timezone: 'Europe/Kyiv',
    location: null,
    recurrence_rule: null,
    recurrence_end_at: null,
    parent_event_id: null,
    original_start_at: null,
    is_cancelled: 0,
    reminder_overrides: null,
    google_event_id: null,
    google_calendar_id: null,
    google_etag: null,
    sync_status: 'local_only' as const,
    sync_version: 0,
    last_synced_at: null,
    created_at: '2026-03-11T08:00:00Z',
    updated_at: '2026-03-11T08:00:00Z',
    ...overrides,
  } as CalendarEvent;
}

function makeOcc(overrides: Partial<CalendarEvent> = {}): EventOccurrence {
  const event = makeEvent(overrides);
  return { event, occurrence_start: event.start_at, occurrence_end: event.end_at, is_exception: false };
}

describe('mapDailyAgendaData', () => {
  test('maps timed event with timezone conversion', () => {
    // 09:00 UTC = 11:00 Europe/Kyiv (UTC+2 in March)
    const result = mapDailyAgendaData({
      occurrences: [makeOcc()],
      dateIso: '2026-03-11',
      timezone: 'Europe/Kyiv',
      locale: 'en',
      theme: THEME_LIGHT,
    });
    expect(result.eventCount).toBe(1);
    expect(result.timedEvents).toHaveLength(1);
    expect(result.timedEvents[0].title).toBe('Test Event');
    expect(result.timedEvents[0].startMinutes).toBe(11 * 60); // 11:00 Kyiv
    expect(result.timedEvents[0].endMinutes).toBe(12 * 60);
  });

  test('separates all-day from timed', () => {
    const result = mapDailyAgendaData({
      occurrences: [
        makeOcc({ all_day: 1, start_at: '2026-03-11T00:00:00Z', end_at: null }),
        makeOcc({ id: 2, start_at: '2026-03-11T14:00:00Z', end_at: '2026-03-11T15:00:00Z' }),
      ],
      dateIso: '2026-03-11',
      timezone: 'Europe/Kyiv',
      locale: 'en',
      theme: THEME_LIGHT,
    });
    expect(result.allDayEvents).toHaveLength(1);
    expect(result.timedEvents).toHaveLength(1);
    expect(result.eventCount).toBe(2);
  });

  test('English date formatting', () => {
    const result = mapDailyAgendaData({
      occurrences: [],
      dateIso: '2026-03-11',
      timezone: 'Europe/Kyiv',
      locale: 'en',
      theme: THEME_LIGHT,
    });
    expect(result.dateFormatted).toContain('March');
    expect(result.dateFormatted).toContain('11');
    expect(result.dayOfWeek).toBe('Wednesday');
  });

  test('Russian date formatting', () => {
    const result = mapDailyAgendaData({
      occurrences: [],
      dateIso: '2026-03-11',
      timezone: 'Europe/Kyiv',
      locale: 'ru',
      theme: THEME_LIGHT,
    });
    expect(result.dateFormatted).toContain('марта');
    expect(result.dayOfWeek).toBe('Среда');
  });

  test('assigns event colors from palette', () => {
    const occs = [0, 1, 2].map((i) =>
      makeOcc({
        id: i + 1,
        start_at: `2026-03-11T${String(9 + i).padStart(2, '0')}:00:00Z`,
        end_at: `2026-03-11T${String(10 + i).padStart(2, '0')}:00:00Z`,
      }),
    );
    const result = mapDailyAgendaData({
      occurrences: occs,
      dateIso: '2026-03-11',
      timezone: 'Europe/Kyiv',
      locale: 'en',
      theme: THEME_LIGHT,
    });
    for (const ev of result.timedEvents) {
      expect(THEME_LIGHT.eventColors).toContain(ev.calendarColor);
    }
  });

  test('empty occurrences', () => {
    const result = mapDailyAgendaData({
      occurrences: [],
      dateIso: '2026-03-11',
      timezone: 'UTC',
      locale: 'en',
      theme: THEME_LIGHT,
    });
    expect(result.eventCount).toBe(0);
    expect(result.timedEvents).toEqual([]);
    expect(result.allDayEvents).toEqual([]);
  });
});

describe('mapWeeklyOverviewData', () => {
  test('produces 7 days starting from Monday', () => {
    const result = mapWeeklyOverviewData({
      occurrencesByDay: new Map(),
      weekStartIso: '2026-03-09', // Monday
      timezone: 'Europe/Kyiv',
      locale: 'en',
      theme: THEME_LIGHT,
    });
    expect(result.days).toHaveLength(7);
    expect(result.days[0].dayName).toBe('Mon');
    expect(result.days[0].dayNumber).toBe(9);
    expect(result.days[5].isWeekend).toBe(true);
    expect(result.days[6].isWeekend).toBe(true);
  });
});

describe('mapEventCardData', () => {
  test('maps event to card with timezone conversion', () => {
    const result = mapEventCardData({
      occurrence: makeOcc({ location: 'Room 42', description: 'Review proposals' }),
      timezone: 'Europe/Kyiv',
      locale: 'en',
      theme: THEME_LIGHT,
    });
    expect(result.title).toBe('Test Event');
    expect(result.location).toBe('Room 42');
    expect(result.description).toBe('Review proposals');
    expect(result.timeFormatted).toContain('11:00');
    expect(result.duration).toBe('1h');
  });
});
