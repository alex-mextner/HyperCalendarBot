import { describe, expect, test } from 'bun:test';
import type { CalendarEvent } from '../../../src/database/types.ts';
import { expandRecurrence } from '../../../src/services/event/recurrence.ts';

function makeTemplate(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 1,
    user_id: 123,
    title: 'Daily standup',
    description: null,
    category: null,
    start_at: '2026-03-01T09:00:00Z',
    end_at: '2026-03-01T09:30:00Z',
    all_day: 0,
    timezone: 'UTC',
    location: null,
    recurrence_rule: 'FREQ=DAILY',
    recurrence_end_at: null,
    parent_event_id: null,
    original_start_at: null,
    is_cancelled: 0,
    reminder_overrides: null,
    google_event_id: null,
    google_calendar_id: null,
    last_synced_at: null,
    created_at: '2026-03-01T00:00:00Z',
    updated_at: '2026-03-01T00:00:00Z',
    ...overrides,
  };
}

describe('expandRecurrence', () => {
  test('expands daily rule within range', () => {
    const template = makeTemplate({ recurrence_rule: 'FREQ=DAILY' });
    const occurrences = expandRecurrence(template, [], '2026-03-10T00:00:00Z', '2026-03-12T23:59:59Z');
    expect(occurrences.length).toBe(3);
    expect(occurrences[0]!.occurrence_start).toContain('2026-03-10T09:00');
    expect(occurrences[0]!.is_exception).toBe(false);
  });

  test('expands weekly rule with BYDAY', () => {
    const template = makeTemplate({
      start_at: '2026-03-02T09:00:00Z',
      recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR',
    });
    const occurrences = expandRecurrence(template, [], '2026-03-09T00:00:00Z', '2026-03-15T23:59:59Z');
    expect(occurrences.length).toBe(3);
  });

  test('respects COUNT limit', () => {
    const template = makeTemplate({ recurrence_rule: 'FREQ=DAILY;COUNT=5' });
    const occurrences = expandRecurrence(template, [], '2026-03-01T00:00:00Z', '2026-12-31T23:59:59Z');
    expect(occurrences.length).toBe(5);
  });

  test('applies exception (modified occurrence)', () => {
    const template = makeTemplate({ recurrence_rule: 'FREQ=DAILY' });
    const exceptions: CalendarEvent[] = [
      {
        ...makeTemplate({ id: 2, title: 'Modified standup' }),
        parent_event_id: 1,
        original_start_at: '2026-03-11T09:00:00Z',
        start_at: '2026-03-11T10:00:00Z',
        recurrence_rule: null,
      },
    ];
    const occurrences = expandRecurrence(template, exceptions, '2026-03-10T00:00:00Z', '2026-03-12T23:59:59Z');
    const mar11 = occurrences.find((o) => o.occurrence_start.includes('2026-03-11'));
    expect(mar11).toBeDefined();
    expect(mar11!.event.title).toBe('Modified standup');
    expect(mar11!.is_exception).toBe(true);
  });

  test('applies cancelled exception', () => {
    const template = makeTemplate({ recurrence_rule: 'FREQ=DAILY' });
    const exceptions: CalendarEvent[] = [
      {
        ...makeTemplate({ id: 2, is_cancelled: 1 }),
        parent_event_id: 1,
        original_start_at: '2026-03-11T09:00:00Z',
        recurrence_rule: null,
      },
    ];
    const occurrences = expandRecurrence(template, exceptions, '2026-03-10T00:00:00Z', '2026-03-12T23:59:59Z');
    expect(occurrences.length).toBe(2);
  });

  test('computes occurrence_end from template duration', () => {
    const template = makeTemplate({
      recurrence_rule: 'FREQ=DAILY',
      end_at: '2026-03-01T09:30:00Z',
    });
    const occurrences = expandRecurrence(template, [], '2026-03-10T00:00:00Z', '2026-03-10T23:59:59Z');
    expect(occurrences[0]!.occurrence_end).toContain('2026-03-10T09:30');
  });
});
