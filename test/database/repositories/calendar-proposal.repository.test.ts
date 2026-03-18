import { Database } from 'bun:sqlite';
import { beforeEach, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { CalendarProposalRepository } from '../../../src/database/repositories/calendar-proposal.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import type { CreateProposalData } from '../../../src/database/types.ts';

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

let repo: CalendarProposalRepository;
let db: Database;

beforeEach(() => {
  db = createTestDb();
  repo = new CalendarProposalRepository(db);
  const users = new UserRepository(db);
  users.create({ telegram_id: 1 });
  users.create({ telegram_id: 2 });
});

const base: CreateProposalData = {
  group_chat_id: -100,
  group_chat_title: 'Dev Team',
  proposer_id: 1,
  target_id: 2,
  action: 'create',
  payload: '{"action":"create","event":{"title":"Test"}}',
  summary: 'добавить встречу Test',
  expires_at: '2099-12-31T23:59:59Z',
};

test('create returns new proposal with pending status', () => {
  const p = repo.create(base);
  expect(p.status).toBe('pending');
  expect(p.action).toBe('create');
});

test('findById returns null for unknown id', () => {
  expect(repo.findById(999)).toBeNull();
});

test('updateStatus changes status', () => {
  const p = repo.create(base);
  const ok = repo.updateStatus(p.id, 'accepted');
  expect(ok).toBe(true);
  expect(repo.findById(p.id)!.status).toBe('accepted');
});

test('setGroupMessageId stores the message id', () => {
  const p = repo.create(base);
  repo.setGroupMessageId(p.id, 555);
  expect(repo.findById(p.id)!.group_message_id).toBe(555);
});

test('getExpired returns proposals past expires_at with pending status', () => {
  const p = repo.create({ ...base, expires_at: '2000-01-01T00:00:00Z' });
  const expired = repo.getExpired();
  expect(expired.some((e) => e.id === p.id)).toBe(true);
});

test('expirePending updates expired proposals to expired status', () => {
  const p = repo.create({ ...base, expires_at: '2000-01-01T00:00:00Z' });
  repo.expirePending();
  expect(repo.findById(p.id)!.status).toBe('expired');
});
