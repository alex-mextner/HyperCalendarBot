import { describe, expect, test } from 'bun:test';
import type { CalendarEvent, EventOccurrence } from '../../../src/database/types.ts';
import {
  mapDailyAgendaData,
  mapEventCardData,
  mapMonthlyCalendarData,
  mapWeeklyOverviewData,
} from '../../../src/services/image/data-mapper.ts';
import { THEME_LIGHT } from '../../../src/worker/templates/themes.ts';

const BIRTHDAY_COLOR = '#EC4899';

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

function makeOcc(overrides: Partial<CalendarEvent> = {}, occStart?: string): EventOccurrence {
  const event = makeEvent(overrides);
  return {
    event,
    occurrence_start: occStart ?? event.start_at,
    occurrence_end: event.end_at,
    is_exception: false,
  };
}

// Birthday occurrence: all-day, 2026-05-10, born 1996 → turns 30
function makeBirthdayOcc(): EventOccurrence {
  return makeOcc(
    {
      title: 'Иван',
      event_type: 'birthday',
      all_day: 1,
      start_at: '2026-05-10T00:00:00Z',
      end_at: null,
      birth_year: 1996,
      recurrence_rule: 'FREQ=YEARLY',
    },
    '2026-05-10T00:00:00Z',
  );
}

// Recurring non-birthday occurrence
function makeRecurringOcc(): EventOccurrence {
  return makeOcc({
    id: 2,
    title: 'Standup',
    recurrence_rule: 'FREQ=DAILY',
    start_at: '2026-03-09T08:00:00Z',
    end_at: '2026-03-09T08:30:00Z',
  });
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
    expect(result.timedEvents[0]!.title).toBe('Test Event');
    expect(result.timedEvents[0]!.startMinutes).toBe(11 * 60); // 11:00 Kyiv
    expect(result.timedEvents[0]!.endMinutes).toBe(12 * 60);
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

  test('birthday event gets pink color and age title (EN)', () => {
    const result = mapDailyAgendaData({
      occurrences: [makeBirthdayOcc()],
      dateIso: '2026-05-10',
      timezone: 'UTC',
      locale: 'en',
      theme: THEME_LIGHT,
    });
    const ev = result.allDayEvents[0]!;
    expect(ev.calendarColor).toBe(BIRTHDAY_COLOR);
    expect(ev.title).toContain('🎁');
    expect(ev.title).toContain('turns 30');
  });

  test('birthday event gets Russian age plural (RU)', () => {
    const result = mapDailyAgendaData({
      occurrences: [makeBirthdayOcc()],
      dateIso: '2026-05-10',
      timezone: 'UTC',
      locale: 'ru',
      theme: THEME_LIGHT,
    });
    expect(result.allDayEvents[0]!.title).toContain('30 лет');
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
    expect(result.days[0]!.dayName).toBe('Mon');
    expect(result.days[0]!.dayNumber).toBe(9);
    expect(result.days[5]!.isWeekend).toBe(true);
    expect(result.days[6]!.isWeekend).toBe(true);
  });

  test('birthday event gets pink color and age title (EN)', () => {
    const bdayOcc = makeBirthdayOcc();
    // override dates to fall on Monday 2026-03-09
    bdayOcc.event.start_at = '2026-03-09T00:00:00Z';
    bdayOcc.occurrence_start = '2026-03-09T00:00:00Z';
    bdayOcc.occurrence_end = null;
    const occsByDay = new Map([['2026-03-09', [bdayOcc]]]);

    const result = mapWeeklyOverviewData({
      occurrencesByDay: occsByDay,
      weekStartIso: '2026-03-09',
      timezone: 'UTC',
      locale: 'en',
      theme: THEME_LIGHT,
    });
    const ev = result.days[0]!.events[0]!;
    expect(ev.color).toBe(BIRTHDAY_COLOR);
    expect(ev.title).toContain('🎁');
    expect(ev.title).toContain('turns 30');
  });

  test('birthday event gets Russian age plural (RU)', () => {
    const bdayOcc = makeBirthdayOcc();
    bdayOcc.event.start_at = '2026-03-09T00:00:00Z';
    bdayOcc.occurrence_start = '2026-03-09T00:00:00Z';
    bdayOcc.occurrence_end = null;
    const occsByDay = new Map([['2026-03-09', [bdayOcc]]]);

    const result = mapWeeklyOverviewData({
      occurrencesByDay: occsByDay,
      weekStartIso: '2026-03-09',
      timezone: 'UTC',
      locale: 'ru',
      theme: THEME_LIGHT,
    });
    expect(result.days[0]!.events[0]!.title).toContain('30 лет');
  });

  test('recurring non-birthday event gets 🔁 suffix', () => {
    const recurOcc = makeRecurringOcc();
    const occsByDay = new Map([['2026-03-09', [recurOcc]]]);

    const result = mapWeeklyOverviewData({
      occurrencesByDay: occsByDay,
      weekStartIso: '2026-03-09',
      timezone: 'UTC',
      locale: 'en',
      theme: THEME_LIGHT,
    });
    expect(result.days[0]!.events[0]!.title).toContain('🔁');
    expect(result.days[0]!.events[0]!.color).not.toBe(BIRTHDAY_COLOR);
  });
});

describe('mapMonthlyCalendarData (makeDay)', () => {
  test('birthday event in monthly view gets pink color and age (EN)', () => {
    const bdayOcc = makeBirthdayOcc();
    const occsByDay = new Map([['2026-03-09', [bdayOcc]]]);

    const result = mapMonthlyCalendarData({
      occurrencesByDay: occsByDay,
      year: 2026,
      month: 2, // March
      timezone: 'UTC',
      locale: 'en',
      theme: THEME_LIGHT,
    });

    // Find the day cell for March 9
    const march9 = result.weeks.flat().find((d) => !d.isOtherMonth && d.dayNumber === 9)!;
    expect(march9.events[0]!.color).toBe(BIRTHDAY_COLOR);
    expect(march9.events[0]!.title).toContain('🎁');
    expect(march9.events[0]!.title).toContain('turns 30');
  });

  test('birthday event in monthly view gets Russian age plural (RU)', () => {
    const bdayOcc = makeBirthdayOcc();
    const occsByDay = new Map([['2026-03-09', [bdayOcc]]]);

    const result = mapMonthlyCalendarData({
      occurrencesByDay: occsByDay,
      year: 2026,
      month: 2,
      timezone: 'UTC',
      locale: 'ru',
      theme: THEME_LIGHT,
    });

    const march9 = result.weeks.flat().find((d) => !d.isOtherMonth && d.dayNumber === 9)!;
    expect(march9.events[0]!.title).toContain('30 лет');
  });

  test('recurring non-birthday event in monthly view gets 🔁 suffix', () => {
    const recurOcc = makeRecurringOcc();
    const occsByDay = new Map([['2026-03-09', [recurOcc]]]);

    const result = mapMonthlyCalendarData({
      occurrencesByDay: occsByDay,
      year: 2026,
      month: 2,
      timezone: 'UTC',
      locale: 'en',
      theme: THEME_LIGHT,
    });

    const march9 = result.weeks.flat().find((d) => !d.isOtherMonth && d.dayNumber === 9)!;
    expect(march9.events[0]!.title).toContain('🔁');
    expect(march9.events[0]!.color).not.toBe(BIRTHDAY_COLOR);
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

  test('birthday event card gets pink color and age title (EN)', () => {
    const result = mapEventCardData({
      occurrence: makeBirthdayOcc(),
      timezone: 'UTC',
      locale: 'en',
      theme: THEME_LIGHT,
    });
    expect(result.calendarColor).toBe(BIRTHDAY_COLOR);
    expect(result.title).toContain('🎁');
    expect(result.title).toContain('turns 30');
  });

  test('birthday event card gets Russian age plural (RU)', () => {
    const result = mapEventCardData({
      occurrence: makeBirthdayOcc(),
      timezone: 'UTC',
      locale: 'ru',
      theme: THEME_LIGHT,
    });
    expect(result.title).toContain('30 лет');
    expect(result.calendarColor).toBe(BIRTHDAY_COLOR);
  });

  test('regular event card gets theme color', () => {
    const result = mapEventCardData({
      occurrence: makeOcc(),
      timezone: 'UTC',
      locale: 'en',
      theme: THEME_LIGHT,
    });
    expect(result.calendarColor).toBe(THEME_LIGHT.eventColors[0]!);
    expect(result.title).toBe('Test Event');
  });
});
