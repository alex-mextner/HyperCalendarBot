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
    timezone: 'Europe/Belgrade',
    selectedDate: '2026-09-30',
    draft: emptyDraft('personal'),
    pendingField: 'schedule',
    pendingFuzzyPeople: [],
    status: 'collecting',
    revision: 0,
    executionReceipt: null,
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

  test('round-trips a session through set/get — a fresh insert (expectedRevision null) lands at revision 1', () => {
    const key = { chatId: 100, userId: 1, topicId: 0 };
    const session = makeSession();
    const result = repo.set(key, session, null);
    expect(result).toEqual({ ok: true, revision: 1 });
    expect(repo.get(key)).toEqual({ ...session, revision: 1 });
  });

  test('a missing session returns null, not a throw', () => {
    expect(repo.get({ chatId: 999, userId: 999, topicId: 0 })).toBeNull();
  });

  test('actor+chat+topic scoping — same actor/chat, different topic, is a distinct session', () => {
    const draftA = makeSession({ topicId: 1, draft: emptyDraft('personal') });
    const draftB = makeSession({ topicId: 2, sessionId: 'sess-2' });
    repo.set({ chatId: 100, userId: 1, topicId: 1 }, draftA, null);
    repo.set({ chatId: 100, userId: 1, topicId: 2 }, draftB, null);
    expect(repo.get({ chatId: 100, userId: 1, topicId: 1 })?.sessionId).toBe('sess-1');
    expect(repo.get({ chatId: 100, userId: 1, topicId: 2 })?.sessionId).toBe('sess-2');
  });

  test('different chats never see each others session even for the same user', () => {
    repo.set({ chatId: 100, userId: 1, topicId: 0 }, makeSession({ chatId: 100 }), null);
    expect(repo.get({ chatId: 200, userId: 1, topicId: 0 })).toBeNull();
  });

  test('delete removes the row', () => {
    const key = { chatId: 100, userId: 1, topicId: 0 };
    repo.set(key, makeSession(), null);
    repo.delete(key);
    expect(repo.get(key)).toBeNull();
  });

  test('a session past its TTL is treated as gone and swept on read', () => {
    const key = { chatId: 100, userId: 1, topicId: 0 };
    const started = Date.now();
    setSystemTime(started);
    repo.set(key, makeSession({ createdAt: started, updatedAt: started }), null);

    setSystemTime(started + DIALOGUE_V3_SESSION_TTL_MS - 1);
    expect(repo.get(key)).not.toBeNull();

    setSystemTime(started + DIALOGUE_V3_SESSION_TTL_MS);
    expect(repo.get(key)).toBeNull();

    const row = db.prepare('SELECT * FROM dialogue_v3_sessions WHERE chat_id = ?').get(100);
    expect(row).toBeNull();
  });

  test('cleanup deletes only rows past the TTL', () => {
    const started = Date.now();
    setSystemTime(started);
    repo.set(
      { chatId: 1, userId: 1, topicId: 0 },
      makeSession({ chatId: 1, createdAt: started, updatedAt: started }),
      null,
    );
    setSystemTime(started + 1000);
    repo.set(
      { chatId: 2, userId: 1, topicId: 0 },
      makeSession({ chatId: 2, createdAt: started + 1000, updatedAt: started + 1000 }),
      null,
    );

    setSystemTime(started + DIALOGUE_V3_SESSION_TTL_MS + 1);
    repo.cleanup();

    expect(repo.get({ chatId: 1, userId: 1, topicId: 0 })).toBeNull();
    expect(repo.get({ chatId: 2, userId: 1, topicId: 0 })).not.toBeNull();
  });

  test('a row with unreadable JSON is treated as absent, never thrown', () => {
    db.prepare(
      'INSERT INTO dialogue_v3_sessions (chat_id, user_id, topic_id, data, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(100, 1, 0, 'not json', 1, Date.now(), Date.now());
    expect(repo.get({ chatId: 100, userId: 1, topicId: 0 })).toBeNull();
  });

  describe('compare-and-swap writes (blocker: durable revision identity, late writes never clobber newer state)', () => {
    test('expectedRevision: null fails when a row already exists — never silently resurrects/overwrites', () => {
      const key = { chatId: 100, userId: 1, topicId: 0 };
      repo.set(key, makeSession({ pendingField: 'schedule' }), null);
      const second = repo.set(key, makeSession({ pendingField: 'title' }), null);
      expect(second).toEqual({ ok: false, reason: 'already_exists' });
      // The original row is untouched.
      expect(repo.get(key)?.pendingField).toBe('schedule');
    });

    test('a correct expectedRevision updates and bumps the revision by exactly 1', () => {
      const key = { chatId: 100, userId: 1, topicId: 0 };
      const first = repo.set(key, makeSession({ pendingField: 'schedule' }), null);
      expect(first).toEqual({ ok: true, revision: 1 });
      const second = repo.set(key, makeSession({ pendingField: 'people' }), 1);
      expect(second).toEqual({ ok: true, revision: 2 });
      expect(repo.get(key)?.pendingField).toBe('people');
      expect(repo.get(key)?.revision).toBe(2);
    });

    test('a stale expectedRevision is rejected — a late/duplicate write never clobbers a newer answer', () => {
      const key = { chatId: 100, userId: 1, topicId: 0 };
      repo.set(key, makeSession({ pendingField: 'schedule' }), null); // revision 1
      repo.set(key, makeSession({ pendingField: 'people' }), 1); // revision 2, the "newer" write
      // A late writer that only ever saw revision 1 (e.g. a duplicate webhook processed out of
      // order) tries to write again against the STALE revision 1 it originally read.
      const stale = repo.set(key, makeSession({ pendingField: 'place' }), 1);
      expect(stale).toEqual({ ok: false, reason: 'revision_mismatch' });
      // The newer state (from the successful revision-2 write) survives untouched.
      expect(repo.get(key)?.pendingField).toBe('people');
    });

    test('expectedRevision against a session that no longer exists (deleted) is rejected, not silently re-created', () => {
      const key = { chatId: 100, userId: 1, topicId: 0 };
      repo.set(key, makeSession(), null); // revision 1
      repo.delete(key);
      const result = repo.set(key, makeSession({ pendingField: 'people' }), 1);
      expect(result).toEqual({ ok: false, reason: 'revision_mismatch' });
      expect(repo.get(key)).toBeNull();
    });

    test('the session payload persisted always carries the CAS-computed revision, never a caller-supplied one', () => {
      const key = { chatId: 100, userId: 1, topicId: 0 };
      repo.set(key, makeSession({ revision: 999 }), null);
      expect(repo.get(key)?.revision).toBe(1);
    });
  });
});
