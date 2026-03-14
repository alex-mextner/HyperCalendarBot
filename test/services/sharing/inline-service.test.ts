import { describe, expect, test } from 'bun:test';
import type { CalendarEvent, EventOccurrence, Visibility } from '../../../src/database/types';
import { InlineService } from '../../../src/services/sharing/inline-service';

function makeOccurrence(
  overrides: Partial<CalendarEvent> & { id: number; title: string; start_at: string; timezone: string },
): EventOccurrence {
  return {
    event: {
      id: overrides.id,
      user_id: overrides.user_id ?? 100,
      title: overrides.title,
      description: overrides.description ?? null,
      category: overrides.category ?? null,
      start_at: overrides.start_at,
      end_at: overrides.end_at ?? null,
      all_day: overrides.all_day ?? 0,
      timezone: overrides.timezone,
      location: overrides.location ?? null,
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
      last_synced_at: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
    occurrence_start: overrides.start_at,
    occurrence_end: overrides.end_at ?? null,
    is_exception: false,
  };
}

describe('InlineService', () => {
  describe('parseQuery', () => {
    test('empty query returns agenda_today intent', () => {
      const service = new InlineService(
        { getEventsForDay: () => [] } as never,
        { resolveVisibility: () => 'full' } as never,
      );
      const intent = service.parseQuery('');
      expect(intent.type).toBe('agenda_today');
    });

    test('"today" returns agenda_today', () => {
      const service = new InlineService(
        { getEventsForDay: () => [] } as never,
        { resolveVisibility: () => 'full' } as never,
      );
      const intent = service.parseQuery('today');
      expect(intent.type).toBe('agenda_today');
    });

    test('"tomorrow" returns agenda_tomorrow', () => {
      const service = new InlineService(
        { getEventsForDay: () => [] } as never,
        { resolveVisibility: () => 'full' } as never,
      );
      const intent = service.parseQuery('tomorrow');
      expect(intent.type).toBe('agenda_tomorrow');
    });

    test('"week" returns agenda_week', () => {
      const service = new InlineService(
        { getEventsForDay: () => [] } as never,
        { resolveVisibility: () => 'full' } as never,
      );
      const intent = service.parseQuery('week');
      expect(intent.type).toBe('agenda_week');
    });

    test('arbitrary text returns search intent', () => {
      const service = new InlineService(
        { getEventsForDay: () => [] } as never,
        { resolveVisibility: () => 'full' } as never,
      );
      const intent = service.parseQuery('meeting with John');
      expect(intent.type).toBe('search');
      expect(intent.query).toBe('meeting with John');
    });

    test('query parsing is case-insensitive', () => {
      const service = new InlineService(
        { getEventsForDay: () => [] } as never,
        { resolveVisibility: () => 'full' } as never,
      );
      expect(service.parseQuery('Today').type).toBe('agenda_today');
      expect(service.parseQuery('TOMORROW').type).toBe('agenda_tomorrow');
      expect(service.parseQuery('Week').type).toBe('agenda_week');
    });

    test('whitespace-only query returns agenda_today', () => {
      const service = new InlineService(
        { getEventsForDay: () => [] } as never,
        { resolveVisibility: () => 'full' } as never,
      );
      const intent = service.parseQuery('   ');
      expect(intent.type).toBe('agenda_today');
    });
  });

  describe('buildResults', () => {
    test('returns empty array when no events', () => {
      const eventService = {
        getEventsForDay: () => [] as EventOccurrence[],
        getEventsForWeek: () => [] as EventOccurrence[],
        searchEvents: () => [],
      };
      const privacyService = {
        resolveVisibility: () => 'full' as Visibility,
      };
      const service = new InlineService(eventService as never, privacyService as never);
      const results = service.buildResults(100, { type: 'agenda_today' as const }, 'UTC');
      expect(results).toHaveLength(0);
    });

    test('builds article results for events', () => {
      const eventService = {
        getEventsForDay: () => [
          makeOccurrence({
            id: 1,
            title: 'Meeting',
            start_at: '2026-03-15T10:00:00Z',
            end_at: '2026-03-15T11:00:00Z',
            timezone: 'UTC',
          }),
        ],
        getEventsForWeek: () => [] as EventOccurrence[],
        searchEvents: () => [],
      };
      const privacyService = {
        resolveVisibility: () => 'full' as Visibility,
      };
      const service = new InlineService(eventService as never, privacyService as never);
      const results = service.buildResults(100, { type: 'agenda_today' as const }, 'UTC');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].type).toBe('article');
      expect(results[0].title).toContain('Meeting');
    });

    test('filters private events', () => {
      const eventService = {
        getEventsForDay: () => [
          makeOccurrence({
            id: 1,
            title: 'Secret',
            start_at: '2026-03-15T10:00:00Z',
            timezone: 'UTC',
          }),
        ],
        getEventsForWeek: () => [] as EventOccurrence[],
        searchEvents: () => [],
      };
      const privacyService = {
        resolveVisibility: () => 'private' as Visibility,
      };
      const service = new InlineService(eventService as never, privacyService as never);
      const results = service.buildResults(100, { type: 'agenda_today' as const }, 'UTC');
      expect(results).toHaveLength(0);
    });

    test('shows "Busy" for free_busy events', () => {
      const eventService = {
        getEventsForDay: () => [
          makeOccurrence({
            id: 1,
            title: 'Private stuff',
            start_at: '2026-03-15T10:00:00Z',
            timezone: 'UTC',
          }),
        ],
        getEventsForWeek: () => [] as EventOccurrence[],
        searchEvents: () => [],
      };
      const privacyService = {
        resolveVisibility: () => 'free_busy' as Visibility,
      };
      const service = new InlineService(eventService as never, privacyService as never);
      const results = service.buildResults(100, { type: 'agenda_today' as const }, 'UTC');
      expect(results).toHaveLength(1);
      expect(results[0].title).toContain('Busy');
      expect(results[0].title).not.toContain('Private stuff');
    });

    test('week intent uses getEventsForWeek', () => {
      let weekCalled = false;
      const eventService = {
        getEventsForDay: () => [] as EventOccurrence[],
        getEventsForWeek: () => {
          weekCalled = true;
          return [
            makeOccurrence({
              id: 2,
              title: 'Weekly standup',
              start_at: '2026-03-16T09:00:00Z',
              timezone: 'UTC',
            }),
          ];
        },
        searchEvents: () => [],
      };
      const privacyService = {
        resolveVisibility: () => 'full' as Visibility,
      };
      const service = new InlineService(eventService as never, privacyService as never);
      const results = service.buildResults(100, { type: 'agenda_week' as const }, 'UTC');
      expect(weekCalled).toBe(true);
      expect(results).toHaveLength(1);
      expect(results[0].title).toContain('Weekly standup');
    });

    test('search intent uses searchEvents', () => {
      let searchQuery = '';
      const eventService = {
        getEventsForDay: () => [] as EventOccurrence[],
        getEventsForWeek: () => [] as EventOccurrence[],
        searchEvents: (userId: number, query: string) => {
          searchQuery = query;
          return [
            {
              id: 3,
              user_id: userId,
              title: 'Dentist appointment',
              start_at: '2026-03-20T14:00:00Z',
              timezone: 'UTC',
            },
          ];
        },
      };
      const privacyService = {
        resolveVisibility: () => 'full' as Visibility,
      };
      const service = new InlineService(eventService as never, privacyService as never);
      const results = service.buildResults(100, { type: 'search' as const, query: 'dentist' }, 'UTC');
      expect(searchQuery).toBe('dentist');
      expect(results).toHaveLength(1);
      expect(results[0].title).toContain('Dentist appointment');
    });

    test('result ids are unique', () => {
      const eventService = {
        getEventsForDay: () => [
          makeOccurrence({ id: 1, title: 'A', start_at: '2026-03-15T08:00:00Z', timezone: 'UTC' }),
          makeOccurrence({ id: 2, title: 'B', start_at: '2026-03-15T09:00:00Z', timezone: 'UTC' }),
        ],
        getEventsForWeek: () => [] as EventOccurrence[],
        searchEvents: () => [],
      };
      const privacyService = {
        resolveVisibility: () => 'full' as Visibility,
      };
      const service = new InlineService(eventService as never, privacyService as never);
      const results = service.buildResults(100, { type: 'agenda_today' as const }, 'UTC');
      const ids = results.map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });
});
