import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { GroupSessionRepository } from '../../../src/database/repositories/group-session.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

function makeSession(chatId = 1, overrides: Record<string, unknown> = {}) {
  return {
    chatId,
    activatedBy: 42,
    remainingMessages: 10,
    lastBotMessageId: 100,
    expiresAt: Date.now() + 5 * 24 * 60 * 60 * 1000,
    ...overrides,
  };
}

describe('GroupSessionRepository', () => {
  let db: Database;
  let repo: GroupSessionRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new GroupSessionRepository(db);
  });

  test('get returns null for missing chat', () => {
    expect(repo.get(999)).toBeNull();
  });

  test('upsert and get roundtrips session', () => {
    const session = makeSession(1, { activatedBy: 7, remainingMessages: 5 });
    repo.upsert(session);

    const result = repo.get(1);
    expect(result).not.toBeNull();
    expect(result!.chatId).toBe(1);
    expect(result!.activatedBy).toBe(7);
    expect(result!.remainingMessages).toBe(5);
  });

  test('upsert updates existing session', () => {
    repo.upsert(makeSession(1, { remainingMessages: 10 }));
    repo.upsert(makeSession(1, { remainingMessages: 3 }));

    expect(repo.get(1)!.remainingMessages).toBe(3);
  });

  test('delete removes session', () => {
    repo.upsert(makeSession(1));
    repo.delete(1);
    expect(repo.get(1)).toBeNull();
  });

  test('different chats are independent', () => {
    repo.upsert(makeSession(1, { activatedBy: 10 }));
    repo.upsert(makeSession(2, { activatedBy: 20 }));

    expect(repo.get(1)!.activatedBy).toBe(10);
    expect(repo.get(2)!.activatedBy).toBe(20);
  });

  test('deleteExpired removes sessions past expiresAt', () => {
    repo.upsert(makeSession(1, { expiresAt: Date.now() - 1 })); // expired
    repo.upsert(makeSession(2, { expiresAt: Date.now() + 1000 })); // active

    repo.deleteExpired();

    expect(repo.get(1)).toBeNull();
    expect(repo.get(2)).not.toBeNull();
  });

  test('deleteExpired removes sessions with 0 remaining messages', () => {
    repo.upsert(makeSession(3, { remainingMessages: 0 }));
    repo.deleteExpired();
    expect(repo.get(3)).toBeNull();
  });
});
