import type { Database } from 'bun:sqlite';
import type { DueReminderRow, EventReminderRow, InsertEventReminderData } from '../types.ts';

export class EventReminderRepository {
  constructor(private db: Database) {}

  insert(data: InsertEventReminderData): void {
    this.db
      .prepare(
        `INSERT INTO event_reminders (event_id, user_id, remind_at_utc, interval_minutes, interval_label)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(data.event_id, data.user_id, data.remind_at_utc, data.interval_minutes, data.interval_label);
  }

  getDue(windowStart: string, windowEnd: string): DueReminderRow[] {
    return this.db
      .prepare(
        `SELECT er.*, e.title AS event_title, e.start_at AS event_start_at, e.end_at AS event_end_at, e.location AS event_location
         FROM event_reminders er
         JOIN events e ON e.id = er.event_id
         WHERE er.remind_at_utc >= ? AND er.remind_at_utc < ? AND er.sent = 0`,
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
}
