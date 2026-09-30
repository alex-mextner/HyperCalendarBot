// src/database/repositories/birthday-metadata.repository.ts

import type { Database } from 'bun:sqlite';
import type { BirthdaySyncState, BirthEventMetadata } from '../types.ts';

export interface UpsertMetadataParams {
  event_id: number;
  celebrant_id: number | null;
  birth_year: number | null;
  auto_created: number;
}

export class BirthdayMetadataRepository {
  constructor(private db: Database) {}

  upsertMetadata(params: UpsertMetadataParams): void {
    this.db
      .prepare(
        `INSERT INTO birth_event_metadata (event_id, celebrant_id, birth_year, auto_created)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (event_id) DO UPDATE SET
           celebrant_id = excluded.celebrant_id,
           birth_year   = excluded.birth_year,
           auto_created = excluded.auto_created`,
      )
      .run(params.event_id, params.celebrant_id ?? null, params.birth_year ?? null, params.auto_created);
  }

  findByEventId(eventId: number): BirthEventMetadata | null {
    return this.db
      .prepare('SELECT * FROM birth_event_metadata WHERE event_id = ?')
      .get(eventId) as BirthEventMetadata | null;
  }

  findByCelebrantAndOwner(
    celebrantId: number,
    ownerId: number,
  ): (BirthEventMetadata & { start_at: string; title: string }) | null {
    return this.db
      .prepare(
        `SELECT m.*, e.start_at, e.title
         FROM birth_event_metadata m
         JOIN events e ON e.id = m.event_id
         WHERE m.celebrant_id = ?
           AND e.user_id = ?
           AND (e.owner_type IS NULL OR e.owner_type = 'user')
           AND e.is_cancelled = 0 AND e.is_deleted = 0`,
      )
      .get(celebrantId, ownerId) as (BirthEventMetadata & { start_at: string; title: string }) | null;
  }

  findByCelebrantAndGroup(
    celebrantId: number,
    groupId: number,
  ): (BirthEventMetadata & { start_at: string; title: string }) | null {
    return this.db
      .prepare(
        `SELECT m.*, e.start_at, e.title
         FROM birth_event_metadata m
         JOIN events e ON e.id = m.event_id
         WHERE m.celebrant_id = ?
           AND e.group_id = ?
           AND e.owner_type = 'group'
           AND e.is_cancelled = 0 AND e.is_deleted = 0`,
      )
      .get(celebrantId, groupId) as (BirthEventMetadata & { start_at: string; title: string }) | null;
  }

  deleteByEventId(eventId: number): void {
    this.db.prepare('DELETE FROM birth_event_metadata WHERE event_id = ?').run(eventId);
  }

  upsertSyncState(userId: number, syncedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO birthday_sync_state (user_id, synced_at) VALUES (?, ?)
         ON CONFLICT (user_id) DO UPDATE SET synced_at = excluded.synced_at`,
      )
      .run(userId, syncedAt);
  }

  getSyncState(userId: number): BirthdaySyncState | null {
    return this.db
      .prepare('SELECT * FROM birthday_sync_state WHERE user_id = ?')
      .get(userId) as BirthdaySyncState | null;
  }

  getUsersNeedingSync(
    maxAgeMs: number,
  ): { telegram_id: number; first_name: string | null; language: string; timezone: string }[] {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    return this.db
      .prepare(
        `SELECT u.telegram_id, u.first_name, u.language, u.timezone FROM users u
         LEFT JOIN birthday_sync_state s ON s.user_id = u.telegram_id
         WHERE s.synced_at IS NULL OR s.synced_at < ?`,
      )
      .all(cutoff) as { telegram_id: number; first_name: string | null; language: string; timezone: string }[];
  }
}
