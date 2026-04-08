import type { Database } from 'bun:sqlite';
import type { ParticipantGoogleSync } from '../types.ts';

export class ParticipantGoogleSyncRepository {
  constructor(private db: Database) {}

  upsert(
    userId: number,
    eventId: number,
    data: {
      google_event_id?: string | null;
      google_calendar_id?: string;
      google_etag?: string | null;
      sync_status?: string;
      last_synced_at?: string | null;
    },
  ): void {
    this.db
      .prepare(
        `INSERT INTO participant_google_sync (user_id, event_id, google_event_id, google_calendar_id, google_etag, sync_status, last_synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, event_id) DO UPDATE SET
           google_event_id = COALESCE(excluded.google_event_id, participant_google_sync.google_event_id),
           google_calendar_id = excluded.google_calendar_id,
           google_etag = excluded.google_etag,
           sync_status = excluded.sync_status,
           last_synced_at = excluded.last_synced_at,
           updated_at = datetime('now')`,
      )
      .run(
        userId,
        eventId,
        data.google_event_id ?? null,
        data.google_calendar_id ?? 'primary',
        data.google_etag ?? null,
        data.sync_status ?? 'pending_push',
        data.last_synced_at ?? null,
      );
  }

  getByUserAndEvent(userId: number, eventId: number): ParticipantGoogleSync | null {
    return this.db
      .prepare('SELECT * FROM participant_google_sync WHERE user_id = ? AND event_id = ?')
      .get(userId, eventId) as ParticipantGoogleSync | null;
  }

  getSyncedByEvent(eventId: number): ParticipantGoogleSync[] {
    return this.db
      .prepare('SELECT * FROM participant_google_sync WHERE event_id = ?')
      .all(eventId) as ParticipantGoogleSync[];
  }

  getSyncedByUser(userId: number): ParticipantGoogleSync[] {
    return this.db
      .prepare('SELECT * FROM participant_google_sync WHERE user_id = ?')
      .all(userId) as ParticipantGoogleSync[];
  }

  updateSyncFields(
    userId: number,
    eventId: number,
    data: {
      google_event_id?: string;
      google_etag?: string;
      sync_status?: string;
      last_synced_at?: string;
    },
  ): void {
    const fields: string[] = [];
    const values: (string | number)[] = [];
    for (const [k, v] of Object.entries(data)) {
      if (v !== undefined) {
        fields.push(`${k} = ?`);
        values.push(v);
      }
    }
    if (fields.length === 0) return;
    fields.push("updated_at = datetime('now')");
    values.push(userId, eventId);
    this.db
      .prepare(`UPDATE participant_google_sync SET ${fields.join(', ')} WHERE user_id = ? AND event_id = ?`)
      .run(...values);
  }

  delete(userId: number, eventId: number): void {
    this.db.prepare('DELETE FROM participant_google_sync WHERE user_id = ? AND event_id = ?').run(userId, eventId);
  }

  deleteByEvent(eventId: number): void {
    this.db.prepare('DELETE FROM participant_google_sync WHERE event_id = ?').run(eventId);
  }

  deleteByUser(userId: number): void {
    this.db.prepare('DELETE FROM participant_google_sync WHERE user_id = ?').run(userId);
  }
}
