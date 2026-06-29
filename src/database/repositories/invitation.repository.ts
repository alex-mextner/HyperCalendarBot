import type { Database } from 'bun:sqlite';
import type { CreateInvitationData, Invitation, InvitationStatus } from '../types.ts';

export class InvitationRepository {
  constructor(private db: Database) {}

  create(data: CreateInvitationData): Invitation {
    const result = this.db
      .prepare(
        `INSERT INTO invitations (event_id, inviter_id, invitee_id, message_id, chat_id, deep_link_code, invitee_username)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        data.event_id,
        data.inviter_id,
        data.invitee_id,
        data.message_id ?? null,
        data.chat_id ?? null,
        data.deep_link_code ?? null,
        data.invitee_username ?? null,
      );
    return this.findById(Number(result.lastInsertRowid))!;
  }

  findById(id: number): Invitation | null {
    return (this.db.prepare('SELECT * FROM invitations WHERE id = ?').get(id) as Invitation | null) ?? null;
  }

  updateStatus(id: number, newStatus: InvitationStatus, expectedCurrent: InvitationStatus): boolean {
    const result = this.db
      .prepare(
        `UPDATE invitations
         SET status = ?, updated_at = datetime('now'), responded_at = datetime('now')
         WHERE id = ? AND status = ?`,
      )
      .run(newStatus, id, expectedCurrent);
    return result.changes > 0;
  }

  findActiveByEventAndInvitee(eventId: number, inviteeId: number): Invitation | null {
    return (
      (this.db
        .prepare(
          `SELECT * FROM invitations
           WHERE event_id = ? AND invitee_id = ? AND status IN ('pending', 'maybe', 'accepted')
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(eventId, inviteeId) as Invitation | null) ?? null
    );
  }

  /**
   * Returns the most recent personal invitation for this invitee and event, if it authorizes access.
   * Fetches the single latest row regardless of status, then rejects if it is cancelled or expired —
   * a newer cancellation supersedes any older responded row (declined, accepted, etc.).
   * Returns null when no invitation exists or when the latest row is cancelled/expired.
   */
  findActiveOrRespondedByEventAndInvitee(eventId: number, inviteeId: number): Invitation | null {
    const latest = this.db
      .prepare(
        `SELECT * FROM invitations
         WHERE event_id = ? AND invitee_id = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(eventId, inviteeId) as Invitation | null;
    if (!latest || latest.status === 'cancelled' || latest.status === 'expired') {
      return null;
    }
    return latest;
  }

  countDeclined(eventId: number, inviteeId: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as cnt FROM invitations WHERE event_id = ? AND invitee_id = ? AND status = 'declined'")
      .get(eventId, inviteeId) as { cnt: number };
    return row.cnt;
  }

  getByInvitee(inviteeId: number): Invitation[] {
    return this.db
      .prepare('SELECT * FROM invitations WHERE invitee_id = ? ORDER BY created_at DESC')
      .all(inviteeId) as Invitation[];
  }

  getByInviter(inviterId: number): Invitation[] {
    return this.db
      .prepare('SELECT * FROM invitations WHERE inviter_id = ? ORDER BY created_at DESC')
      .all(inviterId) as Invitation[];
  }

  getPendingForEvent(eventId: number): Invitation[] {
    return this.db
      .prepare("SELECT * FROM invitations WHERE event_id = ? AND status IN ('pending', 'maybe')")
      .all(eventId) as Invitation[];
  }

  expirePastInvitations(): number {
    const result = this.db
      .prepare(
        `UPDATE invitations SET status = 'expired', updated_at = datetime('now')
         WHERE status IN ('pending', 'maybe')
         AND event_id IN (SELECT id FROM events WHERE start_at < datetime('now') AND is_deleted = 0)`,
      )
      .run();
    return result.changes;
  }

  cancelForEvent(eventId: number): number {
    const result = this.db
      .prepare(
        `UPDATE invitations SET status = 'cancelled', updated_at = datetime('now')
         WHERE event_id = ? AND status IN ('pending', 'maybe')`,
      )
      .run(eventId);
    return result.changes;
  }

  getAcceptedForEvent(eventId: number): Invitation[] {
    return this.db
      .prepare("SELECT * FROM invitations WHERE event_id = ? AND status = 'accepted'")
      .all(eventId) as Invitation[];
  }

  getByEvent(eventId: number): Invitation[] {
    return this.db.prepare('SELECT * FROM invitations WHERE event_id = ? ORDER BY id').all(eventId) as Invitation[];
  }

  setMessageInfo(id: number, messageId: number, chatId: number): void {
    this.db.prepare('UPDATE invitations SET message_id = ?, chat_id = ? WHERE id = ?').run(messageId, chatId, id);
  }

  setProposedTime(id: number, proposedTime: string): void {
    this.db
      .prepare("UPDATE invitations SET proposed_time = ?, updated_at = datetime('now') WHERE id = ?")
      .run(proposedTime, id);
  }

  clearProposedTime(id: number): void {
    this.db.prepare("UPDATE invitations SET proposed_time = NULL, updated_at = datetime('now') WHERE id = ?").run(id);
  }

  clearProposedTimeAndAccept(id: number, expectedStatus: string): boolean {
    const result = this.db.transaction(() => {
      this.db.prepare("UPDATE invitations SET proposed_time = NULL, updated_at = datetime('now') WHERE id = ?").run(id);
      return this.db
        .prepare("UPDATE invitations SET status = 'accepted', updated_at = datetime('now') WHERE id = ? AND status = ?")
        .run(id, expectedStatus);
    })();
    return result.changes > 0;
  }
}
