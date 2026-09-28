// test/database/repositories/dialogue-session.repository.test.ts
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import {
  DIALOGUE_V3_SESSION_TTL_MS,
  DialogueSessionRepository,
} from '../../../src/database/repositories/dialogue-session.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import type { DialogueV3Session } from '../../../src/services/dialogue/v3-types.ts';
import { emptyDraft } from '../../../src/services/dialogue/v3-types.ts';

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

function makeSession(overrides: Partial<DialogueV3Session> = {}): DialogueV3Session {
  const now = Date.now();
  return {
    version: 3,
    sessionId: 'sess-1',
    actorId: 1,
    chatId: 100,
    topicId: 0,
    operation: 'event.create',
    draft: emptyDraft('personal'),
    pendingField: 'schedule',
    status: 'collecting',
    createdAt: now,
    updatedAt: now,
    sourceText: 'Meeting tomorrow',
    ...overrides,
  };
}

describe('DialogueSessionRepository', () => {
  let db: Database;
  let repo: DialogueSessionRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new DialogueSessionRepository(db);
  });

  afterEach(() => {
    setSystemTime();
  });

  test('round-trips a session through set/get', () => {
    const key = { chatId: 100, userId: 1, topicId: 0 };
    const session = makeSession();
    repo.set(key, session);
    expect(repo.get(key)).toEqual(session);
  });

  test('a missing session returns null, not a throw', () => {
    expect(repo.get({ chatId: 999, userId: 999, topicId: 0 })).toBeNull();
  });

  test('actor+chat+topic scoping — same actor/chat, different topic, is a distinct session', () => {
    const draftA = makeSession({ topicId: 1, draft: emptyDraft('personal') });
    const draftB = makeSession({ topicId: 2, sessionId: 'sess-2' });
    repo.set({ chatId: 100, userId: 1, topicId: 1 }, draftA);
    repo.set({ chatId: 100, userId: 1, topicId: 2 }, draftB);
    expect(repo.get({ chatId: 100, userId: 1, topicId: 1 })?.sessionId).toBe('sess-1');
    expect(repo.get({ chatId: 100, userId: 1, topicId: 2 })?.sessionId).toBe('sess-2');
  });

  test('different chats never see each others session even for the same user', () => {
    repo.set({ chatId: 100, userId: 1, topicId: 0 }, makeSession({ chatId: 100 }));
    expect(repo.get({ chatId: 200, userId: 1, topicId: 0 })).toBeNull();
  });

  test('delete removes the row', () => {
    const key = { chatId: 100, userId: 1, topicId: 0 };
    repo.set(key, makeSession());
    repo.delete(key);
    expect(repo.get(key)).toBeNull();
  });

  test('a session past its TTL is treated as gone and swept on read', () => {
    const key = { chatId: 100, userId: 1, topicId: 0 };
    const started = Date.now();
    setSystemTime(started);
    repo.set(key, makeSession({ createdAt: started, updatedAt: started }));

    setSystemTime(started + DIALOGUE_V3_SESSION_TTL_MS - 1);
    expect(repo.get(key)).not.toBeNull();

    setSystemTime(started + DIALOGUE_V3_SESSION_TTL_MS);
    expect(repo.get(key)).toBeNull();

    const row = db.prepare('SELECT * FROM dialogue_v3_sessions WHERE chat_id = ?').get(100);
    expect(row).toBeNull();
  });

  test('set again on the same key overwrites, never duplicates a row', () => {
    const key = { chatId: 100, userId: 1, topicId: 0 };
    repo.set(key, makeSession({ pendingField: 'schedule' }));
    repo.set(key, makeSession({ pendingField: 'people' }));
    expect(repo.get(key)?.pendingField).toBe('people');
    const count = db.prepare('SELECT COUNT(*) as n FROM dialogue_v3_sessions').get() as { n: number };
    expect(count.n).toBe(1);
  });

  test('cleanup deletes only rows past the TTL', () => {
    const started = Date.now();
    setSystemTime(started);
    repo.set({ chatId: 1, userId: 1, topicId: 0 }, makeSession({ chatId: 1, createdAt: started, updatedAt: started }));
    setSystemTime(started + 1000);
    repo.set(
      { chatId: 2, userId: 1, topicId: 0 },
      makeSession({ chatId: 2, createdAt: started + 1000, updatedAt: started + 1000 }),
    );

    setSystemTime(started + DIALOGUE_V3_SESSION_TTL_MS + 1);
    repo.cleanup();

    expect(repo.get({ chatId: 1, userId: 1, topicId: 0 })).toBeNull();
    expect(repo.get({ chatId: 2, userId: 1, topicId: 0 })).not.toBeNull();
  });

  test('a row with unreadable JSON is treated as absent, never thrown', () => {
    db.prepare(
      'INSERT INTO dialogue_v3_sessions (chat_id, user_id, topic_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(100, 1, 0, 'not json', Date.now(), Date.now());
    expect(repo.get({ chatId: 100, userId: 1, topicId: 0 })).toBeNull();
  });
});
