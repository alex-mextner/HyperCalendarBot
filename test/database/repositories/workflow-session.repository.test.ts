import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { WorkflowSessionRepository } from '../../../src/database/repositories/workflow-session.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    intentId: 1,
    stepIndex: 0,
    stepResults: {},
    workflow: { steps: [] },
    captures: {},
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('WorkflowSessionRepository', () => {
  let db: Database;
  let repo: WorkflowSessionRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new WorkflowSessionRepository(db);
  });

  test('get returns null for missing session', () => {
    expect(repo.get(1, 1)).toBeNull();
  });

  test('set and get roundtrips session data', () => {
    const session = makeSession({ intentId: 42, stepIndex: 2 });
    repo.set(10, 20, session);

    const result = repo.get(10, 20);
    expect(result).not.toBeNull();
    expect(result!.intentId).toBe(42);
    expect(result!.stepIndex).toBe(2);
  });

  test('get returns null after delete', () => {
    repo.set(1, 1, makeSession());
    repo.delete(1, 1);
    expect(repo.get(1, 1)).toBeNull();
  });

  test('different (chatId, userId) pairs are independent', () => {
    const s1 = makeSession({ intentId: 1 });
    const s2 = makeSession({ intentId: 2 });
    repo.set(100, 1, s1);
    repo.set(200, 1, s2);

    expect(repo.get(100, 1)!.intentId).toBe(1);
    expect(repo.get(200, 1)!.intentId).toBe(2);
    expect(repo.get(100, 2)).toBeNull();
  });

  test('get returns null for expired session', () => {
    const expired = makeSession({ createdAt: Date.now() - 6 * 60 * 1000 }); // 6 min ago
    repo.set(1, 1, expired);
    expect(repo.get(1, 1)).toBeNull();
  });

  test('cleanup removes expired rows', () => {
    const expired = makeSession({ createdAt: Date.now() - 6 * 60 * 1000 });
    const fresh = makeSession({ intentId: 99 });
    repo.set(1, 1, expired);
    repo.set(2, 2, fresh);

    repo.cleanup();

    // Expired row is gone (but get already deleted it above, so check via fresh)
    const result = repo.get(2, 2);
    expect(result!.intentId).toBe(99);

    // No rows with chatId=1 left
    const count = db.prepare('SELECT COUNT(*) as c FROM workflow_sessions WHERE chat_id = 1').get() as { c: number };
    expect(count.c).toBe(0);
  });

  test('set upserts existing session', () => {
    repo.set(1, 1, makeSession({ intentId: 1, stepIndex: 0 }));
    repo.set(1, 1, makeSession({ intentId: 1, stepIndex: 3 }));

    const result = repo.get(1, 1);
    expect(result!.stepIndex).toBe(3);
  });
});
