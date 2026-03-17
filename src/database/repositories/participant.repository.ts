import type { Database } from 'bun:sqlite';
import type { EventParticipant, ParticipantRole, ParticipantStatus } from '../types.ts';

export class ParticipantRepository {
  constructor(private db: Database) {}

  add(
    eventId: number,
    userId: number,
    status: ParticipantStatus,
    role: ParticipantRole = 'attendee',
  ): EventParticipant {
    this.db
      .prepare('INSERT INTO event_participants (event_id, user_id, status, role) VALUES (?, ?, ?, ?)')
      .run(eventId, userId, status, role);
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

  updateStatus(eventId: number, userId: number, status: ParticipantStatus): void {
    this.db
      .prepare(
        "UPDATE event_participants SET status = ?, updated_at = datetime('now') WHERE event_id = ? AND user_id = ?",
      )
      .run(status, eventId, userId);
  }

  delete(eventId: number, userId: number): void {
    this.db.prepare('DELETE FROM event_participants WHERE event_id = ? AND user_id = ?').run(eventId, userId);
  }
}
