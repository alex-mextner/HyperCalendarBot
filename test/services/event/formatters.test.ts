// test/services/event/formatters.test.ts
import { describe, expect, test } from 'bun:test';
import type { CalendarEvent, EventOccurrence } from '../../../src/database/types.ts';
import {
  formatDayAgenda,
  formatEventDetail,
  formatEventListItem,
  formatInvitation,
  formatRecurrenceHuman,
  formatWeekAgenda,
  ruPlural,
} from '../../../src/services/event/formatters.ts';
import type { HolidayEntry } from '../../../src/services/holiday/holiday-service.ts';

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
    google_etag: null,
    sync_status: 'local_only',
    sync_version: 1,
    owner_type: 'user',
    group_id: null,
    created_by: null,
    last_synced_at: null,
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

function makeOccurrence(
  title: string,
  startUtc: string,
  endUtc: string | null = null,
  overrides: Partial<CalendarEvent> = {},
): EventOccurrence {
  return {
    event: makeEvent({ title, start_at: startUtc, end_at: endUtc, ...overrides }),
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
      google_etag: null,
      sync_status: 'local_only',
      sync_version: 0,
      owner_type: 'user',
      group_id: null,
      created_by: null,
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

// ── formatWeekAgenda (lines 34-82) ──

describe('formatWeekAgenda', () => {
  test('renders a week with no events — each day shows "no events"', () => {
    const result = formatWeekAgenda([], '2026-03-09T00:00:00Z', '2026-03-15T23:59:59Z', 'UTC', 'en');
    expect(result).toContain('Week');
    // All 7 days should say "no events"
    expect(result.match(/no events/g)?.length).toBe(7);
  });

  test('renders a week with no events in Russian', () => {
    const result = formatWeekAgenda([], '2026-03-09T00:00:00Z', '2026-03-15T23:59:59Z', 'UTC', 'ru');
    expect(result).toContain('Неделя');
    expect(result.match(/нет событий/g)?.length).toBe(7);
  });

  test('renders events grouped by day', () => {
    const events = [
      makeOccurrence('Monday Standup', '2026-03-09T09:00:00Z', '2026-03-09T09:30:00Z'),
      makeOccurrence('Monday Lunch', '2026-03-09T12:00:00Z', '2026-03-09T13:00:00Z'),
      makeOccurrence('Wednesday Call', '2026-03-11T15:00:00Z', '2026-03-11T16:00:00Z'),
    ];
    const result = formatWeekAgenda(events, '2026-03-09T00:00:00Z', '2026-03-15T23:59:59Z', 'UTC', 'en');
    expect(result).toContain('Monday Standup');
    expect(result).toContain('Monday Lunch');
    expect(result).toContain('Wednesday Call');
    // Monday has 2 events
    expect(result).toContain('2 events');
    // Wednesday has 1 event
    expect(result).toContain('1 event');
    // Other 5 days should say "no events"
    expect(result.match(/no events/g)?.length).toBe(5);
  });

  test('renders single event day with singular "событие" in Russian', () => {
    const events = [makeOccurrence('Обед', '2026-03-09T12:00:00Z', '2026-03-09T13:00:00Z')];
    const result = formatWeekAgenda(events, '2026-03-09T00:00:00Z', '2026-03-15T23:59:59Z', 'UTC', 'ru');
    expect(result).toContain('1 событие');
    expect(result).toContain('Обед');
  });

  test('renders multiple events day with "событий" in Russian', () => {
    const events = [
      makeOccurrence('Утро', '2026-03-09T08:00:00Z', '2026-03-09T09:00:00Z'),
      makeOccurrence('Обед', '2026-03-09T12:00:00Z', '2026-03-09T13:00:00Z'),
      makeOccurrence('Вечер', '2026-03-09T18:00:00Z', '2026-03-09T19:00:00Z'),
    ];
    const result = formatWeekAgenda(events, '2026-03-09T00:00:00Z', '2026-03-15T23:59:59Z', 'UTC', 'ru');
    expect(result).toContain('3 событий');
  });

  test('renders holidays on a day', () => {
    const holidaysByDate = new Map<string, HolidayEntry[]>([
      [
        '2026-03-09',
        [
          {
            date: '2026-03-09',
            name: "Women's Day (observed)",
            type: 'public',
            countryCode: 'UA',
            countryName: 'Ukraine',
          },
        ],
      ],
    ]);
    const result = formatWeekAgenda([], '2026-03-09T00:00:00Z', '2026-03-15T23:59:59Z', 'UTC', 'en', holidaysByDate);
    expect(result).toContain("Women's Day (observed)");
    expect(result).toContain('🎉');
    // Holiday day should NOT show "no events" since it has a holiday line
    // The remaining 6 days should show "no events"
    expect(result.match(/no events/g)?.length).toBe(6);
  });

  test('renders holidays + events on the same day', () => {
    const events = [makeOccurrence('Party', '2026-03-09T18:00:00Z', '2026-03-09T22:00:00Z')];
    const holidaysByDate = new Map<string, HolidayEntry[]>([
      [
        '2026-03-09',
        [{ date: '2026-03-09', name: 'Holiday', type: 'public', countryCode: 'UA', countryName: 'Ukraine' }],
      ],
    ]);
    const result = formatWeekAgenda(
      events,
      '2026-03-09T00:00:00Z',
      '2026-03-15T23:59:59Z',
      'UTC',
      'en',
      holidaysByDate,
    );
    expect(result).toContain('🎉 Holiday');
    expect(result).toContain('Party');
    expect(result).toContain('1 event');
  });
});

// ── formatEventDetail edge cases (lines 91, 97, 112) ──

describe('formatEventDetail — edge cases', () => {
  test('all-day event shows "All day" label', () => {
    const event = makeEvent({ title: 'Conference', all_day: 1 });
    const result = formatEventDetail(event, 'UTC', 'en');
    expect(result).toContain('All day');
    expect(result).not.toContain('🕐');
  });

  test('all-day event shows "Весь день" in Russian', () => {
    const event = makeEvent({ title: 'Конференция', all_day: 1 });
    const result = formatEventDetail(event, 'UTC', 'ru');
    expect(result).toContain('Весь день');
  });

  test('event without end_at omits duration', () => {
    const event = makeEvent({ title: 'Open-ended', end_at: null });
    const result = formatEventDetail(event, 'UTC', 'en');
    expect(result).toContain('🕐');
    expect(result).not.toContain('(');
  });

  test('event with recurrence_rule shows recurrence line', () => {
    const event = makeEvent({ title: 'Weekly sync', recurrence_rule: 'FREQ=WEEKLY' });
    const result = formatEventDetail(event, 'UTC', 'en');
    expect(result).toContain('🔁');
    expect(result).toContain('Weekly');
  });

  test('event with all optional fields (description, location, category, recurrence)', () => {
    const event = makeEvent({
      title: 'Full Event',
      description: 'A detailed description',
      location: 'Office 42',
      category: 'work',
      recurrence_rule: 'FREQ=DAILY;COUNT=3',
    });
    const result = formatEventDetail(event, 'UTC', 'en');
    expect(result).toContain('📝 A detailed description');
    expect(result).toContain('📍 Office 42');
    expect(result).toContain('🏷 work');
    expect(result).toContain('🔁 Daily, 3 times');
  });

  test('event with no optional fields — minimal output', () => {
    const event = makeEvent({ title: 'Bare', description: null, location: null, category: null });
    const result = formatEventDetail(event, 'UTC', 'en');
    expect(result).toContain('📌');
    expect(result).toContain('Bare');
    expect(result).not.toContain('📝');
    expect(result).not.toContain('📍');
    expect(result).not.toContain('🏷');
    expect(result).not.toContain('🔁');
  });
});

// ── formatInvitation ──

describe('formatInvitation', () => {
  const event = makeEvent({
    title: 'Team Meeting',
    start_at: '2026-03-11T12:00:00Z', // 15:00 Moscow, 14:00 Kyiv
    end_at: '2026-03-11T13:00:00Z',
    timezone: 'Europe/Moscow',
  });

  test('no recipient info — shows only sender timezone', () => {
    const result = formatInvitation(event, 'Europe/Moscow', 'en', 'Alice', 1);
    expect(result).toContain('15:00 (Europe/Moscow)');
    expect(result).not.toContain('Europe/Kyiv');
  });

  test('recipient not onboarded — shows only sender timezone', () => {
    const result = formatInvitation(event, 'Europe/Moscow', 'en', 'Alice', 1, null, 'Europe/Kyiv', false);
    expect(result).toContain('15:00 (Europe/Moscow)');
    expect(result).not.toContain('Europe/Kyiv');
  });

  test('recipient null timezone — shows only sender timezone', () => {
    const result = formatInvitation(event, 'Europe/Moscow', 'en', 'Alice', 1, null, null, true);
    expect(result).toContain('15:00 (Europe/Moscow)');
    expect(result).not.toContain('(Europe/Moscow) /');
  });

  test('recipient onboarded with different timezone — shows both timezones', () => {
    const result = formatInvitation(event, 'Europe/Moscow', 'en', 'Alice', 1, null, 'Europe/Kyiv', true);
    expect(result).toContain('15:00 (Europe/Moscow) / 14:00 (Europe/Kyiv)');
  });

  test('recipient onboarded with same timezone — shows timezone once', () => {
    const result = formatInvitation(event, 'Europe/Moscow', 'en', 'Alice', 1, null, 'Europe/Moscow', true);
    expect(result).toContain('15:00 (Europe/Moscow)');
    // Should not show duplicate
    expect(result.match(/Europe\/Moscow/g)?.length).toBe(1);
  });

  test('all-day event — no timezone annotation', () => {
    const allDay = makeEvent({ title: 'Holiday', all_day: 1, timezone: 'Europe/Moscow' });
    const result = formatInvitation(allDay, 'Europe/Moscow', 'en', 'Alice', 1, null, 'Europe/Kyiv', true);
    expect(result).toContain('All day');
    expect(result).not.toContain('Europe/Moscow)');
  });

  test('includes inviter username link when provided', () => {
    const result = formatInvitation(event, 'Europe/Moscow', 'en', 'Alice', 1, 'alice_tg', 'Europe/Kyiv', true);
    expect(result).toContain('@alice_tg');
  });
});

// ── formatEventListItem (lines 118-119) ──

describe('formatEventListItem', () => {
  test('formats event as numbered list item', () => {
    const event = makeEvent({ title: 'Standup', start_at: '2026-03-11T09:00:00Z' });
    const result = formatEventListItem(event, 'UTC', 0);
    expect(result).toBe('1. 09:00 — Standup');
  });

  test('uses 1-based index from 0-based input', () => {
    const event = makeEvent({ title: 'Lunch', start_at: '2026-03-11T12:30:00Z' });
    const result = formatEventListItem(event, 'UTC', 2);
    expect(result).toBe('3. 12:30 — Lunch');
  });

  test('escapes HTML in title', () => {
    const event = makeEvent({ title: '<b>Bold</b>', start_at: '2026-03-11T14:00:00Z' });
    const result = formatEventListItem(event, 'UTC', 0);
    expect(result).toContain('&lt;b&gt;Bold&lt;/b&gt;');
    expect(result).not.toContain('<b>');
  });
});

describe('ruPlural', () => {
  const cases: [number, string][] = [
    // 1 → one
    [1, 'one'],
    [21, 'one'],
    [31, 'one'],
    [101, 'one'],
    [1001, 'one'],
    // 2-4 → few
    [2, 'few'],
    [3, 'few'],
    [4, 'few'],
    [22, 'few'],
    [23, 'few'],
    [24, 'few'],
    [32, 'few'],
    [102, 'few'],
    [1002, 'few'],
    // 5-9 → many
    [5, 'many'],
    [6, 'many'],
    [7, 'many'],
    [8, 'many'],
    [9, 'many'],
    [25, 'many'],
    [26, 'many'],
    [99, 'many'],
    [100, 'many'],
    [105, 'many'],
    // 0 → many
    [0, 'many'],
    // teens 11-19 → many (exception: overrides 1/2-4 rule)
    [11, 'many'],
    [12, 'many'],
    [13, 'many'],
    [14, 'many'],
    [15, 'many'],
    [16, 'many'],
    [17, 'many'],
    [18, 'many'],
    [19, 'many'],
    // teens in hundreds → many
    [111, 'many'],
    [112, 'many'],
    [113, 'many'],
    [114, 'many'],
    [119, 'many'],
    [211, 'many'],
    [312, 'many'],
    [1011, 'many'],
    [1014, 'many'],
    // boundary: 20 → many
    [20, 'many'],
  ];

  for (const [n, expected] of cases) {
    test(`${n} → ${expected}`, () => {
      expect(ruPlural(n, 'one', 'few', 'many')).toBe(expected);
    });
  }

  test('returns correct Russian word forms for "событие"', () => {
    expect(ruPlural(1, 'событие', 'события', 'событий')).toBe('событие');
    expect(ruPlural(2, 'событие', 'события', 'событий')).toBe('события');
    expect(ruPlural(5, 'событие', 'события', 'событий')).toBe('событий');
    expect(ruPlural(11, 'событие', 'события', 'событий')).toBe('событий');
    expect(ruPlural(21, 'событие', 'события', 'событий')).toBe('событие');
    expect(ruPlural(0, 'событие', 'события', 'событий')).toBe('событий');
  });
});
