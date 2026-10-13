import { describe, expect, test } from 'bun:test';
import { gcalColorId, googleToLocal, localToGoogle } from '../../../src/services/google/event-mapper.ts';

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

    test('maps known colorId to its hex code', () => {
      const result = googleToLocal(
        {
          id: 'g-color',
          summary: 'Tomato Event',
          start: { dateTime: '2026-03-15T10:00:00Z' },
          end: { dateTime: '2026-03-15T11:00:00Z' },
          status: 'confirmed',
          colorId: '1',
        },
        42,
        'primary',
      );
      expect(result.color).toBe('#D50000');
    });

    test('maps every documented GCal colorId to its hex code', () => {
      const expected: Record<string, string> = {
        '1': '#D50000',
        '2': '#E67C73',
        '3': '#F4511E',
        '4': '#F6BF26',
        '5': '#33B679',
        '6': '#0B8043',
        '7': '#039BE5',
        '8': '#3F51B5',
        '9': '#7986CB',
        '10': '#8E24AA',
        '11': '#616161',
      };
      for (const [colorId, hex] of Object.entries(expected)) {
        const result = googleToLocal(
          {
            id: `g-color-${colorId}`,
            start: { dateTime: '2026-03-15T10:00:00Z' },
            end: { dateTime: '2026-03-15T11:00:00Z' },
            status: 'confirmed',
            colorId,
          },
          42,
          'primary',
        );
        expect(result.color).toBe(hex);
      }
    });

    test('unknown colorId maps to null', () => {
      const result = googleToLocal(
        {
          id: 'g-unknown-color',
          start: { dateTime: '2026-03-15T10:00:00Z' },
          end: { dateTime: '2026-03-15T11:00:00Z' },
          status: 'confirmed',
          colorId: '99',
        },
        42,
        'primary',
      );
      expect(result.color).toBeNull();
    });

    test('a colorId naming an Object prototype member maps to null, never a function or object', () => {
      for (const colorId of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
        const result = googleToLocal(
          { id: 'g-proto', start: { dateTime: '2026-03-15T10:00:00Z' }, status: 'confirmed', colorId },
          42,
          'primary',
        );
        expect(result.color).toBeNull();
      }
    });

    test('gcalColorId maps a stored palette hex back to its colorId and anything else to undefined', () => {
      expect(gcalColorId('#D50000')).toBe('1');
      expect(gcalColorId('#8E24AA')).toBe('10');
      expect(gcalColorId(null)).toBeUndefined();
      expect(gcalColorId('#123456')).toBeUndefined();
    });

    test('missing colorId maps to null', () => {
      const result = googleToLocal(
        {
          id: 'g-no-color',
          start: { dateTime: '2026-03-15T10:00:00Z' },
          end: { dateTime: '2026-03-15T11:00:00Z' },
          status: 'confirmed',
        },
        42,
        'primary',
      );
      expect(result.color).toBeNull();
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
