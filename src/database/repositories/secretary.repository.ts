import type { Database } from 'bun:sqlite';
import type { CalendarSecretary, CreateSecretaryData, SecretaryStatus } from '../types.ts';

export class SecretaryRepository {
  constructor(private db: Database) {}

  upsert(data: CreateSecretaryData): CalendarSecretary {
    // Reuse pending record created less than 7 days ago
    const pending = this.db
      .prepare(
        `SELECT * FROM calendar_secretaries
         WHERE owner_id = ? AND secretary_id = ?
         AND status = 'pending'
         AND created_at > datetime('now', '-7 days')`,
      )
      .get(data.owner_id, data.secretary_id) as CalendarSecretary | null;
    if (pending) return pending;

    // Never demote an active record
    const active = this.db
      .prepare(`SELECT * FROM calendar_secretaries WHERE owner_id = ? AND secretary_id = ? AND status = 'active'`)
      .get(data.owner_id, data.secretary_id) as CalendarSecretary | null;
    if (active) return active;

    // Insert new pending row; reset revoked/expired/declined conflict to pending
    this.db
      .prepare(
        `INSERT INTO calendar_secretaries (owner_id, secretary_id, permission, status, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', datetime('now'), datetime('now'))
         ON CONFLICT(owner_id, secretary_id) DO UPDATE SET
           permission = excluded.permission,
           status = 'pending',
           created_at = datetime('now'),
           updated_at = datetime('now')`,
      )
      .run(data.owner_id, data.secretary_id, data.permission);
    return this.findByOwnerAndSecretary(data.owner_id, data.secretary_id)!;
  }

  findById(id: number): CalendarSecretary | null {
    return (
      (this.db.prepare('SELECT * FROM calendar_secretaries WHERE id = ?').get(id) as CalendarSecretary | null) ?? null
    );
  }

  findByOwnerAndSecretary(ownerId: number, secretaryId: number): CalendarSecretary | null {
    return (
      (this.db
        .prepare('SELECT * FROM calendar_secretaries WHERE owner_id = ? AND secretary_id = ?')
        .get(ownerId, secretaryId) as CalendarSecretary | null) ?? null
    );
  }

  updateStatus(id: number, status: SecretaryStatus): boolean {
    const result = this.db
      .prepare(`UPDATE calendar_secretaries SET status = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(status, id);
    return result.changes > 0;
  }

  setDmMessageId(id: number, messageId: number): void {
    this.db.prepare('UPDATE calendar_secretaries SET dm_message_id = ? WHERE id = ?').run(messageId, id);
  }

  /** Active secretary relationships where secretaryId is the secretary */
  getActiveSecretaryFor(secretaryId: number): CalendarSecretary[] {
    return this.db
      .prepare(`SELECT * FROM calendar_secretaries WHERE secretary_id = ? AND status = 'active'`)
      .all(secretaryId) as CalendarSecretary[];
  }

  /** All non-revoked/expired records where ownerId is the owner */
  getSecretariesForOwner(ownerId: number): CalendarSecretary[] {
    return this.db
      .prepare(`SELECT * FROM calendar_secretaries WHERE owner_id = ? AND status NOT IN ('revoked', 'expired')`)
      .all(ownerId) as CalendarSecretary[];
  }

  countActive(ownerId: number): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as cnt FROM calendar_secretaries WHERE owner_id = ? AND status = 'active'`)
      .get(ownerId) as { cnt: number };
    return row.cnt;
  }

  expirePending(): CalendarSecretary[] {
    return this.db.transaction(() => {
      const toExpire = this.getPendingExpired();
      if (toExpire.length > 0) {
        this.db
          .prepare(
            `UPDATE calendar_secretaries SET status = 'expired', updated_at = datetime('now')
             WHERE status = 'pending' AND created_at < datetime('now', '-7 days')`,
          )
          .run();
      }
      return toExpire;
    })();
  }

  getPendingExpired(): CalendarSecretary[] {
    return this.db
      .prepare(
        `SELECT * FROM calendar_secretaries WHERE status = 'pending' AND created_at < datetime('now', '-7 days')`,
      )
      .all() as CalendarSecretary[];
  }
}
