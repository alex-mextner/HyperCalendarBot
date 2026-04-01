import { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';
import { t } from '../../../config/constants.ts';
import type { CalendarEvent, EventOccurrence } from '../../../database/types.ts';
import { getDayRangeUtc } from '../../../utils/date.ts';
import { logger } from '../../../utils/logger.ts';
import { escapeHtml } from '../../../utils/telegram.ts';
import { formatEventDetail, ruPlural } from '../../event/formatters.ts';
import type { EventSummary } from '../../intent/variable-resolver.ts';
import type { AgentContext, ToolResult } from '../types.ts';
import { formatReminderDuration } from './reminders.ts';
import { checkSecretaryAccess } from './secretary-access.ts';
import { resolveScope } from './shared.ts';

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

function expandDateOnly(dateStr: string, timezone: string): { start: string; end: string } {
  // Interpret dateStr as noon in the user's local timezone (not UTC noon) to avoid
  // the anchor landing on the wrong calendar day for UTC±10–12 offsets.
  const d = new TZDate(`${dateStr}T12:00:00`, timezone);
  return getDayRangeUtc(d, timezone);
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

function sendGroupNotifications(ctx: AgentContext, event: CalendarEvent, action: 'created' | 'updated'): void {
  if (!ctx.groupChatId || !ctx.group?.groupMemberService || !ctx.sender) return;
  const groupChat = ctx.group?.groupChatRepo.findByChatId(ctx.groupChatId);
  const groupLabel = ctx.groupTitle ?? groupChat?.title ?? String(ctx.groupChatId);
  const inviteLink = groupChat?.invite_link ?? null;
  const organizerLink = buildOrganizerLink(ctx.user);
  const sender = ctx.sender;
  const errorLabel =
    action === 'created' ? 'Group event notification failed' : 'Group event update notification failed';
  ctx
    .group!.groupMemberService.getRegisteredMembers(ctx.groupChatId)
    .then((memberIds) => {
      for (const userId of memberIds) {
        const recipientUser = ctx.userRepo.findByTelegramId(userId);
        const recipientLang = (recipientUser?.language ?? 'en') as 'en' | 'ru';
        const recipientTimezone = recipientUser?.timezone ?? ctx.user.timezone;
        const message = buildGroupEventNotification(
          event,
          recipientLang,
          recipientTimezone,
          groupLabel,
          inviteLink,
          organizerLink,
          action,
        );
        sender.sendMessage(userId, message, 'HTML').catch((err) => {
          eventsLogger.error({ err: err, userId }, errorLabel);
        });
      }
    })
    .catch((err) => {
      eventsLogger.error({ err: err, groupChatId: ctx.groupChatId }, 'Group member fetch failed');
    });
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

export function handleGetEvents(ctx: AgentContext, input: GetEventsInput): ToolResult {
  const access = checkSecretaryAccess(
    ctx.user.telegram_id,
    input.owner_id,
    ctx.secretary?.secretaryRepo ?? null,
    'read',
  );
  if (!access.ok) return { success: false, error: access.error };
  const userId = access.effectiveUserId;
  const scope = resolveScope(input, ctx);
  if (scope === 'group' && ctx.groupChatId === undefined) {
    return { success: false, error: 'Group context required for group scope' };
  }
  const tz = ctx.user.timezone;
  const startDate = DATE_ONLY_RE.test(input.start_date) ? expandDateOnly(input.start_date, tz).start : input.start_date;
  const endDate = DATE_ONLY_RE.test(input.end_date) ? expandDateOnly(input.end_date, tz).end : input.end_date;
  const occurrences =
    scope === 'group'
      ? ctx.eventService.getEventsInRangeForGroup(ctx.groupChatId!, startDate, endDate)
      : ctx.eventService.getEventsInRange(userId, startDate, endDate);

  const data = occurrences.map((occ) => occurrenceToSummary(occ, tz));

  if (occurrences.length === 0) {
    return { success: true, output: t(ctx.user.language).aiTools.events.noEventsInRange, data };
  }

  const lines = occurrences.map((occ) => {
    const e = occ.event;
    const parts = [`id: ${e.id}`, `title: ${e.title}`, `start: ${occ.occurrence_start}`];
    if (occ.occurrence_end) parts.push(`end: ${occ.occurrence_end}`);
    if (e.description) parts.push(`description: ${e.description}`);
    if (e.location) parts.push(`location: ${e.location}`);
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
    return parts.join(', ');
  });

  return { success: true, output: lines.join('\n'), data };
}

export function handleCreateEvent(ctx: AgentContext, input: CreateEventInput): ToolResult {
  const access = checkSecretaryAccess(
    ctx.user.telegram_id,
    input.owner_id,
    ctx.secretary?.secretaryRepo ?? null,
    'write',
  );
  if (!access.ok) return { success: false, error: access.error };
  const userId = access.effectiveUserId;
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

function executeCreateEvent(ctx: AgentContext, input: CreateEventInput, userId: number): ToolResult {
  try {
    const scope = resolveScope(input, ctx);
    if (scope === 'group' && ctx.groupChatId === undefined) {
      return { success: false, error: 'Group context required for group scope' };
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

    const parts = [`id: ${event.id}`, `title: ${event.title}`, `start: ${event.start_at}`];
    if (event.end_at) parts.push(`end: ${event.end_at}`);
    if (event.description) parts.push(`description: ${event.description}`);
    if (event.location) parts.push(`location: ${event.location}`);

    if (scope === 'group') sendGroupNotifications(ctx, event, 'created');

    if (scope !== 'group') {
      ctx.google
        ?.schedulePush?.(userId, event.id, 'create')
        .catch((err) => logger.error({ err }, 'schedulePush failed'));
    }

    if (ctx.scheduled?.domainEvents && ctx.conflictChecker && scope !== 'group') {
      const conflicts = ctx.conflictChecker.checkConflicts(event, userId);
      if (conflicts.length > 0) {
        ctx.scheduled.domainEvents.emit('myCalendar.conflictDetected', {
          userId: ctx.user.telegram_id,
          event,
          conflictsWith: conflicts[0]!,
        });

        const tz = ctx.user.timezone;
        const conflictList = conflicts
          .map((c) => {
            const start = new TZDate(new Date(c.start_at), tz);
            const end = c.end_at ? new TZDate(new Date(c.end_at), tz) : null;
            const timeRange = end ? `${format(start, 'HH:mm')}–${format(end, 'HH:mm')}` : format(start, 'HH:mm');
            return `"${c.title}" (${timeRange})`;
          })
          .join(', ');

        return {
          success: true,
          output: t(ctx.user.language).aiTools.events.eventCreated(parts.join(', ')),
          agentHint: `⚠️ This event overlaps with: ${conflictList}. Warn the user about the overlap.`,
          data: eventToSummary(event, ctx.user.timezone),
        };
      }
    }

    return {
      success: true,
      output: t(ctx.user.language).aiTools.events.eventCreated(parts.join(', ')),
      data: eventToSummary(event, ctx.user.timezone),
    };
  } catch (error) {
    return { success: false, error: `Failed to create event: ${String(error)}` };
  }
}

export function handleUpdateEvent(ctx: AgentContext, input: UpdateEventInput): ToolResult {
  const access = checkSecretaryAccess(
    ctx.user.telegram_id,
    input.owner_id,
    ctx.secretary?.secretaryRepo ?? null,
    'write',
  );
  if (!access.ok) return { success: false, error: access.error };
  const userId = access.effectiveUserId;
  const scope = resolveScope(input, ctx);
  const { event_id, scope: _, owner_id: _oid, ...updates } = input;
  if (scope === 'group' && ctx.groupChatId === undefined) {
    return { success: false, error: 'Group context required for group scope' };
  }
  const updated =
    scope === 'group'
      ? ctx.eventService.updateEventForGroup(event_id, ctx.groupChatId!, updates)
      : ctx.eventService.updateEvent(event_id, userId, updates);

  if (!updated) {
    return { success: false, error: `Event ${event_id} not found or not owned by you.` };
  }

  const parts = [`id: ${updated.id}`, `title: ${updated.title}`, `start: ${updated.start_at}`];
  if (updated.end_at) parts.push(`end: ${updated.end_at}`);
  if (updated.description) parts.push(`description: ${updated.description}`);
  if (updated.location) parts.push(`location: ${updated.location}`);

  if (scope === 'group') sendGroupNotifications(ctx, updated, 'updated');

  if (scope !== 'group') {
    ctx.google
      ?.schedulePush?.(userId, updated.id, 'update')
      .catch((err) => logger.error({ err }, 'schedulePush failed'));
  }

  let conflictHint: string | undefined;
  if (ctx.scheduled?.domainEvents && ctx.conflictChecker && scope !== 'group') {
    const conflicts = ctx.conflictChecker.checkConflicts(updated, userId);
    if (conflicts.length > 0) {
      ctx.scheduled.domainEvents.emit('myCalendar.conflictDetected', {
        userId: ctx.user.telegram_id,
        event: updated,
        conflictsWith: conflicts[0]!,
      });

      const tz = ctx.user.timezone;
      const conflictList = conflicts
        .map((c) => {
          const start = new TZDate(new Date(c.start_at), tz);
          const end = c.end_at ? new TZDate(new Date(c.end_at), tz) : null;
          const timeRange = end ? `${format(start, 'HH:mm')}–${format(end, 'HH:mm')}` : format(start, 'HH:mm');
          return `"${c.title}" (${timeRange})`;
        })
        .join(', ');
      conflictHint = `⚠️ This event now overlaps with: ${conflictList}. Warn the user about the overlap.`;
    }
  }

  let output = t(ctx.user.language).aiTools.events.eventUpdated(parts.join(', '));

  if (ctx.participantRepo) {
    const accepted = ctx.participantRepo
      .getByEvent(event_id)
      .filter((p) => p.status === 'accepted' && p.user_id !== ctx.user.telegram_id);
    if (accepted.length > 0) {
      output +=
        ctx.user.language === 'ru'
          ? `. У этого события ${accepted.length} ${ruPlural(accepted.length, 'участник', 'участника', 'участников')} — уведоми их, если изменение существенное (инструмент notify_participants).`
          : `. This event has ${accepted.length} participant${accepted.length > 1 ? 's' : ''} — notify them if the change is significant (use notify_participants tool).`;
    }
  }

  return { success: true, output, agentHint: conflictHint, data: eventToSummary(updated, ctx.user.timezone) };
}

export function handleDeleteEvent(ctx: AgentContext, input: DeleteEventInput): ToolResult {
  const access = checkSecretaryAccess(
    ctx.user.telegram_id,
    input.owner_id,
    ctx.secretary?.secretaryRepo ?? null,
    'write',
  );
  if (!access.ok) return { success: false, error: access.error };
  const userId = access.effectiveUserId;
  const scope = resolveScope(input, ctx);

  if (scope === 'group') {
    if (ctx.groupChatId === undefined) {
      return { success: false, error: 'Group context required for group scope' };
    }
    const event = ctx.eventService.getEventForGroup(input.event_id, ctx.groupChatId);
    if (!event) {
      return { success: false, error: `Event ${input.event_id} not found in group calendar.` };
    }
    ctx.eventService.deleteEventForGroup(input.event_id, ctx.groupChatId!);
    return {
      success: true,
      output: t(ctx.user.language).aiTools.events.eventDeleted(event.title, event.id),
      data: eventToSummary(event, ctx.user.timezone),
    };
  }

  const event = ctx.eventService.getEvent(input.event_id, userId);

  if (!event && ctx.participantRepo) {
    const participant = ctx.participantRepo.findByEventAndUser(input.event_id, userId);
    if (participant && participant.status === 'accepted') {
      ctx.participantRepo.updateStatus(input.event_id, userId, 'declined');
      return { success: true, output: t(ctx.user.language).aiTools.events.eventDeclined(input.event_id) };
    }
  }

  if (!event) {
    return { success: false, error: `Event ${input.event_id} not found or not owned by you.` };
  }

  const googleEventId = event.google_event_id ?? undefined;
  ctx.eventService.deleteEvent(input.event_id, userId);

  if (ctx.google?.schedulePush && googleEventId) {
    ctx.google
      .schedulePush(userId, input.event_id, 'delete', { googleEventId })
      .catch((err) => logger.error({ err }, 'schedulePush failed'));
  }

  return {
    success: true,
    output: t(ctx.user.language).aiTools.events.eventDeleted(event.title, event.id),
    data: eventToSummary(event, ctx.user.timezone),
  };
}

export function handleSearchEvents(ctx: AgentContext, input: SearchEventsInput): ToolResult {
  const access = checkSecretaryAccess(
    ctx.user.telegram_id,
    input.owner_id,
    ctx.secretary?.secretaryRepo ?? null,
    'read',
  );
  if (!access.ok) return { success: false, error: access.error };
  const userId = access.effectiveUserId;
  const scope = resolveScope(input, ctx);
  if (scope === 'group' && ctx.groupChatId === undefined) {
    return { success: false, error: 'Group context required for group scope' };
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
    return { success: true, output: t(ctx.user.language).aiTools.events.noEventsMatching, data };
  }

  const lines = events.map((e) => {
    const parts = [`id: ${e.id}`, `title: ${e.title}`, `start: ${e.start_at}`];
    if (e.end_at) parts.push(`end: ${e.end_at}`);
    if (e.location) parts.push(`location: ${e.location}`);
    return parts.join(', ');
  });

  return { success: true, output: lines.join('\n'), data };
}

export function handleGetUpcoming(ctx: AgentContext, input: GetUpcomingInput): ToolResult {
  const access = checkSecretaryAccess(
    ctx.user.telegram_id,
    input.owner_id,
    ctx.secretary?.secretaryRepo ?? null,
    'read',
  );
  if (!access.ok) return { success: false, error: access.error };
  const userId = access.effectiveUserId;
  const limit = input.limit ?? 5;
  const scope = resolveScope(input, ctx);

  if (scope === 'group' && ctx.groupChatId === undefined) {
    return { success: false, error: 'Group context required for group scope' };
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

  const lines = upcoming.map((occ) => {
    const e = occ.event;
    const parts = [`id: ${e.id}`, `title: ${e.title}`, `start: ${occ.occurrence_start}`];
    if (occ.occurrence_end) parts.push(`end: ${occ.occurrence_end}`);
    if (e.location) parts.push(`location: ${e.location}`);
    return parts.join(', ');
  });

  return {
    success: true,
    output: t(ctx.user.language).aiTools.events.upcomingEvents(upcoming.length, lines.join('\n')),
    data,
  };
}

export function handleSnoozeEvent(ctx: AgentContext, input: SnoozeEventInput): ToolResult {
  const access = checkSecretaryAccess(
    ctx.user.telegram_id,
    input.owner_id,
    ctx.secretary?.secretaryRepo ?? null,
    'write',
  );
  if (!access.ok) return { success: false, error: access.error };
  const userId = access.effectiveUserId;
  const scope = resolveScope(input, ctx);
  if (scope === 'group' && ctx.groupChatId === undefined) {
    return { success: false, error: 'Group context required for group scope' };
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

  return {
    success: true,
    output: t(ctx.user.language).aiTools.events.snoozed(updated.title, minutes, updated.start_at),
  };
}

export function handleGetEvent(ctx: AgentContext, input: GetEventInput): ToolResult {
  const access = checkSecretaryAccess(
    ctx.user.telegram_id,
    input.owner_id,
    ctx.secretary?.secretaryRepo ?? null,
    'read',
  );
  if (!access.ok) return { success: false, error: access.error };
  const userId = access.effectiveUserId;
  const scope = resolveScope(input, ctx);
  if (scope === 'group' && ctx.groupChatId === undefined) {
    return { success: false, error: 'Group context required for group scope' };
  }
  const event =
    scope === 'group'
      ? ctx.eventService.getEventForGroup(input.event_id, ctx.groupChatId!)
      : ctx.eventService.getEvent(input.event_id, userId);

  if (!event) {
    return { success: false, error: `Event ${input.event_id} not found or not owned by you.` };
  }

  const parts = [`id: ${event.id}`, `title: ${event.title}`, `start: ${event.start_at}`];
  if (event.end_at) parts.push(`end: ${event.end_at}`);
  if (event.description) parts.push(`description: ${event.description}`);
  if (event.location) parts.push(`location: ${event.location}`);
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

  return { success: true, output: parts.join(', '), data: eventToSummary(event, ctx.user.timezone) };
}

interface NotifyParticipantsInput {
  event_id: number;
  message: string;
}

export function handleNotifyParticipants(ctx: AgentContext, input: NotifyParticipantsInput): ToolResult {
  const event = ctx.eventService.getEvent(input.event_id, ctx.user.telegram_id);
  if (!event) {
    return { success: false, error: `Event ${input.event_id} not found or not owned by you.` };
  }

  if (!ctx.participantRepo) {
    return { success: false, error: 'Participants feature is not configured.' };
  }

  const accepted = ctx.participantRepo
    .getByEvent(input.event_id)
    .filter((p) => p.status === 'accepted' && p.user_id !== ctx.user.telegram_id);

  if (accepted.length === 0) {
    return { success: false, error: 'This event has no accepted participants to notify.' };
  }

  if (ctx.sender) {
    const senderName = ctx.user.first_name ?? ctx.user.username ?? `User ${ctx.user.telegram_id}`;
    const text = `📅 Update on "${event.title}" from ${senderName}:\n${input.message}`;
    for (const p of accepted) {
      ctx.sender.sendMessage(p.user_id, text).catch((err) => {
        eventsLogger.error({ err: err, userId: p.user_id }, 'Participant notification failed');
      });
    }
  }

  return {
    success: true,
    output:
      ctx.user.language === 'ru'
        ? `Уведомление отправлено ${accepted.length} ${ruPlural(accepted.length, 'участнику', 'участникам', 'участникам')}.`
        : `Notification sent to ${accepted.length} participant${accepted.length > 1 ? 's' : ''}.`,
  };
}
