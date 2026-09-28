import { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';
import type { Lang } from '../../../config/constants.ts';
import { t, toLang } from '../../../config/constants.ts';
import { CLEARED_LOCATION } from '../../../database/repositories/event.repository.ts';
import type { CalendarEvent, EventOccurrence } from '../../../database/types.ts';
import { allDayDates, formatLocalEventSpan, getDayRangeUtc, localCalendarDate } from '../../../utils/date.ts';
import { eventTimestampError } from '../../../utils/event-timestamps.ts';
import { logger } from '../../../utils/logger.ts';
import { escapeHtml } from '../../../utils/telegram.ts';
import { formatEventDetail } from '../../event/formatters.ts';
import type { EventSummary } from '../../intent/variable-resolver.ts';
import { formatLocationPlain } from '../../location/format-location.ts';
import { formatEventWeatherLine } from '../../weather/format.ts';
import { dayOfStart } from '../day-reference-guard.ts';
import {
  consumeDeleteApproval,
  type DeleteTarget,
  deleteConfirmationKeyboard,
  dropDeleteConfirmation,
  isPastEvent,
  issueDeleteConfirmation,
  renderDeleteConfirmation,
} from '../delete-confirmation.ts';
import { type AgendaInterval, type AgendaScope, formatEmptyAgenda } from '../empty-agenda.ts';
import type { AgentContext, ToolHandlerMeta, ToolResult } from '../types.ts';
import { formatReminderDuration } from './reminders.ts';
import { checkSecretaryAccess } from './secretary-access.ts';
import { resolveScope } from './shared.ts';

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Fetch event-time weather and return a formatted suffix like `, weather: ☀️ 15°C, clear sky`. */
async function weatherSuffix(ctx: AgentContext, startAt: string, allDay: boolean): Promise<string> {
  if (!ctx.weatherService) return '';
  const lang = (ctx.user.language ?? 'en') as Lang;
  try {
    const forecast = await ctx.weatherService.getForecastAt(ctx.user.timezone, new Date(startAt).getTime(), lang, {
      allDay,
    });
    if (!forecast) return '';
    return `, ${t(lang).weather.eventForecast(formatEventWeatherLine(lang, forecast))}`;
  } catch {
    // Weather is non-critical — API failure should not break tool output
    return '';
  }
}

function expandDateOnly(dateStr: string, timezone: string): { start: string; end: string } {
  // Interpret dateStr as noon in the user's local timezone (not UTC noon) to avoid
  // the anchor landing on the wrong calendar day for UTC±10–12 offsets.
  const d = new TZDate(`${dateStr}T12:00:00`, timezone);
  return getDayRangeUtc(d, timezone);
}

/**
 * Event time for the assistant: the user's wall clock first, so it is never tempted to present a
 * UTC clock time as local, then the stored instants explicitly labelled as UTC. All-day values are
 * floating calendar dates, labelled as dates (with an explicitly exclusive end), not as UTC instants.
 */
function timeParts(start: string, end: string | null | undefined, allDay: boolean, timezone: string): string[] {
  const endIso = end ?? null;
  const parts = [`local: ${formatLocalEventSpan(start, endIso, allDay, timezone)}`];
  if (allDay) {
    const { first, endExclusive } = allDayDates(start, endIso, timezone);
    parts.push(`start_date: ${first}`);
    if (endExclusive) parts.push(`end_date_exclusive: ${endExclusive}`);
    return parts;
  }
  parts.push(`start_utc: ${new Date(start).toISOString()}`);
  if (endIso) parts.push(`end_utc: ${new Date(endIso).toISOString()}`);
  return parts;
}

/**
 * Location for the assistant: the typed text plus the verified place it resolved to (also a place a
 * pin confirmed on an event with no typed text), so the assistant can say which venue was chosen,
 * or a note that the location is not verified yet. Empty when the event has no location at all.
 */
function locationParts(
  e: Pick<CalendarEvent, 'location' | 'resolved_address' | 'venue_name' | 'location_verified'>,
): string[] {
  const place = formatLocationPlain(e);
  if (e.location_verified === 1 && place) {
    const verified = `verified place: ${place}`;
    return [e.location ? `location: ${e.location}, ${verified}` : verified];
  }
  return e.location ? [`location: ${e.location} (not verified)`] : [];
}

function occurrenceToSummary(occ: EventOccurrence, timezone: string): EventSummary {
  const d = new TZDate(new Date(occ.occurrence_start), timezone);
  const e = occ.event;
  const summary: EventSummary = {
    id: e.id,
    title: e.title,
    date: format(d, 'yyyy-MM-dd'),
    all_day: Boolean(e.all_day),
  };
  if (!e.all_day) summary.time = format(d, 'HH:mm');
  if (occ.occurrence_end) summary.end_at = occ.occurrence_end;
  if (e.description) summary.description = e.description;
  if (e.location) summary.location = e.location;
  if (e.recurrence_rule) summary.recurrence_rule = e.recurrence_rule;
  return summary;
}

function eventToSummary(event: CalendarEvent, timezone: string): EventSummary {
  const d = new TZDate(new Date(event.start_at), timezone);
  const summary: EventSummary = {
    id: event.id,
    title: event.title,
    date: format(d, 'yyyy-MM-dd'),
    all_day: Boolean(event.all_day),
  };
  if (!event.all_day) summary.time = format(d, 'HH:mm');
  if (event.end_at) summary.end_at = event.end_at;
  if (event.description) summary.description = event.description;
  if (event.location) summary.location = event.location;
  if (event.recurrence_rule) summary.recurrence_rule = event.recurrence_rule;
  return summary;
}

/**
 * Remember the event's local start day so a later day picture in this run can show it (#506).
 * A date-only (all-day) start is the day written, not UTC midnight shifted into the user's zone;
 * an unreadable start records nothing, which leaves a later picture on the requested day.
 */
function recordChangedDay(ctx: AgentContext, event: CalendarEvent): void {
  const day = dayOfStart(event.start_at, ctx.user.timezone);
  if (!day) return;
  ctx.changedDays ??= new Set();
  ctx.changedDays.add(day);
}

function buildOrganizerLink(user: AgentContext['user']): string {
  if (user.username) return `@${escapeHtml(user.username)}`;
  const name = user.first_name ?? String(user.telegram_id);
  return `<a href="tg://user?id=${user.telegram_id}">${escapeHtml(name)}</a>`;
}

function buildGroupEventNotification(
  event: CalendarEvent,
  lang: 'en' | 'ru',
  timezone: string,
  groupLabel: string,
  inviteLink: string | null,
  organizerLink: string,
  action: 'created' | 'updated',
): string {
  const safeLink = inviteLink?.replace(/[<>"]/g, encodeURIComponent);
  const groupRef = safeLink
    ? `<a href="${safeLink}">${escapeHtml(groupLabel)}</a>`
    : `<b>${escapeHtml(groupLabel)}</b>`;
  const translations = t(lang);
  const header =
    action === 'created'
      ? translations.group_event_created(groupRef, organizerLink)
      : translations.group_event_updated(groupRef, organizerLink);
  const body = formatEventDetail(event, timezone, lang);
  return `${header}\n\n${body}`;
}

/**
 * Enqueue per-recipient broadcast jobs for a group event create/update.
 *
 * Returns the number of enqueued recipients (0 if unavailable). The caller
 * should await this so the tool result honestly reflects "notifications
 * queued for N members" instead of a fire-and-forget lie.
 *
 * Each recipient gets a language- and timezone-localized message formatted
 * at enqueue time; the worker just dispatches the pre-formatted text.
 */
function buildRecipientMention(
  recipientUser: { first_name?: string | null; username?: string | null; telegram_id: number } | null,
  userId: number,
): string {
  if (recipientUser?.username) return `@${escapeHtml(recipientUser.username)}`;
  const name = recipientUser?.first_name ?? String(userId);
  return `<a href="tg://user?id=${userId}">${escapeHtml(name)}</a>`;
}

async function enqueueGroupNotifications(
  ctx: AgentContext,
  event: CalendarEvent,
  action: 'created' | 'updated',
): Promise<number> {
  if (!ctx.groupChatId || !ctx.group?.groupMemberService || !ctx.broadcast) return 0;
  const groupChat = ctx.group.groupChatRepo.findByChatId(ctx.groupChatId);
  const groupLabel = ctx.groupTitle ?? groupChat?.title ?? String(ctx.groupChatId);
  const inviteLink = groupChat?.invite_link ?? null;
  const organizerLink = buildOrganizerLink(ctx.user);

  let memberIds: number[];
  try {
    memberIds = await ctx.group.groupMemberService.getRegisteredMembers(ctx.groupChatId);
  } catch (err) {
    eventsLogger.error({ err, groupChatId: ctx.groupChatId }, 'Group member fetch failed');
    return 0;
  }

  if (memberIds.length === 0) return 0;

  const batchId = `${action}:${event.id}:${Date.now()}`;
  const lang = (ctx.user.language ?? 'en') as 'en' | 'ru';

  // Register batch for aggregated failure tracking (share link + group context)
  if (ctx.broadcast.registerBatch && ctx.deepLinkService && ctx.botUsername) {
    try {
      const link = ctx.deepLinkService.createShareLink(event.id, ctx.user.telegram_id);
      const shareUrl = ctx.deepLinkService.generateUrl(link.code, ctx.botUsername);
      await ctx.broadcast.registerBatch(batchId, {
        total: memberIds.length,
        groupChatId: ctx.groupChatId,
        threadId: ctx.topicThreadId,
        fallbackText: t(lang).invite_deep_link(escapeHtml(event.title), shareUrl),
      });
    } catch (err) {
      eventsLogger.warn({ err, eventId: event.id }, 'Failed to register broadcast batch');
    }
  }

  const jobs = memberIds.map((userId) => {
    const recipientUser = ctx.userRepo.findByTelegramId(userId);
    const recipientLang = (recipientUser?.language ?? 'en') as 'en' | 'ru';
    const recipientTimezone = recipientUser?.timezone ?? ctx.user.timezone;
    const text = buildGroupEventNotification(
      event,
      recipientLang,
      recipientTimezone,
      groupLabel,
      inviteLink,
      organizerLink,
      action,
    );

    return {
      recipientId: userId,
      text,
      parseMode: 'HTML' as const,
      origin: `group_event_${action}:${event.id}`,
      batchId,
      recipientMention: buildRecipientMention(recipientUser, userId),
    };
  });

  try {
    await ctx.broadcast.enqueueBatch(jobs);
    return jobs.length;
  } catch (err) {
    eventsLogger.error({ err, eventId: event.id, count: jobs.length }, 'Failed to enqueue group notifications');
    return 0;
  }
}

const eventsLogger = logger.child({ module: 'ai-tools' });

type Scope = 'personal' | 'group';

interface GetEventsInput {
  start_date: string;
  end_date: string;
  scope?: Scope;
  owner_id?: number;
}

interface CreateEventInput {
  title: string;
  start_at: string;
  end_at?: string;
  description?: string;
  location?: string;
  location_abstract?: boolean;
  all_day?: boolean;
  recurrence_rule?: string;
  reminder_minutes?: number[];
  force?: boolean;
  scope?: Scope;
  owner_id?: number;
}

interface UpdateEventInput {
  event_id: number;
  title?: string;
  start_at?: string;
  end_at?: string | null;
  description?: string | null;
  location?: string | null;
  location_abstract?: boolean;
  recurrence_rule?: string | null;
  scope?: Scope;
  owner_id?: number;
}

interface DeleteEventInput {
  event_id: number;
  scope?: Scope;
  owner_id?: number;
}

interface GetUpcomingInput {
  limit?: number;
  scope?: Scope;
  owner_id?: number;
}

interface SnoozeEventInput {
  event_id: number;
  minutes?: number;
  scope?: Scope;
  owner_id?: number;
}

interface GetEventInput {
  event_id: number;
  scope?: Scope;
  owner_id?: number;
}

interface SearchEventsInput {
  query?: string;
  scope?: Scope;
  owner_id?: number;
  event_type?: 'birthday' | 'regular';
}

const DATETIME_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?)(Z|[+-]\d{2}:?\d{2})?$/;

/** True for a real calendar date; `new Date` would silently roll 2026-02-30 over into March. */
function isRealCalendarDate(dateOnly: string): boolean {
  try {
    localCalendarDate(dateOnly, 'UTC');
    return true;
  } catch {
    // An impossible date is invalid caller input, reported as INVALID_RANGE by the handler.
    return false;
  }
}

/**
 * One get_events bound as an instant. A date-only value is the edge of that local day; a datetime
 * without an offset is UTC, as the tool contract states. Anything else is null, so the formatter
 * and the SQLite query can never read the same string as two different instants.
 */
function parseRangeBound(value: string, timezone: string, edge: 'start' | 'end'): Date | null {
  if (!isRealCalendarDate(value.slice(0, 10))) return null;
  if (DATE_ONLY_RE.test(value)) return new Date(expandDateOnly(value, timezone)[edge]);
  const match = DATETIME_RE.exec(value);
  if (!match) return null;
  const [, date, time, offset] = match;
  // Canonical ISO for `new Date`: "T" separator, millisecond precision, "+HH:MM" offset, UTC default.
  const zone = offset === undefined ? 'Z' : offset.replace(/^([+-]\d{2})(\d{2})$/, '$1:$2');
  const instant = new Date(`${date}T${time?.replace(/(\.\d{3})\d+$/, '$1')}${zone}`);
  return Number.isFinite(instant.getTime()) ? instant : null;
}

function resolveRangeInterval(input: GetEventsInput, timezone: string): AgendaInterval | null {
  const start = parseRangeBound(input.start_date, timezone, 'start');
  const end = parseRangeBound(input.end_date, timezone, 'end');
  if (!start || !end || start.getTime() >= end.getTime()) return null;
  return { start, end };
}

export async function handleGetEvents(ctx: AgentContext, input: GetEventsInput): Promise<ToolResult> {
  const access = checkSecretaryAccess(
    ctx.user.telegram_id,
    input.owner_id,
    ctx.secretary?.secretaryRepo ?? null,
    'read',
  );
  if (!access.ok) return { success: false, mutationState: 'not_applied', error: access.error };
  const userId = access.effectiveUserId;
  const scope = resolveScope(input, ctx);
  if (scope === 'group' && ctx.groupChatId === undefined) {
    return { success: false, mutationState: 'not_applied', error: 'Group context required for group scope' };
  }
  const tz = ctx.user.timezone;
  const interval = resolveRangeInterval(input, tz);
  if (!interval) {
    return {
      success: false,
      mutationState: 'not_applied',
      error: 'INVALID_RANGE: start_date and end_date must be real ISO 8601 dates or timestamps, with start before end.',
    };
  }
  const startDate = interval.start.toISOString();
  const endDate = interval.end.toISOString();
  const occurrences =
    scope === 'group'
      ? ctx.eventService.getEventsInRangeForGroup(ctx.groupChatId!, startDate, endDate)
      : ctx.eventService.getEventsInRange(userId, startDate, endDate);

  const data = occurrences.map((occ) => occurrenceToSummary(occ, tz));

  if (occurrences.length === 0) {
    const calendar: AgendaScope =
      scope === 'group' ? 'group' : userId === ctx.user.telegram_id ? 'personal' : 'delegated';
    const output = formatEmptyAgenda({ interval, timezone: tz, language: ctx.user.language, scope: calendar });
    return { success: true, output, data };
  }

  const weatherSuffixes = await Promise.all(
    occurrences.map((occ) => weatherSuffix(ctx, occ.occurrence_start, occ.event.all_day === 1)),
  );
  const lines = occurrences.map((occ, i) => {
    const e = occ.event;
    const parts = [`id: ${e.id}`, `title: ${e.title}`];
    parts.push(...timeParts(occ.occurrence_start, occ.occurrence_end, e.all_day === 1, tz));
    if (e.description) parts.push(`description: ${e.description}`);
    parts.push(...locationParts(e));
    if (e.recurrence_rule) parts.push(`recurrence: ${e.recurrence_rule}`);
    if (e.owner_type === 'group' && e.group_id) {
      const groupTitle = ctx.group?.groupChatRepo.findByChatId(e.group_id)?.title;
      parts.push(`group: ${groupTitle ?? e.group_id}`);
    }
    if (e.created_by) {
      const creator = ctx.userRepo.findByTelegramId(e.created_by);
      const creatorLabel = creator?.username ? `@${creator.username}` : `id:${e.created_by}`;
      parts.push(`created_by: ${creatorLabel}`);
    }
    return parts.join(', ') + weatherSuffixes[i]!;
  });

  return { success: true, output: lines.join('\n'), data };
}
handleGetEvents.meta = { readonly: true, skipActionLog: true } satisfies ToolHandlerMeta;

export async function handleCreateEvent(ctx: AgentContext, input: CreateEventInput): Promise<ToolResult> {
  const access = checkSecretaryAccess(
    ctx.user.telegram_id,
    input.owner_id,
    ctx.secretary?.secretaryRepo ?? null,
    'write',
  );
  if (!access.ok) return { success: false, mutationState: 'not_applied', error: access.error };
  const userId = access.effectiveUserId;
  const timestampError = eventTimestampError(input);
  if (timestampError) return { success: false, mutationState: 'not_applied', error: timestampError };
  // Block creation of events in the past — force the agent to confirm with the user first
  if (!input.all_day && !input.force) {
    const eventTime = new Date(input.start_at).getTime();
    const now = Date.now();
    if (eventTime < now) {
      const diffMs = now - eventTime;
      const diffDays = Math.floor(diffMs / 86_400_000);
      const diffLabel = diffDays >= 1 ? `${diffDays} day(s) ago` : `${Math.round(diffMs / 60_000)} minutes ago`;
      return {
        success: false,
        mutationState: 'not_applied',
        error:
          `PAST_EVENT: The requested time (${input.start_at}) is ${diffLabel}. ` +
          'You MUST ask the user via ask_user with options like: ' +
          '["Создать в прошлом", "Перенести на <next reasonable date>"] — ' +
          'include a suggestion for the most likely intended date (e.g. same time tomorrow, or same day next month). ' +
          'The user can also reply with free text to specify a different time. ' +
          'If user confirms past event, call create_event again with force: true.',
      };
    }
  }

  return executeCreateEvent(ctx, input, userId);
}

async function executeCreateEvent(ctx: AgentContext, input: CreateEventInput, userId: number): Promise<ToolResult> {
  try {
    const scope = resolveScope(input, ctx);
    if (scope === 'group' && ctx.groupChatId === undefined) {
      return { success: false, mutationState: 'not_applied', error: 'Group context required for group scope' };
    }
    const event = ctx.eventService.createEvent({
      user_id: userId,
      title: input.title,
      start_at: input.start_at,
      end_at: input.end_at,
      description: input.description,
      location: input.location,
      all_day: input.all_day,
      timezone: ctx.user.timezone,
      recurrence_rule: input.recurrence_rule,
      reminder_minutes: input.reminder_minutes,
      ...(scope === 'group' && {
        owner_type: 'group' as const,
        group_id: ctx.groupChatId!,
        created_by: ctx.user.telegram_id,
      }),
    });
    ctx.createdEventIds ??= new Set();
    ctx.createdEventIds.add(event.id);

    const parts = [`id: ${event.id}`, `title: ${event.title}`];
    parts.push(...timeParts(event.start_at, event.end_at, event.all_day === 1, ctx.user.timezone));
    if (event.description) parts.push(`description: ${event.description}`);
    parts.push(...locationParts(event));

    const groupNotificationsQueued = scope === 'group' ? await enqueueGroupNotifications(ctx, event, 'created') : 0;

    if (scope !== 'group' && ctx.google?.schedulePush) {
      try {
        await ctx.google.schedulePush(userId, event.id, 'create');
      } catch (err) {
        logger.error({ err }, 'schedulePush failed');
      }
    }

    // Trigger background location verification if event has a concrete location
    if (event.location && ctx.locationVerification && !input.location_abstract) {
      ctx.locationVerification
        .verifyEventLocation(event, ctx.user)
        .catch((err) => logger.error({ err, eventId: event.id }, 'Background location verification failed'));
    }

    const groupHint =
      scope === 'group'
        ? groupNotificationsQueued > 0
          ? `The group event is saved and ${groupNotificationsQueued} member notification(s) have been queued for delivery. Do NOT call create_event again for this event.`
          : 'The group event is saved but no member notifications were queued (no registered members or broadcast queue unavailable). Do NOT call create_event again for this event.'
        : undefined;

    recordChangedDay(ctx, event);
    return {
      success: true,
      output: t(ctx.user.language).aiTools.events.eventCreated(parts.join(', ')),
      data: eventToSummary(event, ctx.user.timezone),
      agentHint: groupHint,
    };
  } catch (error) {
    return { success: false, error: `Failed to create event: ${String(error)}` };
  }
}

export async function handleUpdateEvent(ctx: AgentContext, input: UpdateEventInput): Promise<ToolResult> {
  const access = checkSecretaryAccess(
    ctx.user.telegram_id,
    input.owner_id,
    ctx.secretary?.secretaryRepo ?? null,
    'write',
  );
  if (!access.ok) return { success: false, mutationState: 'not_applied', error: access.error };
  const userId = access.effectiveUserId;
  const scope = resolveScope(input, ctx);
  const { event_id, scope: _, owner_id: _oid, ...fields } = input;
  // Removing the location also drops a place a pin set on an event without typed text
  const updates = fields.location === null ? { ...fields, ...CLEARED_LOCATION } : fields;
  if (scope === 'group' && ctx.groupChatId === undefined) {
    return { success: false, mutationState: 'not_applied', error: 'Group context required for group scope' };
  }
  const beforeUpdate =
    scope === 'group'
      ? ctx.eventService.getEventForGroup(event_id, ctx.groupChatId!)
      : ctx.eventService.getEvent(event_id, userId);
  if (!beforeUpdate) {
    return { success: false, mutationState: 'not_applied', error: `Event ${event_id} not found or not owned by you.` };
  }
  const timestampError = eventTimestampError(input);
  if (timestampError) return { success: false, mutationState: 'not_applied', error: timestampError };
  const updated =
    scope === 'group'
      ? ctx.eventService.updateEventForGroup(event_id, ctx.groupChatId!, updates)
      : ctx.eventService.updateEvent(event_id, userId, updates);

  if (!updated) {
    return {
      success: false,
      mutationState: 'uncertain',
      error: 'Update was attempted but its result could not be read back. Do not replay automatically.',
    };
  }

  const parts = [`id: ${updated.id}`, `title: ${updated.title}`];
  parts.push(...timeParts(updated.start_at, updated.end_at, updated.all_day === 1, ctx.user.timezone));
  if (updated.description) parts.push(`description: ${updated.description}`);
  parts.push(...locationParts(updated));

  const groupNotificationsQueued = scope === 'group' ? await enqueueGroupNotifications(ctx, updated, 'updated') : 0;

  if (scope !== 'group' && ctx.google?.schedulePush) {
    try {
      await ctx.google.schedulePush(userId, updated.id, 'update');
    } catch (err) {
      logger.error({ err }, 'schedulePush failed');
    }
  }

  // Fetch participants once — used for the accepted-push, the declined-skip, and the hint
  const participants = ctx.participantRepo ? ctx.participantRepo.getByEvent(event_id) : [];
  const acceptedParticipants = participants.filter((p) => p.status === 'accepted' && p.user_id !== userId);

  // Push update to all accepted participants' Google Calendars (parallel).
  // Concurrency note: SQLite ops inside scheduleParticipantPush are sync
  // (bun:sqlite), so only the Redis queue.add runs in parallel — bounded
  // by realistic group sizes (<100 members).
  if (ctx.google?.scheduleParticipantPush && acceptedParticipants.length > 0) {
    const pushParticipant = ctx.google.scheduleParticipantPush;
    const results = await Promise.allSettled(
      acceptedParticipants.map((p) => pushParticipant(p.user_id, updated.id, 'update')),
    );
    for (let i = 0; i < results.length; i++) {
      if (results[i]!.status === 'rejected') {
        logger.error(
          {
            err: (results[i] as PromiseRejectedResult).reason,
            participantUserId: acceptedParticipants[i]!.user_id,
            eventId: updated.id,
          },
          'scheduleParticipantPush failed',
        );
      }
    }
  }

  // Push update to all group members' Google Calendars (parallel).
  // Group events are pushed to every active member by default; a declined RSVP
  // ("Not going") is the opt-out, so members who explicitly declined are skipped
  // — otherwise an edit would re-create the event they removed from their calendar.
  // Members with no RSVP row are undecided, not declined, so they still receive it.
  if (scope === 'group' && ctx.google?.scheduleParticipantPush && ctx.group) {
    const pushParticipant = ctx.google.scheduleParticipantPush;
    const declinedMemberIds = new Set(participants.filter((p) => p.status === 'declined').map((p) => p.user_id));
    const members = ctx.group.groupMemberRepo
      .getActiveMembers(ctx.groupChatId!)
      .filter((m) => m.user_id !== ctx.user.telegram_id && !declinedMemberIds.has(m.user_id));
    const results = await Promise.allSettled(members.map((m) => pushParticipant(m.user_id, updated.id, 'update')));
    for (let i = 0; i < results.length; i++) {
      if (results[i]!.status === 'rejected') {
        logger.error(
          { err: (results[i] as PromiseRejectedResult).reason, userId: members[i]!.user_id, eventId: updated.id },
          'scheduleParticipantPush group failed',
        );
      }
    }
  }

  let output = t(ctx.user.language).aiTools.events.eventUpdated(parts.join(', '));

  if (acceptedParticipants.length > 0) {
    output += t(ctx.user.language).aiTools.events.participantHint(acceptedParticipants.length);
  }

  if (ctx.locationVerification) {
    // Before the question below: a place the creator confirms from it re-renders the cards again,
    // and this edit's render must not land after that one
    await ctx.locationVerification.refreshInvitationCards(beforeUpdate, updated);
  }

  // Trigger background location verification if location was updated with a concrete location
  if (input.location && ctx.locationVerification && !input.location_abstract) {
    ctx.locationVerification
      .verifyEventLocation(updated, ctx.user)
      .catch((err) => logger.error({ err, eventId: updated.id }, 'Background location verification failed'));
  }

  const groupHint =
    scope === 'group'
      ? groupNotificationsQueued > 0
        ? `The group event is updated and ${groupNotificationsQueued} member notification(s) have been queued for delivery. Do NOT call update_event again with identical arguments.`
        : 'The group event is updated but no member notifications were queued (no registered members or broadcast queue unavailable). Do NOT call update_event again with identical arguments.'
      : undefined;

  recordChangedDay(ctx, beforeUpdate);
  recordChangedDay(ctx, updated);
  return { success: true, output, agentHint: groupHint, data: eventToSummary(updated, ctx.user.timezone) };
}

export interface AttachPendingLocationInput {
  event_id: number;
}

export async function handleAttachPendingLocationToEvent(
  ctx: AgentContext,
  input: AttachPendingLocationInput,
): Promise<ToolResult> {
  if (!ctx.locationVerification || !ctx.pendingGeoStore) {
    return { success: false, error: 'Location verification is not available' };
  }

  const geo = await ctx.pendingGeoStore.get(ctx.user.telegram_id);
  if (!geo) {
    return {
      success: false,
      error: 'No pending location pin found. Ask the user to send a 📍 pin via Telegram, then try again.',
    };
  }

  const success = await ctx.locationVerification.resolveFromSharedLocation(input.event_id, geo, ctx.user.telegram_id);

  if (!success) {
    return { success: false, error: `Could not resolve geo to address for event ${input.event_id}` };
  }

  // Clear the pending pin so subsequent calls don't reuse stale data
  await ctx.pendingGeoStore.delete(ctx.user.telegram_id).catch((err) => {
    logger.warn({ err, userId: ctx.user.telegram_id }, 'Failed to clear pending geo after attach');
  });

  return {
    success: true,
    output: t(ctx.user.language).aiTools.events.locationAttached(input.event_id),
  };
}

/**
 * The event a delete_event call from this user would reach, resolved the same way the delete
 * resolves it: the group calendar in a group, the user's own calendar, a calendar they are a
 * write secretary of, or an event they accepted (the delete then declines it).
 */
function resolveDeleteTarget(ctx: AgentContext, eventId: number, now: number): DeleteTarget | null {
  const actorId = ctx.user.telegram_id;
  const target = (event: CalendarEvent, scope: DeleteTarget['scope'], ownerId?: number): DeleteTarget => ({
    eventId: event.id,
    scope,
    ...(ownerId !== undefined && { ownerId }),
    title: event.title,
    startAt: event.start_at,
    endAt: event.end_at,
    allDay: event.all_day === 1,
    recurring: event.recurrence_rule !== null,
    past: isPastEvent(event, now),
  });
  if (ctx.isGroup && ctx.groupChatId !== undefined) {
    const groupEvent = ctx.eventService.getEventForGroup(eventId, ctx.groupChatId);
    if (groupEvent) return target(groupEvent, 'group');
  }
  const own = ctx.eventService.getEvent(eventId, actorId);
  if (own) return target(own, 'personal');
  const ownerId = ctx.eventService.getEventOwnerId(eventId);
  if (ownerId === null || ownerId === actorId) return null;
  const ownersEvent = ctx.eventService.getEvent(eventId, ownerId);
  if (!ownersEvent) return null;
  if (checkSecretaryAccess(actorId, ownerId, ctx.secretary?.secretaryRepo ?? null, 'write').ok) {
    return target(ownersEvent, 'personal', ownerId);
  }
  const participant = ctx.participantRepo?.findByEventAndUser(eventId, actorId);
  return participant?.status === 'accepted' ? target(ownersEvent, 'personal') : null;
}

/**
 * ask_user with event_ids: the bot, not the model, lists the events with their local dates and
 * owns the buttons, and the callback deletes exactly what the user tapped.
 */
export async function handleDeleteConfirmationRequest(ctx: AgentContext, eventIds: number[]): Promise<ToolResult> {
  const lang = toLang(ctx.user.language);
  const tr = t(lang).aiTools.meta;
  const now = Date.now();
  const targets: DeleteTarget[] = [];
  const missing: number[] = [];
  for (const eventId of new Set(eventIds)) {
    const resolved = resolveDeleteTarget(ctx, eventId, now);
    if (resolved) targets.push(resolved);
    else missing.push(eventId);
  }
  if (missing.length > 0) {
    return { success: false, mutationState: 'not_applied', error: tr.deleteTargetsNotFound(missing.join(', ')) };
  }
  const text = renderDeleteConfirmation(targets, ctx.user.timezone, lang, now);
  // A call has no buttons, and a spoken answer is only the model's reading of it. So the call
  // gets the same list in the private chat, and only a tap there deletes (ctx.chatId is the
  // caller's private chat during a call).
  if (!ctx.sender?.sendMessageWithKeyboard) {
    return { success: false, mutationState: 'not_applied', error: 'Buttons not supported.' };
  }
  const confirmationId = issueDeleteConfirmation(ctx.user.telegram_id, ctx.chatId, targets, now);
  try {
    await ctx.sender.sendMessageWithKeyboard(
      ctx.chatId,
      text,
      deleteConfirmationKeyboard(confirmationId, targets, lang),
    );
  } catch (err) {
    dropDeleteConfirmation(confirmationId);
    logger.error({ err }, 'Failed to send delete confirmation');
    return {
      success: false,
      mutationState: 'not_applied',
      error: 'ASK_USER_DELIVERY_FAILED: failed to send the delete confirmation.',
    };
  }
  if (ctx.inputMode === 'live_call') {
    const spoken = tr.deleteConfirmationSentToChat;
    return {
      success: true,
      mutationState: 'not_applied',
      output: spoken,
      awaitingInput: { kind: 'speech', question: spoken },
      stopLoop: true,
      agentHint: 'Nothing is deleted on the call: the user taps the list in the chat. Do not call delete_event.',
    };
  }
  return {
    success: true,
    mutationState: 'not_applied',
    output: tr.deleteConfirmationSent,
    awaitingInput: { kind: 'chat' },
    stopLoop: true,
    agentHint:
      'The bot deletes exactly what the user taps and then tells you what was deleted. Do not call delete_event for these events.',
  };
}

export async function handleDeleteEvent(ctx: AgentContext, input: DeleteEventInput): Promise<ToolResult> {
  const access = checkSecretaryAccess(
    ctx.user.telegram_id,
    input.owner_id,
    ctx.secretary?.secretaryRepo ?? null,
    'write',
  );
  if (!access.ok) return { success: false, mutationState: 'not_applied', error: access.error };
  const userId = access.effectiveUserId;
  // Checked only once the event is known to exist, so a wrong id still gets "not found".
  const unconfirmed = (): ToolResult | null =>
    ctx.toolOrigin === 'intent_workflow' ||
    ctx.createdEventIds?.has(input.event_id) === true ||
    consumeDeleteApproval(ctx.user.telegram_id, ctx.chatId, input.event_id)
      ? null
      : {
          success: false,
          mutationState: 'not_applied',
          error: t(ctx.user.language).aiTools.meta.deleteNeedsConfirmation,
          agentHint:
            'Call ask_user with event_ids listing every event to delete: the bot shows them with local dates and deletes on the user’s tap. A typed "да" or your own question does not confirm a delete.',
        };
  const scope = resolveScope(input, ctx);

  if (scope === 'group') {
    if (ctx.groupChatId === undefined) {
      return { success: false, mutationState: 'not_applied', error: 'Group context required for group scope' };
    }
    const event = ctx.eventService.getEventForGroup(input.event_id, ctx.groupChatId);
    if (!event) {
      return {
        success: false,
        mutationState: 'not_applied',
        error: `Event ${input.event_id} not found in group calendar.`,
      };
    }
    const refusal = unconfirmed();
    if (refusal) return refusal;
    // Remove from all group members' Google Calendars before deleting (parallel)
    if (ctx.google?.scheduleParticipantPush && ctx.group) {
      const pushParticipant = ctx.google.scheduleParticipantPush;
      const members = ctx.group.groupMemberRepo.getActiveMembers(ctx.groupChatId!);
      const results = await Promise.allSettled(
        members.map((m) => pushParticipant(m.user_id, input.event_id, 'delete')),
      );
      for (let i = 0; i < results.length; i++) {
        if (results[i]!.status === 'rejected') {
          logger.error(
            { err: (results[i] as PromiseRejectedResult).reason, userId: members[i]!.user_id, eventId: input.event_id },
            'scheduleParticipantPush group delete failed',
          );
        }
      }
    }
    ctx.eventService.deleteEventForGroup(input.event_id, ctx.groupChatId!);
    recordChangedDay(ctx, event);
    return {
      success: true,
      effect: { kind: 'event_deleted' },
      output: t(ctx.user.language).aiTools.events.eventDeleted(event.title, event.id),
      data: eventToSummary(event, ctx.user.timezone),
    };
  }

  const event = ctx.eventService.getEvent(input.event_id, userId);

  if (!event && ctx.participantRepo) {
    const participant = ctx.participantRepo.findByEventAndUser(input.event_id, userId);
    if (participant && participant.status === 'accepted') {
      const refusal = unconfirmed();
      if (refusal) return refusal;
      ctx.participantRepo.updateStatus(input.event_id, userId, 'declined');
      // Remove from this participant's Google Calendar
      if (ctx.google?.scheduleParticipantPush) {
        try {
          await ctx.google.scheduleParticipantPush(userId, input.event_id, 'delete');
        } catch (err) {
          logger.error({ err, userId, eventId: input.event_id }, 'scheduleParticipantPush decline failed');
        }
      }
      return {
        success: true,
        effect: { kind: 'attendance_declined' },
        output: t(ctx.user.language).aiTools.events.eventDeclined(input.event_id),
      };
    }
  }

  if (!event) {
    return {
      success: false,
      mutationState: 'not_applied',
      error: `Event ${input.event_id} not found or not owned by you.`,
    };
  }
  const refusal = unconfirmed();
  if (refusal) return refusal;

  // Remove from all participants' Google Calendars before deleting (parallel)
  if (ctx.google?.scheduleParticipantPush && ctx.participantRepo) {
    const pushParticipant = ctx.google.scheduleParticipantPush;
    const participants = ctx.participantRepo
      .getByEvent(input.event_id)
      .filter((p) => p.status === 'accepted' && p.user_id !== userId);
    const results = await Promise.allSettled(
      participants.map((p) => pushParticipant(p.user_id, input.event_id, 'delete')),
    );
    for (let i = 0; i < results.length; i++) {
      if (results[i]!.status === 'rejected') {
        logger.error(
          {
            err: (results[i] as PromiseRejectedResult).reason,
            participantUserId: participants[i]!.user_id,
            eventId: input.event_id,
          },
          'scheduleParticipantPush delete failed',
        );
      }
    }
  }

  const googleEventId = event.google_event_id ?? undefined;
  ctx.eventService.deleteEvent(input.event_id, userId);

  if (ctx.google?.schedulePush && googleEventId) {
    try {
      await ctx.google.schedulePush(userId, input.event_id, 'delete', { googleEventId });
    } catch (err) {
      logger.error({ err }, 'schedulePush failed');
    }
  }

  recordChangedDay(ctx, event);
  return {
    success: true,
    effect: { kind: 'event_deleted' },
    output: t(ctx.user.language).aiTools.events.eventDeleted(event.title, event.id),
    data: eventToSummary(event, ctx.user.timezone),
  };
}

export async function handleSearchEvents(ctx: AgentContext, input: SearchEventsInput): Promise<ToolResult> {
  const access = checkSecretaryAccess(
    ctx.user.telegram_id,
    input.owner_id,
    ctx.secretary?.secretaryRepo ?? null,
    'read',
  );
  if (!access.ok) return { success: false, mutationState: 'not_applied', error: access.error };
  const userId = access.effectiveUserId;
  const scope = resolveScope(input, ctx);
  if (scope === 'group' && ctx.groupChatId === undefined) {
    return { success: false, mutationState: 'not_applied', error: 'Group context required for group scope' };
  }
  const events =
    scope === 'group'
      ? ctx.eventService.searchEventsForGroup(ctx.groupChatId!, input.query ?? '')
      : ctx.eventService.searchWithEventType(userId, input.query ?? null, input.event_type ?? null);

  const tz = ctx.user.timezone;
  const data = events.map((e) =>
    occurrenceToSummary(
      { event: e, occurrence_start: e.start_at, occurrence_end: e.end_at ?? null, is_exception: false },
      tz,
    ),
  );

  if (events.length === 0) {
    return {
      success: true,
      output: t(ctx.user.language).aiTools.events.noEventsMatchingScope(scope),
      data,
    };
  }

  const weatherSuffixes = await Promise.all(events.map((e) => weatherSuffix(ctx, e.start_at, e.all_day === 1)));
  const lines = events.map((e, i) => {
    const parts = [`id: ${e.id}`, `title: ${e.title}`, ...timeParts(e.start_at, e.end_at, e.all_day === 1, tz)];
    parts.push(...locationParts(e));
    return parts.join(', ') + weatherSuffixes[i]!;
  });

  return { success: true, output: lines.join('\n'), data, agentHint: `searched ${scope} calendar` };
}
handleSearchEvents.meta = { readonly: true, skipActionLog: true } satisfies ToolHandlerMeta;

export async function handleGetUpcoming(ctx: AgentContext, input: GetUpcomingInput): Promise<ToolResult> {
  const access = checkSecretaryAccess(
    ctx.user.telegram_id,
    input.owner_id,
    ctx.secretary?.secretaryRepo ?? null,
    'read',
  );
  if (!access.ok) return { success: false, mutationState: 'not_applied', error: access.error };
  const userId = access.effectiveUserId;
  const limit = input.limit ?? 5;
  const scope = resolveScope(input, ctx);

  if (scope === 'group' && ctx.groupChatId === undefined) {
    return { success: false, mutationState: 'not_applied', error: 'Group context required for group scope' };
  }

  let upcoming: EventOccurrence[];

  if (scope === 'group') {
    upcoming = ctx.eventService.getUpcomingForGroup(ctx.groupChatId!, limit);
  } else {
    const now = new Date().toISOString();
    const farFuture = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
    const occurrences = ctx.eventService.getEventsInRange(userId, now, farFuture);
    upcoming = occurrences.slice(0, limit);
  }

  const tz = ctx.user.timezone;
  const data = upcoming.map((occ) => occurrenceToSummary(occ, tz));

  if (upcoming.length === 0) {
    return { success: true, output: t(ctx.user.language).aiTools.events.noUpcomingEvents, data };
  }

  const weatherSuffixes = await Promise.all(
    upcoming.map((occ) => weatherSuffix(ctx, occ.occurrence_start, occ.event.all_day === 1)),
  );
  const lines = upcoming.map((occ, i) => {
    const e = occ.event;
    const parts = [`id: ${e.id}`, `title: ${e.title}`];
    parts.push(...timeParts(occ.occurrence_start, occ.occurrence_end, e.all_day === 1, tz));
    parts.push(...locationParts(e));
    return parts.join(', ') + weatherSuffixes[i]!;
  });

  return {
    success: true,
    output: t(ctx.user.language).aiTools.events.upcomingEvents(upcoming.length, lines.join('\n')),
    data,
  };
}
handleGetUpcoming.meta = { readonly: true, skipActionLog: true } satisfies ToolHandlerMeta;

export function handleSnoozeEvent(ctx: AgentContext, input: SnoozeEventInput): ToolResult {
  const access = checkSecretaryAccess(
    ctx.user.telegram_id,
    input.owner_id,
    ctx.secretary?.secretaryRepo ?? null,
    'write',
  );
  if (!access.ok) return { success: false, mutationState: 'not_applied', error: access.error };
  const userId = access.effectiveUserId;
  const scope = resolveScope(input, ctx);
  if (scope === 'group' && ctx.groupChatId === undefined) {
    return { success: false, mutationState: 'not_applied', error: 'Group context required for group scope' };
  }
  const event =
    scope === 'group'
      ? ctx.eventService.getEventForGroup(input.event_id, ctx.groupChatId!)
      : ctx.eventService.getEvent(input.event_id, userId);

  if (!event) {
    return { success: false, error: `Event ${input.event_id} not found or not owned by you.` };
  }

  const minutes = input.minutes ?? 10;
  const newStart = new Date(new Date(event.start_at).getTime() + minutes * 60_000).toISOString();
  const updates: Record<string, string> = { start_at: newStart };

  if (event.end_at) {
    updates.end_at = new Date(new Date(event.end_at).getTime() + minutes * 60_000).toISOString();
  }

  const updated =
    scope === 'group'
      ? ctx.eventService.updateEventForGroup(input.event_id, ctx.groupChatId!, updates)
      : ctx.eventService.updateEvent(input.event_id, userId, updates);

  if (!updated) {
    return { success: false, error: 'Failed to snooze event.' };
  }

  recordChangedDay(ctx, event);
  recordChangedDay(ctx, updated);

  // Snoozing shifts the start by minutes, so even an all-day event now has an exact instant.
  const newStartParts = timeParts(updated.start_at, null, false, ctx.user.timezone);

  return {
    success: true,
    output: t(ctx.user.language).aiTools.events.snoozed(updated.title, minutes, newStartParts.join(', ')),
  };
}

export async function handleGetEvent(ctx: AgentContext, input: GetEventInput): Promise<ToolResult> {
  const access = checkSecretaryAccess(
    ctx.user.telegram_id,
    input.owner_id,
    ctx.secretary?.secretaryRepo ?? null,
    'read',
  );
  if (!access.ok) return { success: false, mutationState: 'not_applied', error: access.error };
  const userId = access.effectiveUserId;
  const scope = resolveScope(input, ctx);
  if (scope === 'group' && ctx.groupChatId === undefined) {
    return { success: false, mutationState: 'not_applied', error: 'Group context required for group scope' };
  }
  const event =
    scope === 'group'
      ? ctx.eventService.getEventForGroup(input.event_id, ctx.groupChatId!)
      : ctx.eventService.getEvent(input.event_id, userId);

  if (!event) {
    return { success: false, error: `Event ${input.event_id} not found or not owned by you.` };
  }

  const weather = await weatherSuffix(ctx, event.start_at, event.all_day === 1);
  const parts = [`id: ${event.id}`, `title: ${event.title}`];
  parts.push(...timeParts(event.start_at, event.end_at, event.all_day === 1, ctx.user.timezone));
  if (event.description) parts.push(`description: ${event.description}`);
  parts.push(...locationParts(event));
  if (event.recurrence_rule) parts.push(`recurrence: ${event.recurrence_rule}`);
  if (event.all_day) parts.push('all_day: true');
  if (event.owner_type === 'group' && event.group_id) {
    const groupTitle = ctx.group?.groupChatRepo.findByChatId(event.group_id)?.title;
    parts.push(`group: ${groupTitle ?? event.group_id}`);
  }
  if (event.created_by) {
    const creator = ctx.userRepo.findByTelegramId(event.created_by);
    const creatorLabel = creator?.username ? `@${creator.username}` : `id:${event.created_by}`;
    parts.push(`created_by: ${creatorLabel}`);
  }

  const reminders = ctx.eventReminderRepo.getForEvent(input.event_id).filter((r) => r.sent === 0);
  if (reminders.length > 0) {
    const lang = ctx.user.language;
    const unique = [...new Set(reminders.map((r) => formatReminderDuration(r.interval_minutes, lang)))];
    parts.push(`reminders: ${unique.join(', ')}`);
  }

  return { success: true, output: parts.join(', ') + weather, data: eventToSummary(event, ctx.user.timezone) };
}
handleGetEvent.meta = { readonly: true, skipActionLog: true } satisfies ToolHandlerMeta;

interface NotifyParticipantsInput {
  event_id: number;
  message: string;
}

export async function handleNotifyParticipants(ctx: AgentContext, input: NotifyParticipantsInput): Promise<ToolResult> {
  const event = ctx.eventService.getEvent(input.event_id, ctx.user.telegram_id);
  if (!event) {
    return { success: false, error: `Event ${input.event_id} not found or not owned by you.` };
  }

  if (!ctx.participantRepo) {
    return { success: false, error: 'Participants feature is not configured.' };
  }

  if (!ctx.broadcast) {
    return { success: false, error: 'Broadcast queue is not configured; cannot notify participants.' };
  }

  const accepted = ctx.participantRepo
    .getByEvent(input.event_id)
    .filter((p) => p.status === 'accepted' && p.user_id !== ctx.user.telegram_id);

  if (accepted.length === 0) {
    return { success: false, error: 'This event has no accepted participants to notify.' };
  }

  const senderName = ctx.user.first_name ?? ctx.user.username ?? `User ${ctx.user.telegram_id}`;
  // Per-recipient localization: each recipient gets the notification in their own language
  const jobs = accepted.map((p) => {
    const recipientUser = ctx.userRepo.findByTelegramId(p.user_id);
    const recipientLang = (recipientUser?.language ?? 'en') as 'en' | 'ru';
    const text = t(recipientLang).aiTools.events.participantUpdate(event.title, senderName, input.message);
    return {
      recipientId: p.user_id,
      text,
      origin: `notify_participants:${input.event_id}`,
    };
  });

  try {
    await ctx.broadcast.enqueueBatch(jobs);
  } catch (err) {
    eventsLogger.error(
      { err, eventId: input.event_id, count: jobs.length },
      'Failed to enqueue participant notifications',
    );
    return { success: false, error: 'NOTIFY_PARTICIPANTS_ENQUEUE_FAILED' };
  }

  const output = t(ctx.user.language).aiTools.events.notificationQueued(jobs.length);

  return {
    success: true,
    output,
    agentHint: `${jobs.length} notifications queued for delivery via the broadcast worker. Do NOT call notify_participants again for this event with the same message.`,
  };
}
