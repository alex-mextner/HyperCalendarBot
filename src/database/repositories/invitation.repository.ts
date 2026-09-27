import type { Database } from 'bun:sqlite';
import type { CreateInvitationData, Invitation, InvitationStatus, ParticipantStatus } from '../types.ts';

/** One person on an event's invitation roster, as stored: the answer rules are applied by the reader. */
export interface InvitationRosterRow {
  source: 'organizer' | 'invitation' | 'participant';
  /** Telegram id; a group invitation carries the (negative) group chat id */
  user_id: number;
  /** Latest invitation status or participant status; null for the organizer */
  status: InvitationStatus | ParticipantStatus | null;
  first_name: string | null;
  username: string | null;
  /** The organizer's own address-book name for this person */
  contact_name: string | null;
}

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

  /** Any status change settles the invitee's pending time proposal, so it also clears proposed_time. */
  updateStatus(id: number, newStatus: InvitationStatus, expectedCurrent: InvitationStatus): boolean {
    const result = this.db
      .prepare(
        `UPDATE invitations
         SET status = ?, proposed_time = NULL, updated_at = datetime('now'), responded_at = datetime('now')
         WHERE id = ? AND status = ?`,
      )
      .run(newStatus, id, expectedCurrent);
    return result.changes > 0;
  }

  // Latest-row lookups order by the AUTOINCREMENT id, not created_at: datetime('now') has
  // one-second resolution and follows the wall clock, which can step backwards.
  findActiveByEventAndInvitee(eventId: number, inviteeId: number): Invitation | null {
    return (
      (this.db
        .prepare(
          `SELECT * FROM invitations
           WHERE event_id = ? AND invitee_id = ? AND status IN ('pending', 'maybe', 'accepted')
           ORDER BY id DESC LIMIT 1`,
        )
        .get(eventId, inviteeId) as Invitation | null) ?? null
    );
  }

  /**
   * Returns the most recently inserted personal invitation for this invitee and event, if it
   * authorizes access. Fetches the single highest-id row regardless of status (created_at can run
   * backwards with the wall clock), then rejects if it is cancelled or expired —
   * a newer cancellation supersedes any older responded row (declined, accepted, etc.).
   * Returns null when no invitation exists or when the latest row is cancelled/expired.
   */
  findActiveOrRespondedByEventAndInvitee(eventId: number, inviteeId: number): Invitation | null {
    const latest = this.db
      .prepare(
        `SELECT * FROM invitations
         WHERE event_id = ? AND invitee_id = ?
         ORDER BY id DESC LIMIT 1`,
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

  getByEvent(eventId: number): Invitation[] {
    return this.db.prepare('SELECT * FROM invitations WHERE event_id = ? ORDER BY id').all(eventId) as Invitation[];
  }

  /**
   * Everyone an invitation card can list, in one read: the event owner, the latest invitation per
   * invitee (group invitations included), and the per-member answers in event_participants.
   */
  getRoster(eventId: number): InvitationRosterRow[] {
    return this.db
      .query<InvitationRosterRow, [number]>(`
        WITH latest AS (
          SELECT i.*, ROW_NUMBER() OVER (PARTITION BY i.invitee_id ORDER BY i.created_at DESC, i.id DESC) AS recipient_rank
          FROM invitations i WHERE i.event_id = ?1
        )
        SELECT source, user_id, status, first_name, username, contact_name FROM (
          SELECT 'organizer' AS source, 0 AS position, e.user_id, NULL AS status, u.first_name, u.username,
            NULL AS contact_name
          FROM events e LEFT JOIN users u ON u.telegram_id = e.user_id WHERE e.id = ?1
          UNION ALL
          SELECT 'invitation', l.id, l.invitee_id, l.status, u.first_name,
            COALESCE(u.username, l.invitee_username),
            (SELECT c.name FROM contacts c WHERE c.user_id = l.inviter_id AND c.telegram_id = l.invitee_id
              ORDER BY c.id LIMIT 1)
          FROM latest l LEFT JOIN users u ON u.telegram_id = l.invitee_id WHERE l.recipient_rank = 1
          UNION ALL
          SELECT 'participant', p.id, p.user_id, p.status, u.first_name, u.username,
            (SELECT c.name FROM contacts c WHERE c.user_id = e.user_id AND c.telegram_id = p.user_id
              ORDER BY c.id LIMIT 1)
          FROM event_participants p JOIN events e ON e.id = p.event_id
          LEFT JOIN users u ON u.telegram_id = p.user_id
          WHERE p.event_id = ?1 AND p.role != 'organizer'
        )
        ORDER BY CASE source WHEN 'organizer' THEN 0 WHEN 'invitation' THEN 1 ELSE 2 END, position
      `)
      .all(eventId);
  }

  setMessageInfo(id: number, messageId: number, chatId: number): void {
    this.db.prepare('UPDATE invitations SET message_id = ?, chat_id = ? WHERE id = ?').run(messageId, chatId, id);
  }

  setProposedTime(id: number, proposedTime: string): void {
    this.db
      .prepare("UPDATE invitations SET proposed_time = ?, updated_at = datetime('now') WHERE id = ?")
      .run(proposedTime, id);
  }

  /** Drops the proposed time while that exact proposal is still open; false once the invitee answered or changed it. */
  clearProposedTime(id: number, expectedProposedTime: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE invitations SET proposed_time = NULL, updated_at = datetime('now')
         WHERE id = ? AND status = 'pending' AND proposed_time = ?`,
      )
      .run(id, expectedProposedTime);
    return result.changes > 0;
  }

  /**
   * Accepts the invitation at its proposed time, only while that exact proposal is still open: the
   * invitation is pending and still carries it. Returns false once the invitee has answered or changed it.
   */
  clearProposedTimeAndAccept(id: number, expectedProposedTime: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE invitations SET status = 'accepted', proposed_time = NULL, updated_at = datetime('now')
         WHERE id = ? AND status = 'pending' AND proposed_time = ?`,
      )
      .run(id, expectedProposedTime);
    return result.changes > 0;
  }
}
