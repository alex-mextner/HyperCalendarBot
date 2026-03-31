// test/services/google/sync-service.test.ts
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { GoogleCalendarRepository } from '../../../src/database/repositories/google-calendar.repository.ts';
import { GoogleSyncRepository } from '../../../src/database/repositories/google-sync.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
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
