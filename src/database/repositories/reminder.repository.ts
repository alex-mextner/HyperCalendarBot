// src/database/repositories/reminder.repository.ts
import type { Database } from 'bun:sqlite';
import type { Reminder } from '../types.ts';

export class ReminderRepository {
  constructor(private db: Database) {}

  create(eventId: number, minutesBefore: number): Reminder {
    const result = this.db
      .prepare('INSERT INTO reminders (event_id, minutes_before) VALUES (?, ?)')
      .run(eventId, minutesBefore);
    return this.db.prepare('SELECT * FROM reminders WHERE id = ?').get(Number(result.lastInsertRowid)) as Reminder;
  }

  getByEventId(eventId: number): Reminder[] {
    return this.db
      .prepare('SELECT * FROM reminders WHERE event_id = ? ORDER BY minutes_before')
      .all(eventId) as Reminder[];
  }

  removeByEventId(eventId: number): void {
    this.db.prepare('DELETE FROM reminders WHERE event_id = ?').run(eventId);
  }

  setForEvent(eventId: number, minutesBefore: number[]): Reminder[] {
    this.db.transaction(() => {
      this.removeByEventId(eventId);
      for (const mins of minutesBefore) {
        this.create(eventId, mins);
      }
    })();
    return this.getByEventId(eventId);
  }
}
