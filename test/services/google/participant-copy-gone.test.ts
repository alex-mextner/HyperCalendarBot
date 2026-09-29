import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, type Mock, mock, test } from 'bun:test';
import { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import { migrations } from '../../../src/database/migrations.ts';
import { EditProposalRepository } from '../../../src/database/repositories/edit-proposal.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { GoogleCalendarRepository } from '../../../src/database/repositories/google-calendar.repository.ts';
import { GoogleSyncRepository } from '../../../src/database/repositories/google-sync.repository.ts';
import { InvitationRepository } from '../../../src/database/repositories/invitation.repository.ts';
import { ParticipantRepository } from '../../../src/database/repositories/participant.repository.ts';
import { ParticipantGoogleSyncRepository } from '../../../src/database/repositories/participant-google-sync.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { GoogleCalendarApi, googleGoneStatus } from '../../../src/services/google/calendar-api.ts';
import { SyncService } from '../../../src/services/google/sync-service.ts';
import { jsonCodec } from '../../../src/utils/json-codec.ts';

// #728: an invitee's Google copy that no longer exists made updateEvent fail with 404/410; the job
// retried five times and failed, and the link row kept the dead id, so every later push failed too.
// Synthetic ids below.
const ORGANIZER = 9101;
const PARTICIPANT = 9102;
const DEAD_COPY = 'g-deleted-copy';
const FRESH_COPY = 'g-fresh-copy';

type UpdateEvent = GoogleCalendarApi['updateEvent'];
type InsertEvent = GoogleCalendarApi['insertEvent'];
type GetEvent = GoogleCalendarApi['getEvent'];
type NotifyUser = (userId: number, text: string) => Promise<void>;

/** The shape googleapis (gaxios 7) gives an HTTP error: numeric code and status. */
function httpError(status: number): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), { code: status, status });
}

/** The shape gaxios gives an aborted request: a string code and no status. */
function timeoutError(): Error {
  return Object.assign(new Error('The operation was aborted due to timeout'), { code: 'TimeoutError' });
}

/** The sync_log details the push writes for a gone copy; an unexpected key or value fails the test. */
const GoneEvidence = jsonCodec(
  z.strictObject({
    reason: z.literal('participant_copy_gone'),
    http_status: z.union([z.literal(404), z.literal(410)]),
    probe: z.enum(['skipped', 'cancelled', 'not_found']),
    outcome: z.enum(['unlinked', 'declined', 'recreated']),
    stale_google_event_id: z.string(),
    new_google_event_id: z.string().optional(),
  }),
);

interface PushLogRow {
  action: string;
  google_event_id: string | null;
  details: z.infer<typeof GoneEvidence> | null;
}

describe('participant push when the Google copy is gone', () => {
  let db: Database;
  let participantRepo: ParticipantRepository;
  let participantSyncRepo: ParticipantGoogleSyncRepository;
  let invitationRepo: InvitationRepository;
  let editProposalRepo: EditProposalRepository;
  let service: SyncService;
  let api: GoogleCalendarApi;
  let updateEvent: Mock<UpdateEvent>;
  let insertEvent: Mock<InsertEvent>;
  let getEvent: Mock<GetEvent>;
  let notifyUser: Mock<NotifyUser>;
  let eventId: number;
  let invitationId: number;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, migrations);
    db.run(`INSERT INTO users (telegram_id, username) VALUES (${ORGANIZER}, 'organizer'), (${PARTICIPANT}, 'guest')`);
    const eventRepo = new EventRepository(db);
    participantRepo = new ParticipantRepository(db);
    participantSyncRepo = new ParticipantGoogleSyncRepository(db);
    invitationRepo = new InvitationRepository(db);
    editProposalRepo = new EditProposalRepository(db);
    notifyUser = mock<NotifyUser>(() => Promise.resolve());
    service = new SyncService(
      db,
      eventRepo,
      new GoogleSyncRepository(db),
      new GoogleCalendarRepository(db),
      undefined,
      undefined,
      participantSyncRepo,
      undefined,
      {
        eventRepo,
        participantRepo,
        participantSyncRepo,
        editProposalRepo,
        invitationRepo,
        notifyUser,
        getUserLang: () => 'en',
        getUserName: () => 'Guest',
      },
    );

    eventId = eventRepo.create({
      user_id: ORGANIZER,
      title: 'Lesson',
      start_at: '2026-09-29T10:30:00.000Z',
      end_at: '2026-09-29T11:30:00.000Z',
      timezone: 'Europe/Belgrade',
    }).id;
    participantRepo.add(eventId, PARTICIPANT, 'accepted');
    const invitation = invitationRepo.create({ event_id: eventId, inviter_id: ORGANIZER, invitee_id: PARTICIPANT });
    invitationRepo.updateStatus(invitation.id, 'accepted', 'pending');
    invitationId = invitation.id;
    participantSyncRepo.upsert(PARTICIPANT, eventId, {
      google_event_id: DEAD_COPY,
      google_calendar_id: 'primary',
      sync_status: 'synced',
    });

    api = new GoogleCalendarApi(new OAuth2Client());
    updateEvent = mock<UpdateEvent>(() => Promise.reject(httpError(404)));
    insertEvent = mock<InsertEvent>(() => Promise.resolve({ id: FRESH_COPY, etag: '"fresh"' }));
    getEvent = mock<GetEvent>(() => Promise.reject(httpError(404)));
    api.updateEvent = updateEvent;
    api.insertEvent = insertEvent;
    api.getEvent = getEvent;
  });

  function pushLog(): PushLogRow[] {
    const rows = db
      .prepare<{ action: string; google_event_id: string | null; details: string | null }, [number]>(
        "SELECT action, google_event_id, details FROM sync_log WHERE user_id = ? AND direction = 'push' ORDER BY id",
      )
      .all(PARTICIPANT);
    return rows.map((row) => ({ ...row, details: row.details === null ? null : GoneEvidence.parse(row.details) }));
  }

  function expectUntouched(): void {
    expect(insertEvent).not.toHaveBeenCalled();
    expect(participantSyncRepo.getByUserAndEvent(PARTICIPANT, eventId)?.google_event_id).toBe(DEAD_COPY);
    expect(participantRepo.findByEventAndUser(eventId, PARTICIPANT)?.status).toBe('accepted');
    expect(invitationRepo.findById(invitationId)?.status).toBe('accepted');
    expect(notifyUser).not.toHaveBeenCalled();
    expect(pushLog()).toEqual([]);
  }

  describe.each(['update', 'create'] as const)('%s with a link row', (action) => {
    describe.each([404, 410])('updateEvent answers %i', (status) => {
      beforeEach(() => {
        updateEvent.mockImplementation(() => Promise.reject(httpError(status)));
      });

      test('a copy Google shows as cancelled is the participant declining, as the pull reads it', async () => {
        getEvent.mockImplementation(() => Promise.resolve({ id: DEAD_COPY, status: 'cancelled' }));
        const proposal = editProposalRepo.create({
          event_id: eventId,
          proposer_id: PARTICIPANT,
          changes: '[]',
          original_values: '{}',
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          source: 'google_sync',
        });

        await service.pushParticipantEvent(api, PARTICIPANT, eventId, action);

        expect(editProposalRepo.findById(proposal.id)?.status).toBe('rejected');

        expect(getEvent).toHaveBeenCalledWith('primary', DEAD_COPY);
        expect(insertEvent).not.toHaveBeenCalled();
        expect(participantSyncRepo.getByUserAndEvent(PARTICIPANT, eventId)).toBeNull();
        expect(participantRepo.findByEventAndUser(eventId, PARTICIPANT)?.status).toBe('declined');
        expect(invitationRepo.findById(invitationId)?.status).toBe('declined');
        expect(notifyUser).toHaveBeenCalledTimes(1);
        expect(notifyUser.mock.calls[0]?.[0]).toBe(ORGANIZER);
        expect(pushLog()).toEqual([
          {
            action: 'delete',
            google_event_id: DEAD_COPY,
            details: {
              reason: 'participant_copy_gone',
              http_status: status,
              probe: 'cancelled',
              outcome: 'declined',
              stale_google_event_id: DEAD_COPY,
            },
          },
        ]);
      });

      test('pushes queued before that decline do not put the copy back', async () => {
        getEvent.mockImplementation(() => Promise.resolve({ id: DEAD_COPY, status: 'cancelled' }));
        await service.pushParticipantEvent(api, PARTICIPANT, eventId, action);

        await service.pushParticipantEvent(api, PARTICIPANT, eventId, 'update');
        await service.pushParticipantEvent(api, PARTICIPANT, eventId, 'create');

        expect(insertEvent).not.toHaveBeenCalled();
        expect(participantSyncRepo.getByUserAndEvent(PARTICIPANT, eventId)).toBeNull();
        expect(participantRepo.findByEventAndUser(eventId, PARTICIPANT)?.status).toBe('declined');
        expect(notifyUser).toHaveBeenCalledTimes(1);
      });

      test('a copy Google no longer knows is recreated while the participant still attends', async () => {
        getEvent.mockImplementation(() => Promise.reject(httpError(status)));

        await service.pushParticipantEvent(api, PARTICIPANT, eventId, action);

        expect(insertEvent).toHaveBeenCalledTimes(1);
        const [calendarId, body] = insertEvent.mock.calls[0]!;
        expect(calendarId).toBe('primary');
        expect(body.summary).toBe('Lesson');
        // The bot's marker makes the participant's own pull skip the copy instead of reading it back.
        expect(body.extendedProperties?.private?.hypercalendarbot_event_id).toBe(String(eventId));
        const link = participantSyncRepo.getByUserAndEvent(PARTICIPANT, eventId);
        expect(link?.google_event_id).toBe(FRESH_COPY);
        expect(link?.google_etag).toBe('"fresh"');
        expect(link?.sync_status).toBe('synced');
        expect(participantRepo.findByEventAndUser(eventId, PARTICIPANT)?.status).toBe('accepted');
        expect(invitationRepo.findById(invitationId)?.status).toBe('accepted');
        expect(notifyUser).not.toHaveBeenCalled();
        expect(pushLog()).toEqual([
          {
            action: 'create',
            google_event_id: FRESH_COPY,
            details: {
              reason: 'participant_copy_gone',
              http_status: status,
              probe: 'not_found',
              outcome: 'recreated',
              stale_google_event_id: DEAD_COPY,
              new_google_event_id: FRESH_COPY,
            },
          },
        ]);

        // The next organizer edit updates the fresh copy instead of the dead id.
        updateEvent.mockImplementation((_calendarId, googleEventId) =>
          Promise.resolve({ id: googleEventId, etag: '"edited"' }),
        );
        await service.pushParticipantEvent(api, PARTICIPANT, eventId, 'update');
        expect(updateEvent.mock.calls.at(-1)?.[1]).toBe(FRESH_COPY);
        expect(insertEvent).toHaveBeenCalledTimes(1);
      });

      test('a participant who already declined is unlinked, never probed or recreated', async () => {
        participantRepo.updateStatus(eventId, PARTICIPANT, 'declined');

        await service.pushParticipantEvent(api, PARTICIPANT, eventId, action);

        expect(getEvent).not.toHaveBeenCalled();
        expect(insertEvent).not.toHaveBeenCalled();
        expect(participantSyncRepo.getByUserAndEvent(PARTICIPANT, eventId)).toBeNull();
        expect(invitationRepo.findById(invitationId)?.status).toBe('accepted');
        expect(notifyUser).not.toHaveBeenCalled();
        expect(pushLog()).toEqual([
          {
            action: 'delete',
            google_event_id: DEAD_COPY,
            details: {
              reason: 'participant_copy_gone',
              http_status: status,
              probe: 'skipped',
              outcome: 'unlinked',
              stale_google_event_id: DEAD_COPY,
            },
          },
        ]);
      });

      test('a copy Google still shows as live contradicts the error and fails the job for a retry', async () => {
        getEvent.mockImplementation(() => Promise.resolve({ id: DEAD_COPY, status: 'confirmed' }));

        await expect(service.pushParticipantEvent(api, PARTICIPANT, eventId, action)).rejects.toMatchObject({
          code: status,
        });

        expectUntouched();
      });

      test('a probe that fails for another reason fails the job for a retry', async () => {
        getEvent.mockImplementation(() => Promise.reject(timeoutError()));

        await expect(service.pushParticipantEvent(api, PARTICIPANT, eventId, action)).rejects.toMatchObject({
          code: 'TimeoutError',
        });

        expectUntouched();
      });
    });

    test('a group member without an RSVP row still attends, so a copy Google no longer knows is recreated', async () => {
      participantRepo.delete(eventId, PARTICIPANT);

      await service.pushParticipantEvent(api, PARTICIPANT, eventId, action);

      expect(insertEvent).toHaveBeenCalledTimes(1);
      expect(participantSyncRepo.getByUserAndEvent(PARTICIPANT, eventId)?.google_event_id).toBe(FRESH_COPY);
      expect(participantRepo.findByEventAndUser(eventId, PARTICIPANT)).toBeNull();
    });

    test('a group member whose copy Google shows as cancelled is declined like on pull: unlinked, organizer told', async () => {
      participantRepo.delete(eventId, PARTICIPANT);
      getEvent.mockImplementation(() => Promise.resolve({ id: DEAD_COPY, status: 'cancelled' }));

      await service.pushParticipantEvent(api, PARTICIPANT, eventId, action);

      expect(insertEvent).not.toHaveBeenCalled();
      expect(participantSyncRepo.getByUserAndEvent(PARTICIPANT, eventId)).toBeNull();
      expect(participantRepo.findByEventAndUser(eventId, PARTICIPANT)).toBeNull();
      expect(notifyUser).toHaveBeenCalledTimes(1);
      expect(pushLog().map((row) => row.details?.outcome)).toEqual(['declined']);
    });

    test.each([500, 503, 403])('HTTP %i still fails the job and keeps the link row for the retry', async (status) => {
      updateEvent.mockImplementation(() => Promise.reject(httpError(status)));

      await expect(service.pushParticipantEvent(api, PARTICIPANT, eventId, action)).rejects.toMatchObject({
        code: status,
      });

      expect(getEvent).not.toHaveBeenCalled();
      expectUntouched();
    });

    test('a timeout still fails the job and keeps the link row for the retry', async () => {
      updateEvent.mockImplementation(() => Promise.reject(timeoutError()));

      await expect(service.pushParticipantEvent(api, PARTICIPANT, eventId, action)).rejects.toMatchObject({
        code: 'TimeoutError',
      });

      expect(getEvent).not.toHaveBeenCalled();
      expectUntouched();
    });

    test('without the participant handler deps a gone copy fails the job and keeps the link row', async () => {
      const bare = new SyncService(
        db,
        new EventRepository(db),
        new GoogleSyncRepository(db),
        new GoogleCalendarRepository(db),
        undefined,
        undefined,
        participantSyncRepo,
      );

      await expect(bare.pushParticipantEvent(api, PARTICIPANT, eventId, action)).rejects.toMatchObject({
        cause: { code: 404 },
      });

      expect(getEvent).not.toHaveBeenCalled();
      expectUntouched();
    });
  });
});

describe('googleGoneStatus', () => {
  test.each([404, 410] as const)('HTTP %i is a definitive answer that the event is gone', (status) => {
    expect(googleGoneStatus(httpError(status))).toBe(status);
  });

  test.each([
    ['HTTP 500', httpError(500)],
    ['HTTP 403', httpError(403)],
    ['HTTP 200', httpError(200)],
    ['a timeout', timeoutError()],
    ['a string "404" code', Object.assign(new Error('odd'), { code: '404' })],
    ['an error without a code', new Error('no code')],
    ['null', null],
    ['a string', 'Not Found'],
  ])('%s says nothing about the event', (_label, err) => {
    expect(googleGoneStatus(err)).toBeNull();
  });
});
