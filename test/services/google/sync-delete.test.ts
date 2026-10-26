// Google → bot deletions (#844): what the bot does when an event is deleted in Google Calendar,
// against a Google double that behaves like the production API observed on 2026-10-26: a deleted
// event comes back as a tombstone that KEEPS its extendedProperties (the bot's own marker), the bot
// stores no calendar id for the events it pushed, and a delta is read page by page.
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from 'bun:test';
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
import type { EventChangeNotifier } from '../../../src/services/event/event-change-notifier.ts';
import { expandRecurrence } from '../../../src/services/event/recurrence.ts';
import type { EventListResult, GoogleCalendarApi } from '../../../src/services/google/calendar-api.ts';
import { SyncService } from '../../../src/services/google/sync-service.ts';
import { syncLogger } from '../../../src/utils/logger.ts';

const USER = 1;
const PRIMARY = 'owner@example.com';
const SECONDARY = 'team@example.com';

interface GoogleDouble {
  api: GoogleCalendarApi;
  events: Map<string, calendar_v3.Schema$Event>;
  listCalls: { syncToken?: string; pageToken?: string }[];
  /** An event the user made in Google Calendar itself. */
  createInGoogle(id: string, summary: string, start: string): void;
  /** Stores an event exactly as given (a series, a moved occurrence, a copy the bot pushed). */
  putInGoogle(id: string, event: calendar_v3.Schema$Event): void;
  /** The user deletes an event in Google Calendar. */
  deleteInGoogle(id: string): void;
  /** The user deletes one occurrence of a series. */
  deleteInstanceInGoogle(masterId: string, originalStart: string, allDay?: boolean): void;
  /** The stored sync token is too old: Google answers 410 Gone to it. */
  expireTokens(): void;
  /** The next listEvents call whose pageToken equals `pageToken` (or the first, '') rejects with `err`. */
  failListAt(pageToken: string, err: Error & { code?: number }): void;
}

function makeGoogle(pageSize = 250): GoogleDouble {
  const events = new Map<string, calendar_v3.Schema$Event>();
  let feed: string[] = [];
  let snapshot: string[] = [];
  let version = 0;
  let expired = false;
  let failure: { pageToken: string; err: Error } | null = null;
  const listCalls: { syncToken?: string; pageToken?: string }[] = [];

  const touch = (id: string, event: calendar_v3.Schema$Event): calendar_v3.Schema$Event => {
    version++;
    const saved = { ...event, id, etag: `"${version}"`, status: event.status ?? 'confirmed' };
    events.set(id, saved);
    feed = [...feed.filter((feedId) => feedId !== id), id];
    return saved;
  };

  const api = {
    insertEvent: async (_calendarId: string, event: calendar_v3.Schema$Event) => touch(`g${events.size + 1}`, event),
    updateEvent: async (_calendarId: string, eventId: string, event: calendar_v3.Schema$Event) => touch(eventId, event),
    deleteEvent: async (_calendarId: string, eventId: string) => {
      touch(eventId, { ...events.get(eventId), status: 'cancelled' });
    },
    listEvents: async (
      _calendarId: string,
      opts: { syncToken?: string; pageToken?: string },
    ): Promise<EventListResult> => {
      listCalls.push({ syncToken: opts.syncToken, pageToken: opts.pageToken });
      if (opts.syncToken && expired) throw Object.assign(new Error('Gone'), { code: 410 });
      if (failure && failure.pageToken === (opts.pageToken ?? '')) {
        const { err } = failure;
        failure = null;
        throw err;
      }
      if (!opts.pageToken) {
        // A list without a sync token answers with live events only; a delta carries tombstones too.
        snapshot = opts.syncToken
          ? feed
          : [...events.values()].filter((event) => event.status !== 'cancelled').map((event) => event.id!);
        if (!opts.syncToken) expired = false;
        feed = [];
      }
      const start = opts.pageToken ? Number(opts.pageToken) : 0;
      const last = start + pageSize >= snapshot.length;
      return {
        events: snapshot.slice(start, start + pageSize).map((id) => events.get(id)!),
        nextPageToken: last ? null : String(start + pageSize),
        nextSyncToken: last ? `sync-${version}` : null,
      };
    },
  };

  return {
    api: api as unknown as GoogleCalendarApi,
    events,
    listCalls,
    createInGoogle(id, summary, start) {
      touch(id, { summary, start: { dateTime: start }, end: { dateTime: start } });
    },
    putInGoogle(id, event) {
      touch(id, event);
    },
    deleteInGoogle(id) {
      touch(id, { ...events.get(id), status: 'cancelled' });
    },
    deleteInstanceInGoogle(masterId, originalStart, allDay = false) {
      // What Google sends for a deleted occurrence: its own id plus the series it belongs to.
      touch(`${masterId}_${originalStart.replace(/[-:]/g, '')}`, {
        status: 'cancelled',
        recurringEventId: masterId,
        originalStartTime: allDay ? { date: originalStart } : { dateTime: originalStart },
      });
    },
    expireTokens() {
      expired = true;
    },
    failListAt(pageToken, err) {
      failure = { pageToken, err };
    },
  };
}

interface NotifierCalls {
  deleted: { eventId: number; source: string; notifyParticipants: boolean | undefined }[];
  /** Whether each announcement was released (the removal committed) or abandoned (it failed). */
  outcomes: ('committed' | 'abandoned')[];
  /** Runs while the notifier of a deletion is still awaiting, as a user's edit in the bot would. */
  duringNotify: (() => void) | null;
}

describe('Google deletions reach the bot (#844)', () => {
  let db: Database;
  let eventRepo: EventRepository;
  let syncRepo: GoogleSyncRepository;
  let calendarRepo: GoogleCalendarRepository;
  let notifierCalls: NotifierCalls;
  let notified: { userId: number; text: string }[];
  let participantSyncRepo: ParticipantGoogleSyncRepository;
  let participantRepo: ParticipantRepository;
  let service: SyncService;
  let errorLog: Mock<typeof syncLogger.error>;
  let infoLog: Mock<typeof syncLogger.info>;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, migrations);
    db.run("INSERT INTO users (telegram_id, username) VALUES (1, 'owner'), (2, 'organizer')");
    eventRepo = new EventRepository(db);
    syncRepo = new GoogleSyncRepository(db);
    calendarRepo = new GoogleCalendarRepository(db);
    notifierCalls = { deleted: [], outcomes: [], duringNotify: null };
    const notifier = {
      onEventChanged: async () => {},
      onEventDeleted: async (params: {
        event: { id: number };
        source: string;
        notifyParticipants?: boolean;
        committed?: Promise<void>;
      }) => {
        notifierCalls.deleted.push({
          eventId: params.event.id,
          source: params.source,
          notifyParticipants: params.notifyParticipants,
        });
        try {
          await params.committed;
          notifierCalls.outcomes.push('committed');
        } catch {
          notifierCalls.outcomes.push('abandoned');
          return;
        }
        notifierCalls.duringNotify?.();
      },
    } as unknown as EventChangeNotifier;
    notified = [];
    const notifyUser = async (userId: number, text: string): Promise<void> => {
      notified.push({ userId, text });
    };
    participantSyncRepo = new ParticipantGoogleSyncRepository(db);
    participantRepo = new ParticipantRepository(db);
    service = new SyncService(
      db,
      eventRepo,
      syncRepo,
      calendarRepo,
      notifyUser,
      () => 'en',
      participantSyncRepo,
      notifier,
      {
        eventRepo,
        participantRepo,
        participantSyncRepo,
        editProposalRepo: new EditProposalRepository(db),
        invitationRepo: new InvitationRepository(db),
        notifyUser,
        getUserLang: () => 'en',
        getUserName: () => 'Participant',
      },
    );
    calendarRepo.upsertCalendar(USER, {
      google_calendar_id: PRIMARY,
      calendar_name: 'Primary',
      is_primary: true,
      access_role: 'owner',
    });
    calendarRepo.upsertCalendar(USER, {
      google_calendar_id: SECONDARY,
      calendar_name: 'Team',
      is_primary: false,
      access_role: 'owner',
    });
    errorLog = spyOn(syncLogger, 'error').mockImplementation(() => {});
    infoLog = spyOn(syncLogger, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    errorLog.mockRestore();
    infoLog.mockRestore();
  });

  function setToken(calendarId: string, token: string): void {
    calendarRepo.updateSyncToken(calendarRepo.getCalendarByGoogleId(USER, calendarId)!.id, token);
  }

  function storedToken(calendarId: string): string | null {
    return calendarRepo.getCalendarByGoogleId(USER, calendarId)!.sync_token;
  }

  /** The production path: the bot creates the event and pushes it; no calendar id is stored for it. */
  async function createAndPush(
    google: GoogleDouble,
    overrides: { recurrence_rule?: string; start_at?: string; all_day?: boolean; timezone?: string } = {},
  ) {
    const start = overrides.start_at ?? '2026-06-02T10:00:00Z';
    const event = eventRepo.create({
      user_id: USER,
      title: 'Planning',
      start_at: start,
      end_at: new Date(Date.parse(start) + 3_600_000).toISOString(),
      all_day: overrides.all_day,
      timezone: overrides.timezone ?? 'Europe/Moscow',
      recurrence_rule: overrides.recurrence_rule,
    });
    eventRepo.updateSyncFields(event.id, { sync_status: 'pending_push' });
    await service.pushEvent(google.api, USER, event.id, 'create');
    // Pushed long ago: a reconcile keeps only what was synced around the time of its read.
    eventRepo.updateSyncFields(event.id, { last_synced_at: '2026-01-01T00:00:00.000Z' });
    const pushed = eventRepo.findById(event.id, USER)!;
    expect(pushed.google_calendar_id).toBeNull();
    return pushed;
  }

  /** A first full read, as after connecting: stores the sync token the next pulls continue from. */
  async function connect(google: GoogleDouble): Promise<void> {
    await service.initialSync(google.api, USER, PRIMARY);
    expect(storedToken(PRIMARY)).not.toBeNull();
  }

  function isDeleted(eventId: number): boolean {
    const row = db.prepare<{ is_deleted: number }, [number]>('SELECT is_deleted FROM events WHERE id = ?').get(eventId);
    return row!.is_deleted === 1;
  }

  function deleteReceipts() {
    return syncRepo.getRecentLogs(USER, 100).filter((log) => log.direction === 'pull' && log.action === 'delete');
  }

  function pullLines() {
    return infoLog.mock.calls.filter((call) => call[1] === 'Google pull applied').map((call) => call[0]);
  }

  describe('single events', () => {
    test('an event the bot pushed (no calendar id stored) is removed when Google deletes it', async () => {
      const google = makeGoogle();
      const pushed = await createAndPush(google);
      await connect(google);

      google.deleteInGoogle(pushed.google_event_id!);
      await service.incrementalPull(google.api, USER, PRIMARY);

      expect(isDeleted(pushed.id)).toBe(true);
      expect(eventRepo.findById(pushed.id, USER)).toBeNull();
      expect(deleteReceipts()).toHaveLength(1);
      expect(deleteReceipts()[0]?.event_id).toBe(pushed.id);
    });

    test('an event the bot pushed to the primary alias is removed when Google deletes it', async () => {
      const google = makeGoogle();
      const pushed = await createAndPush(google);
      eventRepo.updateSyncFields(pushed.id, { google_calendar_id: 'primary' });
      await connect(google);

      google.deleteInGoogle(pushed.google_event_id!);
      await service.incrementalPull(google.api, USER, PRIMARY);

      expect(isDeleted(pushed.id)).toBe(true);
    });

    test('an event made in Google itself is removed when Google deletes it', async () => {
      const google = makeGoogle();
      google.createInGoogle('mine', 'Dentist', '2026-06-03T09:00:00Z');
      await connect(google);
      const imported = eventRepo.findByGoogleEventId(USER, PRIMARY, 'mine')!;
      expect(imported).not.toBeNull();

      google.deleteInGoogle('mine');
      await service.incrementalPull(google.api, USER, PRIMARY);

      expect(isDeleted(imported.id)).toBe(true);
    });

    test('a deletion read from another calendar never removes an event pushed to the primary one', async () => {
      const google = makeGoogle();
      const pushed = await createAndPush(google);
      setToken(SECONDARY, 'secondary-token');
      // Google ids are unique per calendar only: the secondary calendar has its own event with this id.
      google.deleteInGoogle(pushed.google_event_id!);

      await service.incrementalPull(google.api, USER, SECONDARY);

      expect(isDeleted(pushed.id)).toBe(false);
    });

    test('a tombstone of an event the bot never knew changes nothing and is counted', async () => {
      const google = makeGoogle();
      google.createInGoogle('foreign', 'Not mine', '2026-06-03T09:00:00Z');
      await connect(google);
      const imported = eventRepo.findByGoogleEventId(USER, PRIMARY, 'foreign')!;
      eventRepo.remove(imported.id, USER);

      google.deleteInGoogle('foreign');
      await service.incrementalPull(google.api, USER, PRIMARY);

      expect(deleteReceipts()).toHaveLength(0);
      expect(pullLines().at(-1)).toMatchObject({ deleted: 0, unmatchedTombstones: 1 });
    });

    test('the same delta read again deletes nothing twice and sends nothing twice', async () => {
      const google = makeGoogle();
      const pushed = await createAndPush(google);
      await connect(google);
      const tokenBefore = storedToken(PRIMARY);
      google.deleteInGoogle(pushed.google_event_id!);
      await service.incrementalPull(google.api, USER, PRIMARY);

      // The job ran twice (a retry after the answer was lost): the stored token goes back.
      setToken(PRIMARY, tokenBefore!);
      google.deleteInGoogle(pushed.google_event_id!);
      await service.incrementalPull(google.api, USER, PRIMARY);

      expect(deleteReceipts()).toHaveLength(1);
      expect(notifierCalls.deleted).toHaveLength(1);
    });
  });

  describe('recurring series', () => {
    const WEEKLY = 'RRULE:FREQ=WEEKLY;COUNT=6';

    test('deleting the whole series removes the master and its exceptions', async () => {
      const google = makeGoogle();
      const master = await createAndPush(google, { recurrence_rule: WEEKLY });
      const exception = eventRepo.createException(master.id, {
        user_id: USER,
        title: 'Planning',
        start_at: '2026-06-16T10:00:00Z',
        timezone: 'Europe/Moscow',
        original_start_at: '2026-06-16T10:00:00Z',
      });
      await connect(google);

      google.deleteInGoogle(master.google_event_id!);
      await service.incrementalPull(google.api, USER, PRIMARY);

      expect(isDeleted(master.id)).toBe(true);
      expect(isDeleted(exception.id)).toBe(true);
    });

    test('deleting one occurrence cancels that occurrence and keeps the series', async () => {
      const google = makeGoogle();
      const master = await createAndPush(google, { recurrence_rule: WEEKLY });
      await connect(google);

      google.deleteInstanceInGoogle(master.google_event_id!, '2026-06-09T13:00:00+03:00');
      await service.incrementalPull(google.api, USER, PRIMARY);

      expect(isDeleted(master.id)).toBe(false);
      const exceptions = eventRepo.getExceptions(master.id);
      expect(exceptions).toHaveLength(1);
      expect(exceptions[0]?.is_cancelled).toBe(1);
      expect(new Date(exceptions[0]!.original_start_at!).toISOString()).toBe('2026-06-09T10:00:00.000Z');
      const occurrences = expandRecurrence(
        eventRepo.findById(master.id, USER)!,
        exceptions,
        '2026-06-01T00:00:00Z',
        '2026-07-31T00:00:00Z',
      ).map((occurrence) => occurrence.occurrence_start.slice(0, 10));
      expect(occurrences).toEqual(['2026-06-02', '2026-06-16', '2026-06-23', '2026-06-30', '2026-07-07']);
      expect(pullLines().at(-1)).toMatchObject({ deleted: 0, occurrencesCancelled: 1 });
    });

    test('the same occurrence deletion read twice leaves one exception', async () => {
      const google = makeGoogle();
      const master = await createAndPush(google, { recurrence_rule: WEEKLY });
      await connect(google);
      const tokenBefore = storedToken(PRIMARY)!;
      google.deleteInstanceInGoogle(master.google_event_id!, '2026-06-09T13:00:00+03:00');
      await service.incrementalPull(google.api, USER, PRIMARY);

      setToken(PRIMARY, tokenBefore);
      google.deleteInstanceInGoogle(master.google_event_id!, '2026-06-09T13:00:00+03:00');
      await service.incrementalPull(google.api, USER, PRIMARY);

      expect(eventRepo.getExceptions(master.id)).toHaveLength(1);
    });

    test('an occurrence the bot already changed is cancelled, not duplicated', async () => {
      const google = makeGoogle();
      const master = await createAndPush(google, { recurrence_rule: WEEKLY });
      const moved = eventRepo.createException(master.id, {
        user_id: USER,
        title: 'Planning (moved)',
        start_at: '2026-06-09T12:00:00Z',
        timezone: 'Europe/Moscow',
        original_start_at: '2026-06-09T10:00:00Z',
      });
      await connect(google);

      google.deleteInstanceInGoogle(master.google_event_id!, '2026-06-09T13:00:00+03:00');
      await service.incrementalPull(google.api, USER, PRIMARY);

      const exceptions = eventRepo.getExceptions(master.id);
      expect(exceptions.map((exception) => exception.id)).toEqual([moved.id]);
      expect(exceptions[0]?.is_cancelled).toBe(1);
    });

    test('a cancelled occurrence of a series the bot does not know is ignored', async () => {
      const google = makeGoogle();
      await connect(google);
      google.deleteInstanceInGoogle('unknown-series', '2026-06-09T13:00:00+03:00');

      await service.incrementalPull(google.api, USER, PRIMARY);

      expect(pullLines().at(-1)).toMatchObject({ occurrencesCancelled: 0, unmatchedTombstones: 1 });
    });
  });

  describe('paged deltas', () => {
    test('a deletion on the last page is applied and the token moves only after every page', async () => {
      const google = makeGoogle(1);
      const first = await createAndPush(google);
      const second = await createAndPush(google, { start_at: '2026-06-03T10:00:00Z' });
      const third = await createAndPush(google, { start_at: '2026-06-04T10:00:00Z' });
      await connect(google);
      const tokenBefore = storedToken(PRIMARY);

      for (const event of [first, second, third]) google.deleteInGoogle(event.google_event_id!);
      await service.incrementalPull(google.api, USER, PRIMARY);

      expect([first, second, third].map((event) => isDeleted(event.id))).toEqual([true, true, true]);
      expect(storedToken(PRIMARY)).not.toBe(tokenBefore);
      expect(pullLines().at(-1)).toMatchObject({ pages: 3, items: 3, deleted: 3 });
    });

    test('a failure on a later page keeps the old token and the retry finishes the delta', async () => {
      const google = makeGoogle(1);
      const first = await createAndPush(google);
      const second = await createAndPush(google, { start_at: '2026-06-03T10:00:00Z' });
      await connect(google);
      const tokenBefore = storedToken(PRIMARY);
      google.deleteInGoogle(first.google_event_id!);
      google.deleteInGoogle(second.google_event_id!);
      google.failListAt('1', Object.assign(new Error('backend error'), { code: 503 }));

      await expect(service.incrementalPull(google.api, USER, PRIMARY)).rejects.toThrow('backend error');
      expect(storedToken(PRIMARY)).toBe(tokenBefore);
      expect(errorLog.mock.calls.some((call) => call[1] === 'Google pull failed')).toBe(true);

      // The retry reads the delta again from the old token.
      google.deleteInGoogle(first.google_event_id!);
      google.deleteInGoogle(second.google_event_id!);
      await service.incrementalPull(google.api, USER, PRIMARY);
      expect(isDeleted(first.id)).toBe(true);
      expect(isDeleted(second.id)).toBe(true);
      expect(deleteReceipts()).toHaveLength(2);
    });
  });

  describe('token and access failures are surfaced', () => {
    test('a revoked grant propagates, deletes nothing and keeps the sync token', async () => {
      const google = makeGoogle();
      const pushed = await createAndPush(google);
      await connect(google);
      const tokenBefore = storedToken(PRIMARY);
      google.deleteInGoogle(pushed.google_event_id!);
      google.failListAt('', Object.assign(new Error('invalid_grant'), { code: 400 }));

      await expect(service.incrementalPull(google.api, USER, PRIMARY)).rejects.toThrow('invalid_grant');

      expect(isDeleted(pushed.id)).toBe(false);
      expect(storedToken(PRIMARY)).toBe(tokenBefore);
      const failure = errorLog.mock.calls.find((call) => call[1] === 'Google pull failed');
      expect(failure).toBeDefined();
      expect(failure?.[0]).toMatchObject({ userId: USER, calendarId: PRIMARY, pages: 0 });
    });

    test('a calendar that is no longer shared (404) propagates and removes nothing', async () => {
      const google = makeGoogle();
      const pushed = await createAndPush(google);
      await connect(google);
      google.failListAt('', Object.assign(new Error('Not Found'), { code: 404 }));

      await expect(service.incrementalPull(google.api, USER, PRIMARY)).rejects.toThrow('Not Found');

      expect(isDeleted(pushed.id)).toBe(false);
    });
  });

  describe('a stale sync token (410 Gone)', () => {
    test('deletions missed before the reset are removed by the full read that follows', async () => {
      const google = makeGoogle();
      const gone = await createAndPush(google);
      const kept = await createAndPush(google, { start_at: '2026-06-03T10:00:00Z' });
      google.createInGoogle('mine', 'Dentist', '2026-06-04T09:00:00Z');
      google.createInGoogle('mine-gone', 'Lunch', '2026-06-05T09:00:00Z');
      await connect(google);
      const importedGone = eventRepo.findByGoogleEventId(USER, PRIMARY, 'mine-gone')!;
      const importedKept = eventRepo.findByGoogleEventId(USER, PRIMARY, 'mine')!;
      // Imported long ago: only rows created around the read are kept as fresh.
      db.run("UPDATE events SET created_at = '2026-01-01 00:00:00' WHERE google_event_id IN ('mine', 'mine-gone')");
      google.deleteInGoogle(gone.google_event_id!);
      google.deleteInGoogle('mine-gone');
      google.expireTokens();

      await service.incrementalPull(google.api, USER, PRIMARY);

      expect(isDeleted(gone.id)).toBe(true);
      expect(isDeleted(importedGone.id)).toBe(true);
      expect(isDeleted(kept.id)).toBe(false);
      expect(isDeleted(importedKept.id)).toBe(false);
      expect(storedToken(PRIMARY)).not.toBeNull();
      expect(storedToken(PRIMARY)).not.toBe('stale');
    });

    test('an edit waiting to be pushed survives the reset', async () => {
      const google = makeGoogle();
      const pending = await createAndPush(google);
      await connect(google);
      eventRepo.updateSyncFields(pending.id, { sync_status: 'pending_push' });
      google.deleteInGoogle(pending.google_event_id!);
      google.expireTokens();

      await service.incrementalPull(google.api, USER, PRIMARY);

      expect(isDeleted(pending.id)).toBe(false);
    });

    test('a repair that fails keeps the old token, so the next pull repeats it', async () => {
      const google = makeGoogle();
      const gone = await createAndPush(google);
      await createAndPush(google, { start_at: '2026-06-03T10:00:00Z' });
      await connect(google);
      const tokenBefore = storedToken(PRIMARY);
      google.deleteInGoogle(gone.google_event_id!);
      google.expireTokens();
      const logSync = spyOn(syncRepo, 'logSync').mockImplementationOnce(() => {
        throw new Error('SQLITE_BUSY');
      });

      await expect(service.incrementalPull(google.api, USER, PRIMARY)).rejects.toThrow('SQLITE_BUSY');
      expect(storedToken(PRIMARY)).toBe(tokenBefore);
      expect(isDeleted(gone.id)).toBe(false);
      logSync.mockRestore();

      google.expireTokens();
      await service.incrementalPull(google.api, USER, PRIMARY);
      expect(isDeleted(gone.id)).toBe(true);
    });
  });

  describe('reconcile on start', () => {
    test('removes events whose Google copy is gone and keeps the live ones', async () => {
      const google = makeGoogle();
      const gone = await createAndPush(google);
      const kept = await createAndPush(google, { start_at: '2026-06-03T10:00:00Z' });
      await connect(google);
      // The deletion was missed (the bug this fixes): the delta that carried it is no longer available.
      google.deleteInGoogle(gone.google_event_id!);
      const tokenBefore = storedToken(PRIMARY);

      const result = await service.reconcileDeletions(google.api, USER, PRIMARY);

      expect(result).toMatchObject({ tracked: 2, removed: 1, refused: false });
      expect(isDeleted(gone.id)).toBe(true);
      expect(isDeleted(kept.id)).toBe(false);
      expect(storedToken(PRIMARY)).toBe(tokenBefore);
      expect(deleteReceipts()).toHaveLength(1);
      expect(JSON.parse(deleteReceipts()[0]!.details!)).toMatchObject({ reason: 'absent_in_full_list' });
    });

    test('never messages invitees about a deletion of unknown age', async () => {
      const google = makeGoogle();
      const gone = await createAndPush(google, { start_at: '2999-01-01T10:00:00Z' });
      await createAndPush(google, { start_at: '2999-01-02T10:00:00Z' });
      await connect(google);
      google.deleteInGoogle(gone.google_event_id!);

      await service.reconcileDeletions(google.api, USER, PRIMARY);

      expect(notifierCalls.deleted).toEqual([{ eventId: gone.id, source: 'google_sync', notifyParticipants: false }]);
    });

    test('keeps an event whose push finished while the list was being read', async () => {
      const google = makeGoogle();
      const fresh = await createAndPush(google);
      // Google's list was taken before this push landed: its copy is missing from the list.
      google.events.delete(fresh.google_event_id!);
      eventRepo.updateSyncFields(fresh.id, { last_synced_at: new Date(Date.now() + 60_000).toISOString() });

      const result = await service.reconcileDeletions(google.api, USER, PRIMARY);

      expect(result).toMatchObject({ removed: 0, skippedFresh: 1 });
      expect(isDeleted(fresh.id)).toBe(false);
    });

    test('keeps an event with a local edit still waiting to be pushed', async () => {
      const google = makeGoogle();
      const pending = await createAndPush(google);
      eventRepo.updateSyncFields(pending.id, { sync_status: 'pending_push' });
      google.events.delete(pending.google_event_id!);

      const result = await service.reconcileDeletions(google.api, USER, PRIMARY);

      expect(result).toMatchObject({ removed: 0, skippedPending: 1 });
      expect(isDeleted(pending.id)).toBe(false);
    });

    test('refuses to empty a calendar when Google lists nothing', async () => {
      const google = makeGoogle();
      const a = await createAndPush(google);
      const b = await createAndPush(google, { start_at: '2026-06-03T10:00:00Z' });
      const c = await createAndPush(google, { start_at: '2026-06-04T10:00:00Z' });
      google.events.clear();

      const result = await service.reconcileDeletions(google.api, USER, PRIMARY);

      expect(result).toMatchObject({ removed: 0, refused: true });
      expect(isDeleted(a.id)).toBe(false);
      expect(isDeleted(b.id)).toBe(false);
      expect(isDeleted(c.id)).toBe(false);
      expect(errorLog.mock.calls.some((call) => call[1] === 'Google reconcile refused')).toBe(true);
    });

    test('refuses a deletion of most of the calendar at once', async () => {
      const google = makeGoogle();
      const ids: number[] = [];
      for (let day = 1; day <= 14; day++) {
        const pushed = await createAndPush(google, { start_at: `2026-06-${String(day).padStart(2, '0')}T10:00:00Z` });
        ids.push(pushed.id);
      }
      // Twelve of fourteen vanish from the list: more than the guard allows.
      for (const id of ids.slice(0, 12)) google.events.delete(eventRepo.findById(id, USER)!.google_event_id!);

      const result = await service.reconcileDeletions(google.api, USER, PRIMARY);

      expect(result).toMatchObject({ removed: 0, refused: true });
      expect(ids.every((id) => !isDeleted(id))).toBe(true);
    });

    test('a failure while listing removes nothing and propagates', async () => {
      const google = makeGoogle();
      const pushed = await createAndPush(google);
      google.failListAt('', Object.assign(new Error('Forbidden'), { code: 403 }));

      await expect(service.reconcileDeletions(google.api, USER, PRIMARY)).rejects.toThrow('Forbidden');

      expect(isDeleted(pushed.id)).toBe(false);
    });
  });

  describe('invitees', () => {
    test('a live deletion of an upcoming event keeps the delete semantics of the bot: invitees are told', async () => {
      const google = makeGoogle();
      const pushed = await createAndPush(google, { start_at: '2999-01-01T10:00:00Z' });
      await connect(google);

      google.deleteInGoogle(pushed.google_event_id!);
      await service.incrementalPull(google.api, USER, PRIMARY);

      expect(notifierCalls.deleted).toEqual([{ eventId: pushed.id, source: 'google_sync', notifyParticipants: true }]);
    });

    test('a deletion of an event that is over does not message anyone', async () => {
      const google = makeGoogle();
      const pushed = await createAndPush(google);
      await connect(google);

      google.deleteInGoogle(pushed.google_event_id!);
      await service.incrementalPull(google.api, USER, PRIMARY);

      expect(notifierCalls.deleted).toEqual([{ eventId: pushed.id, source: 'google_sync', notifyParticipants: false }]);
    });
  });

  describe('counters', () => {
    test('every pull logs its pages, items and what it applied', async () => {
      const google = makeGoogle();
      const pushed = await createAndPush(google);
      await connect(google);
      google.deleteInGoogle(pushed.google_event_id!);

      await service.incrementalPull(google.api, USER, PRIMARY);

      expect(pullLines().at(-1)).toEqual({
        userId: USER,
        calendarId: PRIMARY,
        pages: 1,
        items: 1,
        deleted: 1,
        occurrencesCancelled: 0,
        participantCopiesDeleted: 0,
        unmatchedTombstones: 0,
        botCopiesSkipped: 0,
      });
    });
  });

  describe('occurrences the bot holds under their own id', () => {
    const SERIES: calendar_v3.Schema$Event = {
      summary: 'Weekly',
      start: { dateTime: '2026-06-02T10:00:00Z', timeZone: 'Europe/Moscow' },
      end: { dateTime: '2026-06-02T11:00:00Z', timeZone: 'Europe/Moscow' },
      recurrence: ['RRULE:FREQ=WEEKLY;COUNT=6'],
    };

    function occurrenceDays(masterId: number): string[] {
      return expandRecurrence(
        eventRepo.findById(masterId, USER)!,
        eventRepo.getExceptions(masterId),
        '2026-06-01T00:00:00Z',
        '2026-07-31T00:00:00Z',
      ).map((occurrence) => occurrence.occurrence_start.slice(0, 10));
    }

    test('a moved occurrence imported as its own event is removed and the series stops listing it', async () => {
      const google = makeGoogle();
      google.putInGoogle('series1', SERIES);
      google.putInGoogle('series1_20260609T100000Z', {
        summary: 'Weekly (moved)',
        recurringEventId: 'series1',
        originalStartTime: { dateTime: '2026-06-09T10:00:00Z' },
        start: { dateTime: '2026-06-09T12:00:00Z' },
        end: { dateTime: '2026-06-09T13:00:00Z' },
      });
      await connect(google);
      const master = eventRepo.findByGoogleEventId(USER, PRIMARY, 'series1')!;
      const moved = eventRepo.findByGoogleEventId(USER, PRIMARY, 'series1_20260609T100000Z')!;
      expect(moved).not.toBeNull();

      google.deleteInstanceInGoogle('series1', '2026-06-09T10:00:00Z');
      await service.incrementalPull(google.api, USER, PRIMARY);

      expect(isDeleted(moved.id)).toBe(true);
      expect(isDeleted(master.id)).toBe(false);
      expect(occurrenceDays(master.id)).toEqual(['2026-06-02', '2026-06-16', '2026-06-23', '2026-06-30', '2026-07-07']);
    });

    test('an exception row that carries the occurrence id stays as the cancelled occurrence', async () => {
      const google = makeGoogle();
      const master = await createAndPush(google, { recurrence_rule: 'RRULE:FREQ=WEEKLY;COUNT=6' });
      const exception = eventRepo.createException(master.id, {
        user_id: USER,
        title: 'Planning (moved)',
        start_at: '2026-06-09T12:00:00Z',
        timezone: 'Europe/Moscow',
        original_start_at: '2026-06-09T10:00:00Z',
      });
      eventRepo.updateSyncFields(exception.id, { google_event_id: `${master.google_event_id}_20260609T100000Z` });
      await connect(google);

      google.deleteInstanceInGoogle(master.google_event_id!, '2026-06-09T10:00:00Z');
      await service.incrementalPull(google.api, USER, PRIMARY);

      expect(isDeleted(exception.id)).toBe(false);
      const exceptions = eventRepo.getExceptions(master.id);
      expect(exceptions.map((row) => [row.id, row.is_cancelled])).toEqual([[exception.id, 1]]);
      expect(deleteReceipts()).toHaveLength(1);
      expect(occurrenceDays(master.id)).toEqual(['2026-06-02', '2026-06-16', '2026-06-23', '2026-06-30', '2026-07-07']);
    });

    test('a deleted occurrence of a daily all-day series in a negative-offset zone is the day written', async () => {
      const google = makeGoogle();
      const master = await createAndPush(google, {
        recurrence_rule: 'RRULE:FREQ=DAILY;COUNT=10',
        start_at: '2026-06-02T00:00:00Z',
        all_day: true,
        timezone: 'America/New_York',
      });
      await connect(google);

      google.deleteInstanceInGoogle(master.google_event_id!, '2026-06-09', true);
      await service.incrementalPull(google.api, USER, PRIMARY);

      const exceptions = eventRepo.getExceptions(master.id);
      expect(exceptions.map((row) => row.original_start_at)).toEqual(['2026-06-09T00:00:00.000Z']);
    });

    test.each([
      ['stored as UTC midnight', '2026-06-02T00:00:00Z', '2026-06-09T00:00:00.000Z'],
      ['stored as local midnight (UTC+2)', '2026-06-01T22:00:00Z', '2026-06-08T22:00:00.000Z'],
    ])('a deleted occurrence of an all-day series %s is cancelled on the right day', async (_label, start, cancelled) => {
      const google = makeGoogle();
      const master = await createAndPush(google, {
        recurrence_rule: 'RRULE:FREQ=WEEKLY;COUNT=6',
        start_at: start,
        all_day: true,
        timezone: 'Europe/Belgrade',
      });
      await connect(google);

      google.deleteInstanceInGoogle(master.google_event_id!, '2026-06-09', true);
      await service.incrementalPull(google.api, USER, PRIMARY);

      const exceptions = eventRepo.getExceptions(master.id);
      expect(exceptions).toHaveLength(1);
      expect(new Date(exceptions[0]!.original_start_at!).toISOString()).toBe(cancelled);
      const left = expandRecurrence(
        eventRepo.findById(master.id, USER)!,
        exceptions,
        '2026-06-01T00:00:00Z',
        '2026-07-31T00:00:00Z',
      ).map((occurrence) => occurrence.occurrence_start);
      expect(left).toHaveLength(5);
      expect(left).not.toContain(cancelled);
    });
  });

  describe("copies of other people's events in the user's calendar", () => {
    function linkCopy(calendar: string): { eventId: number } {
      const event = eventRepo.create({
        user_id: 2,
        title: 'Dinner',
        start_at: '2999-01-01T18:00:00Z',
        end_at: '2999-01-01T19:00:00Z',
        timezone: 'UTC',
      });
      participantRepo.add(event.id, USER, 'accepted');
      participantSyncRepo.upsert(USER, event.id, {
        google_event_id: 'copy1',
        google_calendar_id: calendar,
        sync_status: 'synced',
      });
      return { eventId: event.id };
    }

    /** The copy as the bot pushed it, then deleted in Google: the tombstone keeps the marker. */
    function deletedCopy(google: GoogleDouble): void {
      google.putInGoogle('copy1', {
        summary: 'Dinner',
        start: { dateTime: '2999-01-01T18:00:00Z' },
        end: { dateTime: '2999-01-01T19:00:00Z' },
        extendedProperties: { private: { hypercalendarbot_event_id: '999' } },
      });
      google.deleteInGoogle('copy1');
    }

    test('the participant who deletes their copy declines, and the organizer is told once', async () => {
      const google = makeGoogle();
      const { eventId } = linkCopy('primary');
      await connect(google);
      deletedCopy(google);

      await service.incrementalPull(google.api, USER, PRIMARY);

      expect(participantRepo.findByEventAndUser(eventId, USER)?.status).toBe('declined');
      expect(notified.map((message) => message.userId)).toEqual([2]);
      expect(pullLines().at(-1)).toMatchObject({ participantCopiesDeleted: 1, unmatchedTombstones: 0 });
    });

    test('a tombstone of the same id in another calendar leaves the copy alone', async () => {
      const google = makeGoogle();
      const { eventId } = linkCopy('primary');
      setToken(SECONDARY, 'secondary-token');
      deletedCopy(google);

      await service.incrementalPull(google.api, USER, SECONDARY);

      expect(participantRepo.findByEventAndUser(eventId, USER)?.status).toBe('accepted');
      expect(notified).toEqual([]);
      expect(pullLines().at(-1)).toMatchObject({ participantCopiesDeleted: 0, unmatchedTombstones: 1 });
    });

    test('the echo of the bot deleting the copy of an event it deleted is not a decline', async () => {
      const google = makeGoogle();
      const { eventId } = linkCopy('primary');
      await connect(google);
      eventRepo.remove(eventId, 2);
      // The bot's job that removes the copy has not yet dropped the link row.
      participantSyncRepo.upsert(USER, eventId, { google_event_id: 'copy1', google_calendar_id: 'primary' });
      deletedCopy(google);

      await service.incrementalPull(google.api, USER, PRIMARY);

      expect(participantSyncRepo.getByUserAndEvent(USER, eventId)).not.toBeNull();
      expect(notified).toEqual([]);
      expect(pullLines().at(-1)).toMatchObject({ participantCopiesDeleted: 0, unmatchedTombstones: 1 });
    });
  });

  describe('reconcile guards', () => {
    test('refuses a read that lists nothing even for two events', async () => {
      const google = makeGoogle();
      const a = await createAndPush(google);
      const b = await createAndPush(google, { start_at: '2026-06-03T10:00:00Z' });
      google.events.clear();

      const result = await service.reconcileDeletions(google.api, USER, PRIMARY);

      expect(result).toMatchObject({ removed: 0, refused: true });
      expect(isDeleted(a.id)).toBe(false);
      expect(isDeleted(b.id)).toBe(false);
    });

    test('an edit made while earlier removals are still being announced is not lost', async () => {
      const google = makeGoogle();
      const first = await createAndPush(google);
      const second = await createAndPush(google, { start_at: '2026-06-03T10:00:00Z' });
      await createAndPush(google, { start_at: '2026-06-04T10:00:00Z' });
      await createAndPush(google, { start_at: '2026-06-05T10:00:00Z' });
      await createAndPush(google, { start_at: '2026-06-06T10:00:00Z' });
      google.events.delete(first.google_event_id!);
      google.events.delete(second.google_event_id!);
      // The user edits the second event in the bot while the first removal is announced.
      notifierCalls.duringNotify = () => eventRepo.updateSyncFields(second.id, { sync_status: 'pending_push' });

      const result = await service.reconcileDeletions(google.api, USER, PRIMARY);

      expect(isDeleted(first.id)).toBe(true);
      expect(isDeleted(second.id)).toBe(false);
      expect(result).toMatchObject({ removed: 1, skippedPending: 1 });
    });

    test('a push that completed while earlier removals were announced keeps its event', async () => {
      const google = makeGoogle();
      const first = await createAndPush(google);
      const second = await createAndPush(google, { start_at: '2026-06-03T10:00:00Z' });
      await createAndPush(google, { start_at: '2026-06-04T10:00:00Z' });
      await createAndPush(google, { start_at: '2026-06-05T10:00:00Z' });
      await createAndPush(google, { start_at: '2026-06-06T10:00:00Z' });
      google.events.delete(first.google_event_id!);
      google.events.delete(second.google_event_id!);
      notifierCalls.duringNotify = () =>
        eventRepo.updateSyncFields(second.id, { last_synced_at: new Date(Date.now() + 60_000).toISOString() });

      const result = await service.reconcileDeletions(google.api, USER, PRIMARY);

      expect(isDeleted(first.id)).toBe(true);
      expect(isDeleted(second.id)).toBe(false);
      expect(result).toMatchObject({ removed: 1, skippedFresh: 1 });
    });

    test('an event linked to another Google event meanwhile is not removed for the old one', async () => {
      const google = makeGoogle();
      const first = await createAndPush(google);
      const second = await createAndPush(google, { start_at: '2026-06-03T10:00:00Z' });
      await createAndPush(google, { start_at: '2026-06-04T10:00:00Z' });
      await createAndPush(google, { start_at: '2026-06-05T10:00:00Z' });
      await createAndPush(google, { start_at: '2026-06-06T10:00:00Z' });
      google.events.delete(first.google_event_id!);
      google.events.delete(second.google_event_id!);
      // The push of the second event found its copy gone and recreated it under a new id.
      notifierCalls.duringNotify = () => eventRepo.updateSyncFields(second.id, { google_event_id: 'recreated' });

      await service.reconcileDeletions(google.api, USER, PRIMARY);

      expect(isDeleted(first.id)).toBe(true);
      expect(isDeleted(second.id)).toBe(false);
    });

    test('a first full read after connecting removes nothing, even for an event Google does not list', async () => {
      const google = makeGoogle();
      const pushed = await createAndPush(google);
      google.events.delete(pushed.google_event_id!);
      google.createInGoogle('other', 'Other', '2026-06-08T10:00:00Z');

      await service.initialSync(google.api, USER, PRIMARY);

      expect(isDeleted(pushed.id)).toBe(false);
    });
  });

  describe('removal that fails', () => {
    test('is never announced, and the retry announces it once', async () => {
      const google = makeGoogle();
      const pushed = await createAndPush(google, { start_at: '2999-01-01T10:00:00Z' });
      await connect(google);
      google.deleteInGoogle(pushed.google_event_id!);
      const logSync = spyOn(syncRepo, 'logSync').mockImplementationOnce(() => {
        throw new Error('SQLITE_BUSY');
      });

      await expect(service.incrementalPull(google.api, USER, PRIMARY)).rejects.toThrow('SQLITE_BUSY');

      expect(isDeleted(pushed.id)).toBe(false);
      expect(notifierCalls.outcomes).toEqual(['abandoned']);
      logSync.mockRestore();

      // The job is retried: the token did not move, so the delta is read again.
      google.deleteInGoogle(pushed.google_event_id!);
      await service.incrementalPull(google.api, USER, PRIMARY);
      expect(isDeleted(pushed.id)).toBe(true);
      expect(notifierCalls.outcomes).toEqual(['abandoned', 'committed']);
      expect(deleteReceipts()).toHaveLength(1);
    });
  });

  describe('all-day events', () => {
    test('an all-day event without an end is still upcoming during its day: invitees are told', async () => {
      const google = makeGoogle();
      const today = `${new Date().toISOString().slice(0, 10)}T00:00:00Z`;
      const event = eventRepo.create({
        user_id: USER,
        title: 'Offsite',
        start_at: today,
        all_day: true,
        timezone: 'UTC',
      });
      eventRepo.updateSyncFields(event.id, { google_event_id: 'gad', sync_status: 'synced' });
      await connect(google);
      google.putInGoogle('gad', { summary: 'Offsite', status: 'cancelled' });

      await service.incrementalPull(google.api, USER, PRIMARY);

      expect(isDeleted(event.id)).toBe(true);
      expect(notifierCalls.deleted).toEqual([{ eventId: event.id, source: 'google_sync', notifyParticipants: true }]);
    });
  });
});
