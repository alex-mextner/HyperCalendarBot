import type { Database } from 'bun:sqlite';
import type { DueReminderRow, EventReminderRow, InsertEventReminderData } from '../types.ts';

export class EventReminderRepository {
  constructor(private db: Database) {}

  insert(data: InsertEventReminderData): void {
    this.db
      .prepare(
        `INSERT INTO event_reminders (event_id, user_id, remind_at_utc, interval_minutes, interval_label, occurrence_start, occurrence_end)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        data.event_id,
        data.user_id,
        data.remind_at_utc,
        data.interval_minutes,
        data.interval_label,
        data.occurrence_start ?? null,
        data.occurrence_end ?? null,
      );
  }

  getDue(windowStart: string, windowEnd: string): DueReminderRow[] {
    return this.db
      .prepare(
        `SELECT er.*,
                e.title AS event_title,
                COALESCE(er.occurrence_start, e.start_at) AS event_start_at,
                COALESCE(er.occurrence_end, e.end_at) AS event_end_at,
                e.location AS event_location,
                e.resolved_address AS event_resolved_address,
                e.google_maps_url AS event_google_maps_url,
                e.venue_name AS event_venue_name
         FROM event_reminders er
         JOIN events e ON e.id = er.event_id
         WHERE er.remind_at_utc >= ? AND er.remind_at_utc < ? AND er.sent = 0
           AND e.is_deleted = 0 AND e.is_cancelled = 0`,
      )
      .all(windowStart, windowEnd) as DueReminderRow[];
  }

  markSent(id: number): void {
    this.db.prepare('UPDATE event_reminders SET sent = 1 WHERE id = ?').run(id);
  }

  getForEvent(eventId: number): EventReminderRow[] {
    return this.db.prepare('SELECT * FROM event_reminders WHERE event_id = ?').all(eventId) as EventReminderRow[];
  }

  deleteForEvent(eventId: number): void {
    this.db.prepare('DELETE FROM event_reminders WHERE event_id = ?').run(eventId);
  }

  deleteUnsentForUser(userId: number): void {
    this.db.prepare('DELETE FROM event_reminders WHERE user_id = ? AND sent = 0').run(userId);
  }

  existsForEventAt(eventId: number, remindAtUtc: string): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM event_reminders WHERE event_id = ? AND remind_at_utc = ?')
      .get(eventId, remindAtUtc);
    return row != null;
  }

  deleteUnsentForEvent(eventId: number): void {
    this.db.prepare('DELETE FROM event_reminders WHERE event_id = ? AND sent = 0').run(eventId);
  }

  getLastSentForEvent(eventId: number, userId: number): EventReminderRow | null {
    return (
      (this.db
        .prepare(
          'SELECT * FROM event_reminders WHERE event_id = ? AND user_id = ? AND sent = 1 ORDER BY id DESC LIMIT 1',
        )
        .get(eventId, userId) as EventReminderRow | undefined) ?? null
    );
  }
}
