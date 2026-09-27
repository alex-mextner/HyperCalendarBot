import type { Database } from 'bun:sqlite';
import type { EventParticipant, ParticipantRole, ParticipantStatus } from '../types.ts';

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
        'INSERT INTO event_participants (event_id, user_id, status, role, source_group_id) VALUES (?, ?, ?, ?, ?)',
      )
      .run(eventId, userId, status, role, sourceGroupId);
    return this.findByEventAndUser(eventId, userId)!;
  }

  findByEventAndUser(eventId: number, userId: number): EventParticipant | null {
    return (
      (this.db
        .prepare('SELECT * FROM event_participants WHERE event_id = ? AND user_id = ?')
        .get(eventId, userId) as EventParticipant | null) ?? null
    );
  }

  getByEvent(eventId: number): EventParticipant[] {
    return this.db.prepare('SELECT * FROM event_participants WHERE event_id = ?').all(eventId) as EventParticipant[];
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
      this.db
        .prepare(
          "UPDATE event_participants SET status = ?, updated_at = datetime('now') WHERE event_id = ? AND user_id = ?",
        )
        .run(status, eventId, userId);
      return;
    }
    this.db
      .prepare(
        "UPDATE event_participants SET status = ?, source_group_id = ?, updated_at = datetime('now') WHERE event_id = ? AND user_id = ?",
      )
      .run(status, sourceGroupId, eventId, userId);
  }

  delete(eventId: number, userId: number): void {
    this.db.prepare('DELETE FROM event_participants WHERE event_id = ? AND user_id = ?').run(eventId, userId);
  }
}
