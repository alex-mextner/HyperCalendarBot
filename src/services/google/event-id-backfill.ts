// src/services/google/event-id-backfill.ts
// Relinks bot rows whose Google copy exists but whose Google event id was never stored (#875).
// plan() only reads: it compares one calendar's live events with the rows that have no Google id and
// returns the matches that are unambiguous. apply() writes nothing but the missing id (and a log row
// saying so). Neither touches Google or any user text, and neither prints event text or ids.
import { Database } from 'bun:sqlite';
import { chmodSync, closeSync, fsyncSync, linkSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { calendar_v3 } from 'googleapis';
import type { CalendarEvent } from '../../database/types.ts';
import { syncLogger } from '../../utils/logger.ts';
import { BOT_EVENT_MARKER, localToGoogle } from './event-mapper.ts';

/** A row to relink: the owner's own event, or a participant's link row of someone else's event. */
export type BackfillLink =
  | { kind: 'owner'; userId: number; eventId: number; googleEventId: string; via: 'marker' | 'slot' }
  | { kind: 'participant'; userId: number; eventId: number; googleEventId: string; via: 'marker' | 'slot' };

/** What one calendar's comparison found. Counts only: nothing here names an event. */
export interface BackfillCounts {
  /** Live events the calendar lists. */
  googleListed: number;
  /** Of those, the ones carrying the bot-event marker. */
  googleBotCopies: number;
  /** Bot copies a row of the user already points at. */
  alreadyLinked: number;
  /** Bot copies no row points at. */
  looseCopies: number;
  /** Rows without a Google id (owner rows and participant link rows). */
  unlinkedRows: number;
  linkableByMarker: number;
  linkableBySlot: number;
  /** Rows or copies with more than one candidate: left alone. */
  ambiguous: number;
  /** Loose copies of an event that has no live row to link (deleted in the bot, or not this user's). */
  copiesWithoutRow: number;
  /** Loose copies of an event whose row already points at another copy (a duplicate left in Google). */
  extraCopiesOfLinkedEvent: number;
  /** Rows without a Google id that no copy matched. */
  rowsWithoutCopy: number;
}

export interface BackfillPlan {
  userId: number;
  counts: BackfillCounts;
  links: BackfillLink[];
  /** Copies this plan found more than one candidate for and so did not link: no other plan may link them either. */
  contestedCopyIds: string[];
}

export interface BackfillApplied {
  applied: number;
  /** Rows that changed since the plan was made (linked or edited meanwhile); left alone. */
  skippedChanged: number;
}

interface UnlinkedOwnerRow {
  kind: 'owner';
  event: CalendarEvent;
}
interface UnlinkedParticipantRow {
  kind: 'participant';
  event: CalendarEvent;
  syncStatus: string;
}
type UnlinkedRow = UnlinkedOwnerRow | UnlinkedParticipantRow;

const NO_ID = "(google_event_id IS NULL OR google_event_id = '')";

/** The instant (timed) or day (all-day) an event's start or end names, in one comparable spelling. */
function slotOf(time: calendar_v3.Schema$EventDateTime | undefined): string | null {
  if (time?.dateTime) {
    const ms = Date.parse(time.dateTime);
    return Number.isNaN(ms) ? null : `T${ms}`;
  }
  return time?.date ? `D${time.date}` : null;
}

function slotKey(event: Pick<calendar_v3.Schema$Event, 'summary' | 'start' | 'end'>): string | null {
  const start = slotOf(event.start);
  const end = slotOf(event.end);
  return start && end && event.summary ? `${event.summary}\u0000${start}\u0000${end}` : null;
}

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string | null): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    if (key === null) continue;
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

/**
 * Whether any row, of any user, points at this Google event. A copy another user's row owns is not
 * this user's to claim: two users can share one Google calendar and each link keeps its own copy.
 */
function isLinked(db: Database, googleEventId: string): boolean {
  return (
    db
      .query(
        `SELECT 1 FROM events WHERE google_event_id = ?
         UNION ALL SELECT 1 FROM participant_google_sync WHERE google_event_id = ? LIMIT 1`,
      )
      .get(googleEventId, googleEventId) !== null
  );
}

/**
 * The rows that could own a copy but point at none: the user's own events (a group event's own copy
 * is the participant link, never an owner row) and the user's link rows to other people's events.
 */
function unlinkedRows(db: Database, userId: number): UnlinkedRow[] {
  const own = db
    .query<CalendarEvent, [number]>(
      `SELECT * FROM events WHERE user_id = ? AND is_deleted = 0 AND owner_type = 'user' AND ${NO_ID}`,
    )
    .all(userId);
  const links = db
    .query<{ event_id: number; sync_status: string }, [number]>(
      `SELECT event_id, sync_status FROM participant_google_sync WHERE user_id = ? AND ${NO_ID}`,
    )
    .all(userId);
  const rows: UnlinkedRow[] = own.map((event) => ({ kind: 'owner', event }));
  for (const link of links) {
    const event = db
      .query<CalendarEvent, [number]>('SELECT * FROM events WHERE id = ? AND is_deleted = 0')
      .get(link.event_id);
    if (event) rows.push({ kind: 'participant', event, syncStatus: link.sync_status });
  }
  return rows;
}

/** Whether the row claims a copy exists (it was queued for or reported as synced), not a row that never left the bot. */
function claimsCopy(row: UnlinkedRow): boolean {
  const status = row.kind === 'owner' ? row.event.sync_status : row.syncStatus;
  return status !== 'local_only';
}

/** What the two matching phases accumulate for one user. */
interface MatchState {
  db: Database;
  userId: number;
  counts: BackfillCounts;
  links: BackfillLink[];
  /** Rows a phase has decided about (linked, or left ambiguous): the next phase skips them. */
  taken: Set<UnlinkedRow>;
  contestedCopyIds: Set<string>;
}

function markContested(state: MatchState, copies: readonly calendar_v3.Schema$Event[]): void {
  for (const copy of copies) if (copy.id) state.contestedCopyIds.add(copy.id);
}

/** Whether the user has a live row (owner row or link row) of this bot event, linked or not. */
function userHasRowOfEvent(db: Database, userId: number, eventId: number): boolean {
  const found = db
    .query<{ n: number }, [number, number, number, number]>(
      `SELECT (SELECT COUNT(*) FROM events WHERE id = ? AND user_id = ? AND is_deleted = 0)
            + (SELECT COUNT(*) FROM participant_google_sync WHERE event_id = ? AND user_id = ?) AS n`,
    )
    .get(eventId, userId, eventId, userId);
  return found !== null && found.n > 0;
}

/** Phase 1: copies that carry the marker of a bot event, matched to that event's unlinked rows. */
function matchByMarker(
  state: MatchState,
  rows: readonly UnlinkedRow[],
  looseCopies: readonly calendar_v3.Schema$Event[],
): void {
  const rowsByEvent = groupBy(rows, (row) => String(row.event.id));
  const copiesByMarker = groupBy(looseCopies, (copy) => copy.extendedProperties?.private?.[BOT_EVENT_MARKER] ?? null);
  for (const [marker, copies] of copiesByMarker) {
    const candidates = rowsByEvent.get(marker) ?? [];
    for (const row of candidates) state.taken.add(row);
    const [only] = candidates;
    const [copy] = copies;
    if (candidates.length === 0) {
      if (userHasRowOfEvent(state.db, state.userId, Number(marker) || 0)) {
        state.counts.extraCopiesOfLinkedEvent += copies.length;
      } else {
        state.counts.copiesWithoutRow += copies.length;
      }
    } else if (only && copy?.id && candidates.length === 1 && copies.length === 1) {
      state.counts.linkableByMarker++;
      state.links.push({
        kind: only.kind,
        userId: state.userId,
        eventId: only.event.id,
        googleEventId: copy.id,
        via: 'marker',
      });
    } else {
      state.counts.ambiguous++;
      markContested(state, copies);
    }
  }
}

/**
 * Phase 2: rows that claim a copy and found none by marker: the same summary and times, one row and
 * one copy, among copies that carry no bot marker at all (a copy marked for any bot event belongs to
 * that event).
 */
function matchBySlot(state: MatchState, rows: readonly UnlinkedRow[], live: readonly calendar_v3.Schema$Event[]): void {
  const slotRows = rows.filter(
    (row) =>
      !state.taken.has(row) && claimsCopy(row) && !row.event.recurrence_rule && row.event.parent_event_id === null,
  );
  const slotCopies = live.filter(
    (copy) =>
      copy.extendedProperties?.private?.[BOT_EVENT_MARKER] === undefined &&
      !copy.recurrence?.length &&
      !isLinked(state.db, copy.id ?? ''),
  );
  const copiesBySlot = groupBy(slotCopies, slotKey);
  const rowsBySlot = groupBy(slotRows, (row) => slotKey(localToGoogle(row.event)));
  for (const row of slotRows) {
    const key = slotKey(localToGoogle(row.event));
    const matches = key === null ? [] : (copiesBySlot.get(key) ?? []);
    const peers = key === null ? [] : (rowsBySlot.get(key) ?? []);
    const [match] = matches;
    if (!match?.id) continue;
    if (matches.length === 1 && peers.length === 1) {
      state.counts.linkableBySlot++;
      state.links.push({
        kind: row.kind,
        userId: state.userId,
        eventId: row.event.id,
        googleEventId: match.id,
        via: 'slot',
      });
      state.taken.add(row);
    } else {
      state.counts.ambiguous++;
      markContested(state, matches);
    }
  }
}

/**
 * Compares the live events of the user's calendar with the rows that have no Google id. A copy is
 * matched to a row only when the match is the single candidate on both sides: first through the
 * bot-event marker the copy carries, then, for rows that claim a copy and found none, through
 * (summary, start, end) on copies that carry no marker. Read-only.
 */
export function planGoogleIdBackfill(
  db: Database,
  userId: number,
  calendarEvents: readonly calendar_v3.Schema$Event[],
): BackfillPlan {
  // An instance of a series is not a copy of an event of its own, whatever properties it inherits.
  const live = calendarEvents.filter((copy) => copy.id && copy.status !== 'cancelled' && !copy.recurringEventId);
  const rows = unlinkedRows(db, userId);
  const botCopies = live.filter((copy) => copy.extendedProperties?.private?.[BOT_EVENT_MARKER] !== undefined);
  const loose = botCopies.filter((copy) => !isLinked(db, copy.id ?? ''));
  const state: MatchState = {
    db,
    userId,
    counts: {
      googleListed: live.length,
      googleBotCopies: botCopies.length,
      alreadyLinked: botCopies.length - loose.length,
      looseCopies: loose.length,
      unlinkedRows: rows.length,
      linkableByMarker: 0,
      linkableBySlot: 0,
      ambiguous: 0,
      copiesWithoutRow: 0,
      extraCopiesOfLinkedEvent: 0,
      rowsWithoutCopy: 0,
    },
    links: [],
    taken: new Set(),
    contestedCopyIds: new Set(),
  };
  matchByMarker(state, rows, loose);
  matchBySlot(state, rows, live);
  state.counts.rowsWithoutCopy = rows.filter((row) => !state.taken.has(row)).length;

  syncLogger.info(state.counts, 'Google id backfill planned');
  return { userId, counts: state.counts, links: state.links, contestedCopyIds: [...state.contestedCopyIds] };
}

/**
 * Writes the planned ids in one transaction, each only if its row still has no id and no row of any
 * user already points at that copy; a row that changed since the plan is counted and left
 * alone. Nothing else is written but a log row per link naming the way it was found. Idempotent:
 * a second plan finds the rows linked.
 */
export function applyGoogleIdBackfill(db: Database, plan: BackfillPlan): BackfillApplied {
  const result: BackfillApplied = { applied: 0, skippedChanged: 0 };
  db.transaction(() => {
    for (const link of plan.links) {
      if (!writeMissingId(db, link)) {
        result.skippedChanged++;
        continue;
      }
      db.query(
        `INSERT INTO sync_log (user_id, event_id, google_event_id, direction, action, details)
         VALUES (?, ?, ?, 'pull', 'update', ?)`,
      ).run(
        link.userId,
        link.eventId,
        link.googleEventId,
        JSON.stringify({ reason: 'google_id_backfill', via: link.via, kind: link.kind }),
      );
      result.applied++;
    }
  }).immediate();
  syncLogger.info(result, 'Google id backfill applied');
  return result;
}

/**
 * Drops every link whose copy more than one plan wants and counts it as ambiguous: two users can share
 * one Google calendar, each with a row that matches the same copy, and which of them owns it cannot be
 * told, so neither is linked.
 */
export function dropContestedLinks(plans: readonly BackfillPlan[]): BackfillPlan[] {
  const claims = new Map<string, number>();
  for (const plan of plans) {
    for (const id of [...plan.links.map((link) => link.googleEventId), ...plan.contestedCopyIds]) {
      claims.set(id, (claims.get(id) ?? 0) + 1);
    }
  }
  return plans.map((plan) => {
    const links = plan.links.filter((link) => claims.get(link.googleEventId) === 1);
    const counts: BackfillCounts = {
      ...plan.counts,
      linkableByMarker: links.filter((link) => link.via === 'marker').length,
      linkableBySlot: links.filter((link) => link.via === 'slot').length,
      ambiguous: plan.counts.ambiguous + plan.links.length - links.length,
    };
    return { ...plan, links, counts };
  });
}

/** Sets the id on a row that still has none while no row of any user points at that copy. True when written. */
function writeMissingId(db: Database, link: BackfillLink): boolean {
  if (isLinked(db, link.googleEventId)) return false;
  const { changes } =
    link.kind === 'owner'
      ? db
          .query(`UPDATE events SET google_event_id = ? WHERE id = ? AND user_id = ? AND is_deleted = 0 AND ${NO_ID}`)
          .run(link.googleEventId, link.eventId, link.userId)
      : db
          .query(
            `UPDATE participant_google_sync SET google_event_id = ?
             WHERE user_id = ? AND event_id = ? AND ${NO_ID}
               AND EXISTS (SELECT 1 FROM events WHERE id = participant_google_sync.event_id AND is_deleted = 0)`,
          )
          .run(link.googleEventId, link.userId, link.eventId);
  return changes === 1;
}

/**
 * A verified copy of the whole database at `backupPath` (0600, never replacing a file): VACUUM INTO a
 * private staging directory, quick_check, fsync, then a no-clobber hard link. Throws before any write
 * the caller plans if it cannot.
 */
export function createVerifiedBackup(db: Database, backupPath: string): void {
  const target = resolve(backupPath);
  const staging = mkdtempSync(join(dirname(target), '.hcb-backup-'));
  try {
    const snapshot = join(staging, 'snapshot.db');
    db.query('VACUUM INTO ?').run(snapshot);
    chmodSync(snapshot, 0o600);
    const saved = new Database(snapshot, { readonly: true, create: false });
    try {
      const check = saved.query<{ quick_check: string }, []>('PRAGMA quick_check').all();
      if (check.length !== 1 || check[0]?.quick_check !== 'ok') throw new Error('Backup integrity check failed');
    } finally {
      saved.close();
    }
    const fd = openSync(snapshot, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    linkSync(snapshot, target); // EEXIST if the name is taken: a backup is never overwritten
    const dirFd = openSync(dirname(target), 'r');
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
