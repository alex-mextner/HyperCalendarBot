// src/database/repositories/birthday-metadata.repository.ts

import type { Database } from 'bun:sqlite';
import type { BirthEventMetadata } from '../types.ts';

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
}
