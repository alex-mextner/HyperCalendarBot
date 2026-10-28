// #875: the Google id of a copy the bot creates in Google Calendar is recorded with the creation
// receipt in one transaction, and a creation whose answer was lost is recovered through the copy's
// bot-event marker instead of being replayed into a second copy. Real SQLite, a stateful fake Google
// Calendar that can lose the answer of an insert after creating the event. Synthetic ids and titles.
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, spyOn, test } from 'bun:test';
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
import { BOT_EVENT_MARKER } from '../../../src/services/google/event-mapper.ts';
import { SyncService } from '../../../src/services/google/sync-service.ts';

const OWNER = 9301;
const GUEST = 9302;

/** The shape gaxios gives an HTTP error: numeric code. */
function httpError(status: number): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), { code: status, status });
}

/** The shape gaxios gives an aborted request: a string code, no status. */
function timeoutError(): Error {
  return Object.assign(new Error('The operation was aborted due to timeout'), { code: 'TimeoutError' });
}

/** What the next insert does besides storing the event. */
type InsertFault = 'lose-answer' | 'answer-without-id' | 'refuse';

interface GoogleCopy extends calendar_v3.Schema$Event {
  id: string;
  created: string;
}

interface PlantOptions {
  status?: string;
  /** The copy is an instance of a series, whatever marker it carries. */
  recurringEventId?: string;
}

interface GoogleDouble {
  api: GoogleCalendarApi;
  calls: { insert: number; update: number; lookup: number };
  failNextInsert(fault: InsertFault): void;
  /** Runs `claim` with the new id right after the next insert stored its event, before the answer returns. */
  afterNextInsert(claim: (googleEventId: string) => void): void;
  /** The next update of `eventId` answers 404, as when the copy was deleted since it was listed. */
  failUpdateOf(eventId: string): void;
  liveCopiesOf(botEventId: number): GoogleCopy[];
  plant(id: string, botEventId: number, options?: PlantOptions): string;
}

/** A Google Calendar that keeps what was inserted, so a lost answer leaves the event behind. */
function makeGoogle(): GoogleDouble {
  const store = new Map<string, GoogleCopy>();
  const faults: InsertFault[] = [];
  const afterInsert: Array<(googleEventId: string) => void> = [];
  const goneOnUpdate = new Set<string>();
  const calls = { insert: 0, update: 0, lookup: 0 };
  let seq = 0;

  const put = (id: string, body: calendar_v3.Schema$Event, status = 'confirmed'): GoogleCopy => {
    seq++;
    const saved: GoogleCopy = {
      ...body,
      id,
      etag: `"e${seq}"`,
      status,
      created: `2026-10-28T10:00:${String(seq).padStart(2, '0')}.000Z`,
    };
    store.set(id, saved);
    return saved;
  };
  const marked = (copy: calendar_v3.Schema$Event, botEventId: number): boolean =>
    copy.extendedProperties?.private?.[BOT_EVENT_MARKER] === String(botEventId);

  const api = {
    insertEvent: async (_calendarId: string, body: calendar_v3.Schema$Event) => {
      calls.insert++;
      const fault = faults.shift();
      if (fault === 'refuse') throw httpError(500);
      const saved = put(`g${store.size + 1}`, body);
      afterInsert.shift()?.(saved.id);
      if (fault === 'lose-answer') throw timeoutError();
      if (fault === 'answer-without-id') return { etag: saved.etag };
      return saved;
    },
    updateEvent: async (_calendarId: string, eventId: string, body: calendar_v3.Schema$Event) => {
      calls.update++;
      const current = store.get(eventId);
      if (!current || current.status === 'cancelled' || goneOnUpdate.delete(eventId)) throw httpError(404);
      return put(eventId, { ...body, status: 'confirmed' });
    },
    getEvent: async (_calendarId: string, eventId: string) => {
      const current = store.get(eventId);
      if (!current) throw httpError(404);
      return current;
    },
    deleteEvent: async (_calendarId: string, eventId: string) => {
      const current = store.get(eventId);
      if (!current) throw httpError(404);
      store.set(eventId, { ...current, status: 'cancelled' });
    },
    // What Google lists: live events only, the server-side filter on the marker applied.
    findBotEventCopies: async (_calendarId: string, botEventId: number) => {
      calls.lookup++;
      return [...store.values()].filter((copy) => copy.status !== 'cancelled' && marked(copy, botEventId));
    },
  };

  return {
    api: api as unknown as GoogleCalendarApi,
    calls,
    failNextInsert(fault) {
      faults.push(fault);
    },
    afterNextInsert(claim) {
      afterInsert.push(claim);
    },
    failUpdateOf(eventId) {
      goneOnUpdate.add(eventId);
    },
    liveCopiesOf: (botEventId) =>
      [...store.values()].filter((copy) => copy.status !== 'cancelled' && marked(copy, botEventId)),
    plant(id, botEventId, options = {}) {
      put(
        id,
        {
          summary: 'Planted copy',
          start: { dateTime: '2026-10-30T10:00:00.000Z' },
          end: { dateTime: '2026-10-30T11:00:00.000Z' },
          extendedProperties: { private: { [BOT_EVENT_MARKER]: String(botEventId) } },
          ...(options.recurringEventId ? { recurringEventId: options.recurringEventId } : {}),
        },
        options.status,
      );
      return id;
    },
  };
}

interface Receipt {
  action: string;
  google_event_id: string | null;
  details: string | null;
}

describe('the Google id of a copy the bot creates (#875)', () => {
  let db: Database;
  let eventRepo: EventRepository;
  let syncRepo: GoogleSyncRepository;
  let participantRepo: ParticipantRepository;
  let participantSyncRepo: ParticipantGoogleSyncRepository;
  let service: SyncService;
  let google: GoogleDouble;
  let eventId: number;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, migrations);
    db.run(`INSERT INTO users (telegram_id, username) VALUES (${OWNER}, 'owner'), (${GUEST}, 'guest')`);
    eventRepo = new EventRepository(db);
    syncRepo = new GoogleSyncRepository(db);
    participantRepo = new ParticipantRepository(db);
    participantSyncRepo = new ParticipantGoogleSyncRepository(db);
    service = new SyncService(
      db,
      eventRepo,
      syncRepo,
      new GoogleCalendarRepository(db),
      undefined,
      undefined,
      participantSyncRepo,
      undefined,
      {
        eventRepo,
        participantRepo,
        participantSyncRepo,
        editProposalRepo: new EditProposalRepository(db),
        invitationRepo: new InvitationRepository(db),
        notifyUser: () => Promise.resolve(),
        getUserLang: () => 'en',
        getUserName: () => 'Guest',
      },
    );
    google = makeGoogle();
    eventId = eventRepo.create({
      user_id: OWNER,
      title: 'Planning',
      start_at: '2026-10-30T10:00:00.000Z',
      end_at: '2026-10-30T11:00:00.000Z',
      timezone: 'Europe/Belgrade',
    }).id;
    eventRepo.updateSyncFields(eventId, { sync_status: 'pending_push' });
  });

  const row = () => eventRepo.findById(eventId, OWNER)!;

  function receipts(userId: number, action = 'create'): Receipt[] {
    return db
      .prepare(
        "SELECT action, google_event_id, details FROM sync_log WHERE user_id = ? AND direction = 'push' AND action = ? ORDER BY id",
      )
      .all(userId, action) as Receipt[];
  }

  describe('the owner copy', () => {
    test('the creation receipt carries the id the insert returned, next to the row link', async () => {
      await service.pushEvent(google.api, OWNER, eventId, 'create');

      const [copy] = google.liveCopiesOf(eventId);
      expect(copy).toBeDefined();
      expect(row().google_event_id).toBe(copy!.id);
      expect(row().sync_status).toBe('synced');
      expect(receipts(OWNER)).toEqual([
        { action: 'create', google_event_id: copy!.id, details: JSON.stringify({ via: 'inserted' }) },
      ]);
    });

    test('a failure while recording rolls the link back with the receipt, and the retry adopts the copy', async () => {
      const logSync = spyOn(syncRepo, 'logSync').mockImplementationOnce(() => {
        throw new Error('disk I/O error');
      });
      await expect(service.pushEvent(google.api, OWNER, eventId, 'create')).rejects.toThrow('disk I/O error');
      logSync.mockRestore();

      // Unknown, not failed: the copy exists in Google, the row has no link and is still waiting.
      expect(google.liveCopiesOf(eventId)).toHaveLength(1);
      expect(row().google_event_id).toBeNull();
      expect(row().sync_status).toBe('pending_push');

      await service.pushEvent(google.api, OWNER, eventId, 'create');

      const copies = google.liveCopiesOf(eventId);
      expect(copies).toHaveLength(1);
      expect(row().google_event_id).toBe(copies[0]!.id);
      expect(receipts(OWNER).map((r) => r.details)).toEqual([JSON.stringify({ via: 'adopted_by_marker' })]);
    });

    test('a lost answer after the copy was created is recovered by the retry without a second copy', async () => {
      google.failNextInsert('lose-answer');
      await expect(service.pushEvent(google.api, OWNER, eventId, 'create')).rejects.toThrow('timeout');
      expect(google.liveCopiesOf(eventId)).toHaveLength(1);
      expect(row().google_event_id).toBeNull();

      await service.pushEvent(google.api, OWNER, eventId, 'create');

      const copies = google.liveCopiesOf(eventId);
      expect(copies).toHaveLength(1);
      expect(google.calls.insert).toBe(1);
      expect(row().google_event_id).toBe(copies[0]!.id);
      expect(row().sync_status).toBe('synced');
      expect(receipts(OWNER)).toEqual([
        { action: 'create', google_event_id: copies[0]!.id, details: JSON.stringify({ via: 'adopted_by_marker' }) },
      ]);
    });

    test('an answer without an id is an error that keeps the row waiting, and the retry finds the copy', async () => {
      google.failNextInsert('answer-without-id');
      await expect(service.pushEvent(google.api, OWNER, eventId, 'create')).rejects.toThrow(/without an event id/);
      expect(row().sync_status).toBe('pending_push');
      expect(row().google_event_id).toBeNull();
      expect(receipts(OWNER)).toEqual([]);

      await service.pushEvent(google.api, OWNER, eventId, 'create');

      expect(google.liveCopiesOf(eventId)).toHaveLength(1);
      expect(row().google_event_id).toBe(google.liveCopiesOf(eventId)[0]!.id);
    });

    test('a refused insert leaves nothing in Google and the retry inserts once', async () => {
      google.failNextInsert('refuse');
      await expect(service.pushEvent(google.api, OWNER, eventId, 'create')).rejects.toThrow('500');
      expect(google.liveCopiesOf(eventId)).toHaveLength(0);

      await service.pushEvent(google.api, OWNER, eventId, 'create');

      expect(google.liveCopiesOf(eventId)).toHaveLength(1);
      expect(receipts(OWNER)[0]!.details).toBe(JSON.stringify({ via: 'inserted' }));
    });

    test('a create job for a row that is linked by then updates the linked copy and never inserts', async () => {
      await service.pushEvent(google.api, OWNER, eventId, 'create');
      const linkedId = row().google_event_id!;
      eventRepo.updateSyncFields(eventId, { sync_status: 'pending_push' });

      await service.pushEvent(google.api, OWNER, eventId, 'create');

      expect(google.calls.insert).toBe(1);
      expect(google.calls.update).toBe(1);
      expect(row().google_event_id).toBe(linkedId);
      expect(google.liveCopiesOf(eventId)).toHaveLength(1);
      expect(receipts(OWNER, 'update').map((r) => r.google_event_id)).toEqual([linkedId]);
    });

    test('an update job for a row that was never linked creates the copy instead of updating an empty id', async () => {
      await service.pushEvent(google.api, OWNER, eventId, 'update');

      expect(google.calls.update).toBe(0);
      expect(google.liveCopiesOf(eventId)).toHaveLength(1);
      expect(row().google_event_id).toBe(google.liveCopiesOf(eventId)[0]!.id);
    });

    test('copies left behind by an earlier disconnect are adopted, not duplicated', async () => {
      await service.pushEvent(google.api, OWNER, eventId, 'create');
      const original = google.liveCopiesOf(eventId)[0]!.id;
      eventRepo.clearGoogleSync(OWNER);
      eventRepo.updateSyncFields(eventId, { sync_status: 'pending_push' });

      await service.pushEvent(google.api, OWNER, eventId, 'update');

      expect(google.liveCopiesOf(eventId)).toHaveLength(1);
      expect(row().google_event_id).toBe(original);
    });

    test('with several marked copies already in Google the oldest is linked, none is inserted, and the receipt counts the rest', async () => {
      const older = google.plant('g-older', eventId);
      google.plant('g-newer', eventId);

      await service.pushEvent(google.api, OWNER, eventId, 'create');

      expect(google.calls.insert).toBe(0);
      expect(row().google_event_id).toBe(older);
      expect(receipts(OWNER)).toEqual([
        {
          action: 'create',
          google_event_id: older,
          details: JSON.stringify({ via: 'adopted_by_marker', duplicates: 1 }),
        },
      ]);
    });

    test('a deleted copy, a copy of another event and an instance of a series are not taken for this one', async () => {
      google.plant('g-deleted', eventId, { status: 'cancelled' });
      google.plant('g-other', eventId + 1000);
      google.plant('g-instance', eventId, { recurringEventId: 'g-series' });

      await service.pushEvent(google.api, OWNER, eventId, 'create');

      expect(google.calls.insert).toBe(1);
      expect(row().google_event_id).not.toBe('g-deleted');
      expect(row().google_event_id).not.toBe('g-other');
      expect(row().google_event_id).not.toBe('g-instance');
      expect(receipts(OWNER)[0]!.details).toBe(JSON.stringify({ via: 'inserted' }));
    });

    test('a copy deleted since it was listed fails the push and leaves the row waiting', async () => {
      const planted = google.plant('g-vanishing', eventId);
      google.failUpdateOf(planted);

      await expect(service.pushEvent(google.api, OWNER, eventId, 'create')).rejects.toThrow('404');

      expect(row().google_event_id).toBeNull();
      expect(row().sync_status).toBe('pending_push');
      expect(receipts(OWNER)).toEqual([]);
    });
  });

  describe('the participant copy', () => {
    beforeEach(() => {
      participantRepo.add(eventId, GUEST, 'accepted');
    });

    const link = () => participantSyncRepo.getByUserAndEvent(GUEST, eventId);

    test('the link and the receipt carry the id the insert returned', async () => {
      await service.pushParticipantEvent(google.api, GUEST, eventId, 'create');

      const [copy] = google.liveCopiesOf(eventId);
      expect(link()?.google_event_id).toBe(copy!.id);
      expect(link()?.sync_status).toBe('synced');
      expect(receipts(GUEST)).toEqual([{ action: 'create', google_event_id: copy!.id, details: 'participant_sync' }]);
    });

    test('a lost answer is recovered by the retry without a second copy, and the receipt says it was adopted', async () => {
      google.failNextInsert('lose-answer');
      await expect(service.pushParticipantEvent(google.api, GUEST, eventId, 'create')).rejects.toThrow('timeout');
      expect(google.liveCopiesOf(eventId)).toHaveLength(1);
      expect(link()?.google_event_id ?? null).toBeNull();

      await service.pushParticipantEvent(google.api, GUEST, eventId, 'create');

      const copies = google.liveCopiesOf(eventId);
      expect(copies).toHaveLength(1);
      expect(google.calls.insert).toBe(1);
      expect(link()?.google_event_id).toBe(copies[0]!.id);
      expect(receipts(GUEST)).toEqual([
        { action: 'create', google_event_id: copies[0]!.id, details: 'participant_sync:adopted_by_marker' },
      ]);
    });

    test('an update push for a copy created without a recorded link adopts it', async () => {
      google.failNextInsert('lose-answer');
      await expect(service.pushParticipantEvent(google.api, GUEST, eventId, 'create')).rejects.toThrow('timeout');

      await service.pushParticipantEvent(google.api, GUEST, eventId, 'update');

      expect(google.calls.insert).toBe(1);
      expect(link()?.google_event_id).toBe(google.liveCopiesOf(eventId)[0]!.id);
    });

    test('a copy recreated after Google reported the old one gone survives a lost answer too', async () => {
      participantSyncRepo.upsert(GUEST, eventId, {
        google_event_id: 'g-dead',
        google_calendar_id: 'primary',
        sync_status: 'synced',
      });
      // 'g-dead' was never stored in the double: Google answers 404 to its update and to the probe read.
      google.failNextInsert('lose-answer');
      await expect(service.pushParticipantEvent(google.api, GUEST, eventId, 'update')).rejects.toThrow('timeout');

      await service.pushParticipantEvent(google.api, GUEST, eventId, 'update');

      const copies = google.liveCopiesOf(eventId);
      expect(copies).toHaveLength(1);
      expect(google.calls.insert).toBe(1);
      expect(link()?.google_event_id).toBe(copies[0]!.id);
    });
  });

  describe('two users whose Google accounts are one calendar', () => {
    beforeEach(() => {
      participantRepo.add(eventId, GUEST, 'accepted');
    });

    test('the guest gets a copy of their own: the owner row keeps its copy and the guest link another', async () => {
      await service.pushEvent(google.api, OWNER, eventId, 'create');
      const ownerCopy = row().google_event_id!;

      await service.pushParticipantEvent(google.api, GUEST, eventId, 'create');

      const guestCopy = participantSyncRepo.getByUserAndEvent(GUEST, eventId)!.google_event_id!;
      expect(guestCopy).not.toBe(ownerCopy);
      expect(google.liveCopiesOf(eventId).map((copy) => copy.id)).toEqual([ownerCopy, guestCopy]);
      expect(google.calls.insert).toBe(2);
    });

    test('the same holds when the guest link is made first', async () => {
      await service.pushParticipantEvent(google.api, GUEST, eventId, 'create');
      const guestCopy = participantSyncRepo.getByUserAndEvent(GUEST, eventId)!.google_event_id!;

      await service.pushEvent(google.api, OWNER, eventId, 'create');

      expect(row().google_event_id).not.toBe(guestCopy);
      expect(google.liveCopiesOf(eventId)).toHaveLength(2);
    });

    test('a copy another job linked while this one awaited Google is not linked twice', async () => {
      google.afterNextInsert((googleEventId) =>
        participantSyncRepo.upsert(GUEST, eventId, { google_event_id: googleEventId, sync_status: 'synced' }),
      );

      await expect(service.pushEvent(google.api, OWNER, eventId, 'create')).rejects.toThrow(/linked to another row/);

      // The guest keeps the copy it was linked to; the owner row waits and its retry gets a copy of its own.
      expect(row().google_event_id).toBeNull();
      expect(row().sync_status).toBe('pending_push');
      const guestCopy = participantSyncRepo.getByUserAndEvent(GUEST, eventId)!.google_event_id!;

      await service.pushEvent(google.api, OWNER, eventId, 'create');

      expect(row().google_event_id).not.toBe(guestCopy);
      expect(google.liveCopiesOf(eventId)).toHaveLength(2);
    });
  });
});
