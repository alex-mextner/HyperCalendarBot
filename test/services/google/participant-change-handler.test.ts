import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { EditProposalRepository } from '../../../src/database/repositories/edit-proposal.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { InvitationRepository } from '../../../src/database/repositories/invitation.repository.ts';
import { ParticipantRepository } from '../../../src/database/repositories/participant.repository.ts';
import { ParticipantGoogleSyncRepository } from '../../../src/database/repositories/participant-google-sync.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import type { LocalEventFromGoogleSnapshot } from '../../../src/services/google/change-detection.ts';
import {
  handleParticipantChange,
  handleParticipantDelete,
  type ParticipantHandlerDeps,
} from '../../../src/services/google/participant-change-handler.ts';

const ORGANIZER = 100;
const PARTICIPANT = 200;

function createTestDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

describe('handleParticipantChange', () => {
  let db: Database;
  let eventRepo: EventRepository;
  let participantRepo: ParticipantRepository;
  let participantSyncRepo: ParticipantGoogleSyncRepository;
  let editProposalRepo: EditProposalRepository;
  let invitationRepo: InvitationRepository;
  let notifyUser: ReturnType<typeof mock>;
  let deps: ParticipantHandlerDeps;

  beforeEach(() => {
    db = createTestDb();
    const userRepo = new UserRepository(db);
    eventRepo = new EventRepository(db);
    participantRepo = new ParticipantRepository(db);
    participantSyncRepo = new ParticipantGoogleSyncRepository(db);
    editProposalRepo = new EditProposalRepository(db);
    invitationRepo = new InvitationRepository(db);
    notifyUser = mock(async () => {});
    userRepo.create({ telegram_id: ORGANIZER, timezone: 'UTC', first_name: 'Org' });
    userRepo.create({ telegram_id: PARTICIPANT, timezone: 'UTC', first_name: 'Part' });
    deps = {
      eventRepo,
      participantRepo,
      participantSyncRepo,
      editProposalRepo,
      invitationRepo,
      notifyUser,
      getUserLang: () => 'en',
      getUserName: () => 'Part',
    };
  });

  function createSharedEvent() {
    const event = eventRepo.create({
      user_id: ORGANIZER,
      title: 'Standup',
      start_at: '2026-04-21T10:00:00Z',
      timezone: 'UTC',
    });
    participantRepo.add(event.id, PARTICIPANT, 'accepted');
    participantSyncRepo.upsert(PARTICIPANT, event.id, {
      google_event_id: 'g-event-123',
      google_calendar_id: 'primary',
      sync_status: 'synced',
    });
    return event;
  }

  function makeIncoming(overrides: Partial<LocalEventFromGoogleSnapshot> = {}): LocalEventFromGoogleSnapshot & {
    google_etag: string | null;
  } {
    return {
      title: 'Standup',
      description: null,
      start_at: '2026-04-21T10:00:00Z',
      end_at: null,
      all_day: false,
      timezone: 'UTC',
      location: null,
      recurrence_rule: null,
      google_etag: 'new-etag',
      ...overrides,
    };
  }

  test('shared field change creates edit proposal', async () => {
    const event = createSharedEvent();
    const masterEvent = eventRepo.findByIdUnfiltered(event.id)!;

    await handleParticipantChange(PARTICIPANT, masterEvent, makeIncoming({ title: 'Daily Sync' }), deps);

    const proposals = editProposalRepo.getPendingForEvent(event.id);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.proposer_id).toBe(PARTICIPANT);
    expect(proposals[0]!.source).toBe('google_sync');
    expect(proposals[0]!.expires_at).not.toBeNull();
    expect(notifyUser).toHaveBeenCalledTimes(1);
    expect((notifyUser.mock.calls[0] as unknown[])[0]).toBe(ORGANIZER);
  });

  test('timezone-only change stores override, no proposal', async () => {
    const event = createSharedEvent();
    const masterEvent = eventRepo.findByIdUnfiltered(event.id)!;

    await handleParticipantChange(PARTICIPANT, masterEvent, makeIncoming({ timezone: 'US/Pacific' }), deps);

    const proposals = editProposalRepo.getPendingForEvent(event.id);
    expect(proposals).toHaveLength(0);
    const syncRecord = participantSyncRepo.getByUserAndEvent(PARTICIPANT, event.id);
    expect(syncRecord!.timezone_override).toBe('US/Pacific');
    expect(notifyUser).not.toHaveBeenCalled();
  });

  test('mixed shared + timezone: proposal for shared, timezone stored separately', async () => {
    const event = createSharedEvent();
    const masterEvent = eventRepo.findByIdUnfiltered(event.id)!;

    await handleParticipantChange(
      PARTICIPANT,
      masterEvent,
      makeIncoming({ title: 'New Title', timezone: 'US/Pacific' }),
      deps,
    );

    const proposals = editProposalRepo.getPendingForEvent(event.id);
    expect(proposals).toHaveLength(1);
    const changes = JSON.parse(proposals[0]!.changes) as { field: string }[];
    expect(changes.some((c) => c.field === 'title')).toBe(true);
    expect(changes.some((c) => c.field === 'timezone')).toBe(false);

    const syncRecord = participantSyncRepo.getByUserAndEvent(PARTICIPANT, event.id);
    expect(syncRecord!.timezone_override).toBe('US/Pacific');
  });

  test('second edit updates existing proposal instead of creating new', async () => {
    const event = createSharedEvent();
    const masterEvent = eventRepo.findByIdUnfiltered(event.id)!;

    await handleParticipantChange(PARTICIPANT, masterEvent, makeIncoming({ title: 'First Edit' }), deps);
    await handleParticipantChange(PARTICIPANT, masterEvent, makeIncoming({ title: 'Second Edit' }), deps);

    const proposals = editProposalRepo.getPendingForEvent(event.id);
    expect(proposals).toHaveLength(1);
    const changes = JSON.parse(proposals[0]!.changes) as { field: string; newValue: string }[];
    expect(changes[0]!.newValue).toBe('Second Edit');
  });

  test('no changes → no proposal', async () => {
    const event = createSharedEvent();
    const masterEvent = eventRepo.findByIdUnfiltered(event.id)!;

    await handleParticipantChange(PARTICIPANT, masterEvent, makeIncoming(), deps);

    const proposals = editProposalRepo.getPendingForEvent(event.id);
    expect(proposals).toHaveLength(0);
  });

  test('updates participant_google_sync etag', async () => {
    const event = createSharedEvent();
    const masterEvent = eventRepo.findByIdUnfiltered(event.id)!;

    await handleParticipantChange(PARTICIPANT, masterEvent, makeIncoming({ title: 'New' }), deps);

    const syncRecord = participantSyncRepo.getByUserAndEvent(PARTICIPANT, event.id);
    expect(syncRecord!.google_etag).toBe('new-etag');
  });

  test('group event → skipped', async () => {
    const event = eventRepo.create({
      user_id: ORGANIZER,
      title: 'Group Event',
      start_at: '2026-04-21T10:00:00Z',
      timezone: 'UTC',
      owner_type: 'group',
      group_id: 999,
    });
    const masterEvent = eventRepo.findByIdUnfiltered(event.id)!;

    await handleParticipantChange(PARTICIPANT, masterEvent, makeIncoming({ title: 'Changed' }), deps);

    const proposals = editProposalRepo.getPendingForEvent(event.id);
    expect(proposals).toHaveLength(0);
  });
});

describe('handleParticipantDelete', () => {
  let db: Database;
  let eventRepo: EventRepository;
  let participantRepo: ParticipantRepository;
  let participantSyncRepo: ParticipantGoogleSyncRepository;
  let editProposalRepo: EditProposalRepository;
  let invitationRepo: InvitationRepository;
  let notifyUser: ReturnType<typeof mock>;
  let deps: ParticipantHandlerDeps;

  beforeEach(() => {
    db = createTestDb();
    const userRepo = new UserRepository(db);
    eventRepo = new EventRepository(db);
    participantRepo = new ParticipantRepository(db);
    participantSyncRepo = new ParticipantGoogleSyncRepository(db);
    editProposalRepo = new EditProposalRepository(db);
    invitationRepo = new InvitationRepository(db);
    notifyUser = mock(async () => {});
    userRepo.create({ telegram_id: ORGANIZER, timezone: 'UTC', first_name: 'Org' });
    userRepo.create({ telegram_id: PARTICIPANT, timezone: 'UTC', first_name: 'Part' });
    deps = {
      eventRepo,
      participantRepo,
      participantSyncRepo,
      editProposalRepo,
      invitationRepo,
      notifyUser,
      getUserLang: () => 'en',
      getUserName: () => 'Part',
    };
  });

  test('participant delete → status=declined, organizer notified, sync cleaned', async () => {
    const event = eventRepo.create({
      user_id: ORGANIZER,
      title: 'Meeting',
      start_at: '2026-04-21T10:00:00Z',
      timezone: 'UTC',
    });
    participantRepo.add(event.id, PARTICIPANT, 'accepted');
    participantSyncRepo.upsert(PARTICIPANT, event.id, {
      google_event_id: 'g-123',
      google_calendar_id: 'primary',
      sync_status: 'synced',
    });

    const syncRecord = participantSyncRepo.getByUserAndEvent(PARTICIPANT, event.id)!;
    await handleParticipantDelete(PARTICIPANT, syncRecord, deps);

    const participant = participantRepo.findByEventAndUser(event.id, PARTICIPANT);
    expect(participant!.status).toBe('declined');
    expect(participantSyncRepo.getByUserAndEvent(PARTICIPANT, event.id)).toBeNull();
    expect(notifyUser).toHaveBeenCalledTimes(1);
    expect((notifyUser.mock.calls[0] as unknown[])[0]).toBe(ORGANIZER);
  });

  test('participant delete with active invitation → invitation also declined', async () => {
    const event = eventRepo.create({
      user_id: ORGANIZER,
      title: 'Meeting',
      start_at: '2026-04-21T10:00:00Z',
      timezone: 'UTC',
    });
    participantRepo.add(event.id, PARTICIPANT, 'accepted');
    const inv = invitationRepo.create({
      event_id: event.id,
      inviter_id: ORGANIZER,
      invitee_id: PARTICIPANT,
    });
    participantSyncRepo.upsert(PARTICIPANT, event.id, {
      google_event_id: 'g-123',
      google_calendar_id: 'primary',
      sync_status: 'synced',
    });

    const syncRecord = participantSyncRepo.getByUserAndEvent(PARTICIPANT, event.id)!;
    await handleParticipantDelete(PARTICIPANT, syncRecord, deps);

    const updatedInv = invitationRepo.findById(inv.id);
    expect(updatedInv!.status).toBe('declined');
  });

  test('participant delete cancels pending proposals', async () => {
    const event = eventRepo.create({
      user_id: ORGANIZER,
      title: 'Meeting',
      start_at: '2026-04-21T10:00:00Z',
      timezone: 'UTC',
    });
    participantRepo.add(event.id, PARTICIPANT, 'accepted');
    editProposalRepo.create({
      event_id: event.id,
      proposer_id: PARTICIPANT,
      changes: '[]',
      source: 'google_sync',
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    });
    participantSyncRepo.upsert(PARTICIPANT, event.id, {
      google_event_id: 'g-123',
      google_calendar_id: 'primary',
      sync_status: 'synced',
    });

    const syncRecord = participantSyncRepo.getByUserAndEvent(PARTICIPANT, event.id)!;
    await handleParticipantDelete(PARTICIPANT, syncRecord, deps);

    const proposals = editProposalRepo.getPendingForEvent(event.id);
    expect(proposals).toHaveLength(0);
  });
});
