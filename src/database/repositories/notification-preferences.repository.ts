import type { Database } from 'bun:sqlite';

export interface NotificationPreferencesRow {
  user_id: number;
  morning_agenda_enabled: number;
  morning_agenda_time: string;
  morning_agenda_utc: string | null;
  morning_agenda_format: string;
  default_reminder_intervals: string;
  evening_review_enabled: number;
  evening_review_time: string;
  evening_review_utc: string | null;
  evening_review_format: string;
  quiet_hours_enabled: number;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  updated_at: string;
}

export type NotificationPreferencesUpdate = Partial<Omit<NotificationPreferencesRow, 'user_id' | 'updated_at'>>;

export class NotificationPreferencesRepository {
  constructor(private db: Database) {}

  ensureDefaults(userId: number): void {
    this.db.prepare('INSERT OR IGNORE INTO notification_preferences (user_id) VALUES (?)').run(userId);
  }

  get(userId: number): NotificationPreferencesRow | null {
    return this.db
      .prepare('SELECT * FROM notification_preferences WHERE user_id = ?')
      .get(userId) as NotificationPreferencesRow | null;
  }

  update(userId: number, patch: NotificationPreferencesUpdate): void {
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return;
    const sets = entries.map(([k]) => `${k} = ?`).join(', ');
    const values = entries.map(([, v]) => v);
    this.db
      .prepare(`UPDATE notification_preferences SET ${sets}, updated_at = datetime('now') WHERE user_id = ?`)
      .run(...values, userId);
  }

  getAllByMorningUtc(utcHHMM: string): NotificationPreferencesRow[] {
    return this.db
      .prepare(
        `SELECT * FROM notification_preferences
         WHERE morning_agenda_enabled = 1 AND morning_agenda_utc = ?`,
      )
      .all(utcHHMM) as NotificationPreferencesRow[];
  }

  getAllByEveningUtc(utcHHMM: string): NotificationPreferencesRow[] {
    return this.db
      .prepare(
        `SELECT * FROM notification_preferences
         WHERE evening_review_enabled = 1 AND evening_review_utc = ?`,
      )
      .all(utcHHMM) as NotificationPreferencesRow[];
  }

  getAllMorningEnabled(): Array<NotificationPreferencesRow & { timezone: string; language: string }> {
    return this.db
      .prepare(
        `SELECT np.*, u.timezone, u.language
         FROM notification_preferences np
         JOIN users u ON np.user_id = u.telegram_id
         WHERE np.morning_agenda_enabled = 1`,
      )
      .all() as Array<NotificationPreferencesRow & { timezone: string; language: string }>;
  }

  getAllEveningEnabled(): Array<NotificationPreferencesRow & { timezone: string; language: string }> {
    return this.db
      .prepare(
        `SELECT np.*, u.timezone, u.language
         FROM notification_preferences np
         JOIN users u ON np.user_id = u.telegram_id
         WHERE np.evening_review_enabled = 1`,
      )
      .all() as Array<NotificationPreferencesRow & { timezone: string; language: string }>;
  }

  getAll(): NotificationPreferencesRow[] {
    return this.db.prepare('SELECT * FROM notification_preferences').all() as NotificationPreferencesRow[];
  }
}
