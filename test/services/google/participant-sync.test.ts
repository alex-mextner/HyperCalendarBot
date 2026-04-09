import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { GoogleCalendarRepository } from '../../../src/database/repositories/google-calendar.repository.ts';
import { GoogleSyncRepository } from '../../../src/database/repositories/google-sync.repository.ts';
import { ParticipantGoogleSyncRepository } from '../../../src/database/repositories/participant-google-sync.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { SyncService } from '../../../src/services/google/sync-service.ts';

function createMockApi() {
  return {
    listEvents: mock(() => Promise.resolve({ events: [], nextSyncToken: 'tok' })),
    insertEvent: mock(() => Promise.resolve({ id: 'g-participant-1', etag: '"etag-p1"' })),
    updateEvent: mock((_calId: string, eventId: string) => Promise.resolve({ id: eventId, etag: '"etag-upd"' })),
    deleteEvent: mock(() => Promise.resolve()),
  };
}

describe('SyncService.pushParticipantEvent', () => {
  let db: Database;
  let eventRepo: EventRepository;
  let syncRepo: GoogleSyncRepository;
  let calendarRepo: GoogleCalendarRepository;
  let participantSyncRepo: ParticipantGoogleSyncRepository;
  let service: SyncService;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, migrations);
    // Owner user
    db.run("INSERT INTO users (telegram_id, username) VALUES (1, 'owner')");
    // Participant user
    db.run("INSERT INTO users (telegram_id, username) VALUES (2, 'participant')");
    // Event owned by user 1
    db.run(
      `INSERT INTO events (user_id, title, start_at, end_at, timezone, all_day, sync_status, sync_version)
       VALUES (1, 'Team Meeting', '2026-04-10T10:00:00Z', '2026-04-10T11:00:00Z', 'UTC', 0, 'synced', 1)`,
    );

    eventRepo = new EventRepository(db);
    syncRepo = new GoogleSyncRepository(db);
    calendarRepo = new GoogleCalendarRepository(db);
    participantSyncRepo = new ParticipantGoogleSyncRepository(db);
    service = new SyncService(db, eventRepo, syncRepo, calendarRepo);
  });

  test('create pushes event to participant Google Calendar', async () => {
    const api = createMockApi();
    await service.pushParticipantEvent(api as never, 2, 1, 'create', participantSyncRepo);

    expect(api.insertEvent).toHaveBeenCalledTimes(1);
    const [calId, gEvent] = api.insertEvent.mock.calls[0] as unknown as [string, { summary: string }];
    expect(calId).toBe('primary');
    expect(gEvent.summary).toBe('Team Meeting');

    const record = participantSyncRepo.getByUserAndEvent(2, 1);
    expect(record).not.toBeNull();
    expect(record!.google_event_id).toBe('g-participant-1');
    expect(record!.sync_status).toBe('synced');
  });

  test('create with existing sync record updates instead', async () => {
    participantSyncRepo.upsert(2, 1, {
      google_event_id: 'g-existing',
      google_calendar_id: 'primary',
      sync_status: 'synced',
    });
    const api = createMockApi();
    await service.pushParticipantEvent(api as never, 2, 1, 'create', participantSyncRepo);

    expect(api.updateEvent).toHaveBeenCalledTimes(1);
    expect(api.insertEvent).not.toHaveBeenCalled();
    const [calId, eventId] = api.updateEvent.mock.calls[0] as unknown as [string, string];
    expect(calId).toBe('primary');
    expect(eventId).toBe('g-existing');
  });

  test('update with existing sync record updates Google event', async () => {
    participantSyncRepo.upsert(2, 1, {
      google_event_id: 'g-existing',
      google_calendar_id: 'primary',
      sync_status: 'synced',
    });
    const api = createMockApi();
    await service.pushParticipantEvent(api as never, 2, 1, 'update', participantSyncRepo);

    expect(api.updateEvent).toHaveBeenCalledTimes(1);
    const record = participantSyncRepo.getByUserAndEvent(2, 1);
    expect(record!.sync_status).toBe('synced');
    expect(record!.google_etag).toBe('"etag-upd"');
  });

  test('update without existing sync record creates new Google event', async () => {
    const api = createMockApi();
    await service.pushParticipantEvent(api as never, 2, 1, 'update', participantSyncRepo);

    expect(api.insertEvent).toHaveBeenCalledTimes(1);
    const record = participantSyncRepo.getByUserAndEvent(2, 1);
    expect(record).not.toBeNull();
    expect(record!.google_event_id).toBe('g-participant-1');
  });

  test('delete removes event from Google and cleans up sync record', async () => {
    participantSyncRepo.upsert(2, 1, {
      google_event_id: 'g-to-delete',
      google_calendar_id: 'primary',
      sync_status: 'synced',
    });
    const api = createMockApi();
    await service.pushParticipantEvent(api as never, 2, 1, 'delete', participantSyncRepo);

    expect(api.deleteEvent).toHaveBeenCalledWith('primary', 'g-to-delete');
    expect(participantSyncRepo.getByUserAndEvent(2, 1)).toBeNull();
  });

  test('delete without sync record is a no-op', async () => {
    const api = createMockApi();
    await service.pushParticipantEvent(api as never, 2, 1, 'delete', participantSyncRepo);

    expect(api.deleteEvent).not.toHaveBeenCalled();
  });

  test('delete handles 404 from Google gracefully', async () => {
    participantSyncRepo.upsert(2, 1, {
      google_event_id: 'g-gone',
      google_calendar_id: 'primary',
      sync_status: 'synced',
    });
    const api = createMockApi();
    api.deleteEvent.mockImplementation(() => {
      const err = new Error('Not Found') as Error & { code: number };
      err.code = 404;
      return Promise.reject(err);
    });
    await service.pushParticipantEvent(api as never, 2, 1, 'delete', participantSyncRepo);

    // Record should still be cleaned up
    expect(participantSyncRepo.getByUserAndEvent(2, 1)).toBeNull();
  });

  test('create with non-existent event is a no-op', async () => {
    const api = createMockApi();
    await service.pushParticipantEvent(api as never, 2, 999, 'create', participantSyncRepo);

    expect(api.insertEvent).not.toHaveBeenCalled();
  });

  test('sync log is created on push', async () => {
    const api = createMockApi();
    // Need sync state to create logs
    syncRepo.upsertSyncState(2, 'calendar');

    await service.pushParticipantEvent(api as never, 2, 1, 'create', participantSyncRepo);

    const logs = syncRepo.getRecentLogs(2, 10);
    expect(logs.length).toBeGreaterThanOrEqual(1);
    const log = logs.find((l) => l.details === 'participant_sync');
    expect(log).toBeDefined();
    expect(log!.direction).toBe('push');
    expect(log!.action).toBe('create');
  });
});
