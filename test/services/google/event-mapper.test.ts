import { describe, expect, test } from 'bun:test';
import { googleToLocal, localToGoogle } from '../../../src/services/google/event-mapper.ts';

describe('event-mapper', () => {
  describe('localToGoogle', () => {
    test('maps timed event', () => {
      const result = localToGoogle({
        id: 1,
        title: 'Meeting',
        description: 'Team sync',
        start_at: '2026-03-15T10:00:00Z',
        end_at: '2026-03-15T11:00:00Z',
        all_day: 0,
        timezone: 'Europe/Kyiv',
        location: 'Office',
        resolved_address: null,
        venue_name: null,
        location_verified: 0,
        recurrence_rule: null,
        reminder_overrides: null,
        sync_version: 1,
      });
      expect(result.summary).toBe('Meeting');
      expect(result.description).toBe('Team sync');
      expect(result.location).toBe('Office');
      expect(result.start?.dateTime).toBe('2026-03-15T10:00:00Z');
      expect(result.start?.timeZone).toBe('Europe/Kyiv');
      expect(result.end?.dateTime).toBe('2026-03-15T11:00:00Z');
    });

    test('maps all-day event', () => {
      const result = localToGoogle({
        id: 2,
        title: 'Holiday',
        start_at: '2026-03-15T00:00:00Z',
        end_at: '2026-03-16T00:00:00Z',
        all_day: 1,
        timezone: 'UTC',
        description: null,
        location: null,
        resolved_address: null,
        venue_name: null,
        location_verified: 0,
        recurrence_rule: null,
        reminder_overrides: null,
        sync_version: 0,
      });
      expect(result.start?.date).toBe('2026-03-15');
      expect(result.end?.date).toBe('2026-03-16');
      expect(result.start?.dateTime).toBeUndefined();
    });

    test('single-day all-day event with end_at == start_at gets end.date bumped +1 day', () => {
      const result = localToGoogle({
        id: 2,
        title: 'Birthday',
        start_at: '2026-03-15T00:00:00Z',
        end_at: '2026-03-15T00:00:00Z',
        all_day: 1,
        timezone: 'UTC',
        description: null,
        location: null,
        resolved_address: null,
        venue_name: null,
        location_verified: 0,
        recurrence_rule: null,
        reminder_overrides: null,
        sync_version: 0,
      });
      expect(result.start?.date).toBe('2026-03-15');
      expect(result.end?.date).toBe('2026-03-16');
    });

    test('single-day all-day event with null end_at gets end.date bumped +1 day', () => {
      const result = localToGoogle({
        id: 2,
        title: 'Holiday',
        start_at: '2026-03-15T00:00:00Z',
        end_at: null,
        all_day: 1,
        timezone: 'UTC',
        description: null,
        location: null,
        resolved_address: null,
        venue_name: null,
        location_verified: 0,
        recurrence_rule: null,
        reminder_overrides: null,
        sync_version: 0,
      });
      expect(result.start?.date).toBe('2026-03-15');
      expect(result.end?.date).toBe('2026-03-16');
    });

    test('maps recurrence rule', () => {
      const result = localToGoogle({
        id: 3,
        title: 'Weekly',
        start_at: '2026-03-15T10:00:00Z',
        end_at: '2026-03-15T11:00:00Z',
        all_day: 0,
        timezone: 'UTC',
        description: null,
        location: null,
        resolved_address: null,
        venue_name: null,
        location_verified: 0,
        recurrence_rule: 'RRULE:FREQ=WEEKLY;BYDAY=MO',
        reminder_overrides: null,
        sync_version: 0,
      });
      expect(result.recurrence).toEqual(['RRULE:FREQ=WEEKLY;BYDAY=MO']);
    });

    test('splits multi-line recurrence_rule back into array for Google', () => {
      const result = localToGoogle({
        id: 4,
        title: 'Weekly with exception',
        start_at: '2026-04-07T09:00:00Z',
        end_at: '2026-04-07T10:00:00Z',
        all_day: 0,
        timezone: 'Europe/Moscow',
        description: null,
        location: null,
        resolved_address: null,
        venue_name: null,
        location_verified: 0,
        recurrence_rule: 'RRULE:FREQ=WEEKLY\nEXDATE;TZID=Europe/Moscow:20260401T090000',
        reminder_overrides: null,
        sync_version: 1,
      });
      expect(result.recurrence).toEqual(['RRULE:FREQ=WEEKLY', 'EXDATE;TZID=Europe/Moscow:20260401T090000']);
    });

    test('normalizes a locally-created bare rule (no RRULE: prefix) before export', () => {
      // recurrence-google-roundtrip-003
      const result = localToGoogle({
        id: 5,
        title: 'Bare rule',
        start_at: '2026-03-15T10:00:00Z',
        end_at: '2026-03-15T11:00:00Z',
        all_day: 0,
        timezone: 'UTC',
        description: null,
        location: null,
        resolved_address: null,
        venue_name: null,
        location_verified: 0,
        recurrence_rule: 'FREQ=WEEKLY;INTERVAL=1;COUNT=6',
        reminder_overrides: null,
        sync_version: 0,
      });
      expect(result.recurrence).toEqual(['RRULE:FREQ=WEEKLY;INTERVAL=1;COUNT=6']);
    });

    test('an unsupported multi-RRULE series falls back to the raw line split, never clears the field', () => {
      // `events.update` is a full-resource replace — omitting `recurrence` here would delete
      // an existing Google series, not just fail to improve it (found in review).
      const result = localToGoogle({
        id: 6,
        title: 'Bad series',
        start_at: '2026-03-15T10:00:00Z',
        end_at: '2026-03-15T11:00:00Z',
        all_day: 0,
        timezone: 'UTC',
        description: null,
        location: null,
        resolved_address: null,
        venue_name: null,
        location_verified: 0,
        recurrence_rule: 'RRULE:FREQ=WEEKLY;COUNT=6\nRRULE:FREQ=DAILY;COUNT=3',
        reminder_overrides: null,
        sync_version: 0,
      });
      expect(result.recurrence).toEqual(['RRULE:FREQ=WEEKLY;COUNT=6', 'RRULE:FREQ=DAILY;COUNT=3']);
      expect(result.summary).toBe('Bad series');
    });

    test('sets extended properties with local event ID', () => {
      const result = localToGoogle({
        id: 42,
        title: 'Test',
        start_at: '2026-03-15T10:00:00Z',
        end_at: '2026-03-15T11:00:00Z',
        all_day: 0,
        timezone: 'UTC',
        description: null,
        location: null,
        resolved_address: null,
        venue_name: null,
        location_verified: 0,
        recurrence_rule: null,
        reminder_overrides: null,
        sync_version: 3,
      });
      expect(result.extendedProperties?.private?.hypercalendarbot_event_id).toBe('42');
      expect(result.extendedProperties?.private?.hypercalendarbot_version).toBe('3');
    });

    test('maps reminder overrides', () => {
      const result = localToGoogle({
        id: 1,
        title: 'Test',
        start_at: '2026-03-15T10:00:00Z',
        end_at: '2026-03-15T11:00:00Z',
        all_day: 0,
        timezone: 'UTC',
        description: null,
        location: null,
        resolved_address: null,
        venue_name: null,
        location_verified: 0,
        recurrence_rule: null,
        reminder_overrides: '[5, 30]',
        sync_version: 0,
      });
      expect(result.reminders?.useDefault).toBe(false);
      expect(result.reminders?.overrides).toEqual([
        { method: 'popup', minutes: 5 },
        { method: 'popup', minutes: 30 },
      ]);
    });

    describe('location', () => {
      const geocoded = {
        id: 5,
        title: 'Обед',
        start_at: '2026-03-15T10:00:00Z',
        end_at: '2026-03-15T11:00:00Z',
        all_day: 0,
        timezone: 'Europe/Moscow',
        description: null,
        location: 'кафе у парка',
        resolved_address: 'ул. Примерная, 1, Москва',
        venue_name: 'Кафе Ромашка',
        recurrence_rule: null,
        reminder_overrides: null,
        sync_version: 1,
      };

      test('verified location sends the venue and resolved address for Google to geocode', () => {
        const result = localToGoogle({ ...geocoded, location_verified: 1 });
        expect(result.location).toBe('Кафе Ромашка — ул. Примерная, 1, Москва');
      });

      test('verified location without a venue sends the resolved address', () => {
        const result = localToGoogle({ ...geocoded, venue_name: null, location_verified: 1 });
        expect(result.location).toBe('ул. Примерная, 1, Москва');
      });

      test('unverified location sends exactly the typed text, never the geocode', () => {
        const result = localToGoogle({ ...geocoded, location_verified: 0 });
        expect(result.location).toBe('кафе у парка');
      });
    });
  });

  describe('googleToLocal', () => {
    test('maps timed event', () => {
      const result = googleToLocal(
        {
          id: 'g123',
          etag: '"etag1"',
          summary: 'Meeting',
          description: 'Notes',
          location: 'Room A',
          start: { dateTime: '2026-03-15T10:00:00+02:00', timeZone: 'Europe/Kyiv' },
          end: { dateTime: '2026-03-15T11:00:00+02:00', timeZone: 'Europe/Kyiv' },
          status: 'confirmed',
        },
        42,
        'primary',
      );
      expect(result.title).toBe('Meeting');
      expect(result.google_event_id).toBe('g123');
      expect(result.google_etag).toBe('"etag1"');
      expect(result.all_day).toBe(false);
      expect(result.timezone).toBe('Europe/Kyiv');
    });

    test('maps all-day event', () => {
      const result = googleToLocal(
        {
          id: 'g456',
          summary: 'Day Off',
          start: { date: '2026-03-15' },
          end: { date: '2026-03-16' },
          status: 'confirmed',
        },
        42,
        'primary',
      );
      expect(result.all_day).toBe(true);
      expect(result.start_at).toBe('2026-03-15');
      expect(result.end_at).toBe('2026-03-16');
    });

    test('defaults title to Untitled', () => {
      const result = googleToLocal(
        {
          id: 'g789',
          start: { dateTime: '2026-03-15T10:00:00Z' },
          end: { dateTime: '2026-03-15T11:00:00Z' },
          status: 'confirmed',
        },
        42,
        'primary',
      );
      expect(result.title).toBe('Untitled');
    });

    test('detects cancelled status', () => {
      const result = googleToLocal(
        {
          id: 'g000',
          status: 'cancelled',
          start: { dateTime: '2026-03-15T10:00:00Z' },
          end: { dateTime: '2026-03-15T11:00:00Z' },
        },
        42,
        'primary',
      );
      expect(result.is_cancelled).toBe(true);
    });

    test('preserves all recurrence components (RRULE + EXDATE) joined by newline', () => {
      const result = googleToLocal(
        {
          id: 'g-rec',
          summary: 'Weekly',
          start: { dateTime: '2026-04-07T09:00:00Z', timeZone: 'Europe/Moscow' },
          end: { dateTime: '2026-04-07T10:00:00Z', timeZone: 'Europe/Moscow' },
          status: 'confirmed',
          recurrence: ['RRULE:FREQ=WEEKLY', 'EXDATE;TZID=Europe/Moscow:20260401T090000'],
        },
        42,
        'primary',
      );
      expect(result.recurrence_rule).toBe('RRULE:FREQ=WEEKLY\nEXDATE;TZID=Europe/Moscow:20260401T090000');
    });

    test('rejects a multiple-RRULE recurring event instead of silently taking the first line', () => {
      const result = googleToLocal(
        {
          id: 'g-multi',
          summary: 'Bad series',
          start: { dateTime: '2026-01-01T10:00:00Z' },
          end: { dateTime: '2026-01-01T11:00:00Z' },
          status: 'confirmed',
          recurrence: ['RRULE:FREQ=WEEKLY;COUNT=6', 'RRULE:FREQ=DAILY;COUNT=3'],
        },
        42,
        'primary',
      );
      expect(result.recurrence_rule).toBeNull();
      expect(result.recurrenceUnsupportedReason).toBe('multi_rrule_unsupported');
      // The event itself still syncs as a one-off, not dropped entirely.
      expect(result.title).toBe('Bad series');
    });

    test('rejects EXRULE instead of silently dropping or applying it', () => {
      // recurrence-exrule-reject-002
      const result = googleToLocal(
        {
          id: 'g-exrule',
          summary: 'Legacy series',
          start: { dateTime: '2026-01-01T10:00:00Z' },
          end: { dateTime: '2026-01-01T11:00:00Z' },
          status: 'confirmed',
          recurrence: ['RRULE:FREQ=WEEKLY;COUNT=6', 'EXRULE:FREQ=WEEKLY;COUNT=2'],
        },
        42,
        'primary',
      );
      expect(result.recurrence_rule).toBeNull();
      expect(result.recurrenceUnsupportedReason).toBe('exrule_unsupported');
    });

    test('EXDATE/RDATE round-trip: export then re-import preserves the full recurrence set', () => {
      // recurrence-google-roundtrip-001
      const exported = localToGoogle({
        id: 7,
        title: 'Weekly',
        start_at: '2026-01-06T10:00:00Z',
        end_at: '2026-01-06T11:00:00Z',
        all_day: 0,
        timezone: 'UTC',
        description: null,
        location: null,
        resolved_address: null,
        venue_name: null,
        location_verified: 0,
        recurrence_rule: 'RRULE:FREQ=WEEKLY;INTERVAL=1;COUNT=6\nEXDATE:20260113T100000Z\nRDATE:20260301T100000Z',
        reminder_overrides: null,
        sync_version: 0,
      });

      const reimported = googleToLocal(
        {
          id: 'g-roundtrip',
          summary: exported.summary,
          start: exported.start,
          end: exported.end,
          status: 'confirmed',
          recurrence: exported.recurrence,
        },
        42,
        'primary',
      );

      expect(reimported.recurrence_rule).toBe(
        'RRULE:FREQ=WEEKLY;INTERVAL=1;COUNT=6\nEXDATE:20260113T100000Z\nRDATE:20260301T100000Z',
      );
      expect(reimported.recurrenceUnsupportedReason).toBeUndefined();
    });
  });
});

describe('localToGoogle — reminder_overrides resilience', () => {
  const baseEvent = {
    id: 1,
    title: 'Test',
    start_at: '2026-03-15T10:00:00Z',
    end_at: '2026-03-15T11:00:00Z',
    all_day: 0 as const,
    timezone: 'UTC',
    description: null,
    location: null,
    resolved_address: null,
    venue_name: null,
    location_verified: 0,
    recurrence_rule: null,
    sync_version: 0,
  };

  test('invalid JSON in reminder_overrides does not throw', () => {
    expect(() => localToGoogle({ ...baseEvent, reminder_overrides: 'not-valid-json' })).not.toThrow();
  });

  test('invalid JSON yields no reminders field', () => {
    const result = localToGoogle({ ...baseEvent, reminder_overrides: '{broken' });
    expect(result.reminders).toBeUndefined();
  });

  test('null reminder_overrides yields no reminders field', () => {
    const result = localToGoogle({ ...baseEvent, reminder_overrides: null });
    expect(result.reminders).toBeUndefined();
  });

  test('valid JSON still maps correctly after guard', () => {
    const result = localToGoogle({ ...baseEvent, reminder_overrides: '[10, 60]' });
    expect(result.reminders?.overrides).toEqual([
      { method: 'popup', minutes: 10 },
      { method: 'popup', minutes: 60 },
    ]);
  });
});

describe('localToGoogle — reminder_overrides resilience', () => {
  const baseEvent = {
    id: 1,
    title: 'Test',
    start_at: '2026-03-15T10:00:00Z',
    end_at: '2026-03-15T11:00:00Z',
    all_day: 0 as const,
    timezone: 'UTC',
    description: null,
    location: null,
    resolved_address: null,
    venue_name: null,
    location_verified: 0,
    recurrence_rule: null,
    sync_version: 0,
  };

  test('invalid JSON in reminder_overrides does not throw', () => {
    expect(() => localToGoogle({ ...baseEvent, reminder_overrides: 'not-valid-json' })).not.toThrow();
  });

  test('invalid JSON yields no reminders field', () => {
    const result = localToGoogle({ ...baseEvent, reminder_overrides: '{broken' });
    expect(result.reminders).toBeUndefined();
  });

  test('null reminder_overrides yields no reminders field', () => {
    const result = localToGoogle({ ...baseEvent, reminder_overrides: null });
    expect(result.reminders).toBeUndefined();
  });

  test('valid JSON still maps correctly after guard', () => {
    const result = localToGoogle({ ...baseEvent, reminder_overrides: '[10, 60]' });
    expect(result.reminders?.overrides).toEqual([
      { method: 'popup', minutes: 10 },
      { method: 'popup', minutes: 60 },
    ]);
  });
});
