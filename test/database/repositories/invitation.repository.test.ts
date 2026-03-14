import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { InvitationRepository } from '../../../src/database/repositories/invitation.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

const INVITER = 100;
const INVITEE = 200;

describe('InvitationRepository', () => {
  let db: Database;
  let repo: InvitationRepository;
  let eventId: number;

  beforeEach(() => {
    db = createTestDb();
    repo = new InvitationRepository(db);
    new UserRepository(db).create({ telegram_id: INVITER });
    const event = new EventRepository(db).create({
      user_id: INVITER,
      title: 'Party',
      start_at: '2026-03-15T18:00:00Z',
      timezone: 'UTC',
    });
    eventId = event.id;
  });

  test('create stores invitation with pending status', () => {
    const inv = repo.create({ event_id: eventId, inviter_id: INVITER, invitee_id: INVITEE });
    expect(inv.id).toBeGreaterThan(0);
    expect(inv.status).toBe('pending');
  });

  test('findById returns invitation', () => {
    const inv = repo.create({ event_id: eventId, inviter_id: INVITER, invitee_id: INVITEE });
    expect(repo.findById(inv.id)).not.toBeNull();
  });

  test('updateStatus transitions with optimistic locking', () => {
    const inv = repo.create({ event_id: eventId, inviter_id: INVITER, invitee_id: INVITEE });
    const ok = repo.updateStatus(inv.id, 'accepted', 'pending');
    expect(ok).toBe(true);
    expect(repo.findById(inv.id)!.status).toBe('accepted');
  });

  test('updateStatus fails when current status mismatches', () => {
    const inv = repo.create({ event_id: eventId, inviter_id: INVITER, invitee_id: INVITEE });
    repo.updateStatus(inv.id, 'accepted', 'pending');
    const ok = repo.updateStatus(inv.id, 'declined', 'pending');
    expect(ok).toBe(false);
  });

  test('findActiveByEventAndInvitee finds pending/maybe/accepted', () => {
    repo.create({ event_id: eventId, inviter_id: INVITER, invitee_id: INVITEE });
    expect(repo.findActiveByEventAndInvitee(eventId, INVITEE)).not.toBeNull();
  });

  test('findActiveByEventAndInvitee returns null for declined only', () => {
    const inv = repo.create({ event_id: eventId, inviter_id: INVITER, invitee_id: INVITEE });
    repo.updateStatus(inv.id, 'declined', 'pending');
    expect(repo.findActiveByEventAndInvitee(eventId, INVITEE)).toBeNull();
  });

  test('countDeclined counts declined per event+invitee', () => {
    const inv = repo.create({ event_id: eventId, inviter_id: INVITER, invitee_id: INVITEE });
    repo.updateStatus(inv.id, 'declined', 'pending');
    expect(repo.countDeclined(eventId, INVITEE)).toBe(1);
  });

  test('getByInvitee returns received invitations', () => {
    repo.create({ event_id: eventId, inviter_id: INVITER, invitee_id: INVITEE });
    expect(repo.getByInvitee(INVITEE)).toHaveLength(1);
  });

  test('getByInviter returns sent invitations', () => {
    repo.create({ event_id: eventId, inviter_id: INVITER, invitee_id: INVITEE });
    expect(repo.getByInviter(INVITER)).toHaveLength(1);
  });

  test('getPendingForEvent returns pending/maybe', () => {
    repo.create({ event_id: eventId, inviter_id: INVITER, invitee_id: INVITEE });
    expect(repo.getPendingForEvent(eventId)).toHaveLength(1);
  });

  test('expirePastInvitations marks past-event invitations expired', () => {
    const pastEvent = new EventRepository(db).create({
      user_id: INVITER,
      title: 'Past',
      start_at: '2020-01-01T10:00:00Z',
      timezone: 'UTC',
    });
    repo.create({ event_id: pastEvent.id, inviter_id: INVITER, invitee_id: INVITEE });
    expect(repo.expirePastInvitations()).toBe(1);
  });

  test('cancelForEvent cancels pending/maybe invitations', () => {
    repo.create({ event_id: eventId, inviter_id: INVITER, invitee_id: INVITEE });
    expect(repo.cancelForEvent(eventId)).toBe(1);
    expect(repo.findById(1)!.status).toBe('cancelled');
  });

  test('setMessageInfo stores message_id and chat_id', () => {
    const inv = repo.create({ event_id: eventId, inviter_id: INVITER, invitee_id: INVITEE });
    repo.setMessageInfo(inv.id, 555, 100);
    const updated = repo.findById(inv.id);
    expect(updated!.message_id).toBe(555);
    expect(updated!.chat_id).toBe(100);
  });
});
