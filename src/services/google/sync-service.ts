// src/services/google/sync-service.ts
import type { Database } from 'bun:sqlite';
import type { calendar_v3 } from 'googleapis';
import { type Lang, t } from '../../config/constants.ts';
import { GOOGLE_CALENDAR_WEBHOOK_PATH, publicUrl } from '../../config/public-url.ts';
import type { EventRepository } from '../../database/repositories/event.repository.ts';
import type { GoogleCalendarRepository } from '../../database/repositories/google-calendar.repository.ts';
import type { GoogleSyncRepository } from '../../database/repositories/google-sync.repository.ts';
import type { ParticipantGoogleSyncRepository } from '../../database/repositories/participant-google-sync.repository.ts';
import type { CalendarEvent, ParticipantGoogleSync } from '../../database/types.ts';
import { storedInstantMs } from '../../utils/date.ts';
import { syncLogger } from '../../utils/logger.ts';
import type { EventChangeNotifier } from '../event/event-change-notifier.ts';
import { expandRecurrence } from '../event/recurrence.ts';
import { type GoogleCalendarApi, googleGoneStatus } from './calendar-api.ts';
import { computeEventDiff, snapshotFromCalendarEvent, snapshotFromGoogleLocal } from './change-detection.ts';
import {
  BOT_EVENT_MARKER,
  type GoogleEvent,
  googleToLocal,
  type LocalEventFromGoogle,
  localToGoogle,
} from './event-mapper.ts';
import {
  handleParticipantChange,
  handleParticipantDelete,
  type ParticipantHandlerDeps,
} from './participant-change-handler.ts';

/** Side effect to run after the pull's transaction committed; null when nothing is to be sent. */
type PendingNotification = (() => Promise<void>) | null;

/** How a Google copy of a bot event got linked: inserted now, or found by its marker (made by an earlier attempt). */
type CopyOrigin = 'inserted' | 'adopted_by_marker';

/** A Google copy of a bot event whose id is known, with the way it was reached. */
interface LinkedCopy {
  id: string;
  etag: string | undefined;
  origin: CopyOrigin;
  /** Further adoptable live copies with the same marker (left by the old replay of a lost insert); never touched. */
  duplicates: number;
}

/** A participant's linked Google copy about to be updated. */
interface ParticipantCopy {
  link: ParticipantGoogleSync;
  calendarId: string;
  googleEventId: string;
  gEvent: GoogleEvent;
}

/** sync_log details of a participant copy that Google reported gone (#728). */
interface GoneParticipantCopyEvidence {
  reason: 'participant_copy_gone';
  http_status: 404 | 410;
  probe: 'skipped' | 'cancelled' | 'not_found';
  outcome: 'unlinked' | 'declined' | 'recreated';
  stale_google_event_id: string;
  new_google_event_id?: string;
}

/** Counters of one incremental pull, written to the log line that ends it. */
interface PullStats {
  userId: number;
  calendarId: string;
  pages: number;
  /** Items Google returned, tombstones included. */
  items: number;
  /** Events removed because Google reported them deleted. */
  deleted: number;
  /** Occurrences of a series cancelled because Google reported them deleted. */
  occurrencesCancelled: number;
  /** The user's own copies of someone else's event that were deleted in Google (a decline). */
  participantCopiesDeleted: number;
  /** Tombstones of events the bot has no live row for (its own deletions echoing back, foreign events). */
  unmatchedTombstones: number;
  /** Copies the bot pushed that were read as changed; their edits are not read back (#224). */
  botCopiesSkipped: number;
}

/** Counters of one reconcile of a calendar against a complete Google read. */
interface ReconcileResult {
  userId: number;
  calendarId: string;
  /** Live events of the user linked to a Google event of this calendar. */
  tracked: number;
  /** Events the complete read listed. */
  listed: number;
  removed: number;
  skippedPending: number;
  skippedFresh: number;
  /** The removal was not applied because it would have emptied most of the calendar. */
  refused: boolean;
}

/** Why a deletion was applied; written to the `reason` of its sync_log receipt. */
type GoogleDeleteReason = 'cancelled_in_google' | 'absent_in_full_list' | 'occurrence_cancelled_in_google';

/** A reconcile never removes more than half of a calendar's linked events at once once this many are missing. */
const RECONCILE_REFUSE_MIN = 3;

/** Oldest first; an equal creation time falls back to the id. Plain code-unit order, not the locale's, so every machine picks the same copy. */
function byCreatedThenId(a: calendar_v3.Schema$Event, b: calendar_v3.Schema$Event): number {
  return compareText(a.created ?? '', b.created ?? '') || compareText(a.id ?? '', b.id ?? '');
}

function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

const DAY_MS = 86_400_000;

/**
 * Whether an event needs no "cancelled" message to its participants: a one-off event that has ended.
 * A series always counts as upcoming, because the end of its last occurrence is not tracked. An
 * all-day event without an end lasts until the end of its day.
 */
function eventIsOver(event: CalendarEvent): boolean {
  if (event.recurrence_rule) return false;
  const endMs = event.end_at
    ? storedInstantMs(event.end_at)
    : storedInstantMs(event.start_at) + (event.all_day ? DAY_MS : 0);
  return endMs < Date.now();
}

/** The calendar day an instant falls on in a time zone, as `YYYY-MM-DD`. */
function localDay(instantMs: number, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(instantMs);
  } catch {
    return new Date(instantMs).toISOString().slice(0, 10);
  }
}

/**
 * The start the series' rule gave an occurrence Google names in `originalStartTime`, as the ISO
 * instant `expandRecurrence` produces for it (the identity of a recurrence exception). A timed
 * occurrence is that instant; an all-day one names a day, resolved to the series' own occurrence on
 * that day in its time zone, because the bot stores an all-day start as UTC midnight or as local midnight.
 */
function occurrenceOriginalStart(series: CalendarEvent, time: GoogleEvent['originalStartTime']): string | null {
  if (time?.dateTime) {
    const ms = Date.parse(time.dateTime);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  }
  if (!time?.date) return null;
  const dayMs = Date.parse(time.date);
  if (Number.isNaN(dayMs)) return null;
  // An occurrence's local day can sit up to 14 h either side of the UTC day Google names (zone offsets),
  // so the window reaches a day and a half back and two and a half days forward.
  const nearby = expandRecurrence(
    series,
    [],
    new Date(dayMs - 1.5 * DAY_MS).toISOString(),
    new Date(dayMs + 2.5 * DAY_MS).toISOString(),
  );
  // The bot stores an all-day start as UTC midnight (the day written) or as local midnight; a UTC-midnight
  // occurrence is that UTC day, any other is its day in the series' zone.
  const dayOf = (occurrenceStart: string): string =>
    occurrenceStart.endsWith('T00:00:00.000Z')
      ? occurrenceStart.slice(0, 10)
      : localDay(Date.parse(occurrenceStart), series.timezone);
  // A bot-pushed local-midnight series reaches Google under its UTC date part (localToGoogle), so that
  // spelling is the fallback when no occurrence has the date as its own day.
  const onDay =
    nearby.find((occurrence) => dayOf(occurrence.occurrence_start) === time.date) ??
    nearby.find((occurrence) => occurrence.occurrence_start.slice(0, 10) === time.date);
  return onDay ? new Date(onDay.occurrence_start).toISOString() : null;
}

/** Why a reconcile must keep a row (counted), or null when the read proves its Google copy gone. */
function reconcileKeepReason(event: CalendarEvent, readStartedAt: number): 'pending' | 'fresh' | null {
  if (event.sync_status === 'pending_push') return 'pending';
  // A margin: stored sync times can be second-precise while the read start is not.
  if (storedInstantMs(event.last_synced_at ?? event.created_at) > readStartedAt - 5000) return 'fresh';
  return null;
}

function countKeptEvent(result: ReconcileResult, reason: 'pending' | 'fresh'): void {
  if (reason === 'pending') result.skippedPending++;
  else result.skippedFresh++;
}

/** Tracked events missing from the full list and not kept; kept ones are counted into `result`. */
function selectAbsentEvents(
  tracked: CalendarEvent[],
  live: ReadonlySet<string>,
  readStartedAt: number,
  result: ReconcileResult,
): CalendarEvent[] {
  const gone: CalendarEvent[] = [];
  for (const event of tracked) {
    if (!event.google_event_id || live.has(event.google_event_id)) continue;
    const reason = reconcileKeepReason(event, readStartedAt);
    if (reason) countKeptEvent(result, reason);
    else gone.push(event);
  }
  return gone;
}

/** An empty list while events are linked, or most of them missing at once, points at a wrong read. */
function reconcileLooksWrong(listedCount: number, goneCount: number, trackedCount: number): boolean {
  const emptyRead = listedCount === 0 && goneCount > 0;
  return emptyRead || (goneCount >= RECONCILE_REFUSE_MIN && goneCount * 2 > trackedCount);
}

export class SyncService {
  constructor(
    private db: Database,
    private eventRepo: EventRepository,
    private syncRepo: GoogleSyncRepository,
    private calendarRepo: GoogleCalendarRepository,
    private notifyUser?: (userId: number, message: string) => Promise<void>,
    private getUserLang?: (userId: number) => Lang,
    private participantSyncRepo?: ParticipantGoogleSyncRepository,
    private changeNotifier?: EventChangeNotifier,
    private participantHandlerDeps?: ParticipantHandlerDeps,
  ) {}

  /**
   * A full read of the calendar: imports what the bot does not have yet and stores the sync token the
   * next pulls continue from. `removeAbsent` is set when Google expired the old token (410): the delta
   * that carried the deletions is lost, so the read ends by removing the events it no longer lists. A
   * first read after connecting never removes anything.
   */
  async initialSync(
    api: GoogleCalendarApi,
    userId: number,
    calendarId: string,
    opts: { removeAbsent: boolean } = { removeAbsent: false },
  ): Promise<number> {
    const readStartedAt = Date.now();
    const live = new Set<string>();
    let pageToken: string | undefined;
    let nextSyncToken: string | null = null;
    let totalImported = 0;

    do {
      const result = await api.listEvents(calendarId, { pageToken });

      const insertBatch = this.db.transaction(() => {
        for (const gEvent of result.events) {
          if (gEvent.status === 'cancelled') continue;
          if (gEvent.id) live.add(gEvent.id);
          if (gEvent.extendedProperties?.private?.[BOT_EVENT_MARKER]) continue;

          const local = googleToLocal(gEvent as GoogleEvent, userId, calendarId);
          this.eventRepo.insertSyncedEvent({
            user_id: userId,
            title: local.title,
            description: local.description,
            start_at: local.start_at,
            end_at: local.end_at,
            all_day: local.all_day,
            timezone: local.timezone,
            location: local.location,
            recurrence_rule: local.recurrence_rule,
            google_calendar_id: calendarId,
            google_event_id: local.google_event_id,
            google_etag: local.google_etag,
            is_cancelled: local.is_cancelled ?? false,
          });
          totalImported++;
        }
      });
      insertBatch();

      pageToken = result.nextPageToken ?? undefined;
      nextSyncToken = result.nextSyncToken;
    } while (pageToken);

    const cal = this.calendarRepo.getCalendarByGoogleId(userId, calendarId);
    syncLogger.info({ userId, calendarId, totalImported }, 'Initial sync completed');
    if (opts.removeAbsent) {
      await this.removeEventsAbsentFromList(
        userId,
        calendarId,
        cal?.is_primary === 1,
        live,
        readStartedAt,
        'token_reset',
      );
    }
    // Stored last, after the repair above: a token that moved on would hide a repair that failed.
    if (cal && nextSyncToken) {
      this.calendarRepo.updateSyncToken(cal.id, nextSyncToken);
    }
    return totalImported;
  }

  /**
   * Applies every change since the stored sync token. Google splits a long delta into pages read with
   * the same sync token; only the last page carries the next token, stored after every page was
   * applied. A failure on any page keeps the old token, so the next pull reads the whole delta again
   * (a deletion already applied then finds no live row and changes nothing). Every pull ends with one
   * counter line, a failed one with the counters reached so far.
   */
  async incrementalPull(api: GoogleCalendarApi, userId: number, calendarId: string): Promise<void> {
    const cal = this.calendarRepo.getCalendarByGoogleId(userId, calendarId);
    if (!cal?.sync_token) {
      await this.initialSync(api, userId, calendarId);
      return;
    }

    const primaryCalendar = cal.is_primary === 1;
    const stats: PullStats = {
      userId,
      calendarId,
      pages: 0,
      items: 0,
      deleted: 0,
      occurrencesCancelled: 0,
      participantCopiesDeleted: 0,
      unmatchedTombstones: 0,
      botCopiesSkipped: 0,
    };
    let pageToken: string | undefined;
    let nextSyncToken: string | null = null;
    try {
      do {
        const result = await api.listEvents(calendarId, { syncToken: cal.sync_token, pageToken });
        stats.pages++;
        stats.items += result.events.length;

        for (const gEvent of result.events) {
          if (gEvent.status === 'cancelled') {
            await this.handleDeletedEvent(userId, calendarId, gEvent as GoogleEvent, primaryCalendar, stats);
          } else if (gEvent.extendedProperties?.private?.[BOT_EVENT_MARKER]) {
            stats.botCopiesSkipped++;
          } else {
            await this.handleUpdatedOrNewEvent(userId, calendarId, gEvent as GoogleEvent);
          }
        }

        pageToken = result.nextPageToken ?? undefined;
        nextSyncToken = result.nextSyncToken;
      } while (pageToken);
    } catch (err: unknown) {
      const error = err as { code?: number };
      if (error.code === 410) {
        syncLogger.warn(stats, 'Sync token expired, falling back to full sync');
        // The old token stays until the full read has been applied: a failed read or repair makes the
        // next pull hit the 410 again and repeat the repair, instead of continuing without it.
        await this.initialSync(api, userId, calendarId, { removeAbsent: true });
        return;
      }
      syncLogger.error({ ...stats, err }, 'Google pull failed');
      throw err;
    }

    if (nextSyncToken) {
      this.calendarRepo.updateSyncToken(cal.id, nextSyncToken);
    }

    syncLogger.info(stats, 'Google pull applied');
  }

  /**
   * Pushes one event's change to Google. The scheduled `action` is a hint: a row that has a Google
   * id is updated, one that has none gets its copy created, because the row can have changed since
   * the push was queued (a second create must never insert a second copy, an update has nothing to
   * address without an id). A delete is the one action taken as asked.
   */
  async pushEvent(
    api: GoogleCalendarApi,
    userId: number,
    eventId: number,
    action: 'create' | 'update' | 'delete',
  ): Promise<void> {
    const event = this.eventRepo.findById(eventId, userId);
    if (!event || event.sync_status !== 'pending_push') return;

    const calendarId = event.google_calendar_id ?? 'primary';

    if (action === 'delete') {
      if (event.google_event_id) {
        await api.deleteEvent(calendarId, event.google_event_id);
      }
      this.eventRepo.remove(eventId, userId);
      this.logPush(userId, eventId, 'delete', event.google_event_id ?? undefined);
      return;
    }

    if (event.google_event_id) {
      const updated = await api.updateEvent(calendarId, event.google_event_id, localToGoogle(event));
      this.eventRepo.updateSyncFields(eventId, {
        google_etag: updated.etag ?? undefined,
        sync_status: 'synced',
        last_synced_at: new Date().toISOString(),
      });
      this.logPush(userId, eventId, 'update', event.google_event_id);
      return;
    }

    await this.ensureCopy(api, calendarId, eventId, localToGoogle(event), (copy) => {
      this.eventRepo.updateSyncFields(eventId, {
        google_event_id: copy.id,
        google_etag: copy.etag ?? undefined,
        sync_status: 'synced',
        last_synced_at: new Date().toISOString(),
      });
      const duplicates = copy.duplicates > 0 ? { duplicates: copy.duplicates } : {};
      this.logPush(userId, eventId, 'create', copy.id, JSON.stringify({ via: copy.origin, ...duplicates }));
    });
  }

  private logPush(
    userId: number,
    eventId: number,
    action: 'create' | 'update' | 'delete',
    googleEventId: string | undefined,
    details?: string,
  ): void {
    this.syncRepo.logSync({
      user_id: userId,
      event_id: eventId,
      google_event_id: googleEventId,
      direction: 'push',
      action,
      details,
    });
  }

  /**
   * Makes bot event `eventId` exist in Google exactly once and hands the copy to `onLinked`, which runs
   * in one transaction (the link and the creation receipt both carry the id, or neither is written).
   * The calendar is searched for the copy before anything is inserted: an earlier attempt may have
   * created it and lost the answer (a timeout, a restart while the job ran, a failed write afterwards),
   * and unknown completion is not failure. A copy found is updated to the current body and adopted;
   * with several, the oldest is. A copy some row already points at is never adopted: two users can
   * share one Google calendar, and each link keeps its own copy. The same check runs again inside the
   * transaction, right before the link is written, so a copy another job linked while this one was
   * awaiting Google is never linked twice (the sync worker runs one job at a time; this keeps the
   * guarantee if that ever changes). One extra read per creation buys all of this for retries,
   * restarts and relinking after a disconnect alike, with no state to persist before the insert. An
   * insert whose answer has no id is an error: the next attempt finds that copy.
   */
  private async ensureCopy(
    api: GoogleCalendarApi,
    calendarId: string,
    eventId: number,
    gEvent: GoogleEvent,
    onLinked: (copy: LinkedCopy) => void,
  ): Promise<void> {
    const found = await api.findBotEventCopies(calendarId, eventId);
    const [oldest, ...newer] = found.filter((candidate) => this.isAdoptable(candidate)).sort(byCreatedThenId);

    let copy: LinkedCopy;
    if (oldest?.id) {
      const updated = await api.updateEvent(calendarId, oldest.id, gEvent);
      copy = { id: oldest.id, etag: updated.etag ?? undefined, origin: 'adopted_by_marker', duplicates: newer.length };
    } else {
      const created = await api.insertEvent(calendarId, gEvent);
      if (!created.id) {
        throw new Error(`Google answered the insert of event ${eventId} without an event id`);
      }
      copy = { id: created.id, etag: created.etag ?? undefined, origin: 'inserted', duplicates: 0 };
    }

    this.db.transaction(() => {
      if (this.isLinkedToRow(copy.id)) {
        throw new Error(`Google copy ${copy.id} of event ${eventId} was linked to another row meanwhile`);
      }
      onLinked(copy);
    })();
    const evidence = { eventId, googleEventId: copy.id, origin: copy.origin, duplicates: copy.duplicates };
    if (copy.duplicates > 0) {
      syncLogger.warn(
        evidence,
        'Google copy linked; several copies carry this bot event marker, the others are left alone',
      );
    } else {
      syncLogger.info(evidence, 'Google copy linked');
    }
  }

  /** A live copy of the event itself (not an instance of a series) that no row points at yet. */
  private isAdoptable(copy: calendar_v3.Schema$Event): boolean {
    if (!copy.id || copy.status === 'cancelled' || copy.recurringEventId) return false;
    return !this.isLinkedToRow(copy.id);
  }

  /** Whether any row, of any user, points at this Google event. */
  private isLinkedToRow(googleEventId: string): boolean {
    return (
      this.db
        .query(
          `SELECT 1 FROM events WHERE google_event_id = ?
           UNION ALL SELECT 1 FROM participant_google_sync WHERE google_event_id = ? LIMIT 1`,
        )
        .get(googleEventId, googleEventId) !== null
    );
  }

  resolveConflict(localEvent: CalendarEvent, googleUpdatedAt: string): 'keep_local' | 'keep_google' {
    const localMs = new Date(localEvent.updated_at).getTime();
    const googleMs = new Date(googleUpdatedAt).getTime();
    return googleMs > localMs ? 'keep_google' : 'keep_local';
  }

  /**
   * Applies one tombstone (status=cancelled) of a delta. Google keeps the whole body of a deleted
   * event, including the marker of a copy the bot pushed, so a tombstone is recognised by its status
   * alone. The row is found through the primary-calendar alias (the bot stores no calendar id for what
   * it pushed). A cancelled occurrence of a series cancels that occurrence of the series, and the row
   * the bot may hold for the occurrence's own id goes with it.
   */
  private async handleDeletedEvent(
    userId: number,
    calendarId: string,
    gEvent: GoogleEvent,
    primaryCalendar: boolean,
    stats: PullStats,
  ): Promise<void> {
    const googleEventId = gEvent.id;
    if (!googleEventId) {
      stats.unmatchedTombstones++;
      return;
    }
    const existing = this.eventRepo.findByGoogleEventId(userId, calendarId, googleEventId, { primaryCalendar });
    const occurrence = gEvent.recurringEventId
      ? this.cancelOccurrenceDeletedInGoogle(userId, calendarId, gEvent, primaryCalendar)
      : 'no_series';
    if (occurrence === 'cancelled') stats.occurrencesCancelled++;

    if (existing?.parent_event_id) {
      this.applyTombstoneToExceptionRow(existing, occurrence, stats);
      return;
    }
    if (existing) {
      await this.removeEventGoneFromGoogle(existing, 'cancelled_in_google', !eventIsOver(existing));
      stats.deleted++;
      return;
    }
    if (occurrence !== 'no_series') return;

    if (await this.deleteParticipantCopyForTombstone(userId, calendarId, googleEventId, primaryCalendar, stats)) return;
    stats.unmatchedTombstones++;
  }

  /**
   * An exception row that carries the occurrence's Google id stays, as the cancelled occurrence
   * (cancelOccurrenceDeletedInGoogle already did that when the series is known).
   */
  private applyTombstoneToExceptionRow(
    existing: CalendarEvent,
    occurrence: 'cancelled' | 'already_cancelled' | 'no_series',
    stats: PullStats,
  ): void {
    if (occurrence !== 'no_series') return;
    if (!existing.is_cancelled) this.cancelExceptionRow(existing);
    else stats.unmatchedTombstones++;
  }

  /** True when the tombstone was the echo of the bot's own removal of a participant's copy and was handled. */
  private async deleteParticipantCopyForTombstone(
    userId: number,
    calendarId: string,
    googleEventId: string,
    primaryCalendar: boolean,
    stats: PullStats,
  ): Promise<boolean> {
    const participantSync = this.participantSyncRepo?.getByUserAndGoogleEventId(userId, googleEventId);
    if (
      !participantSync ||
      !this.participantHandlerDeps ||
      !this.isCopyInCalendar(participantSync, calendarId, primaryCalendar)
    ) {
      return false;
    }
    // An event the bot itself deleted: its removal of the participant's copy echoes back as this tombstone.
    const master = this.eventRepo.findByIdUnfiltered(participantSync.event_id);
    if (!master) return false;
    await handleParticipantDelete(userId, participantSync, this.participantHandlerDeps);
    stats.participantCopiesDeleted++;
    return true;
  }

  /**
   * Whether a participant's linked copy lives in the calendar being read. Participant copies go to
   * `primary` (pushParticipantEvent), which the user's primary calendar owns, the same alias rule as
   * GOOGLE_CALENDAR_OWNS_SQL for the user's own events.
   */
  private isCopyInCalendar(copy: ParticipantGoogleSync, calendarId: string, primaryCalendar: boolean): boolean {
    const copyCalendar = copy.google_calendar_id;
    return copyCalendar === calendarId || (primaryCalendar && (!copyCalendar || copyCalendar === 'primary'));
  }

  /** The durable receipt of a deletion read from Google: `reason` plus what the case adds. */
  private logGoogleDelete(
    row: { user_id: number; id: number; google_event_id?: string | null },
    reason: GoogleDeleteReason,
    extra: Record<string, string | boolean> = {},
  ): void {
    this.syncRepo.logSync({
      user_id: row.user_id,
      event_id: row.id,
      google_event_id: row.google_event_id ?? undefined,
      direction: 'pull',
      action: 'delete',
      details: JSON.stringify({ reason, ...extra }),
    });
  }

  /**
   * Removes an event whose Google copy is gone and leaves a durable receipt in sync_log. The notifier
   * reads the participants and open invitations before its first await (see onEventDeleted), so it is
   * started first and the row is removed right after, as EventService.deleteEvent does; it sends nothing
   * until the removal and the receipt are committed, and is abandoned when they fail. A retry therefore
   * finds either no live row (nothing is sent twice) or a live row nobody was told about.
   */
  private async removeEventGoneFromGoogle(
    event: CalendarEvent,
    reason: GoogleDeleteReason,
    notifyParticipants: boolean,
  ): Promise<void> {
    const gate = Promise.withResolvers<void>();
    // The notifier awaits the gate; this keeps one that returned early from leaving an unhandled rejection.
    gate.promise.catch(() => {});
    const notified = this.changeNotifier
      ?.onEventDeleted({ event, source: 'google_sync', notifyParticipants, committed: gate.promise })
      .catch((err: unknown) => {
        syncLogger.error({ err, eventId: event.id }, 'EventChangeNotifier.onEventDeleted failed for a Google deletion');
      });
    try {
      this.db.transaction(() => {
        this.eventRepo.remove(event.id, event.user_id);
        this.logGoogleDelete(event, reason, { notified_participants: notifyParticipants });
      })();
      gate.resolve();
    } catch (err) {
      gate.reject(err);
      throw err;
    }
    await notified;
  }

  /** Marks an exception row that carries the Google id of a deleted occurrence as cancelled, with a receipt. */
  private cancelExceptionRow(exception: CalendarEvent): void {
    this.db.transaction(() => {
      this.eventRepo.cancelException(exception.id);
      this.logGoogleDelete(exception, 'occurrence_cancelled_in_google');
    })();
  }

  /**
   * A deleted occurrence of a series becomes a cancelled recurrence exception, the same row
   * EventService.cancelOccurrence writes for a deletion made in the bot. Idempotent: an occurrence
   * that is already cancelled stays one exception.
   */
  private cancelOccurrenceDeletedInGoogle(
    userId: number,
    calendarId: string,
    gEvent: GoogleEvent,
    primaryCalendar: boolean,
  ): 'cancelled' | 'already_cancelled' | 'no_series' {
    if (!gEvent.recurringEventId) return 'no_series';
    const series = this.eventRepo.findByGoogleEventId(userId, calendarId, gEvent.recurringEventId, { primaryCalendar });
    if (!series?.recurrence_rule) return 'no_series';
    const original = occurrenceOriginalStart(series, gEvent.originalStartTime);
    if (!original) return 'no_series';

    const originalMs = Date.parse(original);
    const exception = this.eventRepo
      .getExceptions(series.id)
      .find(
        (candidate) =>
          (candidate.original_start_at !== null && storedInstantMs(candidate.original_start_at) === originalMs) ||
          (gEvent.id != null && candidate.google_event_id === gEvent.id),
      );
    if (exception?.is_cancelled) return 'already_cancelled';

    this.db.transaction(() => {
      if (exception) {
        this.eventRepo.cancelException(exception.id);
      } else {
        this.eventRepo.createException(series.id, {
          user_id: series.user_id,
          title: series.title,
          start_at: original,
          timezone: series.timezone,
          original_start_at: original,
          is_cancelled: true,
        });
      }
      this.logGoogleDelete({ ...series, google_event_id: gEvent.id }, 'occurrence_cancelled_in_google', {
        original_start_at: original,
      });
    })();
    return 'cancelled';
  }

  /**
   * Removes the events of one calendar whose Google copy a full read no longer lists. It repairs the
   * deletions an earlier pull missed (the delta that carried them is gone for good) without touching
   * the sync token. Throws when the read fails, and removes nothing then.
   */
  async reconcileDeletions(api: GoogleCalendarApi, userId: number, calendarId: string): Promise<ReconcileResult> {
    const cal = this.calendarRepo.getCalendarByGoogleId(userId, calendarId);
    const startedAt = Date.now();
    const live = new Set<string>();
    let pageToken: string | undefined;
    do {
      const result = await api.listEvents(calendarId, { pageToken });
      for (const gEvent of result.events) {
        if (gEvent.id && gEvent.status !== 'cancelled') live.add(gEvent.id);
      }
      pageToken = result.nextPageToken ?? undefined;
    } while (pageToken);
    return this.removeEventsAbsentFromList(userId, calendarId, cal?.is_primary === 1, live, startedAt, 'startup');
  }

  /**
   * `live` is every id a complete read of the calendar listed, `readStartedAt` when that read began,
   * `source` what ran the read (it labels the log lines). Kept: an event with a local edit waiting to
   * be pushed (its push decides), and one whose last sync is newer than the read (its Google copy may
   * simply have been created after the list was taken); both are checked again on the current row right
   * before each removal, because the notifier awaits between removals.
   * Refused: a read that lists nothing while events are linked, and more than half of the linked
   * events (at least three) missing at once. Both point at a wrong read, not at a user who deleted
   * that much (a real clear-out arrives as tombstones); the counts are logged at error level.
   */
  private async removeEventsAbsentFromList(
    userId: number,
    calendarId: string,
    primaryCalendar: boolean,
    live: ReadonlySet<string>,
    readStartedAt: number,
    source: 'startup' | 'token_reset',
  ): Promise<ReconcileResult> {
    const tracked = this.eventRepo.findLinkedToGoogleCalendar(userId, calendarId, { primaryCalendar });
    const result: ReconcileResult = {
      userId,
      calendarId,
      tracked: tracked.length,
      listed: live.size,
      removed: 0,
      skippedPending: 0,
      skippedFresh: 0,
      refused: false,
    };

    const gone = selectAbsentEvents(tracked, live, readStartedAt, result);

    if (reconcileLooksWrong(live.size, gone.length, tracked.length)) {
      result.refused = true;
      syncLogger.error({ ...result, source }, 'Google reconcile refused');
      return result;
    }
    for (const stale of gone) {
      const current = this.eventRepo.findById(stale.id, stale.user_id);
      // Gone, relinked to another Google event, edited or pushed since the list was read: not this read's to remove.
      if (!current || current.google_event_id !== stale.google_event_id) continue;
      const reason = reconcileKeepReason(current, readStartedAt);
      if (reason) {
        countKeptEvent(result, reason);
        continue;
      }
      await this.removeEventGoneFromGoogle(current, 'absent_in_full_list', false);
      result.removed++;
    }
    syncLogger.info({ ...result, source }, 'Google reconcile applied');
    return result;
  }

  private async handleUpdatedOrNewEvent(userId: number, calendarId: string, gEvent: GoogleEvent): Promise<void> {
    const local = googleToLocal(gEvent, userId, calendarId);

    const applyUpdate = this.db.transaction((): PendingNotification => {
      const existing = this.eventRepo.findByGoogleEventId(userId, calendarId, local.google_event_id);
      return existing
        ? this.applyPulledUpdate(existing, userId, calendarId, gEvent, local)
        : this.applyPulledNewEvent(userId, calendarId, gEvent, local);
    });
    const notify = applyUpdate();
    if (notify) await notify();
  }

  /** Pull-side conflict between a pending local push and a newer Google copy; Google wins unless local is newer. */
  private resolvePullConflict(
    existing: CalendarEvent,
    userId: number,
    gEvent: GoogleEvent,
    local: LocalEventFromGoogle,
  ): { keepLocal: true } | { keepLocal: false; notification: PendingNotification } {
    const winner = this.resolveConflict(existing, gEvent.updated ?? '');
    if (winner === 'keep_local') return { keepLocal: true };
    this.syncRepo.logSync({
      user_id: userId,
      event_id: existing.id,
      google_event_id: local.google_event_id,
      direction: 'pull',
      action: 'conflict_resolve',
      details: JSON.stringify({ winner: 'google' }),
    });
    if (!this.notifyUser) return { keepLocal: false, notification: null };
    const notifyUser = this.notifyUser;
    const conflictLang = this.getUserLang?.(userId) ?? 'en';
    return {
      keepLocal: false,
      notification: () => notifyUser(userId, t(conflictLang).gcal_conflict(local.title, 'google')),
    };
  }

  private applyPulledUpdate(
    existing: CalendarEvent,
    userId: number,
    calendarId: string,
    gEvent: GoogleEvent,
    local: LocalEventFromGoogle,
  ): PendingNotification {
    let conflictNotification: PendingNotification = null;
    if (existing.sync_status === 'pending_push') {
      const conflict = this.resolvePullConflict(existing, userId, gEvent, local);
      if (conflict.keepLocal) return null;
      conflictNotification = conflict.notification;
    }

    const snapshot = snapshotFromCalendarEvent(existing);

    this.eventRepo.updateSyncFields(existing.id, {
      google_etag: local.google_etag ?? undefined,
      sync_status: 'synced',
      last_synced_at: new Date().toISOString(),
    });
    this.eventRepo.update(existing.id, userId, {
      title: local.title,
      description: local.description,
      start_at: local.start_at,
      end_at: local.end_at,
      all_day: local.all_day,
      timezone: local.timezone,
      location: local.location,
      recurrence_rule: local.recurrence_rule,
    });
    this.syncRepo.logSync({
      user_id: userId,
      event_id: existing.id,
      google_event_id: local.google_event_id,
      direction: 'pull',
      action: 'update',
    });

    const changes = computeEventDiff(snapshot, snapshotFromGoogleLocal(local));
    const changeNotifier = this.changeNotifier;
    if (changes.length > 0 && changeNotifier) {
      const updatedEvent = this.eventRepo.findByGoogleEventId(userId, calendarId, local.google_event_id);
      if (!updatedEvent) return null;
      return async () => {
        if (conflictNotification) await conflictNotification();
        await changeNotifier.onEventChanged({ event: updatedEvent, changes, source: 'google_sync' });
      };
    }
    return conflictNotification;
  }

  private applyPulledNewEvent(
    userId: number,
    calendarId: string,
    gEvent: GoogleEvent,
    local: LocalEventFromGoogle,
  ): PendingNotification {
    const participantSync = this.participantSyncRepo?.getByUserAndGoogleEventId(userId, local.google_event_id);
    if (participantSync) return this.notificationForParticipantCopy(userId, gEvent, local, participantSync);

    this.eventRepo.insertSyncedEvent({
      user_id: userId,
      title: local.title,
      description: local.description,
      start_at: local.start_at,
      end_at: local.end_at,
      all_day: local.all_day,
      timezone: local.timezone,
      location: local.location,
      recurrence_rule: local.recurrence_rule,
      google_calendar_id: calendarId,
      google_event_id: local.google_event_id,
      google_etag: local.google_etag,
      is_cancelled: local.is_cancelled ?? false,
    });
    this.syncRepo.logSync({
      user_id: userId,
      google_event_id: local.google_event_id,
      direction: 'pull',
      action: 'create',
    });
    return null;
  }

  /** The pulled event is a participant's copy of someone else's event: it is never inserted as an own event. */
  private notificationForParticipantCopy(
    userId: number,
    gEvent: GoogleEvent,
    local: LocalEventFromGoogle,
    participantSync: ParticipantGoogleSync,
  ): PendingNotification {
    if (gEvent.recurringEventId) {
      syncLogger.debug(
        { userId, googleEventId: local.google_event_id, recurringEventId: gEvent.recurringEventId },
        'Skipping recurrence exception from participant (not supported in MVP)',
      );
      return null;
    }
    const masterEvent = this.eventRepo.findByIdUnfiltered(participantSync.event_id);
    const deps = this.participantHandlerDeps;
    if (!masterEvent || !deps) return null;
    return () => handleParticipantChange(userId, masterEvent, local, deps);
  }

  /**
   * `knownCopy` is the Google copy captured when the delete was queued: the event delete removes
   * the participant_google_sync row before the worker runs, so the row alone cannot be trusted.
   */
  async pushParticipantEvent(
    api: GoogleCalendarApi,
    participantUserId: number,
    eventId: number,
    action: 'create' | 'update' | 'delete',
    participantSyncRepoOverride?: ParticipantGoogleSyncRepository,
    knownCopy?: { googleEventId?: string; calendarId?: string | null },
  ): Promise<void> {
    const participantSyncRepo = participantSyncRepoOverride ?? this.participantSyncRepo;
    if (!participantSyncRepo) throw new Error('participantSyncRepo required for pushParticipantEvent');
    if (action === 'delete') {
      await this.deleteParticipantCopy(api, participantUserId, eventId, participantSyncRepo, knownCopy);
      return;
    }

    const event = this.eventRepo.findByIdUnfiltered(eventId);
    if (!event) return;

    const gcalId = 'primary';
    const gEvent = localToGoogle(event);

    const syncRecord = participantSyncRepo.getByUserAndEvent(participantUserId, eventId);
    // A push queued before the invitee declined must not give them a copy again.
    if (!syncRecord?.google_event_id && this.hasDeclined(participantUserId, eventId)) {
      syncLogger.info({ participantUserId, eventId, action }, 'Participant declined; no Google copy inserted');
      return;
    }

    if (syncRecord?.google_event_id) {
      const copy = { link: syncRecord, calendarId: gcalId, googleEventId: syncRecord.google_event_id, gEvent };
      const copyUpdated = await this.updateParticipantCopy(api, participantSyncRepo, copy);
      if (!copyUpdated) return;
      this.syncRepo.logSync({
        user_id: participantUserId,
        event_id: eventId,
        google_event_id: syncRecord.google_event_id,
        direction: 'push',
        action,
        details: 'participant_sync',
      });
    } else {
      await this.createParticipantCopy(api, participantSyncRepo, participantUserId, eventId, gcalId, gEvent);
    }

    syncLogger.info({ participantUserId, eventId, action }, 'Participant event synced to Google');
  }

  /** Deletes the participant's Google copy (tolerating one already gone) and drops the link row. */
  private async deleteParticipantCopy(
    api: GoogleCalendarApi,
    participantUserId: number,
    eventId: number,
    participantSyncRepo: ParticipantGoogleSyncRepository,
    knownCopy?: { googleEventId?: string; calendarId?: string | null },
  ): Promise<void> {
    const syncRecord = participantSyncRepo.getByUserAndEvent(participantUserId, eventId);
    const googleEventId = syncRecord?.google_event_id ?? knownCopy?.googleEventId;
    if (!googleEventId) {
      participantSyncRepo.delete(participantUserId, eventId);
      return;
    }
    const calendarId = syncRecord?.google_calendar_id ?? knownCopy?.calendarId ?? 'primary';
    try {
      await api.deleteEvent(calendarId, googleEventId);
    } catch (err) {
      if (googleGoneStatus(err) === null) throw err;
    }
    participantSyncRepo.delete(participantUserId, eventId);
    this.syncRepo.logSync({
      user_id: participantUserId,
      event_id: eventId,
      google_event_id: googleEventId,
      direction: 'push',
      action: 'delete',
      details: 'participant_sync',
    });
  }

  /** Inserts a first copy for the participant and records the create in sync_log. */
  private async createParticipantCopy(
    api: GoogleCalendarApi,
    participantSyncRepo: ParticipantGoogleSyncRepository,
    participantUserId: number,
    eventId: number,
    calendarId: string,
    gEvent: GoogleEvent,
  ): Promise<void> {
    const link = { user_id: participantUserId, event_id: eventId };
    await this.ensureParticipantCopy(api, participantSyncRepo, link, calendarId, gEvent, (copy) =>
      this.syncRepo.logSync({
        user_id: participantUserId,
        event_id: eventId,
        google_event_id: copy.id,
        direction: 'push',
        action: 'create',
        details: copy.origin === 'inserted' ? 'participant_sync' : `participant_sync:${copy.origin}`,
      }),
    );
  }

  /** Whether the participant's RSVP is declined; the pull records a copy deleted in Google as one. */
  private hasDeclined(participantUserId: number, eventId: number): boolean {
    const participant = this.participantHandlerDeps?.participantRepo.findByEventAndUser(eventId, participantUserId);
    return participant?.status === 'declined';
  }

  /**
   * Creates the participant's copy (or finds the one an earlier attempt made) and points their link
   * row at it; `onLinked` writes the caller's log row in the same transaction as the link.
   */
  private ensureParticipantCopy(
    api: GoogleCalendarApi,
    participantSyncRepo: ParticipantGoogleSyncRepository,
    link: Pick<ParticipantGoogleSync, 'user_id' | 'event_id'>,
    calendarId: string,
    gEvent: GoogleEvent,
    onLinked: (copy: LinkedCopy) => void,
  ): Promise<void> {
    return this.ensureCopy(api, calendarId, link.event_id, gEvent, (copy) => {
      participantSyncRepo.upsert(link.user_id, link.event_id, {
        google_event_id: copy.id,
        google_calendar_id: calendarId,
        google_etag: copy.etag,
        sync_status: 'synced',
        last_synced_at: new Date().toISOString(),
      });
      onLinked(copy);
    });
  }

  /**
   * Updates the participant's linked copy. Returns false when Google answered that the copy is gone
   * and the link was resolved instead; any other error fails the job so BullMQ retries it.
   */
  private async updateParticipantCopy(
    api: GoogleCalendarApi,
    participantSyncRepo: ParticipantGoogleSyncRepository,
    copy: ParticipantCopy,
  ): Promise<boolean> {
    let updated: calendar_v3.Schema$Event;
    try {
      updated = await api.updateEvent(copy.calendarId, copy.googleEventId, copy.gEvent);
    } catch (err) {
      const httpStatus = googleGoneStatus(err);
      if (httpStatus === null) throw err;
      await this.resolveGoneParticipantCopy(api, participantSyncRepo, copy, httpStatus, err);
      return false;
    }
    participantSyncRepo.updateSyncFields(copy.link.user_id, copy.link.event_id, {
      google_etag: updated.etag ?? undefined,
      sync_status: 'synced',
      last_synced_at: new Date().toISOString(),
    });
    return true;
  }

  /**
   * Resolves a copy Google reported gone the way the pull reads the same copy (handleDeletedEvent):
   * a copy Google still lists as cancelled means the participant removed the event, so they decline
   * as on pull; a copy Google no longer knows at all (purged, or another Google account connected)
   * is recreated, because nothing says they stopped attending. A participant who already declined
   * is only unlinked. A copy that is still live contradicts the error, which is rethrown for a retry.
   * Google's Events reference (`status`): events.get always returns a deleted event as cancelled until
   * Google drops it, the same tombstone the pull's incremental feed delivers.
   */
  private async resolveGoneParticipantCopy(
    api: GoogleCalendarApi,
    participantSyncRepo: ParticipantGoogleSyncRepository,
    copy: ParticipantCopy,
    httpStatus: 404 | 410,
    err: unknown,
  ): Promise<void> {
    const deps = this.participantHandlerDeps;
    if (!deps) throw new Error('participantHandlerDeps required to resolve a gone participant copy', { cause: err });
    const { link, calendarId, googleEventId } = copy;
    const record = (
      action: 'create' | 'delete',
      loggedGoogleEventId: string | undefined,
      evidence: Pick<GoneParticipantCopyEvidence, 'probe' | 'outcome' | 'new_google_event_id'>,
    ): void => {
      const details: GoneParticipantCopyEvidence = {
        reason: 'participant_copy_gone',
        http_status: httpStatus,
        stale_google_event_id: googleEventId,
        ...evidence,
      };
      this.syncRepo.logSync({
        user_id: link.user_id,
        event_id: link.event_id,
        google_event_id: loggedGoogleEventId,
        direction: 'push',
        action,
        details: JSON.stringify(details),
      });
      syncLogger.warn({ participantUserId: link.user_id, eventId: link.event_id, ...details }, 'Participant copy gone');
    };

    if (this.hasDeclined(link.user_id, link.event_id)) {
      participantSyncRepo.delete(link.user_id, link.event_id);
      record('delete', googleEventId, { probe: 'skipped', outcome: 'unlinked' });
      return;
    }

    let listed: calendar_v3.Schema$Event | null;
    try {
      listed = await api.getEvent(calendarId, googleEventId);
    } catch (probeErr) {
      if (googleGoneStatus(probeErr) === null) throw probeErr;
      listed = null;
    }

    if (listed?.status === 'cancelled') {
      await handleParticipantDelete(link.user_id, link, deps);
      record('delete', googleEventId, { probe: 'cancelled', outcome: 'declined' });
      return;
    }
    if (listed) throw err;

    await this.ensureParticipantCopy(api, participantSyncRepo, link, calendarId, copy.gEvent, (linked) =>
      record('create', linked.id, {
        probe: 'not_found',
        outcome: 'recreated',
        new_google_event_id: linked.id,
      }),
    );
  }

  async setupWatchChannel(
    api: GoogleCalendarApi,
    calendarRowId: number,
    calendarId: string,
    publicDomain: string,
  ): Promise<void> {
    const channelId = crypto.randomUUID();
    const channelToken = crypto.randomUUID();
    const webhookUrl = publicUrl(publicDomain, GOOGLE_CALENDAR_WEBHOOK_PATH);
    const expirationMs = Date.now() + 7 * 24 * 60 * 60 * 1000;

    const result = await api.watchEvents(calendarId, channelId, webhookUrl, expirationMs, channelToken);
    this.calendarRepo.addWatchChannel(calendarRowId, channelId, result.resourceId, result.expiration, result.token);

    syncLogger.info({ calendarId, channelId }, 'Watch channel created');
  }
}
