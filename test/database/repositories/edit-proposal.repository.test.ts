import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { EditProposalRepository } from '../../../src/database/repositories/edit-proposal.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';

function createTestDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

describe('EditProposalRepository', () => {
  let db: Database;
  let repo: EditProposalRepository;
  let eventId: number;

  beforeEach(() => {
    db = createTestDb();
    repo = new EditProposalRepository(db);
    const userRepo = new UserRepository(db);
    const eventRepo = new EventRepository(db);
    userRepo.create({ telegram_id: 100, timezone: 'UTC' });
    const event = eventRepo.create({
      user_id: 100,
      title: 'Test',
      start_at: '2026-03-20T10:00:00Z',
      timezone: 'UTC',
    });
    eventId = event.id;
  });

  test('create stores proposal', () => {
    const proposal = repo.create({
      event_id: eventId,
      proposer_id: 200,
      changes: '{"title":"New Title"}',
      reason: 'Rename it',
    });
    expect(proposal.id).toBeDefined();
    expect(proposal.event_id).toBe(eventId);
    expect(proposal.proposer_id).toBe(200);
    expect(proposal.changes).toBe('{"title":"New Title"}');
    expect(proposal.reason).toBe('Rename it');
    expect(proposal.status).toBe('pending');
  });

  test('findById returns proposal', () => {
    const created = repo.create({ event_id: eventId, proposer_id: 200, changes: '{}' });
    const found = repo.findById(created.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
  });

  test('findById returns null for non-existent', () => {
    expect(repo.findById(9999)).toBeNull();
  });

  test('getPendingForEvent returns pending proposals', () => {
    repo.create({ event_id: eventId, proposer_id: 200, changes: '{"title":"A"}' });
    repo.create({ event_id: eventId, proposer_id: 300, changes: '{"title":"B"}' });
    const pending = repo.getPendingForEvent(eventId);
    expect(pending).toHaveLength(2);
  });

  test('updateStatus changes from pending to accepted', () => {
    const proposal = repo.create({ event_id: eventId, proposer_id: 200, changes: '{}' });
    const ok = repo.updateStatus(proposal.id, 'accepted');
    expect(ok).toBe(true);
    expect(repo.findById(proposal.id)!.status).toBe('accepted');
  });

  test('updateStatus does not change non-pending', () => {
    const proposal = repo.create({ event_id: eventId, proposer_id: 200, changes: '{}' });
    repo.updateStatus(proposal.id, 'rejected');
    const ok = repo.updateStatus(proposal.id, 'accepted');
    expect(ok).toBe(false);
    expect(repo.findById(proposal.id)!.status).toBe('rejected');
  });
});
