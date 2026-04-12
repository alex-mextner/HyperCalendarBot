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
    is_deleted: 0,
    reminder_overrides: null,
    google_event_id: null,
    google_calendar_id: null,
    google_etag: null,
    sync_status: 'local_only' as const,
    sync_version: 0,
    owner_type: 'user' as const,
    group_id: null,
    created_by: null,
    resolved_address: null,
    latitude: null,
    longitude: null,
    google_maps_url: null,
    location_verified: 0,
    venue_name: null,
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

  test('returns empty array for invalid start_at date instead of crashing', () => {
    const template = makeTemplate({
      start_at: '2027-00-00T00:00:00Z',
      recurrence_rule: 'FREQ=YEARLY',
    });
    const occurrences = expandRecurrence(template, [], '2026-03-01T00:00:00Z', '2027-12-31T23:59:59Z');
    expect(occurrences).toEqual([]);
  });

  describe('DST handling with TZID', () => {
    // Europe/Belgrade: UTC+1 winter, UTC+2 summer. DST switch 2026: last Sunday of March = March 29.
    // At 2:00 AM CET, clocks move forward to 3:00 AM CEST.

    test('weekly event preserves local time across DST transition', () => {
      // English lesson at 12:30 Belgrade time, created in winter (UTC+1)
      // 12:30 CET = 11:30 UTC
      const template = makeTemplate({
        start_at: '2026-01-05T11:30:00Z', // Monday, 12:30 Belgrade (CET, UTC+1)
        end_at: '2026-01-05T12:30:00Z', // 13:30 Belgrade
        timezone: 'Europe/Belgrade',
        recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO',
      });

      // Before DST (March 23, still winter)
      const beforeDst = expandRecurrence(template, [], '2026-03-23T00:00:00Z', '2026-03-23T23:59:59Z');
      expect(beforeDst.length).toBe(1);
      // 12:30 CET = 11:30 UTC
      expect(beforeDst[0]!.occurrence_start).toContain('2026-03-23T11:30');
      expect(beforeDst[0]!.occurrence_end).toContain('2026-03-23T12:30');

      // After DST (March 30, summer time)
      const afterDst = expandRecurrence(template, [], '2026-03-30T00:00:00Z', '2026-03-30T23:59:59Z');
      expect(afterDst.length).toBe(1);
      // 12:30 CEST = 10:30 UTC (NOT 11:30 UTC — that would be 13:30 local)
      expect(afterDst[0]!.occurrence_start).toContain('2026-03-30T10:30');
      expect(afterDst[0]!.occurrence_end).toContain('2026-03-30T11:30');
    });

    test('daily event adjusts UTC time on DST boundary day', () => {
      // 09:00 Belgrade time, created in winter
      // 09:00 CET = 08:00 UTC
      const template = makeTemplate({
        start_at: '2026-03-01T08:00:00Z', // 09:00 Belgrade (CET)
        end_at: '2026-03-01T08:30:00Z',
        timezone: 'Europe/Belgrade',
        recurrence_rule: 'FREQ=DAILY',
      });

      // March 28 (winter) and March 30 (summer)
      const occs = expandRecurrence(template, [], '2026-03-28T00:00:00Z', '2026-03-30T23:59:59Z');
      expect(occs.length).toBe(3);

      // March 28: CET (UTC+1) → 09:00 local = 08:00 UTC
      expect(occs[0]!.occurrence_start).toContain('2026-03-28T08:00');
      // March 29 (DST transition day): CEST (UTC+2) → 09:00 local = 07:00 UTC
      expect(occs[1]!.occurrence_start).toContain('2026-03-29T07:00');
      // March 30: CEST (UTC+2) → 09:00 local = 07:00 UTC
      expect(occs[2]!.occurrence_start).toContain('2026-03-30T07:00');
    });

    test('exception matches occurrence across DST transition by local date', () => {
      const template = makeTemplate({
        start_at: '2026-01-05T11:30:00Z', // 12:30 Belgrade (CET)
        end_at: '2026-01-05T12:30:00Z',
        timezone: 'Europe/Belgrade',
        recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO',
      });

      // Exception was created before DST fix — stored with old UTC time (11:30 UTC)
      // but the occurrence after fix is at 10:30 UTC. Should still match by local date.
      const exceptions: CalendarEvent[] = [
        {
          ...makeTemplate({
            id: 2,
            title: 'English (rescheduled)',
            start_at: '2026-03-30T09:00:00Z', // moved to 11:00 Belgrade
            end_at: '2026-03-30T10:00:00Z',
          }),
          parent_event_id: 1,
          original_start_at: '2026-03-30T11:30:00Z', // old UTC (pre-DST-fix value)
          recurrence_rule: null,
        },
      ];

      const occs = expandRecurrence(template, exceptions, '2026-03-30T00:00:00Z', '2026-03-30T23:59:59Z');
      expect(occs.length).toBe(1);
      expect(occs[0]!.event.title).toBe('English (rescheduled)');
      expect(occs[0]!.is_exception).toBe(true);
    });

    test('cancelled exception works across DST transition', () => {
      const template = makeTemplate({
        start_at: '2026-01-05T11:30:00Z',
        timezone: 'Europe/Belgrade',
        recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO',
      });

      const exceptions: CalendarEvent[] = [
        {
          ...makeTemplate({ id: 2, is_cancelled: 1 }),
          parent_event_id: 1,
          original_start_at: '2026-03-30T11:30:00Z', // old UTC
          recurrence_rule: null,
        },
      ];

      const occs = expandRecurrence(template, exceptions, '2026-03-30T00:00:00Z', '2026-03-30T23:59:59Z');
      expect(occs.length).toBe(0);
    });

    test('all-day recurring events stay in UTC (no TZID)', () => {
      const template = makeTemplate({
        start_at: '2026-03-01T00:00:00Z',
        end_at: '2026-03-02T00:00:00Z',
        all_day: 1,
        timezone: 'Europe/Belgrade',
        recurrence_rule: 'FREQ=DAILY',
      });

      const occs = expandRecurrence(template, [], '2026-03-28T00:00:00Z', '2026-03-30T23:59:59Z');
      expect(occs.length).toBe(3);
      // All-day events keep midnight UTC regardless of DST
      expect(occs[0]!.occurrence_start).toContain('2026-03-28T00:00');
      expect(occs[1]!.occurrence_start).toContain('2026-03-29T00:00');
      expect(occs[2]!.occurrence_start).toContain('2026-03-30T00:00');
    });
  });
});
