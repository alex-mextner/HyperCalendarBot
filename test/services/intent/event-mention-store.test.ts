import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import {
  InMemoryEventMentionStore,
  RedisEventMentionStore,
  SqliteEventMentionStore,
} from '../../../src/services/intent/event-mention-store.ts';

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

describe('InMemoryEventMentionStore', () => {
  test('returns null for unknown user', () => {
    const store = new InMemoryEventMentionStore();
    expect(store.get(999)).toBeNull();
  });

  test('stores and retrieves eventId', () => {
    const store = new InMemoryEventMentionStore();
    store.set(1, 42);
    expect(store.get(1)).toBe(42);
  });

  test('overwrites previous value', () => {
    const store = new InMemoryEventMentionStore();
    store.set(1, 10);
    store.set(1, 20);
    expect(store.get(1)).toBe(20);
  });

  test('different users are isolated', () => {
    const store = new InMemoryEventMentionStore();
    store.set(1, 10);
    store.set(2, 20);
    expect(store.get(1)).toBe(10);
    expect(store.get(2)).toBe(20);
  });
});

describe('RedisEventMentionStore', () => {
  function makeRedis(data: Map<string, string>, ttlCapture?: { ex?: number }) {
    return {
      async set(key: string, value: string, opts?: { ex?: number }) {
        data.set(key, value);
        if (ttlCapture && opts) Object.assign(ttlCapture, opts);
        return 'OK';
      },
      async get(key: string): Promise<string | null> {
        return data.get(key) ?? null;
      },
    };
  }

  test('returns null for unknown user', async () => {
    const store = new RedisEventMentionStore(makeRedis(new Map()));
    expect(await store.get(999)).toBeNull();
  });

  test('stores and retrieves eventId via Redis', async () => {
    const data = new Map<string, string>();
    const ttl: { ex?: number } = {};
    const store = new RedisEventMentionStore(makeRedis(data, ttl));
    await store.set(1, 42);
    expect(await store.get(1)).toBe(42);
    expect(data.get('last_mentioned_event:1')).toBe('42');
    expect(ttl.ex).toBe(7 * 24 * 60 * 60); // 7-day TTL
  });

  test('overwrites previous value', async () => {
    const store = new RedisEventMentionStore(makeRedis(new Map()));
    await store.set(1, 10);
    await store.set(1, 20);
    expect(await store.get(1)).toBe(20);
  });

  test('returns null for non-numeric stored value', async () => {
    const data = new Map<string, string>([['last_mentioned_event:1', 'garbage']]);
    const store = new RedisEventMentionStore(makeRedis(data));
    expect(await store.get(1)).toBeNull();
  });
});

describe('SqliteEventMentionStore', () => {
  test('returns null for unknown user', () => {
    const store = new SqliteEventMentionStore(createTestDb());
    expect(store.get(999)).toBeNull();
  });

  test('stores and retrieves eventId', () => {
    const store = new SqliteEventMentionStore(createTestDb());
    store.set(1, 42);
    expect(store.get(1)).toBe(42);
  });

  test('overwrites previous value', () => {
    const store = new SqliteEventMentionStore(createTestDb());
    store.set(1, 10);
    store.set(1, 20);
    expect(store.get(1)).toBe(20);
  });

  test('different users are isolated', () => {
    const store = new SqliteEventMentionStore(createTestDb());
    store.set(1, 10);
    store.set(2, 20);
    expect(store.get(1)).toBe(10);
    expect(store.get(2)).toBe(20);
  });

  test('returns null for entries older than 7 days', () => {
    const db = createTestDb();
    const store = new SqliteEventMentionStore(db);
    const oldTs = Date.now() - 8 * 24 * 60 * 60 * 1000;
    db.prepare('INSERT INTO event_mention_store (user_id, event_id, updated_at) VALUES (?, ?, ?)').run(1, 42, oldTs);
    expect(store.get(1)).toBeNull();
  });

  test('deleteExpired removes stale entries, keeps fresh ones', () => {
    const db = createTestDb();
    const store = new SqliteEventMentionStore(db);
    store.set(2, 99);
    const oldTs = Date.now() - 8 * 24 * 60 * 60 * 1000;
    db.prepare('INSERT INTO event_mention_store (user_id, event_id, updated_at) VALUES (?, ?, ?)').run(1, 42, oldTs);
    store.deleteExpired();
    expect(store.get(1)).toBeNull();
    expect(store.get(2)).toBe(99);
  });
});
