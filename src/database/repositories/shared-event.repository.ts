import type { Database } from 'bun:sqlite';
import type { CreateSharedEventData, SharedEvent } from '../types.ts';

export class SharedEventRepository {
  constructor(private db: Database) {}

  create(data: CreateSharedEventData): SharedEvent {
    const result = this.db
      .prepare(
        `INSERT INTO shared_events (event_id, shared_by, shared_to_type, shared_to_id, share_type, message_id, deep_link_code)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        data.event_id,
        data.shared_by,
        data.shared_to_type,
        data.shared_to_id,
        data.share_type,
        data.message_id ?? null,
        data.deep_link_code ?? null,
      );
    return this.db
      .prepare('SELECT * FROM shared_events WHERE id = ?')
      .get(Number(result.lastInsertRowid)) as SharedEvent;
  }

  getByEvent(eventId: number): SharedEvent[] {
    return this.db
      .prepare('SELECT * FROM shared_events WHERE event_id = ? ORDER BY created_at DESC')
      .all(eventId) as SharedEvent[];
  }

  getByTarget(targetType: string, targetId: number): SharedEvent[] {
    return this.db
      .prepare('SELECT * FROM shared_events WHERE shared_to_type = ? AND shared_to_id = ? ORDER BY created_at DESC')
      .all(targetType, targetId) as SharedEvent[];
  }
}
