// test/services/google/sync-service.test.ts
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { calendar_v3 } from 'googleapis';
import { migrations } from '../../../src/database/migrations.ts';
import { EditProposalRepository } from '../../../src/database/repositories/edit-proposal.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { GoogleCalendarRepository } from '../../../src/database/repositories/google-calendar.repository.ts';
import { GoogleSyncRepository } from '../../../src/database/repositories/google-sync.repository.ts';
import { InvitationRepository } from '../../../src/database/repositories/invitation.repository.ts';
import { ParticipantRepository } from '../../../src/database/repositories/participant.repository.ts';
import { ParticipantGoogleSyncRepository } from '../../../src/database/repositories/participant-google-sync.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import type { GoogleCalendarApi } from '../../../src/services/google/calendar-api.ts';
import { SyncService } from '../../../src/services/google/sync-service.ts';

function createMockApi(
  events: Array<{
    id: string;
    summary: string;
    start: { dateTime: string };
    end: { dateTime: string };
    status?: string;
    updated?: string;
    etag?: string;
    extendedProperties?: { [key: string]: unknown };
  }>,
  nextSyncToken = 'token-1',
) {
  return {
    listEvents: mock(() => Promise.resolve({ events, nextSyncToken, nextPageToken: undefined })),
    insertEvent: mock(() => Promise.resolve({ id: 'g-new-1', etag: '"etag-new"' })),
    updateEvent: mock((_calId: string, eventId: string) => Promise.resolve({ id: eventId, etag: '"etag-upd"' })),
    deleteEvent: mock(() => Promise.resolve()),
  };
}

describe('SyncService', () => {
  let db: Database;
  let eventRepo: EventRepository;
  let syncRepo: GoogleSyncRepository;
  let calendarRepo: GoogleCalendarRepository;
  let service: SyncService;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, migrations);
    db.run("INSERT INTO users (telegram_id, username) VALUES (1, 'test')");
    eventRepo = new EventRepository(db);
    syncRepo = new GoogleSyncRepository(db);
    calendarRepo = new GoogleCalendarRepository(db);
    service = new SyncService(db, eventRepo, syncRepo, calendarRepo);

    calendarRepo.upsertCalendar(1, {
      google_calendar_id: 'cal-1',
      calendar_name: 'Primary',
      is_primary: true,
      access_role: 'owner',
    });
  });

  test('initialSync imports events and saves sync token', async () => {
    const api = createMockApi(
      [
        {
          id: 'g1',
          summary: 'Meeting',
          start: { dateTime: '2026-03-15T10:00:00Z' },
          end: { dateTime: '2026-03-15T11:00:00Z' },
          etag: '"e1"',
        },
        {
          id: 'g2',
          summary: 'Lunch',
          start: { dateTime: '2026-03-15T12:00:00Z' },
          end: { dateTime: '2026-03-15T13:00:00Z' },
          etag: '"e2"',
        },
      ],
      'sync-token-abc',
    );

    const count = await service.initialSync(api as never, 1, 'cal-1');

    expect(count).toBe(2);
    expect(api.listEvents).toHaveBeenCalledTimes(1);
    const imported = eventRepo.findByGoogleEventId(1, 'cal-1', 'g1');
    expect(imported).not.toBeNull();
    expect(imported!.title).toBe('Meeting');
  });

  test('initialSync does not pass timeMin — imports full history', async () => {
    const api = createMockApi(
      [
        {
          id: 'g1',
          summary: 'Old Event',
          start: { dateTime: '2020-01-15T10:00:00Z' },
          end: { dateTime: '2020-01-15T11:00:00Z' },
          etag: '"e1"',
        },
      ],
      'sync-token-full',
    );

    await service.initialSync(api as never, 1, 'cal-1');

    const [calendarId, opts] = api.listEvents.mock.calls[0] as unknown as [string, { timeMin?: string }];
    expect(calendarId).toBe('cal-1');
    expect(opts.timeMin).toBeUndefined();
  });

  test('initialSync skips events with our extended property', async () => {
    const api = createMockApi([
      {
        id: 'g1',
        summary: 'Ours',
        start: { dateTime: '2026-03-15T10:00:00Z' },
        end: { dateTime: '2026-03-15T11:00:00Z' },
        etag: '"e1"',
        extendedProperties: { private: { hypercalendarbot_event_id: '42' } },
      },
    ]);

    const count = await service.initialSync(api as never, 1, 'cal-1');
    expect(count).toBe(0);
  });

  test('pushEvent creates event on Google and updates sync fields', async () => {
    const event = eventRepo.create({
      user_id: 1,
      title: 'New Event',
      start_at: '2026-03-15T10:00:00Z',
      end_at: '2026-03-15T11:00:00Z',
      all_day: false,
      timezone: 'UTC',
    });
    eventRepo.updateSyncFields(event.id, { sync_status: 'pending_push', google_calendar_id: 'cal-1' });

    const api = createMockApi([]);
    await service.pushEvent(api as never, 1, event.id, 'create');

    expect(api.insertEvent).toHaveBeenCalledTimes(1);
    const updated = eventRepo.findById(event.id, 1);
    expect(updated!.google_event_id).toBe('g-new-1');
    expect(updated!.sync_status).toBe('synced');
  });

  test('resolveConflict returns keep_google when Google is newer', () => {
    const result = service.resolveConflict({ updated_at: '2026-03-15T10:00:00Z' } as never, '2026-03-15T11:00:00Z');
    expect(result).toBe('keep_google');
  });

  test('resolveConflict returns keep_local when local is newer', () => {
    const result = service.resolveConflict({ updated_at: '2026-03-15T12:00:00Z' } as never, '2026-03-15T11:00:00Z');
    expect(result).toBe('keep_local');
  });
});

describe('SyncService.initialSync — transaction atomicity', () => {
  let db: Database;
  let eventRepo: EventRepository;
  let syncRepo: GoogleSyncRepository;
  let calendarRepo: GoogleCalendarRepository;
  let service: SyncService;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, migrations);
    db.run("INSERT INTO users (telegram_id, username) VALUES (1, 'test')");
    eventRepo = new EventRepository(db);
    syncRepo = new GoogleSyncRepository(db);
    calendarRepo = new GoogleCalendarRepository(db);
    service = new SyncService(db, eventRepo, syncRepo, calendarRepo);
    calendarRepo.upsertCalendar(1, {
      google_calendar_id: 'cal-1',
      calendar_name: 'Primary',
      is_primary: true,
      access_role: 'owner',
    });
  });

  test('rolls back all inserts in a page when one fails mid-batch', async () => {
    // Replace insertSyncedEvent to throw on the 2nd call
    let callCount = 0;
    const originalInsert = eventRepo.insertSyncedEvent.bind(eventRepo);
    eventRepo.insertSyncedEvent = (data) => {
      callCount++;
      if (callCount === 2) throw new Error('Simulated DB error on insert 2');
      return originalInsert(data);
    };

    const api = createMockApi(
      [
        {
          id: 'g1',
          summary: 'Event A',
          start: { dateTime: '2026-03-15T10:00:00Z' },
          end: { dateTime: '2026-03-15T11:00:00Z' },
        },
        {
          id: 'g2',
          summary: 'Event B',
          start: { dateTime: '2026-03-15T12:00:00Z' },
          end: { dateTime: '2026-03-15T13:00:00Z' },
        },
        {
          id: 'g3',
          summary: 'Event C',
          start: { dateTime: '2026-03-15T14:00:00Z' },
          end: { dateTime: '2026-03-15T15:00:00Z' },
        },
      ],
      'token-x',
    );

    await expect(service.initialSync(api as never, 1, 'cal-1')).rejects.toThrow('Simulated DB error on insert 2');

    // Transaction should have rolled back — 0 events in DB
    const allEvents = db.prepare('SELECT * FROM events WHERE user_id = 1').all();
    expect(allEvents).toHaveLength(0);
  });

  test('succeeds and all events persist when no failure', async () => {
    const api = createMockApi(
      [
        {
          id: 'g1',
          summary: 'A',
          start: { dateTime: '2026-03-15T10:00:00Z' },
          end: { dateTime: '2026-03-15T11:00:00Z' },
        },
        {
          id: 'g2',
          summary: 'B',
          start: { dateTime: '2026-03-15T12:00:00Z' },
          end: { dateTime: '2026-03-15T13:00:00Z' },
        },
      ],
      'token-y',
    );
    const count = await service.initialSync(api as never, 1, 'cal-1');
    expect(count).toBe(2);
    const allEvents = db.prepare('SELECT * FROM events WHERE user_id = 1').all();
    expect(allEvents).toHaveLength(2);
  });
});

function asGoogleCalendarApi(partial: Partial<GoogleCalendarApi>): GoogleCalendarApi {
  return partial as unknown as GoogleCalendarApi;
}

/** Google Calendar double: keeps what the bot writes and lists it back as Google does, private properties included. */
function makeInMemoryGoogleCalendar(): { api: GoogleCalendarApi; stored: Map<string, calendar_v3.Schema$Event> } {
  const stored = new Map<string, calendar_v3.Schema$Event>();
  const save = (id: string, event: calendar_v3.Schema$Event): calendar_v3.Schema$Event => {
    const saved = { ...event, id, etag: `"etag-${id}"`, status: 'confirmed', updated: new Date().toISOString() };
    stored.set(id, saved);
    return saved;
  };
  return {
    api: asGoogleCalendarApi({
      insertEvent: async (_calendarId, event) => save(`g-${stored.size + 1}`, event),
      updateEvent: async (_calendarId, eventId, event) => save(eventId, event),
      listEvents: async () => ({
        events: [...stored.values()],
        nextSyncToken: 'token-after-pull',
        nextPageToken: null,
      }),
    }),
    stored,
  };
}

describe('SyncService — resolved place round trip', () => {
  const ORGANIZER = 1;
  const PARTICIPANT = 2;
  const PLACE = 'Кафе Ромашка — ул. Примерная, 1, Москва';
  let db: Database;
  let eventRepo: EventRepository;
  let syncRepo: GoogleSyncRepository;
  let calendarRepo: GoogleCalendarRepository;
  let participantSyncRepo: ParticipantGoogleSyncRepository;
  let editProposalRepo: EditProposalRepository;
  let notified: string[];
  let service: SyncService;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, migrations);
    db.run("INSERT INTO users (telegram_id, username) VALUES (1, 'organizer'), (2, 'participant')");
    eventRepo = new EventRepository(db);
    syncRepo = new GoogleSyncRepository(db);
    calendarRepo = new GoogleCalendarRepository(db);
    participantSyncRepo = new ParticipantGoogleSyncRepository(db);
    editProposalRepo = new EditProposalRepository(db);
    notified = [];
    const notifyUser = async (_userId: number, text: string): Promise<void> => {
      notified.push(text);
    };
    service = new SyncService(
      db,
      eventRepo,
      syncRepo,
      calendarRepo,
      notifyUser,
      () => 'ru',
      participantSyncRepo,
      undefined,
      {
        eventRepo,
        participantRepo: new ParticipantRepository(db),
        participantSyncRepo,
        editProposalRepo,
        invitationRepo: new InvitationRepository(db),
        notifyUser,
        getUserLang: () => 'ru',
        getUserName: () => 'participant',
      },
    );
    for (const [userId, calendarId] of [
      [ORGANIZER, 'cal-1'],
      [PARTICIPANT, 'primary'],
    ] as const) {
      calendarRepo.upsertCalendar(userId, {
        google_calendar_id: calendarId,
        calendar_name: 'Primary',
        is_primary: true,
        access_role: 'owner',
      });
      calendarRepo.updateSyncToken(calendarRepo.getCalendarByGoogleId(userId, calendarId)!.id, 'token-before-pull');
    }
  });

  function createVerifiedEvent(): number {
    const event = eventRepo.create({
      user_id: ORGANIZER,
      title: 'Обед',
      start_at: '2026-03-15T10:00:00Z',
      end_at: '2026-03-15T11:00:00Z',
      all_day: false,
      timezone: 'UTC',
      location: 'кафе у парка',
    });
    eventRepo.updateLocationFields(event.id, {
      resolved_address: 'ул. Примерная, 1, Москва',
      latitude: 55.75,
      longitude: 37.61,
      google_maps_url: 'https://www.google.com/maps/search/?api=1&query=55.75,37.61',
      location_verified: 1,
      venue_name: 'Кафе Ромашка',
    });
    return event.id;
  }

  function expectResolutionIntact(eventId: number): void {
    const after = eventRepo.findById(eventId, ORGANIZER)!;
    expect(after.location).toBe('кафе у парка');
    expect(after.location_verified).toBe(1);
    expect(after.venue_name).toBe('Кафе Ромашка');
    expect(after.resolved_address).toBe('ул. Примерная, 1, Москва');
    expect(db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 1 });
  }

  test('owner calendar: the pushed place comes back from Google as no change', async () => {
    const eventId = createVerifiedEvent();
    eventRepo.updateSyncFields(eventId, { sync_status: 'pending_push', google_calendar_id: 'cal-1' });
    const google = makeInMemoryGoogleCalendar();

    await service.pushEvent(google.api, ORGANIZER, eventId, 'create');
    expect([...google.stored.values()].map((e) => e.location)).toEqual([PLACE]);

    await service.incrementalPull(google.api, ORGANIZER, 'cal-1');

    expectResolutionIntact(eventId);
    expect(syncRepo.getRecentLogs(ORGANIZER, 10).filter((log) => log.direction === 'pull')).toEqual([]);
    expect(notified).toEqual([]);
  });

  test('participant calendar: the pushed place comes back from Google without an edit proposal', async () => {
    const eventId = createVerifiedEvent();
    const google = makeInMemoryGoogleCalendar();

    await service.pushParticipantEvent(google.api, PARTICIPANT, eventId, 'create');
    expect([...google.stored.values()].map((e) => e.location)).toEqual([PLACE]);

    await service.incrementalPull(google.api, PARTICIPANT, 'primary');

    expectResolutionIntact(eventId);
    expect(editProposalRepo.getPendingByProposerAndEvent(PARTICIPANT, eventId)).toBeNull();
    expect(notified).toEqual([]);
  });
});
