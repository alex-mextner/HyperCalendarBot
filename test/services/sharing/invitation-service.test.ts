import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations';
import { EventRepository } from '../../../src/database/repositories/event.repository';
import { InvitationRepository } from '../../../src/database/repositories/invitation.repository';
import { ParticipantRepository } from '../../../src/database/repositories/participant.repository';
import { SharingSettingsRepository } from '../../../src/database/repositories/sharing-settings.repository';
import { UserRepository } from '../../../src/database/repositories/user.repository';
import { runMigrations } from '../../../src/database/schema';
import { InvitationService } from '../../../src/services/sharing/invitation-service';

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

const INVITER = 100;
const INVITEE = 200;

describe('InvitationService', () => {
  function setup() {
    const db = createTestDb();
    const userRepo = new UserRepository(db);
    userRepo.create({ telegram_id: INVITER });
    userRepo.create({ telegram_id: INVITEE });
    const eventRepo = new EventRepository(db);
    const invRepo = new InvitationRepository(db);
    const settingsRepo = new SharingSettingsRepository(db);
    const service = new InvitationService(invRepo, eventRepo, settingsRepo);
    const event = eventRepo.create({
      user_id: INVITER,
      title: 'Party',
      start_at: '2026-03-15T18:00:00Z',
      timezone: 'UTC',
    });
    return { db, service, invRepo, eventRepo, settingsRepo, event };
  }

  test('sendInvitation creates pending invitation', () => {
    const { service, event } = setup();
    const result = service.sendInvitation(event.id, INVITER, INVITEE);
    expect(result.success).toBe(true);
    expect(result.invitation).not.toBeNull();
    expect(result.invitation!.status).toBe('pending');
  });

  test('sendInvitation fails for non-existent event', () => {
    const { service } = setup();
    const result = service.sendInvitation(999, INVITER, INVITEE);
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  test('sendInvitation fails when inviting self', () => {
    const { service, event } = setup();
    const result = service.sendInvitation(event.id, INVITER, INVITER);
    expect(result.success).toBe(false);
    expect(result.error).toContain('yourself');
  });

  test('sendInvitation fails for duplicate active invitation', () => {
    const { service, event } = setup();
    service.sendInvitation(event.id, INVITER, INVITEE);
    const result = service.sendInvitation(event.id, INVITER, INVITEE);
    expect(result.success).toBe(false);
    expect(result.error).toContain('already');
  });

  test('sendInvitation fails when invitations disabled', () => {
    const { service, event, settingsRepo } = setup();
    settingsRepo.ensureDefaults(INVITEE);
    settingsRepo.update(INVITEE, { allow_invitations: 0 });
    const result = service.sendInvitation(event.id, INVITER, INVITEE);
    expect(result.success).toBe(false);
    expect(result.error).toContain('disabled');
  });

  test('acceptInvitation transitions to accepted', () => {
    const { service, event } = setup();
    const { invitation } = service.sendInvitation(event.id, INVITER, INVITEE);
    const result = service.acceptInvitation(invitation!.id, INVITEE);
    expect(result.success).toBe(true);
    expect(result.invitation!.status).toBe('accepted');
  });

  test('declineInvitation transitions to declined', () => {
    const { service, event } = setup();
    const { invitation } = service.sendInvitation(event.id, INVITER, INVITEE);
    const result = service.declineInvitation(invitation!.id, INVITEE);
    expect(result.success).toBe(true);
    expect(result.invitation!.status).toBe('declined');
  });

  test('maybeInvitation transitions to maybe', () => {
    const { service, event } = setup();
    const { invitation } = service.sendInvitation(event.id, INVITER, INVITEE);
    const result = service.maybeInvitation(invitation!.id, INVITEE);
    expect(result.success).toBe(true);
    expect(result.invitation!.status).toBe('maybe');
  });

  test('respondToInvitation fails for wrong user', () => {
    const { service, event } = setup();
    const { invitation } = service.sendInvitation(event.id, INVITER, INVITEE);
    const result = service.acceptInvitation(invitation!.id, 999);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Not authorized');
  });

  test('cancelInvitation cancels by inviter', () => {
    const { service, event } = setup();
    const { invitation } = service.sendInvitation(event.id, INVITER, INVITEE);
    const result = service.cancelInvitation(invitation!.id, INVITER);
    expect(result.success).toBe(true);
    expect(result.invitation!.status).toBe('cancelled');
  });

  test('cancelInvitation fails for non-inviter', () => {
    const { service, event } = setup();
    const { invitation } = service.sendInvitation(event.id, INVITER, INVITEE);
    const result = service.cancelInvitation(invitation!.id, INVITEE);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Not authorized');
  });

  test('sendInvitation blocks after 3 declines (re-invitation limit)', () => {
    const { service, event, db } = setup();
    // Insert 3 declined invitations with distinct created_at to avoid UNIQUE constraint
    for (let i = 0; i < 3; i++) {
      db.prepare(
        `INSERT INTO invitations (event_id, inviter_id, invitee_id, status, created_at)
         VALUES (?, ?, ?, 'declined', datetime('now', ?))`,
      ).run(event.id, INVITER, INVITEE, `-${i + 1} seconds`);
    }
    const result = service.sendInvitation(event.id, INVITER, INVITEE);
    expect(result.success).toBe(false);
    expect(result.error).toContain('declined');
  });

  test('can re-invite after decline if under limit', () => {
    const { service, event, db } = setup();
    db.prepare(
      `INSERT INTO invitations (event_id, inviter_id, invitee_id, status, created_at)
       VALUES (?, ?, ?, 'declined', datetime('now', '-1 seconds'))`,
    ).run(event.id, INVITER, INVITEE);
    const result = service.sendInvitation(event.id, INVITER, INVITEE);
    expect(result.success).toBe(true);
  });

  describe('proposeTime', () => {
    test('sets proposed_time and returns success', () => {
      const { service, invRepo, event } = setup();
      const inv = service.sendInvitation(event.id, INVITER, INVITEE).invitation!;
      const result = service.proposeTime(inv.id, INVITEE, '2026-04-01T16:00:00Z');
      expect(result.success).toBe(true);
      const updated = invRepo.findById(inv.id)!;
      expect(updated.proposed_time).toBe('2026-04-01T16:00:00Z');
    });

    test('proposeTime rejects non-invitee', () => {
      const { service, event } = setup();
      const inv = service.sendInvitation(event.id, INVITER, INVITEE).invitation!;
      const result = service.proposeTime(inv.id, INVITER, '2026-04-01T16:00:00Z');
      expect(result.success).toBe(false);
      expect(result.error).toContain('authorized');
    });

    test('proposeTime rejects unknown invitation', () => {
      const { service } = setup();
      const result = service.proposeTime(9999, INVITEE, '2026-04-01T16:00:00Z');
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('rescheduleFromProposal', () => {
    test('clears proposed_time and returns proposedTime in result', () => {
      const { service, invRepo, event } = setup();
      const inv = service.sendInvitation(event.id, INVITER, INVITEE).invitation!;
      service.proposeTime(inv.id, INVITEE, '2026-04-01T16:00:00Z');
      const result = service.rescheduleFromProposal(inv.id, INVITER);
      expect(result.success).toBe(true);
      expect(result.proposedTime).toBe('2026-04-01T16:00:00Z');
      const updated = invRepo.findById(inv.id)!;
      expect(updated.proposed_time).toBeNull();
      expect(updated.status).toBe('accepted');
    });

    test('rescheduleFromProposal adds invitee to event_participants', () => {
      const { db, invRepo, eventRepo, settingsRepo, event } = setup();
      const participantRepo = new ParticipantRepository(db);
      const service = new InvitationService(invRepo, eventRepo, settingsRepo, participantRepo);
      const inv = service.sendInvitation(event.id, INVITER, INVITEE).invitation!;
      service.proposeTime(inv.id, INVITEE, '2026-04-01T16:00:00Z');
      const result = service.rescheduleFromProposal(inv.id, INVITER);
      expect(result.success).toBe(true);
      const participant = participantRepo.findByEventAndUser(event.id, INVITEE);
      expect(participant).not.toBeNull();
      expect(participant!.status).toBe('accepted');
    });

    test('rescheduleFromProposal rejects non-inviter', () => {
      const { service, event } = setup();
      const inv = service.sendInvitation(event.id, INVITER, INVITEE).invitation!;
      service.proposeTime(inv.id, INVITEE, '2026-04-01T16:00:00Z');
      const result = service.rescheduleFromProposal(inv.id, INVITEE);
      expect(result.success).toBe(false);
    });

    test('rescheduleFromProposal rejects if no proposed_time', () => {
      const { service, event } = setup();
      const inv = service.sendInvitation(event.id, INVITER, INVITEE).invitation!;
      const result = service.rescheduleFromProposal(inv.id, INVITER);
      expect(result.success).toBe(false);
      expect(result.error).toContain('No proposed time');
    });
  });

  describe('keepOriginalTime', () => {
    test('clears proposed_time, invitation stays pending', () => {
      const { service, invRepo, event } = setup();
      const inv = service.sendInvitation(event.id, INVITER, INVITEE).invitation!;
      service.proposeTime(inv.id, INVITEE, '2026-04-01T16:00:00Z');
      const result = service.keepOriginalTime(inv.id, INVITER);
      expect(result.success).toBe(true);
      const updated = invRepo.findById(inv.id)!;
      expect(updated.proposed_time).toBeNull();
      expect(updated.status).toBe('pending');
    });

    test('keepOriginalTime rejects non-inviter', () => {
      const { service, event } = setup();
      const inv = service.sendInvitation(event.id, INVITER, INVITEE).invitation!;
      service.proposeTime(inv.id, INVITEE, '2026-04-01T16:00:00Z');
      const result = service.keepOriginalTime(inv.id, INVITEE);
      expect(result.success).toBe(false);
    });
  });

  describe('recordGroupAttendance', () => {
    function setupGroup() {
      const db = createTestDb();
      const userRepo = new UserRepository(db);
      userRepo.create({ telegram_id: INVITER });
      const eventRepo = new EventRepository(db);
      const invRepo = new InvitationRepository(db);
      const settingsRepo = new SharingSettingsRepository(db);
      const participantRepo = new ParticipantRepository(db);
      const service = new InvitationService(invRepo, eventRepo, settingsRepo, participantRepo);
      const event = eventRepo.create({
        user_id: INVITER,
        title: 'Group Party',
        start_at: '2026-03-15T18:00:00Z',
        timezone: 'UTC',
      });
      return { db, service, invRepo, eventRepo, participantRepo, event };
    }

    test('the old inv: path rejects a group invitee_id, recordGroupAttendance accepts it', () => {
      const { service, invRepo, participantRepo, event } = setupGroup();
      const GROUP_ID = -100123;
      const MEMBER = 555;
      // The picker path stored the group chat id as the invitation invitee_id.
      const groupInvitation = invRepo.create({
        event_id: event.id,
        inviter_id: INVITER,
        invitee_id: GROUP_ID,
      });

      // Regression: a member responding via the personal inv: path is never authorized,
      // because invitee_id is the group id, not the member's telegram_id.
      const rejected = service.acceptInvitation(groupInvitation.id, MEMBER);
      expect(rejected.success).toBe(false);
      expect(rejected.error).toContain('Not authorized');

      // The group RSVP path records the member directly against the event.
      const recorded = service.recordGroupAttendance(event.id, MEMBER, 'accepted');
      expect(recorded.success).toBe(true);
      const row = participantRepo.findByEventAndUser(event.id, MEMBER);
      expect(row).not.toBeNull();
      expect(row!.status).toBe('accepted');
    });

    test('members RSVP independently — one row per member, no "already changed"', () => {
      const { service, participantRepo, event } = setupGroup();
      const a = service.recordGroupAttendance(event.id, 555, 'accepted');
      const b = service.recordGroupAttendance(event.id, 777, 'declined');
      expect(a.success).toBe(true);
      expect(b.success).toBe(true);

      const rows = participantRepo.getByEvent(event.id);
      expect(rows.length).toBe(2);
      expect(participantRepo.findByEventAndUser(event.id, 555)!.status).toBe('accepted');
      expect(participantRepo.findByEventAndUser(event.id, 777)!.status).toBe('declined');
    });

    test('a member can flip their answer (accepted -> declined updates the same row)', () => {
      const { service, participantRepo, event } = setupGroup();
      service.recordGroupAttendance(event.id, 555, 'accepted');
      const flip = service.recordGroupAttendance(event.id, 555, 'declined');
      expect(flip.success).toBe(true);

      const rows = participantRepo.getByEvent(event.id);
      expect(rows.length).toBe(1);
      expect(participantRepo.findByEventAndUser(event.id, 555)!.status).toBe('declined');
    });

    test('fails when the event no longer exists', () => {
      const { service, participantRepo } = setupGroup();
      const result = service.recordGroupAttendance(999999, 555, 'accepted');
      expect(result.success).toBe(false);
      expect(participantRepo.findByEventAndUser(999999, 555)).toBeNull();
    });

    test('fails when the participant registry is not wired', () => {
      const db = createTestDb();
      const userRepo = new UserRepository(db);
      userRepo.create({ telegram_id: INVITER });
      const eventRepo = new EventRepository(db);
      const invRepo = new InvitationRepository(db);
      const settingsRepo = new SharingSettingsRepository(db);
      // No participantRepo passed.
      const service = new InvitationService(invRepo, eventRepo, settingsRepo);
      const event = eventRepo.create({
        user_id: INVITER,
        title: 'Group Party',
        start_at: '2026-03-15T18:00:00Z',
        timezone: 'UTC',
      });
      const result = service.recordGroupAttendance(event.id, 555, 'accepted');
      expect(result.success).toBe(false);
    });
  });
});
