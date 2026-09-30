import type { Database } from 'bun:sqlite';
import type { NotificationPreferencesRow, NotificationPreferencesUpdate } from '../types.ts';

/** Extra user-level flags returned by morning/evening queries for contextual tips */
export interface UserContextFlags {
  timezone: string;
  language: string;
  /** 1 if user has Google Calendar connected, 0 otherwise */
  has_google: number;
  /** 1 if user has country_code set, 0 otherwise */
  has_country: number;
  /** 1 if user has voice calls enabled, 0 otherwise */
  has_voice_calls: number;
}

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
    const ALLOWED_FIELDS = new Set([
      'morning_agenda_enabled',
      'morning_agenda_time',
      'morning_agenda_format',
      'default_reminder_intervals',
      'evening_review_enabled',
      'evening_review_time',
      'evening_review_format',
      'quiet_hours_enabled',
      'quiet_hours_start',
      'quiet_hours_end',
    ]);
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return;
    const invalid = entries.find(([k]) => !ALLOWED_FIELDS.has(k));
    if (invalid !== undefined) throw new Error(`Unknown notification preference field: ${invalid[0]}`);
    const sets = entries.map(([k]) => `${k} = ?`).join(', ');
    const values = entries.map(([, v]) => v);
    this.db
      .prepare(`UPDATE notification_preferences SET ${sets}, updated_at = datetime('now') WHERE user_id = ?`)
      .run(...values, userId);
  }

  getAllMorningEnabled(): Array<NotificationPreferencesRow & UserContextFlags> {
    return this.getAllEnabledByColumn('morning_agenda_enabled');
  }

  getAllEveningEnabled(): Array<NotificationPreferencesRow & UserContextFlags> {
    return this.getAllEnabledByColumn('evening_review_enabled');
  }

  private getAllEnabledByColumn(
    column: 'morning_agenda_enabled' | 'evening_review_enabled',
  ): Array<NotificationPreferencesRow & UserContextFlags> {
    return this.db
      .prepare(
        `SELECT np.*, u.timezone, u.language,
                (u.google_refresh_token_enc IS NOT NULL) AS has_google,
                (u.country_code IS NOT NULL) AS has_country,
                COALESCE(u.voice_response_enabled, 0) AS has_voice_calls
         FROM notification_preferences np
         JOIN users u ON np.user_id = u.telegram_id
         WHERE np.${column} = 1`,
      )
      .all() as Array<NotificationPreferencesRow & UserContextFlags>;
  }

  getMany(ids: number[]): Map<number, NotificationPreferencesRow> {
    if (ids.length === 0) return new Map();
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM notification_preferences WHERE user_id IN (${placeholders})`)
      .all(...ids) as NotificationPreferencesRow[];
    return new Map(rows.map((r) => [r.user_id, r]));
  }

  getAll(): NotificationPreferencesRow[] {
    return this.db.prepare('SELECT * FROM notification_preferences').all() as NotificationPreferencesRow[];
  }
}
