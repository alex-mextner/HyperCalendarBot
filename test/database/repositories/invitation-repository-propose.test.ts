import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations';
import { EventRepository } from '../../../src/database/repositories/event.repository';
import { InvitationRepository } from '../../../src/database/repositories/invitation.repository';
import { UserRepository } from '../../../src/database/repositories/user.repository';
import { runMigrations } from '../../../src/database/schema';

function setup() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  const users = new UserRepository(db);
  users.create({ telegram_id: 100 });
  users.create({ telegram_id: 200 });
  const events = new EventRepository(db);
  const invRepo = new InvitationRepository(db);
  const event = events.create({ user_id: 100, title: 'Party', start_at: '2026-04-01T10:00:00Z', timezone: 'UTC' });
  const inv = invRepo.create({ event_id: event.id, inviter_id: 100, invitee_id: 200 });
  return { invRepo, inv };
}

describe('InvitationRepository.setProposedTime', () => {
  test('sets proposed_time on invitation', () => {
    const { invRepo, inv } = setup();
    invRepo.setProposedTime(inv.id, '2026-04-01T14:00:00Z');
    const updated = invRepo.findById(inv.id)!;
    expect(updated.proposed_time).toBe('2026-04-01T14:00:00Z');
  });

  test('clearProposedTime sets proposed_time to null', () => {
    const { invRepo, inv } = setup();
    invRepo.setProposedTime(inv.id, '2026-04-01T14:00:00Z');
    expect(invRepo.clearProposedTime(inv.id, '2026-04-01T14:00:00Z')).toBe(true);
    const updated = invRepo.findById(inv.id)!;
    expect(updated.proposed_time).toBeNull();
  });

  // The inviter's Reschedule/Keep read the invitation first; an answer landing before their write wins.
  test('a proposal answered after it was read can be neither accepted nor dropped', () => {
    const { invRepo, inv } = setup();
    invRepo.setProposedTime(inv.id, '2026-04-01T14:00:00Z');
    invRepo.updateStatus(inv.id, 'declined', 'pending');

    expect(invRepo.clearProposedTimeAndAccept(inv.id, '2026-04-01T14:00:00Z')).toBe(false);
    expect(invRepo.clearProposedTime(inv.id, '2026-04-01T14:00:00Z')).toBe(false);
    expect(invRepo.findById(inv.id)!.status).toBe('declined');
  });

  test('a proposal replaced after it was read is not accepted at the old time', () => {
    const { invRepo, inv } = setup();
    invRepo.setProposedTime(inv.id, '2026-04-01T14:00:00Z');
    invRepo.setProposedTime(inv.id, '2026-04-01T15:00:00Z');

    expect(invRepo.clearProposedTimeAndAccept(inv.id, '2026-04-01T14:00:00Z')).toBe(false);
    expect(invRepo.findById(inv.id)).toMatchObject({ status: 'pending', proposed_time: '2026-04-01T15:00:00Z' });
  });
});
