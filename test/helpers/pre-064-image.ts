// What an image from before migration 064 writes to event_participants, for tests of a rollback onto
// it: the exact statements its ParticipantRepository ran. They name no origin column.
import type { Database } from 'bun:sqlite';
import type { ParticipantStatus } from '../../src/database/types.ts';

/** ParticipantRepository.add of the pre-064 image */
export function addAsPre064Image(db: Database, eventId: number, userId: number, status: ParticipantStatus): void {
  db.prepare('INSERT INTO event_participants (event_id, user_id, status, role) VALUES (?, ?, ?, ?)').run(
    eventId,
    userId,
    status,
    'attendee',
  );
}

/** ParticipantRepository.updateStatus of the pre-064 image: an answer through any card, group or personal */
export function answerAsPre064Image(db: Database, eventId: number, userId: number, status: ParticipantStatus): void {
  db.prepare(
    "UPDATE event_participants SET status = ?, updated_at = datetime('now') WHERE event_id = ? AND user_id = ?",
  ).run(status, eventId, userId);
}

/**
 * Moves every timestamp of the event's answers an hour back, as if they were given before a release
 * switch. datetime('now') has one-second resolution, so without it a test's later write could land in
 * the same second as the earlier one, which no real rollback does.
 */
export function ageAnswers(db: Database, eventId: number): void {
  const columns = db
    .query<{ name: string }, []>('PRAGMA table_info(event_participants)')
    .all()
    .map((column) => column.name)
    .filter((name) => name.endsWith('_at'));
  const assignments = columns.map((name) => `${name} = datetime(${name}, '-1 hour')`).join(', ');
  db.prepare(`UPDATE event_participants SET ${assignments} WHERE event_id = ?`).run(eventId);
}
