// test/database/repositories/event-location-change.test.ts
//
// Regression for #395: an event stores the typed location plus a resolved
// place (venue, address, coordinates, map link, verified flag). Changing the
// typed location must drop the old resolved place in the same write, otherwise
// every card, invitation and agenda keeps showing the previous venue and a map
// link to it.

import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { GoogleCalendarRepository } from '../../../src/database/repositories/google-calendar.repository.ts';
import { GoogleSyncRepository } from '../../../src/database/repositories/google-sync.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import type { CalendarEvent } from '../../../src/database/types.ts';
import { handleUpdateEvent } from '../../../src/services/ai/tool-handlers/events.ts';
import type { AgentContext } from '../../../src/services/ai/types.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import { formatDayAgenda, formatEventDetail, formatInvitation } from '../../../src/services/event/formatters.ts';
import type { GoogleCalendarApi } from '../../../src/services/google/calendar-api.ts';
import { SyncService } from '../../../src/services/google/sync-service.ts';
import { formatLocationHtml } from '../../../src/services/location/format-location.ts';

const USER_ID = 501;
const GROUP_ID = -100777;

const OLD_PLACE = {
  resolved_address: 'Example Boulevard 7, Sampletown',
  latitude: 52.11,
  longitude: 4.28,
  google_maps_url: 'https://www.google.com/maps/place/?q=place_id:SYNTHETIC_OLD_PLACE',
  location_verified: 1,
  venue_name: 'Seaside Hotel Example',
};

type ResolvedColumns = Pick<
  CalendarEvent,
  'location' | 'resolved_address' | 'latitude' | 'longitude' | 'google_maps_url' | 'location_verified' | 'venue_name'
>;

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

function readColumns(db: Database, id: number): ResolvedColumns {
  const row = db
    .prepare(
      `SELECT location, resolved_address, latitude, longitude, google_maps_url, location_verified, venue_name
       FROM events WHERE id = ?`,
    )
    .get(id) as ResolvedColumns | null;
  if (!row) throw new Error(`event ${id} not found`);
  return row;
}

function expectCleared(columns: ResolvedColumns, location: string | null): void {
  expect(columns).toEqual({
    location,
    resolved_address: null,
    latitude: null,
    longitude: null,
    google_maps_url: null,
    location_verified: 0,
    venue_name: null,
  });
}

function expectOldPlace(columns: ResolvedColumns, location: string): void {
  expect(columns).toEqual({ location, ...OLD_PLACE });
}

/** Centralized partial-context factory: handlers only read the fields supplied here. */
function makeAgentCtx(partial: Partial<AgentContext>): AgentContext {
  return partial as unknown as AgentContext;
}

/** Centralized partial Google API factory: incremental pull only calls listEvents. */
function makeGoogleApi(events: { id: string; summary: string; location?: string }[]): GoogleCalendarApi {
  const listEvents = mock(() =>
    Promise.resolve({
      events: events.map((e) => ({
        ...e,
        start: { dateTime: '2026-10-05T17:00:00Z' },
        end: { dateTime: '2026-10-05T18:00:00Z' },
        etag: '"e2"',
        updated: '2026-09-27T10:00:00Z',
      })),
      nextSyncToken: 'token-2',
      nextPageToken: undefined,
    }),
  );
  return { listEvents } as unknown as GoogleCalendarApi;
}

describe('changing an event location drops the old resolved place (#395)', () => {
  let db: Database;
  let events: EventRepository;
  let service: EventService;

  beforeEach(() => {
    db = createTestDb();
    new UserRepository(db).create({ telegram_id: USER_ID, timezone: 'UTC' });
    events = new EventRepository(db);
    service = new EventService({ eventRepo: events });
  });

  function resolvedEvent(extra: { owner_type?: 'group'; group_id?: number; created_by?: number } = {}) {
    const event = events.create({
      user_id: USER_ID,
      title: 'Dinner',
      start_at: '2026-10-05T17:00:00Z',
      end_at: '2026-10-05T18:00:00Z',
      timezone: 'UTC',
      location: 'seaside hotel',
      ...extra,
    });
    events.updateLocationFields(event.id, OLD_PLACE);
    expectOldPlace(readColumns(db, event.id), 'seaside hotel');
    return event;
  }

  describe('EventRepository write boundary', () => {
    test('a different location text clears every resolved field in the same write', () => {
      const event = resolvedEvent();
      const returned = events.update(event.id, USER_ID, { location: 'дома' });

      expectCleared(readColumns(db, event.id), 'дома');
      expect(returned?.venue_name).toBeNull();
      expect(returned?.google_maps_url).toBeNull();
    });

    test('clearing the location clears every resolved field', () => {
      const event = resolvedEvent();
      events.update(event.id, USER_ID, { location: null });

      expectCleared(readColumns(db, event.id), null);
    });

    test('rewriting the same location text keeps the resolved place', () => {
      const event = resolvedEvent();
      events.update(event.id, USER_ID, { location: 'seaside hotel', title: 'Dinner with friends' });

      expectOldPlace(readColumns(db, event.id), 'seaside hotel');
    });

    test('an update that does not touch the location keeps the resolved place', () => {
      const event = resolvedEvent();
      events.update(event.id, USER_ID, { title: 'Late dinner' });

      expectOldPlace(readColumns(db, event.id), 'seaside hotel');
    });

    test('an explicitly supplied resolved place is written with the new location', () => {
      const event = resolvedEvent();
      events.update(event.id, USER_ID, {
        location: 'harbour cafe',
        resolved_address: 'Pier 3, Sampletown',
        latitude: 52.2,
        longitude: 4.3,
        google_maps_url: 'https://www.google.com/maps/place/?q=place_id:SYNTHETIC_NEW_PLACE',
        location_verified: 1,
        venue_name: 'Harbour Cafe Example',
      });

      expect(readColumns(db, event.id)).toEqual({
        location: 'harbour cafe',
        resolved_address: 'Pier 3, Sampletown',
        latitude: 52.2,
        longitude: 4.3,
        google_maps_url: 'https://www.google.com/maps/place/?q=place_id:SYNTHETIC_NEW_PLACE',
        location_verified: 1,
        venue_name: 'Harbour Cafe Example',
      });
    });

    test('a group event location change clears the resolved place', () => {
      const event = resolvedEvent({ owner_type: 'group', group_id: GROUP_ID, created_by: USER_ID });
      events.updateInGroup(event.id, GROUP_ID, { location: 'дома' });

      expectCleared(readColumns(db, event.id), 'дома');
    });
  });

  describe('rendered surfaces after the location changes to a relative place', () => {
    function changedToHome(): CalendarEvent {
      const event = resolvedEvent();
      const updated = service.updateEvent(event.id, USER_ID, { location: 'дома' });
      if (!updated) throw new Error('update returned null');
      return updated;
    }

    function expectOnlyHome(html: string): void {
      expect(html).toContain('дома');
      expect(html).not.toContain(OLD_PLACE.venue_name);
      expect(html).not.toContain(OLD_PLACE.resolved_address);
      expect(html).not.toContain('SYNTHETIC_OLD_PLACE');
    }

    test('location line shows the typed text only', () => {
      const html = formatLocationHtml(changedToHome());
      expectOnlyHome(html);
    });

    test('event card shows the typed text only', () => {
      expectOnlyHome(formatEventDetail(changedToHome(), 'UTC', 'ru'));
    });

    test('invitation text shows the typed text only', () => {
      expectOnlyHome(formatInvitation(changedToHome(), 'UTC', 'ru', 'Alex Example', 9001, null, 'UTC', true));
    });

    test('day agenda shows the typed text only', () => {
      const event = changedToHome();
      const agenda = formatDayAgenda(
        [{ event, occurrence_start: event.start_at, occurrence_end: event.end_at, is_exception: false }],
        '2026-10-05',
        'UTC',
        'ru',
      );
      expectOnlyHome(agenda);
    });
  });

  describe('write paths', () => {
    test('AI update_event with a new location clears the resolved place', async () => {
      const event = resolvedEvent();
      const user = new UserRepository(db).findByTelegramId(USER_ID);
      if (!user) throw new Error('user missing');

      const result = await handleUpdateEvent(makeAgentCtx({ user, eventService: service }), {
        event_id: event.id,
        location: 'дома',
        location_abstract: true,
      });

      expect(result.success).toBe(true);
      expectCleared(readColumns(db, event.id), 'дома');
    });

    test('AI update_event removing the location clears the resolved place', async () => {
      const event = resolvedEvent();
      const user = new UserRepository(db).findByTelegramId(USER_ID);
      if (!user) throw new Error('user missing');

      const result = await handleUpdateEvent(makeAgentCtx({ user, eventService: service }), {
        event_id: event.id,
        location: null,
      });

      expect(result.success).toBe(true);
      expectCleared(readColumns(db, event.id), null);
    });

    describe('Google Calendar incremental pull', () => {
      let sync: SyncService;

      beforeEach(() => {
        const calendarRepo = new GoogleCalendarRepository(db);
        sync = new SyncService(db, events, new GoogleSyncRepository(db), calendarRepo);
        calendarRepo.upsertCalendar(USER_ID, {
          google_calendar_id: 'cal-1',
          calendar_name: 'Primary',
          is_primary: true,
          access_role: 'owner',
        });
        const cal = calendarRepo.getCalendarByGoogleId(USER_ID, 'cal-1');
        if (!cal) throw new Error('calendar missing');
        calendarRepo.updateSyncToken(cal.id, 'token-1');
      });

      function importedResolvedEvent(): CalendarEvent {
        const event = resolvedEvent();
        events.updateSyncFields(event.id, {
          google_calendar_id: 'cal-1',
          google_event_id: 'g-dinner',
          sync_status: 'synced',
        });
        return event;
      }

      test('a location changed in Google clears the resolved place', async () => {
        const event = importedResolvedEvent();
        await sync.incrementalPull(
          makeGoogleApi([{ id: 'g-dinner', summary: 'Dinner', location: 'дома' }]),
          USER_ID,
          'cal-1',
        );

        expectCleared(readColumns(db, event.id), 'дома');
      });

      test('an unchanged location from Google keeps the resolved place', async () => {
        const event = importedResolvedEvent();
        await sync.incrementalPull(
          makeGoogleApi([{ id: 'g-dinner', summary: 'Dinner moved', location: 'seaside hotel' }]),
          USER_ID,
          'cal-1',
        );

        expectOldPlace(readColumns(db, event.id), 'seaside hotel');
      });
    });
  });
});
