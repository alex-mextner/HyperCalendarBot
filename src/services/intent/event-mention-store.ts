// src/services/intent/event-mention-store.ts
import type { Database } from 'bun:sqlite';

const KEY_PREFIX = 'last_mentioned_event:';
const TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

interface RedisClient {
  set(key: string, value: string, opts?: { ex?: number }): Promise<string>;
  get(key: string): Promise<string | null>;
}

export interface EventMentionStore {
  set(userId: number, eventId: number): void | Promise<void>;
  get(userId: number): number | null | Promise<number | null>;
}

export class InMemoryEventMentionStore implements EventMentionStore {
  private store = new Map<number, number>();

  set(userId: number, eventId: number): void {
    this.store.set(userId, eventId);
  }

  get(userId: number): number | null {
    return this.store.get(userId) ?? null;
  }
}

export class RedisEventMentionStore implements EventMentionStore {
  constructor(private redis: RedisClient) {}

  async set(userId: number, eventId: number): Promise<void> {
    await this.redis.set(`${KEY_PREFIX}${userId}`, String(eventId), { ex: TTL_SECONDS });
  }

  async get(userId: number): Promise<number | null> {
    const val = await this.redis.get(`${KEY_PREFIX}${userId}`);
    if (!val) return null;
    const n = Number.parseInt(val, 10);
    return Number.isNaN(n) ? null : n;
  }
}

export class SqliteEventMentionStore implements EventMentionStore {
  constructor(private db: Database) {}

  set(userId: number, eventId: number): void {
    this.db
      .prepare(
        `INSERT INTO event_mention_store (user_id, event_id, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET
           event_id = excluded.event_id,
           updated_at = excluded.updated_at`,
      )
      .run(userId, eventId, Date.now());
  }

  get(userId: number): number | null {
    const cutoff = Date.now() - TTL_SECONDS * 1000;
    const row = this.db
      .prepare('SELECT event_id FROM event_mention_store WHERE user_id = ? AND updated_at > ?')
      .get(userId, cutoff) as { event_id: number } | null;
    return row?.event_id ?? null;
  }

  deleteExpired(): void {
    const cutoff = Date.now() - TTL_SECONDS * 1000;
    this.db.prepare('DELETE FROM event_mention_store WHERE updated_at <= ?').run(cutoff);
  }
}
