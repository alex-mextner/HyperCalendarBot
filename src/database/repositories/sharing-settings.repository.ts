import type { Database } from 'bun:sqlite';
import type { SharingSettings, Visibility } from '../types.ts';

export class SharingSettingsRepository {
  private static ALLOWED_COLUMNS = new Set([
    'default_visibility',
    'inline_mode_enabled',
    'allow_invitations',
    'share_location',
    'share_description',
  ]);

  constructor(private db: Database) {}

  ensureDefaults(userId: number): void {
    this.db.prepare('INSERT OR IGNORE INTO sharing_settings (user_id) VALUES (?)').run(userId);
  }

  get(userId: number): SharingSettings | null {
    return (
      (this.db.prepare('SELECT * FROM sharing_settings WHERE user_id = ?').get(userId) as SharingSettings | null) ??
      null
    );
  }

  update(userId: number, patch: Partial<Omit<SharingSettings, 'user_id' | 'updated_at'>>): void {
    const entries = Object.entries(patch).filter(
      ([k, v]) => v !== undefined && SharingSettingsRepository.ALLOWED_COLUMNS.has(k),
    );
    if (entries.length === 0) return;
    const sets = entries.map(([k]) => `${k} = ?`).join(', ');
    const values = entries.map(([, v]) => v);
    this.db
      .prepare(`UPDATE sharing_settings SET ${sets}, updated_at = datetime('now') WHERE user_id = ?`)
      .run(...values, userId);
  }

  getEventVisibility(eventId: number): Visibility | null {
    const row = this.db.prepare('SELECT visibility FROM event_visibility WHERE event_id = ?').get(eventId) as {
      visibility: Visibility;
    } | null;
    return row?.visibility ?? null;
  }

  setEventVisibility(eventId: number, visibility: Visibility): void {
    this.db
      .prepare(
        `INSERT INTO event_visibility (event_id, visibility)
         VALUES (?, ?)
         ON CONFLICT (event_id) DO UPDATE SET
           visibility = excluded.visibility,
           updated_at = datetime('now')`,
      )
      .run(eventId, visibility);
  }

  removeEventVisibility(eventId: number): void {
    this.db.prepare('DELETE FROM event_visibility WHERE event_id = ?').run(eventId);
  }
}
