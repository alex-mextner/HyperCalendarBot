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
        recurrence_rule: 'RRULE:FREQ=WEEKLY;BYDAY=MO',
        reminder_overrides: null,
        sync_version: 0,
      });
      expect(result.recurrence).toEqual(['RRULE:FREQ=WEEKLY;BYDAY=MO']);
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
