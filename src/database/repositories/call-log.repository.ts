// src/database/repositories/call-log.repository.ts
import type { Database } from 'bun:sqlite';
import type { CallLog, CallStatus } from '../types';

/** What a call log row records. The reminder's words are never stored: event content stays out of the database. */
interface CreateCallLogData {
  user_id: number;
  event_id?: number;
}

export class CallLogRepository {
  constructor(private db: Database) {}

  create(data: CreateCallLogData): CallLog {
    const result = this.db
      .prepare('INSERT INTO call_log (user_id, event_id) VALUES (?, ?)')
      .run(data.user_id, data.event_id ?? null);
    return this.findById(Number(result.lastInsertRowid))!;
  }

  findById(id: number): CallLog | null {
    return this.db.query<CallLog, [number]>('SELECT * FROM call_log WHERE id = ?').get(id);
  }

  updateStatus(id: number, status: CallStatus): void {
    this.db.prepare('UPDATE call_log SET status = ? WHERE id = ?').run(status, id);
  }

  complete(id: number, status: CallStatus, durationSec: number, error?: string): void {
    this.db
      .prepare(
        "UPDATE call_log SET status = ?, duration_sec = ?, error = ?, completed_at = datetime('now') WHERE id = ?",
      )
      .run(status, durationSec, error ?? null, id);
  }

  /** Calls logged at or after `sinceUtcIso`; `created_at` is stored as SQLite UTC `datetime('now')`. */
  countCallsSince(userId: number, sinceUtcIso: string): number {
    const row = this.db
      .query<{ cnt: number }, [number, string]>(
        'SELECT COUNT(*) as cnt FROM call_log WHERE user_id = ? AND created_at >= datetime(?)',
      )
      .get(userId, sinceUtcIso);
    return row?.cnt ?? 0;
  }

  getRecent(userId: number, limit: number): CallLog[] {
    return this.db
      .query<CallLog, [number, number]>('SELECT * FROM call_log WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(userId, limit);
  }
}
