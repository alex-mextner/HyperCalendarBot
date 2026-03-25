// Extended sync-service tests covering incrementalPull, pushEvent update/delete,
// handleDeletedEvent, handleUpdatedOrNewEvent, setupWatchChannel
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { GoogleCalendarRepository } from '../../../src/database/repositories/google-calendar.repository.ts';
import { GoogleSyncRepository } from '../../../src/database/repositories/google-sync.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { SyncService } from '../../../src/services/google/sync-service.ts';

function createMockApi(overrides: Record<string, unknown> = {}) {
  return {
    listEvents: mock(() => Promise.resolve({ events: [], nextSyncToken: 'token-new', nextPageToken: undefined })),
    insertEvent: mock(() => Promise.resolve({ id: 'g-new-1', etag: '"etag-new"' })),
    updateEvent: mock((_calId: string, eventId: string) => Promise.resolve({ id: eventId, etag: '"etag-upd"' })),
    deleteEvent: mock(() => Promise.resolve()),
    watchEvents: mock(() => Promise.resolve({ resourceId: 'res-123', expiration: '2026-03-22T00:00:00Z' })),
    ...overrides,
  };
}

describe('SyncService — extended coverage', () => {
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

  // ── incrementalPull ──

  test('incrementalPull falls back to initialSync when no sync token', async () => {
    // Calendar has no sync_token initially, so should call initialSync
    const api = createMockApi({
      listEvents: mock(() =>
        Promise.resolve({
          events: [
            {
              id: 'g1',
              summary: 'Test',
              start: { dateTime: '2026-03-15T10:00:00Z' },
              end: { dateTime: '2026-03-15T11:00:00Z' },
              etag: '"e1"',
            },
          ],
          nextSyncToken: 'token-initial',
          nextPageToken: undefined,
        }),
      ),
    });

    await service.incrementalPull(api as never, 1, 'cal-1');

    // Should have called listEvents (via initialSync since no sync token)
    expect(api.listEvents).toHaveBeenCalled();
    const imported = eventRepo.findByGoogleEventId(1, 'cal-1', 'g1');
    expect(imported).not.toBeNull();
  });

  test('incrementalPull processes changed events with sync token', async () => {
    // Set a sync token first
    const cal = calendarRepo.getCalendarByGoogleId(1, 'cal-1')!;
    calendarRepo.updateSyncToken(cal.id, 'old-token');

    // Pre-insert an event that will be "updated"
    eventRepo.insertSyncedEvent({
      user_id: 1,
      title: 'Old Title',
      description: null,
      start_at: '2026-03-15T10:00:00Z',
      end_at: '2026-03-15T11:00:00Z',
      all_day: false,
      timezone: 'UTC',
      location: null,
      recurrence_rule: null,
      google_calendar_id: 'cal-1',
      google_event_id: 'g-exist',
      google_etag: '"old-etag"',
      is_cancelled: false,
    });

    const api = createMockApi({
      listEvents: mock(() =>
        Promise.resolve({
          events: [
            {
              id: 'g-exist',
              summary: 'Updated Title',
              start: { dateTime: '2026-03-15T10:00:00Z' },
              end: { dateTime: '2026-03-15T11:00:00Z' },
              etag: '"new-etag"',
              status: 'confirmed',
              updated: '2026-03-15T12:00:00Z',
            },
          ],
          nextSyncToken: 'new-sync-token',
          nextPageToken: undefined,
        }),
      ),
    });

    await service.incrementalPull(api as never, 1, 'cal-1');

    // listEvents should be called with syncToken
    expect(api.listEvents).toHaveBeenCalledTimes(1);

    // Event should be updated
    const updated = eventRepo.findByGoogleEventId(1, 'cal-1', 'g-exist');
    expect(updated!.title).toBe('Updated Title');

    // Sync token should be updated
    const calAfter = calendarRepo.getCalendarByGoogleId(1, 'cal-1')!;
    expect(calAfter.sync_token).toBe('new-sync-token');
  });

  test('incrementalPull handles cancelled events by deleting them', async () => {
    const cal = calendarRepo.getCalendarByGoogleId(1, 'cal-1')!;
    calendarRepo.updateSyncToken(cal.id, 'old-token');

    eventRepo.insertSyncedEvent({
      user_id: 1,
      title: 'To Delete',
      description: null,
      start_at: '2026-03-15T10:00:00Z',
      end_at: '2026-03-15T11:00:00Z',
      all_day: false,
      timezone: 'UTC',
      location: null,
      recurrence_rule: null,
      google_calendar_id: 'cal-1',
      google_event_id: 'g-del',
      google_etag: '"e1"',
      is_cancelled: false,
    });

    const api = createMockApi({
      listEvents: mock(() =>
        Promise.resolve({
          events: [{ id: 'g-del', status: 'cancelled' }],
          nextSyncToken: 'token-2',
          nextPageToken: undefined,
        }),
      ),
    });

    await service.incrementalPull(api as never, 1, 'cal-1');

    const deleted = eventRepo.findByGoogleEventId(1, 'cal-1', 'g-del');
    expect(deleted).toBeNull();
  });

  test('incrementalPull skips events with our extended property', async () => {
    const cal = calendarRepo.getCalendarByGoogleId(1, 'cal-1')!;
    calendarRepo.updateSyncToken(cal.id, 'old-token');

    const api = createMockApi({
      listEvents: mock(() =>
        Promise.resolve({
          events: [
            {
              id: 'g-ours',
              summary: 'Ours',
              start: { dateTime: '2026-03-15T10:00:00Z' },
              end: { dateTime: '2026-03-15T11:00:00Z' },
              etag: '"e1"',
              status: 'confirmed',
              extendedProperties: { private: { hypercalendarbot_event_id: '99' } },
            },
          ],
          nextSyncToken: 'token-3',
          nextPageToken: undefined,
        }),
      ),
    });

    await service.incrementalPull(api as never, 1, 'cal-1');

    // Should not create any new event
    const found = eventRepo.findByGoogleEventId(1, 'cal-1', 'g-ours');
    expect(found).toBeNull();
  });

  test('incrementalPull falls back to full sync on 410 error', async () => {
    const cal = calendarRepo.getCalendarByGoogleId(1, 'cal-1')!;
    calendarRepo.updateSyncToken(cal.id, 'expired-token');

    let callCount = 0;
    const api = createMockApi({
      listEvents: mock(() => {
        callCount++;
        if (callCount === 1) {
          // biome-ignore lint/suspicious/noExplicitAny: test error simulation
          const err: any = new Error('Gone');
          err.code = 410;
          throw err;
        }
        return Promise.resolve({
          events: [],
          nextSyncToken: 'fresh-token',
          nextPageToken: undefined,
        });
      }),
    });

    await service.incrementalPull(api as never, 1, 'cal-1');

    // Called twice: first failed with 410, second is the full sync fallback
    expect(api.listEvents).toHaveBeenCalledTimes(2);
  });

  test('incrementalPull rethrows non-410 errors', async () => {
    const cal = calendarRepo.getCalendarByGoogleId(1, 'cal-1')!;
    calendarRepo.updateSyncToken(cal.id, 'some-token');

    const api = createMockApi({
      listEvents: mock(() => {
        // biome-ignore lint/suspicious/noExplicitAny: test error simulation
        const err: any = new Error('Server Error');
        err.code = 500;
        throw err;
      }),
    });

    expect(service.incrementalPull(api as never, 1, 'cal-1')).rejects.toThrow('Server Error');
  });

  // ── pushEvent ──

  test('pushEvent update calls updateEvent and updates sync fields', async () => {
    const event = eventRepo.create({
      user_id: 1,
      title: 'Update Me',
      start_at: '2026-03-15T10:00:00Z',
      end_at: '2026-03-15T11:00:00Z',
      all_day: false,
      timezone: 'UTC',
    });
    eventRepo.updateSyncFields(event.id, {
      sync_status: 'pending_push',
      google_calendar_id: 'cal-1',
      google_event_id: 'g-upd-1',
    });

    const api = createMockApi();
    await service.pushEvent(api as never, 1, event.id, 'update');

    expect(api.updateEvent).toHaveBeenCalledTimes(1);
    const updated = eventRepo.findById(event.id, 1);
    expect(updated!.sync_status).toBe('synced');
    expect(updated!.google_etag).toBe('"etag-upd"');
  });

  test('pushEvent delete calls deleteEvent and removes from DB', async () => {
    const event = eventRepo.create({
      user_id: 1,
      title: 'Delete Me',
      start_at: '2026-03-15T10:00:00Z',
      end_at: '2026-03-15T11:00:00Z',
      all_day: false,
      timezone: 'UTC',
    });
    eventRepo.updateSyncFields(event.id, {
      sync_status: 'pending_push',
      google_calendar_id: 'cal-1',
      google_event_id: 'g-del-1',
    });

    const api = createMockApi();
    await service.pushEvent(api as never, 1, event.id, 'delete');

    expect(api.deleteEvent).toHaveBeenCalledTimes(1);
    const deleted = eventRepo.findById(event.id, 1);
    expect(deleted).toBeNull();
  });

  test('pushEvent delete without google_event_id still removes locally', async () => {
    const event = eventRepo.create({
      user_id: 1,
      title: 'Local Only Delete',
      start_at: '2026-03-15T10:00:00Z',
      all_day: false,
      timezone: 'UTC',
    });
    eventRepo.updateSyncFields(event.id, { sync_status: 'pending_push' });

    const api = createMockApi();
    await service.pushEvent(api as never, 1, event.id, 'delete');

    // Should not call deleteEvent on Google
    expect(api.deleteEvent).not.toHaveBeenCalled();
    // But should remove locally
    const deleted = eventRepo.findById(event.id, 1);
    expect(deleted).toBeNull();
  });

  test('pushEvent skips if event does not exist', async () => {
    const api = createMockApi();
    await service.pushEvent(api as never, 1, 99999, 'create');

    expect(api.insertEvent).not.toHaveBeenCalled();
  });

  test('pushEvent skips if sync_status is not pending_push', async () => {
    const event = eventRepo.create({
      user_id: 1,
      title: 'Already Synced',
      start_at: '2026-03-15T10:00:00Z',
      all_day: false,
      timezone: 'UTC',
    });
    // sync_status defaults to 'local_only', not 'pending_push'

    const api = createMockApi();
    await service.pushEvent(api as never, 1, event.id, 'create');

    expect(api.insertEvent).not.toHaveBeenCalled();
  });

  test('pushEvent logs sync entry after create', async () => {
    const event = eventRepo.create({
      user_id: 1,
      title: 'Log Test',
      start_at: '2026-03-15T10:00:00Z',
      end_at: '2026-03-15T11:00:00Z',
      all_day: false,
      timezone: 'UTC',
    });
    eventRepo.updateSyncFields(event.id, { sync_status: 'pending_push', google_calendar_id: 'cal-1' });

    const api = createMockApi();
    await service.pushEvent(api as never, 1, event.id, 'create');

    const logs = syncRepo.getRecentLogs(1, 10);
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs[0]!.action).toBe('create');
    expect(logs[0]!.direction).toBe('push');
  });

  // ── handleUpdatedOrNewEvent (via incrementalPull) ──

  test('incrementalPull creates new event when google event is unknown', async () => {
    const cal = calendarRepo.getCalendarByGoogleId(1, 'cal-1')!;
    calendarRepo.updateSyncToken(cal.id, 'token-a');

    const api = createMockApi({
      listEvents: mock(() =>
        Promise.resolve({
          events: [
            {
              id: 'g-brand-new',
              summary: 'Brand New From Google',
              start: { dateTime: '2026-03-16T09:00:00Z' },
              end: { dateTime: '2026-03-16T10:00:00Z' },
              etag: '"etag-brand"',
              status: 'confirmed',
            },
          ],
          nextSyncToken: 'token-b',
          nextPageToken: undefined,
        }),
      ),
    });

    await service.incrementalPull(api as never, 1, 'cal-1');

    const created = eventRepo.findByGoogleEventId(1, 'cal-1', 'g-brand-new');
    expect(created).not.toBeNull();
    expect(created!.title).toBe('Brand New From Google');
  });

  test('incrementalPull resolves conflict — keeps google when newer', async () => {
    const cal = calendarRepo.getCalendarByGoogleId(1, 'cal-1')!;
    calendarRepo.updateSyncToken(cal.id, 'token-c');

    eventRepo.insertSyncedEvent({
      user_id: 1,
      title: 'Local Version',
      description: null,
      start_at: '2026-03-15T10:00:00Z',
      end_at: '2026-03-15T11:00:00Z',
      all_day: false,
      timezone: 'UTC',
      location: null,
      recurrence_rule: null,
      google_calendar_id: 'cal-1',
      google_event_id: 'g-conflict',
      google_etag: '"old"',
      is_cancelled: false,
    });

    // Mark as pending_push to trigger conflict resolution
    const existing = eventRepo.findByGoogleEventId(1, 'cal-1', 'g-conflict')!;
    eventRepo.updateSyncFields(existing.id, { sync_status: 'pending_push' });

    const notifyUser = mock(() => Promise.resolve());
    const serviceWithNotify = new SyncService(db, eventRepo, syncRepo, calendarRepo, notifyUser);

    const api = createMockApi({
      listEvents: mock(() =>
        Promise.resolve({
          events: [
            {
              id: 'g-conflict',
              summary: 'Google Version',
              start: { dateTime: '2026-03-15T10:00:00Z' },
              end: { dateTime: '2026-03-15T11:00:00Z' },
              etag: '"newer"',
              status: 'confirmed',
              updated: '2099-01-01T00:00:00Z', // Way in the future = Google wins
            },
          ],
          nextSyncToken: 'token-d',
          nextPageToken: undefined,
        }),
      ),
    });

    await serviceWithNotify.incrementalPull(api as never, 1, 'cal-1');

    const result = eventRepo.findByGoogleEventId(1, 'cal-1', 'g-conflict');
    expect(result!.title).toBe('Google Version');
    expect(notifyUser).toHaveBeenCalledTimes(1);
  });

  test('incrementalPull resolves conflict — keeps local when newer', async () => {
    const cal = calendarRepo.getCalendarByGoogleId(1, 'cal-1')!;
    calendarRepo.updateSyncToken(cal.id, 'token-e');

    eventRepo.insertSyncedEvent({
      user_id: 1,
      title: 'Local Is Newer',
      description: null,
      start_at: '2026-03-15T10:00:00Z',
      end_at: '2026-03-15T11:00:00Z',
      all_day: false,
      timezone: 'UTC',
      location: null,
      recurrence_rule: null,
      google_calendar_id: 'cal-1',
      google_event_id: 'g-local-wins',
      google_etag: '"old"',
      is_cancelled: false,
    });

    const existing = eventRepo.findByGoogleEventId(1, 'cal-1', 'g-local-wins')!;
    eventRepo.updateSyncFields(existing.id, { sync_status: 'pending_push' });

    // Force updated_at to future by updating the event
    db.run(`UPDATE events SET updated_at = '2099-12-31T23:59:59Z' WHERE id = ?`, [existing.id]);

    const api = createMockApi({
      listEvents: mock(() =>
        Promise.resolve({
          events: [
            {
              id: 'g-local-wins',
              summary: 'Google Version Should Lose',
              start: { dateTime: '2026-03-15T10:00:00Z' },
              end: { dateTime: '2026-03-15T11:00:00Z' },
              etag: '"g-etag"',
              status: 'confirmed',
              updated: '2020-01-01T00:00:00Z', // Very old = Local wins
            },
          ],
          nextSyncToken: 'token-f',
          nextPageToken: undefined,
        }),
      ),
    });

    await service.incrementalPull(api as never, 1, 'cal-1');

    const result = eventRepo.findByGoogleEventId(1, 'cal-1', 'g-local-wins');
    // Title should remain local version since local wins
    expect(result!.title).toBe('Local Is Newer');
  });

  // ── setupWatchChannel ──

  test('setupWatchChannel creates channel and stores it', async () => {
    const cal = calendarRepo.getCalendarByGoogleId(1, 'cal-1')!;
    const api = createMockApi();

    await service.setupWatchChannel(api as never, cal.id, 'cal-1', 'example.com');

    expect(api.watchEvents).toHaveBeenCalledTimes(1);
    const watchCall = (api.watchEvents as ReturnType<typeof mock>).mock.calls[0]!;
    expect(watchCall[0]).toBe('cal-1');
    expect(watchCall[2]).toBe('https://example.com/webhooks/google-calendar');

    const channels = calendarRepo.getWatchChannels(cal.id);
    expect(channels.length).toBe(1);
    expect(channels[0]!.resource_id).toBe('res-123');
  });

  // ── resolveConflict edge cases ──

  test('resolveConflict returns keep_local when timestamps are equal', () => {
    const result = service.resolveConflict({ updated_at: '2026-03-15T10:00:00Z' } as never, '2026-03-15T10:00:00Z');
    expect(result).toBe('keep_local');
  });

  // ── initialSync with pagination ──

  test('initialSync handles multiple pages', async () => {
    let callCount = 0;
    const api = createMockApi({
      listEvents: mock(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            events: [
              {
                id: 'g-p1',
                summary: 'Page 1',
                start: { dateTime: '2026-03-15T10:00:00Z' },
                end: { dateTime: '2026-03-15T11:00:00Z' },
                etag: '"e-p1"',
              },
            ],
            nextSyncToken: null,
            nextPageToken: 'page2',
          });
        }
        return Promise.resolve({
          events: [
            {
              id: 'g-p2',
              summary: 'Page 2',
              start: { dateTime: '2026-03-15T12:00:00Z' },
              end: { dateTime: '2026-03-15T13:00:00Z' },
              etag: '"e-p2"',
            },
          ],
          nextSyncToken: 'final-token',
          nextPageToken: undefined,
        });
      }),
    });

    const count = await service.initialSync(api as never, 1, 'cal-1');

    expect(count).toBe(2);
    expect(api.listEvents).toHaveBeenCalledTimes(2);
  });

  test('initialSync skips cancelled events', async () => {
    const api = createMockApi({
      listEvents: mock(() =>
        Promise.resolve({
          events: [{ id: 'g-cancel', summary: 'Cancelled', status: 'cancelled' }],
          nextSyncToken: 'token-x',
          nextPageToken: undefined,
        }),
      ),
    });

    const count = await service.initialSync(api as never, 1, 'cal-1');
    expect(count).toBe(0);
  });
});
