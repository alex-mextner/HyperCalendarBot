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
    invRepo.clearProposedTime(inv.id);
    const updated = invRepo.findById(inv.id)!;
    expect(updated.proposed_time).toBeNull();
  });
});
