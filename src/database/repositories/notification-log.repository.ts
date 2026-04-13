import type { Database } from 'bun:sqlite';
import type { InsertNotificationLogData, NotificationLogRow } from '../types.ts';

export class NotificationLogRepository {
  constructor(private db: Database) {}

  insert(data: InsertNotificationLogData): number | null {
    try {
      const result = this.db
        .prepare(
          `INSERT INTO notification_log (user_id, type, reference_key, channel, payload)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(data.user_id, data.type, data.reference_key, data.channel, data.payload);
      return Number(result.lastInsertRowid);
    } catch (err) {
      if (String(err).includes('UNIQUE constraint failed')) return null;
      throw err;
    }
  }

  getById(id: number): NotificationLogRow | null {
    return this.db.prepare('SELECT * FROM notification_log WHERE id = ?').get(id) as NotificationLogRow | null;
  }

  markSent(id: number): void {
    this.db
      .prepare(
        `UPDATE notification_log SET status = 'sent', sent_at = datetime('now'), attempts = attempts + 1
         WHERE id = ?`,
      )
      .run(id);
  }

  markFailed(id: number, error: string, attempts: number): void {
    this.db
      .prepare(`UPDATE notification_log SET status = 'failed', error = ?, attempts = ? WHERE id = ?`)
      .run(error, attempts, id);
  }

  updateAttempts(id: number, error: string, attempts: number): void {
    this.db.prepare('UPDATE notification_log SET error = ?, attempts = ? WHERE id = ?').run(error, attempts, id);
  }

  recentByChannel(
    channel: string,
    limit: number,
  ): Pick<NotificationLogRow, 'id' | 'user_id' | 'type' | 'status' | 'created_at' | 'sent_at' | 'error'>[] {
    return this.db
      .prepare(
        `SELECT id, user_id, type, status, created_at, sent_at, error
         FROM notification_log WHERE channel = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(channel, limit) as Pick<
      NotificationLogRow,
      'id' | 'user_id' | 'type' | 'status' | 'created_at' | 'sent_at' | 'error'
    >[];
  }

  getDeliveryStats(userId: number): { total: number; lastError: string | null } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as total,
                (SELECT error FROM notification_log
                 WHERE user_id = ? AND channel = 'mtproto_user' AND error IS NOT NULL
                 ORDER BY created_at DESC LIMIT 1) as last_error
         FROM notification_log WHERE user_id = ? AND channel = 'mtproto_user'`,
      )
      .get(userId, userId) as { total: number; last_error: string | null };
    return { total: row.total, lastError: row.last_error };
  }

  cleanup(olderThanDays: number): number {
    const result = this.db
      .prepare(`DELETE FROM notification_log WHERE created_at < datetime('now', '-' || ? || ' days')`)
      .run(olderThanDays);
    return Number(result.changes);
  }
}
