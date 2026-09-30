// src/database/repositories/call-settings.repository.ts
import type { Database } from 'bun:sqlite';
import type { UserCallSettings } from '../types';

export class CallSettingsRepository {
  constructor(private db: Database) {}

  get(userId: number): UserCallSettings | null {
    return (
      (this.db.prepare('SELECT * FROM user_call_settings WHERE user_id = ?').get(userId) as UserCallSettings | null) ??
      null
    );
  }

  ensureDefaults(userId: number): void {
    this.db.prepare('INSERT OR IGNORE INTO user_call_settings (user_id) VALUES (?)').run(userId);
  }

  setEnabled(userId: number, enabled: boolean): void {
    this.db
      .prepare("UPDATE user_call_settings SET enabled = ?, updated_at = datetime('now') WHERE user_id = ?")
      .run(enabled ? 1 : 0, userId);
  }

  setQuietHours(userId: number, start: string | null, end: string | null): void {
    this.db
      .prepare(
        "UPDATE user_call_settings SET quiet_hours_start = ?, quiet_hours_end = ?, updated_at = datetime('now') WHERE user_id = ?",
      )
      .run(start, end, userId);
  }

  setLanguage(userId: number, language: string): void {
    this.db
      .prepare("UPDATE user_call_settings SET language = ?, updated_at = datetime('now') WHERE user_id = ?")
      .run(language, userId);
  }

  isEnabled(userId: number): boolean {
    const row = this.db.prepare('SELECT enabled FROM user_call_settings WHERE user_id = ?').get(userId) as {
      enabled: number;
    } | null;
    return row?.enabled === 1;
  }
}
