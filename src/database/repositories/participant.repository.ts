import type { Database } from 'bun:sqlite';
import type { EventParticipant, ParticipantRole, ParticipantStatus } from '../types.ts';

/**
 * The group chat whose card carried the answer, as SQL over an event_participants alias. A recorded
 * origin counts only while updated_at still equals the stamp written with it: a writer that does not
 * know these columns (the image before migration 064, after a rollback) moves updated_at and so voids
 * it, and its answer is never attributed to the group recorded before it. Every write below that
 * records or keeps an origin sets both from datetime('now') in one statement; SQLite returns the same
 * 'now' to every call within one statement step.
 */
export function sourceGroupSql(alias: 'event_participants' | 'p'): string {
  return `CASE WHEN ${alias}.source_group_recorded_at = ${alias}.updated_at THEN ${alias}.source_group_id END`;
}

const PARTICIPANT_COLUMNS = `id, event_id, user_id, status, role,
  ${sourceGroupSql('event_participants')} AS source_group_id, created_at, updated_at`;

export class ParticipantRepository {
  constructor(private db: Database) {}

  /** `sourceGroupId`: the group chat whose invitation card carried the answer; null for a personal one. */
  add(
    eventId: number,
    userId: number,
    status: ParticipantStatus,
    role: ParticipantRole = 'attendee',
    sourceGroupId: number | null = null,
  ): EventParticipant {
    this.db
      .prepare(
        `INSERT INTO event_participants (event_id, user_id, status, role, source_group_id, source_group_recorded_at, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      )
      .run(eventId, userId, status, role, sourceGroupId);
    return this.findByEventAndUser(eventId, userId)!;
  }

  findByEventAndUser(eventId: number, userId: number): EventParticipant | null {
    return (
      (this.db
        .prepare(`SELECT ${PARTICIPANT_COLUMNS} FROM event_participants WHERE event_id = ? AND user_id = ?`)
        .get(eventId, userId) as EventParticipant | null) ?? null
    );
  }

  getByEvent(eventId: number): EventParticipant[] {
    return this.db
      .prepare(`SELECT ${PARTICIPANT_COLUMNS} FROM event_participants WHERE event_id = ?`)
      .all(eventId) as EventParticipant[];
  }

  getAcceptedEventIds(userId: number): number[] {
    const rows = this.db
      .prepare("SELECT event_id FROM event_participants WHERE user_id = ? AND status = 'accepted'")
      .all(userId) as { event_id: number }[];
    return rows.map((r) => r.event_id);
  }

  /** Omitting `sourceGroupId` keeps the recorded origin; passing it (null = personal) records a new answer's origin. */
  updateStatus(eventId: number, userId: number, status: ParticipantStatus, sourceGroupId?: number | null): void {
    if (sourceGroupId === undefined) {
      // SET reads the row as it was: a valid origin is re-stamped with the new updated_at, a voided one stays void.
      this.db
        .prepare(
          `UPDATE event_participants SET status = ?,
             source_group_recorded_at = CASE WHEN source_group_recorded_at = updated_at THEN datetime('now') END,
             updated_at = datetime('now')
           WHERE event_id = ? AND user_id = ?`,
        )
        .run(status, eventId, userId);
      return;
    }
    this.db
      .prepare(
        `UPDATE event_participants SET status = ?, source_group_id = ?, source_group_recorded_at = datetime('now'),
           updated_at = datetime('now')
         WHERE event_id = ? AND user_id = ?`,
      )
      .run(status, sourceGroupId, eventId, userId);
  }

  delete(eventId: number, userId: number): void {
    this.db.prepare('DELETE FROM event_participants WHERE event_id = ? AND user_id = ?').run(eventId, userId);
  }
}
