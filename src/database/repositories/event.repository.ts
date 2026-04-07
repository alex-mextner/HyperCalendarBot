// src/database/repositories/event.repository.ts
import type { Database, SQLQueryBindings } from 'bun:sqlite';
import type { CalendarEvent, CreateEventData, UpdateEventData } from '../types.ts';

// SQL fragment: group event visible to user if they are an active member
// and the event starts on or after the day they joined. For one-off events.
// Expects 1 bind param (userId).
function groupVisibleSql(alias: string): string {
  const col = alias ? `${alias}.` : '';
  return `(${col}owner_type = 'group' AND EXISTS (
    SELECT 1 FROM group_members gm
    WHERE gm.chat_id = ${col}group_id AND gm.user_id = ?
      AND gm.left_at IS NULL
      AND ${col}start_at >= gm.joined_at
  ))`;
}

// SQL fragment: group recurring template visible to a member (active or left).
// Returns templates for any group where user has a membership record.
// The service layer clips occurrences to [joined_at, left_at] window.
function groupMemberAnySql(alias: string): string {
  const col = alias ? `${alias}.` : '';
  return `(${col}owner_type = 'group' AND EXISTS (
    SELECT 1 FROM group_members gm
    WHERE gm.chat_id = ${col}group_id AND gm.user_id = ?
  ))`;
}

export class EventRepository {
  constructor(private db: Database) {}

  create(data: CreateEventData): CalendarEvent {
    const result = this.db
      .prepare(`
      INSERT INTO events (user_id, title, description, category, start_at, end_at, all_day, timezone, location, recurrence_rule, recurrence_end_at, owner_type, group_id, created_by, event_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        data.owner_type ?? 'user',
        data.group_id ?? null,
        data.created_by ?? null,
        data.event_type ?? null,
      );
    const id = Number(result.lastInsertRowid);
    if (data.owner_type === 'group' && data.group_id != null) {
      return this.findByIdInGroup(id, data.group_id)!;
    }
    return this.findById(id, data.user_id)!;
  }

  findById(id: number, userId: number): CalendarEvent | null {
    return this.db
      .prepare(
        `SELECT * FROM events WHERE id = ? AND is_cancelled = 0
         AND ((user_id = ? AND (owner_type IS NULL OR owner_type = 'user'))
           OR ${groupVisibleSql('')})`,
      )
      .get(id, userId, userId) as CalendarEvent | null;
  }

  /** Find event by ID without user/group visibility filter. For background services only. */
  findByIdUnfiltered(id: number): CalendarEvent | null {
    return this.db.prepare('SELECT * FROM events WHERE id = ? AND is_cancelled = 0').get(id) as CalendarEvent | null;
  }

  /** Update resolved location fields. For background location verification. */
  updateLocationFields(
    eventId: number,
    fields: {
      resolved_address: string;
      latitude: number;
      longitude: number;
      google_maps_url: string;
      location_verified: number;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE events SET resolved_address = ?, latitude = ?, longitude = ?,
         google_maps_url = ?, location_verified = ?, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(
        fields.resolved_address,
        fields.latitude,
        fields.longitude,
        fields.google_maps_url,
        fields.location_verified,
        eventId,
      );
  }

  findLatestCreatedByUser(userId: number): CalendarEvent | null {
    return this.db
      .prepare(
        `SELECT * FROM events WHERE is_cancelled = 0
         AND ((user_id = ? AND (owner_type IS NULL OR owner_type = 'user'))
           OR ${groupVisibleSql('')})
         ORDER BY id DESC LIMIT 1`,
      )
      .get(userId, userId) as CalendarEvent | null;
  }

  getOwnerId(eventId: number): number | null {
    const row = this.db.prepare('SELECT user_id FROM events WHERE id = ?').get(eventId) as { user_id: number } | null;
    return row?.user_id ?? null;
  }

  getInRange(userId: number, startUtc: string, endUtc: string): CalendarEvent[] {
    return this.db
      .prepare(`
      SELECT * FROM events
      WHERE start_at >= ? AND start_at <= ?
        AND is_cancelled = 0 AND recurrence_rule IS NULL AND parent_event_id IS NULL
        AND ((user_id = ? AND (owner_type IS NULL OR owner_type = 'user'))
          OR ${groupVisibleSql('')})
      ORDER BY start_at
    `)
      .all(startUtc, endUtc, userId, userId) as CalendarEvent[];
  }

  getRecurringTemplates(userId: number): CalendarEvent[] {
    return this.db
      .prepare(`
      SELECT * FROM events
      WHERE recurrence_rule IS NOT NULL AND parent_event_id IS NULL AND is_cancelled = 0
        AND ((user_id = ? AND (owner_type IS NULL OR owner_type = 'user'))
          OR ${groupMemberAnySql('')})
    `)
      .all(userId, userId) as CalendarEvent[];
  }

  getVisibleRecurringTemplates(userId: number): CalendarEvent[] {
    return this.db
      .prepare(
        `
      SELECT DISTINCT e.*, m.birth_year FROM events e
      LEFT JOIN birth_event_metadata m ON m.event_id = e.id
      WHERE e.recurrence_rule IS NOT NULL
        AND e.parent_event_id IS NULL
        AND e.is_cancelled = 0
        AND (
          (e.user_id = ? AND (e.owner_type IS NULL OR e.owner_type = 'user'))
          OR ${groupMemberAnySql('e')}
          OR e.id IN (
            SELECT event_id FROM event_participants
            WHERE user_id = ? AND status = 'accepted'
          )
        )
    `,
      )
      .all(userId, userId, userId) as CalendarEvent[];
  }

  getVisibleUpcoming(userId: number, limit = 10, now?: Date): CalendarEvent[] {
    const nowIso = (now ?? new Date()).toISOString();
    return this.db
      .prepare(
        `
      SELECT DISTINCT e.* FROM events e
      WHERE e.is_cancelled = 0
        AND e.parent_event_id IS NULL
        AND (e.start_at > ? OR e.recurrence_rule IS NOT NULL)
        AND (
          (e.user_id = ? AND (e.owner_type IS NULL OR e.owner_type = 'user'))
          OR ${groupVisibleSql('e')}
          OR e.id IN (
            SELECT event_id FROM event_participants
            WHERE user_id = ? AND status = 'accepted'
          )
        )
      ORDER BY e.start_at
      LIMIT ?
    `,
      )
      .all(nowIso, userId, userId, userId, limit) as CalendarEvent[];
  }

  getExceptions(parentEventId: number): CalendarEvent[] {
    return this.db.prepare('SELECT * FROM events WHERE parent_event_id = ?').all(parentEventId) as CalendarEvent[];
  }

  private buildUpdateQuery(data: UpdateEventData): { fields: string[]; values: SQLQueryBindings[] } {
    const ALLOWED_COLUMNS = new Set([
      'title',
      'description',
      'category',
      'start_at',
      'end_at',
      'all_day',
      'timezone',
      'location',
      'recurrence_rule',
      'recurrence_end_at',
      'reminder_overrides',
      'resolved_address',
      'latitude',
      'longitude',
      'google_maps_url',
      'location_verified',
    ]);
    const fields: string[] = [];
    const values: SQLQueryBindings[] = [];

    for (const [key, value] of Object.entries(data)) {
      if (!ALLOWED_COLUMNS.has(key)) continue;
      if (value !== undefined) {
        fields.push(`${key} = ?`);
        values.push(key === 'all_day' ? (value ? 1 : 0) : value);
      }
    }

    return { fields, values };
  }

  update(id: number, userId: number, data: UpdateEventData): CalendarEvent | null {
    const existing = this.findById(id, userId);
    if (!existing) return null;

    const { fields, values } = this.buildUpdateQuery(data);
    if (fields.length === 0) return existing;

    fields.push("updated_at = datetime('now')");
    values.push(id, userId);

    this.db.prepare(`UPDATE events SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`).run(...values);

    return this.findById(id, userId)!;
  }

  remove(id: number, userId: number): boolean {
    const result = this.db
      .prepare(
        `DELETE FROM events WHERE id = ?
         AND ((user_id = ? AND (owner_type IS NULL OR owner_type = 'user'))
           OR ${groupVisibleSql('')})`,
      )
      .run(id, userId, userId);
    return result.changes > 0;
  }

  getVisibleInRange(userId: number, startUtc: string, endUtc: string): CalendarEvent[] {
    return this.db
      .prepare(
        `
      SELECT DISTINCT e.* FROM events e
      WHERE e.start_at >= ? AND e.start_at < ?
        AND e.is_cancelled = 0
        AND e.recurrence_rule IS NULL
        AND e.parent_event_id IS NULL
        AND (
          (e.user_id = ? AND (e.owner_type IS NULL OR e.owner_type = 'user'))
          OR ${groupVisibleSql('e')}
          OR e.id IN (
            SELECT event_id FROM event_participants
            WHERE user_id = ? AND status = 'accepted'
          )
        )
      ORDER BY e.start_at
    `,
      )
      .all(startUtc, endUtc, userId, userId, userId) as CalendarEvent[];
  }

  isParticipant(eventId: number, userId: number): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM event_participants WHERE event_id = ? AND user_id = ? AND status = 'accepted'")
      .get(eventId, userId);
    return row != null;
  }

  private escapeLike(query: string): string {
    return query.replace(/[%_\\]/g, '\\$&');
  }

  search(userId: number, query: string, limit = 20): CalendarEvent[] {
    return this.db
      .prepare(`
      SELECT * FROM events
      WHERE title LIKE ? ESCAPE '\\' AND is_cancelled = 0
        AND ((user_id = ? AND (owner_type IS NULL OR owner_type = 'user'))
          OR ${groupVisibleSql('')})
      ORDER BY start_at ASC
      LIMIT ?
    `)
      .all(`%${this.escapeLike(query)}%`, userId, userId, limit) as CalendarEvent[];
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

  getExceptionsFrom(parentEventId: number, fromDate: string): CalendarEvent[] {
    return this.db
      .prepare('SELECT * FROM events WHERE parent_event_id = ? AND original_start_at >= ?')
      .all(parentEventId, fromDate) as CalendarEvent[];
  }

  reparentExceptions(oldTemplateId: number, newTemplateId: number, fromDate: string): void {
    this.db
      .prepare('UPDATE events SET parent_event_id = ? WHERE parent_event_id = ? AND original_start_at >= ?')
      .run(newTemplateId, oldTemplateId, fromDate);
  }

  deleteExceptionsFrom(parentEventId: number, fromDate: string): void {
    this.db
      .prepare('DELETE FROM events WHERE parent_event_id = ? AND original_start_at >= ?')
      .run(parentEventId, fromDate);
  }

  setRecurrenceUntil(eventId: number, untilDate: string): void {
    const untilStr = untilDate.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const event = this.db.prepare('SELECT recurrence_rule FROM events WHERE id = ?').get(eventId) as {
      recurrence_rule: string;
    } | null;
    if (!event?.recurrence_rule) return;

    const lines = event.recurrence_rule.split('\n');
    const rruleIdx = lines.findIndex((line) => line.startsWith('RRULE:'));
    const rruleLine = rruleIdx >= 0 ? lines[rruleIdx]! : lines[0]!;
    const otherLines = lines.filter((_, i) => i !== (rruleIdx >= 0 ? rruleIdx : 0));
    const baseRule = rruleLine
      .split(';')
      .filter((p) => !p.startsWith('UNTIL='))
      .join(';');
    const newRruleLine = `${baseRule};UNTIL=${untilStr}`;
    const newRule = [newRruleLine, ...otherLines].join('\n');

    this.db
      .prepare("UPDATE events SET recurrence_rule = ?, updated_at = datetime('now') WHERE id = ?")
      .run(newRule, eventId);
  }

  findByGoogleEventId(userId: number, googleCalendarId: string, googleEventId: string): CalendarEvent | null {
    return this.db
      .prepare('SELECT * FROM events WHERE user_id = ? AND google_calendar_id = ? AND google_event_id = ?')
      .get(userId, googleCalendarId, googleEventId) as CalendarEvent | null;
  }

  updateSyncFields(
    eventId: number,
    data: {
      google_event_id?: string;
      google_calendar_id?: string;
      google_etag?: string;
      sync_status?: string;
      last_synced_at?: string;
    },
  ): void {
    const ALLOWED_FIELDS = new Set([
      'google_event_id',
      'google_calendar_id',
      'google_etag',
      'sync_status',
      'last_synced_at',
    ]);
    const fields: string[] = [];
    const values: (string | number)[] = [];
    for (const [k, v] of Object.entries(data)) {
      if (v !== undefined) {
        if (!ALLOWED_FIELDS.has(k)) throw new Error(`Unknown sync field: ${k}`);
        fields.push(`${k} = ?`);
        values.push(v);
      }
    }
    if (fields.length === 0) return;
    fields.push("updated_at = datetime('now')");
    values.push(eventId);
    this.db.prepare(`UPDATE events SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  clearGoogleSync(userId: number): void {
    this.db
      .prepare(`
      UPDATE events SET
        google_calendar_id = NULL, google_event_id = NULL,
        google_etag = NULL, sync_status = 'local_only', last_synced_at = NULL
      WHERE user_id = ?
    `)
      .run(userId);
  }

  insertSyncedEvent(data: {
    user_id: number;
    title: string;
    description: string | null;
    start_at: string;
    end_at: string | null;
    all_day: boolean | number;
    timezone: string;
    location: string | null;
    recurrence_rule: string | null;
    google_calendar_id: string;
    google_event_id: string;
    google_etag: string | null;
    is_cancelled: boolean | number;
  }): void {
    this.db
      .prepare(`
      INSERT OR IGNORE INTO events (
        user_id, title, description, start_at, end_at, all_day,
        timezone, location, recurrence_rule, google_calendar_id, google_event_id,
        google_etag, sync_status, sync_version, is_cancelled
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced', 0, ?)
    `)
      .run(
        data.user_id,
        data.title,
        data.description,
        data.start_at,
        data.end_at,
        data.all_day ? 1 : 0,
        data.timezone,
        data.location,
        data.recurrence_rule,
        data.google_calendar_id,
        data.google_event_id,
        data.google_etag,
        data.is_cancelled ? 1 : 0,
      );
  }

  findVisibleOverlapping(userId: number, startUtc: string, endUtc: string, requesterId?: number): CalendarEvent[] {
    const applyPrivacy = requesterId !== undefined && requesterId !== userId;
    const privacyClause = applyPrivacy
      ? `AND (
          e.user_id = ?
          OR COALESCE(
            (SELECT visibility FROM event_visibility WHERE event_id = e.id),
            (SELECT default_visibility FROM sharing_settings WHERE user_id = e.user_id),
            'full'
          ) != 'private'
        )`
      : '';
    const sql = `
      SELECT DISTINCT e.* FROM events e
      WHERE e.is_cancelled = 0
        AND e.recurrence_rule IS NULL
        AND e.parent_event_id IS NULL
        AND e.start_at < ?
        AND (
          e.end_at > ?
          OR (e.end_at IS NULL AND strftime('%Y-%m-%dT%H:%M:%SZ', e.start_at, '+30 minutes') > ?)
        )
        AND (
          e.user_id = ?
          OR e.id IN (
            SELECT event_id FROM event_participants
            WHERE user_id = ? AND status = 'accepted'
          )
        )
        ${privacyClause}
      ORDER BY e.start_at
    `;
    const params: (string | number)[] = [endUtc, startUtc, startUtc, userId, userId];
    if (applyPrivacy) params.push(requesterId as number);
    return this.db.prepare(sql).all(...params) as CalendarEvent[];
  }

  countInRange(userId: number, startUtc: string, endUtc: string): number {
    const row = this.db
      .prepare(`
      SELECT COUNT(*) as count FROM events
      WHERE user_id = ? AND start_at >= ? AND start_at <= ? AND is_cancelled = 0
        AND (owner_type IS NULL OR owner_type = 'user')
    `)
      .get(userId, startUtc, endUtc) as { count: number };
    return row.count;
  }

  findByIdInGroup(id: number, groupId: number): CalendarEvent | null {
    return this.db
      .prepare("SELECT * FROM events WHERE id = ? AND owner_type = 'group' AND group_id = ? AND is_cancelled = 0")
      .get(id, groupId) as CalendarEvent | null;
  }

  getByDateRangeForGroup(groupId: number, startUtc: string, endUtc: string): CalendarEvent[] {
    return this.db
      .prepare(
        "SELECT * FROM events WHERE owner_type = 'group' AND group_id = ? AND start_at >= ? AND start_at <= ? AND is_cancelled = 0 ORDER BY start_at",
      )
      .all(groupId, startUtc, endUtc) as CalendarEvent[];
  }

  getInRangeForGroup(groupId: number, startUtc: string, endUtc: string): CalendarEvent[] {
    return this.db
      .prepare(`
      SELECT * FROM events
      WHERE owner_type = 'group' AND group_id = ? AND start_at >= ? AND start_at <= ?
        AND is_cancelled = 0 AND recurrence_rule IS NULL AND parent_event_id IS NULL
      ORDER BY start_at
    `)
      .all(groupId, startUtc, endUtc) as CalendarEvent[];
  }

  getRecurringTemplatesForGroup(groupId: number): CalendarEvent[] {
    return this.db
      .prepare(`
      SELECT e.*, m.birth_year FROM events e
      LEFT JOIN birth_event_metadata m ON m.event_id = e.id
      WHERE e.owner_type = 'group' AND e.group_id = ? AND e.recurrence_rule IS NOT NULL AND e.parent_event_id IS NULL AND e.is_cancelled = 0
    `)
      .all(groupId) as CalendarEvent[];
  }

  searchForGroup(groupId: number, query: string, limit = 20): CalendarEvent[] {
    return this.db
      .prepare(`
      SELECT * FROM events
      WHERE owner_type = 'group' AND group_id = ? AND title LIKE ? ESCAPE '\\' AND is_cancelled = 0
      ORDER BY start_at ASC
      LIMIT ?
    `)
      .all(groupId, `%${this.escapeLike(query)}%`, limit) as CalendarEvent[];
  }

  getUpcomingForGroup(groupId: number, limit = 10, now?: Date): CalendarEvent[] {
    const nowIso = (now ?? new Date()).toISOString();
    return this.db
      .prepare(`
      SELECT * FROM events
      WHERE owner_type = 'group' AND group_id = ? AND is_cancelled = 0 AND parent_event_id IS NULL
        AND (start_at > ? OR recurrence_rule IS NOT NULL)
      ORDER BY start_at
      LIMIT ?
    `)
      .all(groupId, nowIso, limit) as CalendarEvent[];
  }

  updateInGroup(id: number, groupId: number, data: UpdateEventData): CalendarEvent | null {
    const existing = this.findByIdInGroup(id, groupId);
    if (!existing) return null;

    const { fields, values } = this.buildUpdateQuery(data);
    if (fields.length === 0) return existing;

    fields.push("updated_at = datetime('now')");
    values.push(id, groupId);

    this.db
      .prepare(`UPDATE events SET ${fields.join(', ')} WHERE id = ? AND owner_type = 'group' AND group_id = ?`)
      .run(...values);

    return this.findByIdInGroup(id, groupId)!;
  }

  removeFromGroup(id: number, groupId: number): boolean {
    const result = this.db
      .prepare("DELETE FROM events WHERE id = ? AND owner_type = 'group' AND group_id = ?")
      .run(id, groupId);
    return result.changes > 0;
  }

  getBirthdays(userId: number): CalendarEvent[] {
    return this.db
      .prepare(
        `SELECT e.*, m.birth_year, m.celebrant_id FROM events e
         LEFT JOIN birth_event_metadata m ON m.event_id = e.id
         WHERE e.user_id = ? AND e.event_type = 'birthday' AND e.is_cancelled = 0
           AND (e.owner_type IS NULL OR e.owner_type = 'user')
         ORDER BY e.start_at`,
      )
      .all(userId) as CalendarEvent[];
  }

  getBirthdaysForGroup(groupId: number): CalendarEvent[] {
    return this.db
      .prepare(
        `SELECT e.*, m.birth_year, m.celebrant_id FROM events e
         LEFT JOIN birth_event_metadata m ON m.event_id = e.id
         WHERE e.group_id = ? AND e.event_type = 'birthday' AND e.is_cancelled = 0
           AND e.owner_type = 'group'
         ORDER BY e.start_at`,
      )
      .all(groupId) as CalendarEvent[];
  }

  searchWithEventType(userId: number, query: string | null, eventType: string | null): CalendarEvent[] {
    const conditions: string[] = [
      'e.is_cancelled = 0',
      `((e.user_id = ? AND (e.owner_type IS NULL OR e.owner_type = 'user'))
        OR ${groupVisibleSql('e')})`,
    ];
    const params: (string | number | null)[] = [userId, userId];

    if (query) {
      conditions.push('e.title LIKE ?');
      params.push(`%${this.escapeLike(query)}%`);
    }
    if (eventType) {
      if (eventType === 'regular') {
        conditions.push('e.event_type IS NULL');
      } else {
        conditions.push('e.event_type = ?');
        params.push(eventType);
      }
    }

    return this.db
      .prepare(
        `SELECT e.*, m.birth_year, m.celebrant_id FROM events e
         LEFT JOIN birth_event_metadata m ON m.event_id = e.id
         WHERE ${conditions.join(' AND ')} ORDER BY e.start_at`,
      )
      .all(...params) as CalendarEvent[];
  }

  getAllRecurringTemplates(): CalendarEvent[] {
    return this.db
      .prepare(`
      SELECT * FROM events
      WHERE recurrence_rule IS NOT NULL AND parent_event_id IS NULL AND is_cancelled = 0
    `)
      .all() as CalendarEvent[];
  }

  findStartingWithin(withinMs: number): CalendarEvent[] {
    const now = new Date().toISOString();
    const until = new Date(Date.now() + withinMs).toISOString();
    return this.db
      .prepare(`
      SELECT * FROM events
      WHERE start_at >= ? AND start_at <= ?
      AND all_day = 0
      AND recurrence_rule IS NULL
      ORDER BY start_at ASC
    `)
      .all(now, until) as CalendarEvent[];
  }
}
