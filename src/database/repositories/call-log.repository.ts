// src/database/repositories/call-log.repository.ts
import type { Database } from 'bun:sqlite';
import type { CallLog, CallStatus } from '../types';

interface CreateCallLogData {
  user_id: number;
  event_id?: number;
  tts_text?: string;
}

export class CallLogRepository {
  constructor(private db: Database) {}

  create(data: CreateCallLogData): CallLog {
    const result = this.db
      .prepare('INSERT INTO call_log (user_id, event_id, tts_text) VALUES (?, ?, ?)')
      .run(data.user_id, data.event_id ?? null, data.tts_text ?? null);
    return this.findById(Number(result.lastInsertRowid))!;
  }

  findById(id: number): CallLog | null {
    return (this.db.prepare('SELECT * FROM call_log WHERE id = ?').get(id) as CallLog | null) ?? null;
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

  countTodayCalls(userId: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as cnt FROM call_log WHERE user_id = ? AND created_at >= date('now')")
      .get(userId) as { cnt: number };
    return row.cnt;
  }

  getRecent(userId: number, limit: number): CallLog[] {
    return this.db
      .prepare('SELECT * FROM call_log WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(userId, limit) as CallLog[];
  }
}
