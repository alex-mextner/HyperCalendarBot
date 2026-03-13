// src/database/repositories/google-sync.repository.ts
import type { Database } from 'bun:sqlite';
import type { GoogleSyncState, SyncLogEntry } from '../types.ts';

interface LogSyncData {
  user_id: number;
  event_id?: number;
  google_event_id?: string;
  direction: 'push' | 'pull';
  action: 'create' | 'update' | 'delete' | 'conflict_resolve';
  details?: string;
}

export class GoogleSyncRepository {
  constructor(private db: Database) {}

  getSyncState(userId: number): GoogleSyncState | null {
    return this.db.prepare('SELECT * FROM google_sync_state WHERE user_id = ?').get(userId) as GoogleSyncState | null;
  }

  upsertSyncState(userId: number, scopes: string): void {
    this.db
      .prepare(`
      INSERT INTO google_sync_state (user_id, scopes)
      VALUES (?, ?)
      ON CONFLICT (user_id) DO UPDATE SET
        status = 'active',
        scopes = excluded.scopes,
        updated_at = datetime('now')
    `)
      .run(userId, scopes);
  }

  updateAccessToken(userId: number, accessToken: string, expiresAt: string): void {
    this.db
      .prepare(`
      UPDATE google_sync_state
      SET access_token = ?, expires_at = ?, updated_at = datetime('now')
      WHERE user_id = ?
    `)
      .run(accessToken, expiresAt, userId);
  }

  markRevoked(userId: number): void {
    this.db
      .prepare(`
      UPDATE google_sync_state SET status = 'revoked', updated_at = datetime('now')
      WHERE user_id = ?
    `)
      .run(userId);
  }

  deleteSyncState(userId: number): void {
    this.db.prepare('DELETE FROM google_sync_state WHERE user_id = ?').run(userId);
  }

  getActiveUsers(): number[] {
    const rows = this.db.prepare("SELECT user_id FROM google_sync_state WHERE status = 'active'").all() as {
      user_id: number;
    }[];
    return rows.map((r) => r.user_id);
  }

  logSync(data: LogSyncData): void {
    this.db
      .prepare(`
      INSERT INTO sync_log (user_id, event_id, google_event_id, direction, action, details)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
      .run(
        data.user_id,
        data.event_id ?? null,
        data.google_event_id ?? null,
        data.direction,
        data.action,
        data.details ?? null,
      );
  }

  getRecentLogs(userId: number, limit: number): SyncLogEntry[] {
    return this.db
      .prepare('SELECT * FROM sync_log WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(userId, limit) as SyncLogEntry[];
  }

  pruneOldLogs(daysOld: number): void {
    this.db.prepare(`DELETE FROM sync_log WHERE created_at < datetime('now', '-' || ? || ' days')`).run(daysOld);
  }
}
