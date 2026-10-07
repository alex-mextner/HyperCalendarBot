// src/database/repositories/event.repository.ts
import type { Database, SQLQueryBindings } from 'bun:sqlite';
import { assertValidEventTimestamps } from '../../utils/event-timestamps.ts';
import type { CalendarEvent, CreateEventData, UpdateEventData } from '../types.ts';

// Compare actual instants in SQL: persisted ISO offsets/millisecond spellings and
// SQLite membership timestamps are not lexicographically interchangeable.
// No stored event values are rewritten by these read predicates.

// SQL fragment: group event visible to user if they are an active member
// and the event starts on or after the day they joined. For one-off events.
// Expects 1 bind param (userId).
function groupVisibleSql(alias: string): string {
  const col = alias ? `${alias}.` : '';
  return `(${col}owner_type = 'group' AND EXISTS (
    SELECT 1 FROM group_members gm
    WHERE gm.chat_id = ${col}group_id AND gm.user_id = ?
      AND gm.left_at IS NULL
      AND julianday(${col}start_at) >= julianday(gm.joined_at)
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

// SQL fragment: candidate events whose occupied time may intersect [start, end].
// Expects 2 bind params (rangeEnd, rangeStart). Timed events occupy at least 30
// minutes; all-day values are floating dates that can sit a day away from the
// requester's local day boundaries, so their range is padded by one day. This is
// a superset: the service clips each candidate to its exact occupied time.
function overlapCandidateSql(alias: string): string {
  const col = alias ? `${alias}.` : '';
  return `julianday(${col}start_at) < julianday(?) + (CASE WHEN ${col}all_day = 1 THEN 1.0 ELSE 0.0 END)
    AND MAX(COALESCE(julianday(${col}end_at), 0), julianday(${col}start_at, '+30 minutes'))
      > julianday(?) - (CASE WHEN ${col}all_day = 1 THEN 1.0 ELSE 0.0 END)`;
}

/**
 * Title substring search over rows the caller's SQL already restricted to what the user may see.
 * SQLite LIKE folds case only for ASCII, so "встреча" never found "Встреча"; the match runs here
 * with Unicode case folding while the rows stream, and reading stops at `limit` matches.
 */
function takeTitleMatches(
  rows: IterableIterator<CalendarEvent>,
  query: string,
  limit = Number.POSITIVE_INFINITY,
): CalendarEvent[] {
  const matches: CalendarEvent[] = [];
  if (limit <= 0) return matches;
  const needle = query.normalize('NFKC').toLowerCase();
  for (const row of rows) {
    if (!row.title.normalize('NFKC').toLowerCase().includes(needle)) continue;
    matches.push(row);
    if (matches.length >= limit) break;
  }
  return matches;
}

export const EVENT_UPDATE_FIELDS = [
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
  'venue_name',
] satisfies readonly (keyof UpdateEventData)[];

/**
 * Resolved-place columns derived from the typed `location`. They describe one specific location
 * text and are stale as soon as that text changes. Only the location-verification service (the
 * creator's tap or pin) writes them; model tool input never may (#620).
 */
export const RESOLVED_PLACE_COLUMNS = [
  'resolved_address',
  'latitude',
  'longitude',
  'google_maps_url',
  'venue_name',
  'location_verified',
] as const satisfies readonly (keyof UpdateEventData)[];

/** The value of each resolved-place column that means "not resolved"; its keys are exactly those columns. */
export const UNRESOLVED_PLACE = {
  resolved_address: null,
  latitude: null,
  longitude: null,
  google_maps_url: null,
  venue_name: null,
  location_verified: 0,
} as const satisfies Record<(typeof RESOLVED_PLACE_COLUMNS)[number], null | 0>;

/**
 * Update fields that remove an event's location together with its resolved place. An explicit
 * removal must also drop a place a pin set on an event without typed text, which the text-change
 * reset in `buildUpdateQuery` cannot see (NULL → NULL looks unchanged). Only explicit removals use
 * it: a Google pull writes `location: null` on unrelated changes and must keep such a place.
 */
export const CLEARED_LOCATION = { location: null, ...UNRESOLVED_PLACE } as const satisfies UpdateEventData;

export class EventRepository {
  /**
   * Tables that `cascadeCleanupChildren` should wipe when a parent event
   * is soft-deleted. Computed once at construction from `sqlite_master`
   * — test DBs with minimal schemas may not have all of them.
   */
  private readonly cascadeTargets: readonly string[];
  private readonly cascadeDeleteStmts: ReadonlyMap<string, ReturnType<Database['prepare']>>;
  /** Cancels the pending, maybe and accepted invitations of a soft-deleted event; null when the schema has no invitations table. */
  private readonly cascadeCancelInvitationsStmt: ReturnType<Database['prepare']> | null;
  private readonly cascadeSoftDeleteExceptionStmt: ReturnType<Database['prepare']>;
  private readonly cascadeFindChildrenStmt: ReturnType<Database['prepare']>;

  constructor(private db: Database) {
    const candidates = [
      'event_participants',
      'event_visibility',
      'shared_events',
      'group_shared_events',
      'birth_event_metadata',
      'participant_google_sync',
      'reminders',
      'event_reminders',
    ];
    const tableNames = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((r) => r.name);
    const existing = new Set(tableNames);
    this.cascadeTargets = candidates.filter((t) => existing.has(t));
    const deleteStmts = new Map<string, ReturnType<Database['prepare']>>();
    for (const table of this.cascadeTargets) {
      deleteStmts.set(table, db.prepare(`DELETE FROM ${table} WHERE event_id = ?`));
    }
    this.cascadeDeleteStmts = deleteStmts;
    // Invitations are the record of who was invited, so they outlive the event: pending, maybe
    // and accepted ones become cancelled, since the event can no longer be attended; declined,
    // cancelled and expired ones keep their status.
    this.cascadeCancelInvitationsStmt = existing.has('invitations')
      ? db.prepare(
          `UPDATE invitations SET status = 'cancelled', updated_at = datetime('now')
           WHERE event_id = ? AND status IN ('pending', 'maybe', 'accepted')`,
        )
      : null;
    this.cascadeSoftDeleteExceptionStmt = db.prepare(
      "UPDATE events SET is_deleted = 1, updated_at = datetime('now') WHERE id = ?",
    );
    this.cascadeFindChildrenStmt = db.prepare('SELECT id FROM events WHERE parent_event_id = ? AND is_deleted = 0');
  }

  create(data: CreateEventData): CalendarEvent {
    assertValidEventTimestamps(data);
    const result = this.db
      .prepare(`
      INSERT INTO events (user_id, title, description, category, start_at, end_at, all_day, timezone, location, recurrence_rule, recurrence_end_at, owner_type, group_id, created_by, event_type, reminder_overrides)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        data.reminder_minutes === undefined ? null : JSON.stringify(data.reminder_minutes),
      );
    const id = Number(result.lastInsertRowid);
    if (data.owner_type === 'group' && data.group_id != null) {
      return this.findByIdInGroup(id, data.group_id)!;
    }
    return this.findById(id, data.user_id)!;
  }

  /** Load event by ID without ownership checks. For internal service use only (sync workers, etc.). */
  findByIdUnfiltered(
    id: number,
  ): Pick<
    CalendarEvent,
    | 'id'
    | 'user_id'
    | 'title'
    | 'description'
    | 'start_at'
    | 'end_at'
    | 'all_day'
    | 'timezone'
    | 'location'
    | 'resolved_address'
    | 'venue_name'
    | 'location_verified'
    | 'recurrence_rule'
    | 'reminder_overrides'
    | 'sync_version'
    | 'owner_type'
  > | null {
    return this.db
      .prepare(
        `SELECT id, user_id, title, description, start_at, end_at, all_day, timezone, location,
                resolved_address, venue_name, location_verified,
                recurrence_rule, reminder_overrides, sync_version, owner_type
         FROM events WHERE id = ? AND is_cancelled = 0 AND is_deleted = 0`,
      )
      .get(id) as Pick<
      CalendarEvent,
      | 'id'
      | 'user_id'
      | 'title'
      | 'description'
      | 'start_at'
      | 'end_at'
      | 'all_day'
      | 'timezone'
      | 'location'
      | 'resolved_address'
      | 'venue_name'
      | 'location_verified'
      | 'recurrence_rule'
      | 'reminder_overrides'
      | 'sync_version'
      | 'owner_type'
    > | null;
  }

  findById(id: number, userId: number): CalendarEvent | null {
    return this.db
      .prepare(
        `SELECT * FROM events WHERE id = ? AND is_cancelled = 0 AND is_deleted = 0
         AND ((user_id = ? AND (owner_type IS NULL OR owner_type = 'user'))
           OR ${groupVisibleSql('')})`,
      )
      .get(id, userId, userId) as CalendarEvent | null;
  }

  /**
   * Fetch an event by id, bypassing ONLY the soft-delete filter. Ownership
   * and group-visibility checks are still enforced — the caller must have
   * had access to the event before it was soft-deleted. Used by downstream
   * systems that need the title of an event the user removed themselves,
   * e.g. proposal accept/reject notifications to the proposer.
   *
   * Visibility information does not disappear on soft-delete: `events.user_id`
   * is still set, and group membership is still valid, so the same access
   * predicate as `findById` is applied here — minus `is_deleted = 0`.
   */
  findByIdIncludingSoftDeleted(id: number, userId: number): CalendarEvent | null {
    return this.db
      .prepare(
        `SELECT * FROM events WHERE id = ? AND is_cancelled = 0
         AND ((user_id = ? AND (owner_type IS NULL OR owner_type = 'user'))
           OR ${groupVisibleSql('')})`,
      )
      .get(id, userId, userId) as CalendarEvent | null;
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
      venue_name: string | null;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE events SET resolved_address = ?, latitude = ?, longitude = ?,
         google_maps_url = ?, location_verified = ?, venue_name = ?, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(
        fields.resolved_address,
        fields.latitude,
        fields.longitude,
        fields.google_maps_url,
        fields.location_verified,
        fields.venue_name,
        eventId,
      );
  }

  /** Drop the resolved place so only the typed location remains, unverified. */
  clearLocationFields(eventId: number): void {
    this.db
      .prepare(
        `UPDATE events SET resolved_address = NULL, latitude = NULL, longitude = NULL,
         google_maps_url = NULL, location_verified = 0, venue_name = NULL, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(eventId);
  }

  findLatestCreatedByUser(userId: number): CalendarEvent | null {
    return this.db
      .prepare(
        `SELECT * FROM events WHERE is_cancelled = 0 AND is_deleted = 0
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
      WHERE julianday(start_at) >= julianday(?) AND julianday(start_at) <= julianday(?)
        AND is_cancelled = 0 AND is_deleted = 0 AND recurrence_rule IS NULL AND parent_event_id IS NULL
        AND ((user_id = ? AND (owner_type IS NULL OR owner_type = 'user'))
          OR ${groupVisibleSql('')})
      ORDER BY julianday(start_at), id
    `)
      .all(startUtc, endUtc, userId, userId) as CalendarEvent[];
  }

  getRecurringTemplates(userId: number): CalendarEvent[] {
    return this.db
      .prepare(`
      SELECT * FROM events
      WHERE recurrence_rule IS NOT NULL AND parent_event_id IS NULL AND is_cancelled = 0 AND is_deleted = 0
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
        AND e.is_cancelled = 0 AND e.is_deleted = 0
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
      WHERE e.is_cancelled = 0 AND e.is_deleted = 0
        AND e.parent_event_id IS NULL
        AND (julianday(e.start_at) > julianday(?) OR e.recurrence_rule IS NOT NULL)
        AND (
          (e.user_id = ? AND (e.owner_type IS NULL OR e.owner_type = 'user'))
          OR ${groupVisibleSql('e')}
          OR e.id IN (
            SELECT event_id FROM event_participants
            WHERE user_id = ? AND status = 'accepted'
          )
        )
      ORDER BY julianday(e.start_at), e.id
      LIMIT ?
    `,
      )
      .all(nowIso, userId, userId, userId, limit) as CalendarEvent[];
  }

  getExceptions(parentEventId: number): CalendarEvent[] {
    return this.db
      .prepare('SELECT * FROM events WHERE parent_event_id = ? AND is_deleted = 0')
      .all(parentEventId) as CalendarEvent[];
  }

  private buildUpdateQuery(data: UpdateEventData): { fields: string[]; values: SQLQueryBindings[] } {
    assertValidEventTimestamps(data);
    const fields: string[] = [];
    const values: SQLQueryBindings[] = [];

    for (const [key, value] of Object.entries(data)) {
      if (!EVENT_UPDATE_FIELDS.some((field) => field === key)) continue;
      if (value !== undefined) {
        fields.push(`${key} = ?`);
        values.push(key === 'all_day' ? (value ? 1 : 0) : value);
      }
    }

    // Every write path funnels through here, so a changed location can never keep the
    // previous venue, address and map link. The reset happens in the same UPDATE:
    // SQLite evaluates `location IS ?` against the pre-update row, so an unchanged
    // text keeps its resolution. A caller that supplies a resolved column wins.
    if (data.location !== undefined) {
      for (const column of RESOLVED_PLACE_COLUMNS) {
        if (data[column] !== undefined) continue;
        fields.push(`${column} = CASE WHEN location IS ? THEN ${column} ELSE ? END`);
        values.push(data.location, UNRESOLVED_PLACE[column]);
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
    // Soft-delete: keep the events row so downstream systems (edit proposals,
    // action log) can still resolve the title by id. All user-facing read
    // paths filter `is_deleted = 0`.
    //
    // Child data that would have been nuked by ON DELETE CASCADE is cleaned
    // up explicitly here — participants, sharing state, reminder rows,
    // birthday metadata, and recursively child exception rows. Invitations
    // are kept as history; pending, maybe and accepted ones become cancelled.
    // Edit proposals are intentionally preserved so the proposer notification
    // can still look up the title.
    return this.db.transaction((): boolean => {
      const result = this.db
        .prepare(
          `UPDATE events SET is_deleted = 1, updated_at = datetime('now')
           WHERE id = ? AND is_deleted = 0
           AND ((user_id = ? AND (owner_type IS NULL OR owner_type = 'user'))
             OR ${groupVisibleSql('')})`,
        )
        .run(id, userId, userId);
      if (result.changes === 0) return false;
      this.cascadeCleanupChildren(id, 0);
      return true;
    })();
  }

  private static readonly CASCADE_MAX_DEPTH = 8;

  private cascadeCleanupChildren(eventId: number, depth: number): void {
    // In practice SQLite recurrence exceptions nest 2 levels at most
    // (template → exception). The guard is defense-in-depth against a
    // corrupted graph or a future schema change that introduces cycles.
    if (depth > EventRepository.CASCADE_MAX_DEPTH) {
      throw new Error(`cascadeCleanupChildren: depth > ${EventRepository.CASCADE_MAX_DEPTH} for event ${eventId}`);
    }
    // Tables that used to cascade via ON DELETE CASCADE. edit_proposals is
    // intentionally absent — that row is what lets us resolve the title for
    // the proposer notification after the owner soft-deletes the event.
    // Statements + resolved target list are cached at construction.
    for (const table of this.cascadeTargets) {
      this.cascadeDeleteStmts.get(table)!.run(eventId);
    }
    this.cascadeCancelInvitationsStmt?.run(eventId);
    // Recursively soft-delete child exception rows so the same cleanup chain
    // applies to them.
    const exceptions = this.cascadeFindChildrenStmt.all(eventId) as { id: number }[];
    for (const exc of exceptions) {
      this.cascadeSoftDeleteExceptionStmt.run(exc.id);
      this.cascadeCleanupChildren(exc.id, depth + 1);
    }
  }

  getVisibleInRange(userId: number, startUtc: string, endUtc: string): CalendarEvent[] {
    return this.db
      .prepare(
        `
      SELECT DISTINCT e.* FROM events e
      WHERE julianday(e.start_at) >= julianday(?) AND julianday(e.start_at) < julianday(?)
        AND e.is_cancelled = 0 AND e.is_deleted = 0
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
      ORDER BY julianday(e.start_at), e.id
    `,
      )
      .all(startUtc, endUtc, userId, userId, userId) as CalendarEvent[];
  }

  /** Same visibility as `getVisibleInRange`, but matches events that started before the range and still overlap it. */
  getVisibleOverlapping(userId: number, startUtc: string, endUtc: string): CalendarEvent[] {
    return this.db
      .prepare(
        `
      SELECT DISTINCT e.* FROM events e
      WHERE ${overlapCandidateSql('e')}
        AND e.is_cancelled = 0 AND e.is_deleted = 0
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
      ORDER BY julianday(e.start_at), e.id
    `,
      )
      .all(endUtc, startUtc, userId, userId, userId) as CalendarEvent[];
  }

  isParticipant(eventId: number, userId: number): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM event_participants WHERE event_id = ? AND user_id = ? AND status = 'accepted'")
      .get(eventId, userId);
    return row != null;
  }

  search(userId: number, query: string, limit = 20): CalendarEvent[] {
    const rows = this.db
      .prepare<CalendarEvent, [number, number, number]>(`
      SELECT * FROM events
      WHERE is_cancelled = 0 AND is_deleted = 0
        AND ((user_id = ? AND (owner_type IS NULL OR owner_type = 'user'))
          OR ${groupVisibleSql('')}
          OR id IN (
            SELECT event_id FROM event_participants
            WHERE user_id = ? AND status = 'accepted'
          ))
      ORDER BY julianday(start_at), id
    `)
      .iterate(userId, userId, userId);
    return takeTitleMatches(rows, query, limit);
  }

  getUpcoming(userId: number, limit = 10, now?: Date): CalendarEvent[] {
    const nowIso = (now ?? new Date()).toISOString();
    return this.db
      .prepare(`
      SELECT * FROM events
      WHERE user_id = ? AND is_cancelled = 0 AND is_deleted = 0 AND parent_event_id IS NULL
        AND (julianday(start_at) > julianday(?) OR recurrence_rule IS NOT NULL)
      ORDER BY julianday(start_at), id
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
      .prepare(
        'SELECT * FROM events WHERE parent_event_id = ? AND julianday(original_start_at) >= julianday(?) AND is_deleted = 0',
      )
      .all(parentEventId, fromDate) as CalendarEvent[];
  }

  reparentExceptions(oldTemplateId: number, newTemplateId: number, fromDate: string): void {
    this.db
      .prepare(
        'UPDATE events SET parent_event_id = ? WHERE parent_event_id = ? AND julianday(original_start_at) >= julianday(?)',
      )
      .run(newTemplateId, oldTemplateId, fromDate);
  }

  deleteExceptionsFrom(parentEventId: number, fromDate: string): void {
    this.db
      .prepare('DELETE FROM events WHERE parent_event_id = ? AND julianday(original_start_at) >= julianday(?)')
      .run(parentEventId, fromDate);
  }

  setRecurrenceUntil(eventId: number, untilDate: string): void {
    const untilStr = untilDate.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const event = this.db
      .prepare('SELECT recurrence_rule FROM events WHERE id = ? AND is_deleted = 0')
      .get(eventId) as { recurrence_rule: string } | null;
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
      .prepare(
        'SELECT * FROM events WHERE user_id = ? AND google_calendar_id = ? AND google_event_id = ? AND is_deleted = 0',
      )
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
      WHERE e.is_cancelled = 0 AND e.is_deleted = 0
        AND e.recurrence_rule IS NULL
        AND e.parent_event_id IS NULL
        AND julianday(e.start_at) < julianday(?)
        AND (
          julianday(e.end_at) > julianday(?)
          OR (e.end_at IS NULL AND julianday(e.start_at, '+30 minutes') > julianday(?))
        )
        AND (
          e.user_id = ?
          OR e.id IN (
            SELECT event_id FROM event_participants
            WHERE user_id = ? AND status = 'accepted'
          )
        )
        ${privacyClause}
      ORDER BY julianday(e.start_at), e.id
    `;
    const params: (string | number)[] = [endUtc, startUtc, startUtc, userId, userId];
    if (applyPrivacy) params.push(requesterId as number);
    return this.db.prepare(sql).all(...params) as CalendarEvent[];
  }

  countInRange(userId: number, startUtc: string, endUtc: string): number {
    const row = this.db
      .prepare(`
      SELECT COUNT(*) as count FROM events
      WHERE user_id = ? AND julianday(start_at) >= julianday(?) AND julianday(start_at) <= julianday(?) AND is_cancelled = 0 AND is_deleted = 0
        AND (owner_type IS NULL OR owner_type = 'user')
    `)
      .get(userId, startUtc, endUtc) as { count: number };
    return row.count;
  }

  findByIdInGroup(id: number, groupId: number): CalendarEvent | null {
    return this.db
      .prepare(
        "SELECT * FROM events WHERE id = ? AND owner_type = 'group' AND group_id = ? AND is_cancelled = 0 AND is_deleted = 0",
      )
      .get(id, groupId) as CalendarEvent | null;
  }

  getByDateRangeForGroup(groupId: number, startUtc: string, endUtc: string): CalendarEvent[] {
    return this.db
      .prepare(
        "SELECT * FROM events WHERE owner_type = 'group' AND group_id = ? AND julianday(start_at) >= julianday(?) AND julianday(start_at) <= julianday(?) AND is_cancelled = 0 AND is_deleted = 0 ORDER BY julianday(start_at), id",
      )
      .all(groupId, startUtc, endUtc) as CalendarEvent[];
  }

  getInRangeForGroup(groupId: number, startUtc: string, endUtc: string): CalendarEvent[] {
    return this.db
      .prepare(`
      SELECT * FROM events
      WHERE owner_type = 'group' AND group_id = ? AND julianday(start_at) >= julianday(?) AND julianday(start_at) <= julianday(?)
        AND is_cancelled = 0 AND is_deleted = 0 AND recurrence_rule IS NULL AND parent_event_id IS NULL
      ORDER BY julianday(start_at), id
    `)
      .all(groupId, startUtc, endUtc) as CalendarEvent[];
  }

  /** Same scope as `getInRangeForGroup`, but matches events that started before the range and still overlap it. */
  getOverlappingForGroup(groupId: number, startUtc: string, endUtc: string): CalendarEvent[] {
    return this.db
      .prepare(`
      SELECT * FROM events e
      WHERE e.owner_type = 'group' AND e.group_id = ? AND ${overlapCandidateSql('e')}
        AND e.is_cancelled = 0 AND e.is_deleted = 0 AND e.recurrence_rule IS NULL AND e.parent_event_id IS NULL
      ORDER BY julianday(e.start_at), e.id
    `)
      .all(groupId, endUtc, startUtc) as CalendarEvent[];
  }

  getRecurringTemplatesForGroup(groupId: number): CalendarEvent[] {
    return this.db
      .prepare(`
      SELECT e.*, m.birth_year FROM events e
      LEFT JOIN birth_event_metadata m ON m.event_id = e.id
      WHERE e.owner_type = 'group' AND e.group_id = ? AND e.recurrence_rule IS NOT NULL AND e.parent_event_id IS NULL AND e.is_cancelled = 0 AND e.is_deleted = 0
    `)
      .all(groupId) as CalendarEvent[];
  }

  searchForGroup(groupId: number, query: string, limit = 20): CalendarEvent[] {
    const rows = this.db
      .prepare<CalendarEvent, [number]>(`
      SELECT * FROM events
      WHERE owner_type = 'group' AND group_id = ? AND is_cancelled = 0 AND is_deleted = 0
      ORDER BY julianday(start_at), id
    `)
      .iterate(groupId);
    return takeTitleMatches(rows, query, limit);
  }

  getUpcomingForGroup(groupId: number, limit = 10, now?: Date): CalendarEvent[] {
    const nowIso = (now ?? new Date()).toISOString();
    return this.db
      .prepare(`
      SELECT * FROM events
      WHERE owner_type = 'group' AND group_id = ? AND is_cancelled = 0 AND is_deleted = 0 AND parent_event_id IS NULL
        AND (julianday(start_at) > julianday(?) OR recurrence_rule IS NOT NULL)
      ORDER BY julianday(start_at), id
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
    // Soft-delete — see remove() for rationale.
    return this.db.transaction((): boolean => {
      const result = this.db
        .prepare(
          `UPDATE events SET is_deleted = 1, updated_at = datetime('now')
           WHERE id = ? AND owner_type = 'group' AND group_id = ? AND is_deleted = 0`,
        )
        .run(id, groupId);
      if (result.changes === 0) return false;
      this.cascadeCleanupChildren(id, 0);
      return true;
    })();
  }

  getBirthdays(userId: number): CalendarEvent[] {
    return this.db
      .prepare(
        `SELECT e.*, m.birth_year, m.celebrant_id FROM events e
         LEFT JOIN birth_event_metadata m ON m.event_id = e.id
         WHERE e.user_id = ? AND e.event_type = 'birthday' AND e.is_cancelled = 0 AND e.is_deleted = 0
           AND (e.owner_type IS NULL OR e.owner_type = 'user')
         ORDER BY julianday(e.start_at), e.id`,
      )
      .all(userId) as CalendarEvent[];
  }

  getBirthdaysForGroup(groupId: number): CalendarEvent[] {
    return this.db
      .prepare(
        `SELECT e.*, m.birth_year, m.celebrant_id FROM events e
         LEFT JOIN birth_event_metadata m ON m.event_id = e.id
         WHERE e.group_id = ? AND e.event_type = 'birthday' AND e.is_cancelled = 0 AND e.is_deleted = 0
           AND e.owner_type = 'group'
         ORDER BY julianday(e.start_at), e.id`,
      )
      .all(groupId) as CalendarEvent[];
  }

  searchWithEventType(userId: number, query: string | null, eventType: string | null): CalendarEvent[] {
    const conditions: string[] = [
      'e.is_cancelled = 0 AND e.is_deleted = 0',
      `((e.user_id = ? AND (e.owner_type IS NULL OR e.owner_type = 'user'))
        OR ${groupVisibleSql('e')}
        OR e.id IN (
          SELECT event_id FROM event_participants
          WHERE user_id = ? AND status = 'accepted'
        ))`,
    ];
    const params: (string | number | null)[] = [userId, userId, userId];

    if (eventType) {
      if (eventType === 'regular') {
        conditions.push('e.event_type IS NULL');
      } else {
        conditions.push('e.event_type = ?');
        params.push(eventType);
      }
    }

    const statement = this.db.prepare<CalendarEvent, SQLQueryBindings[]>(
      `SELECT e.*, m.birth_year, m.celebrant_id FROM events e
         LEFT JOIN birth_event_metadata m ON m.event_id = e.id
         WHERE ${conditions.join(' AND ')} ORDER BY julianday(e.start_at), e.id`,
    );
    return query ? takeTitleMatches(statement.iterate(...params), query) : statement.all(...params);
  }

  getAllRecurringTemplates(): CalendarEvent[] {
    return this.db
      .prepare(`
      SELECT * FROM events
      WHERE recurrence_rule IS NOT NULL AND parent_event_id IS NULL AND is_cancelled = 0 AND is_deleted = 0
    `)
      .all() as CalendarEvent[];
  }

  findStartingWithin(withinMs: number): CalendarEvent[] {
    const now = new Date().toISOString();
    const until = new Date(Date.now() + withinMs).toISOString();
    return this.db
      .prepare(`
      SELECT * FROM events
      WHERE julianday(start_at) >= julianday(?) AND julianday(start_at) <= julianday(?)
      AND all_day = 0
      AND recurrence_rule IS NULL
      AND is_cancelled = 0 AND is_deleted = 0
      ORDER BY julianday(start_at), id
    `)
      .all(now, until) as CalendarEvent[];
  }
}
