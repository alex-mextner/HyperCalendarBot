// src/database/repositories/event.repository.ts
import type { Database, SQLQueryBindings } from 'bun:sqlite';
import type { CalendarEvent, CreateEventData, UpdateEventData } from '../types.ts';

export class EventRepository {
  constructor(private db: Database) {}

  create(data: CreateEventData): CalendarEvent {
    const result = this.db
      .prepare(`
      INSERT INTO events (user_id, title, description, category, start_at, end_at, all_day, timezone, location, recurrence_rule, recurrence_end_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        data.user_id,
        data.title,
        data.description ?? null,
        data.category ?? null,
        data.start_at,
        data.end_at ?? null,
        data.all_day ? 1 : 0,
        data.timezone,
        data.location ?? null,
        data.recurrence_rule ?? null,
        data.recurrence_end_at ?? null,
      );
    return this.findById(Number(result.lastInsertRowid), data.user_id)!;
  }

  findById(id: number, userId: number): CalendarEvent | null {
    return this.db
      .prepare('SELECT * FROM events WHERE id = ? AND user_id = ? AND is_cancelled = 0')
      .get(id, userId) as CalendarEvent | null;
  }

  getInRange(userId: number, startUtc: string, endUtc: string): CalendarEvent[] {
    return this.db
      .prepare(`
      SELECT * FROM events
      WHERE user_id = ? AND start_at >= ? AND start_at <= ?
        AND is_cancelled = 0 AND recurrence_rule IS NULL AND parent_event_id IS NULL
      ORDER BY start_at
    `)
      .all(userId, startUtc, endUtc) as CalendarEvent[];
  }

  getRecurringTemplates(userId: number): CalendarEvent[] {
    return this.db
      .prepare(`
      SELECT * FROM events
      WHERE user_id = ? AND recurrence_rule IS NOT NULL AND parent_event_id IS NULL AND is_cancelled = 0
    `)
      .all(userId) as CalendarEvent[];
  }

  getExceptions(parentEventId: number): CalendarEvent[] {
    return this.db.prepare('SELECT * FROM events WHERE parent_event_id = ?').all(parentEventId) as CalendarEvent[];
  }

  update(id: number, userId: number, data: UpdateEventData): CalendarEvent | null {
    const existing = this.findById(id, userId);
    if (!existing) return null;

    const fields: string[] = [];
    const values: SQLQueryBindings[] = [];

    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined) {
        fields.push(`${key} = ?`);
        values.push(key === 'all_day' ? (value ? 1 : 0) : value);
      }
    }

    if (fields.length === 0) return existing;

    fields.push("updated_at = datetime('now')");
    values.push(id, userId);

    this.db.prepare(`UPDATE events SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`).run(...values);

    return this.findById(id, userId)!;
  }

  remove(id: number, userId: number): boolean {
    const result = this.db.prepare('DELETE FROM events WHERE id = ? AND user_id = ?').run(id, userId);
    return result.changes > 0;
  }

  search(userId: number, query: string, limit = 20): CalendarEvent[] {
    return this.db
      .prepare(`
      SELECT * FROM events
      WHERE user_id = ? AND title LIKE ? AND is_cancelled = 0
      ORDER BY start_at ASC
      LIMIT ?
    `)
      .all(userId, `%${query}%`, limit) as CalendarEvent[];
  }

  getUpcoming(userId: number, limit = 10, now?: Date): CalendarEvent[] {
    const nowIso = (now ?? new Date()).toISOString();
    return this.db
      .prepare(`
      SELECT * FROM events
      WHERE user_id = ? AND is_cancelled = 0 AND parent_event_id IS NULL
        AND (start_at > ? OR recurrence_rule IS NOT NULL)
      ORDER BY start_at
      LIMIT ?
    `)
      .all(userId, nowIso, limit) as CalendarEvent[];
  }

  createException(
    parentId: number,
    data: CreateEventData & { original_start_at: string; is_cancelled?: boolean },
  ): CalendarEvent {
    const result = this.db
      .prepare(`
      INSERT INTO events (user_id, title, description, category, start_at, end_at, all_day, timezone, location,
        parent_event_id, original_start_at, is_cancelled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        data.user_id,
        data.title,
        data.description ?? null,
        data.category ?? null,
        data.start_at,
        data.end_at ?? null,
        data.all_day ? 1 : 0,
        data.timezone,
        data.location ?? null,
        parentId,
        data.original_start_at,
        data.is_cancelled ? 1 : 0,
      );
    // Use raw query — findById filters out is_cancelled=1
    return this.db.prepare('SELECT * FROM events WHERE id = ?').get(Number(result.lastInsertRowid)) as CalendarEvent;
  }

  countInRange(userId: number, startUtc: string, endUtc: string): number {
    const row = this.db
      .prepare(`
      SELECT COUNT(*) as count FROM events
      WHERE user_id = ? AND start_at >= ? AND start_at <= ? AND is_cancelled = 0
    `)
      .get(userId, startUtc, endUtc) as { count: number };
    return row.count;
  }
}
