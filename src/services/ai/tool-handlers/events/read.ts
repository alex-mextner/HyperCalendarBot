// Read-only event tools: get_events, search_events, get_upcoming_events and get_event. They never
// write, so they carry `readonly` metadata and are kept out of the action log.
import { t } from '../../../../config/constants.ts';
import type { CalendarEvent, EventOccurrence } from '../../../../database/types.ts';
import { type AgendaScope, formatEmptyAgenda } from '../../empty-agenda.ts';
import type { AgentContext, ToolHandlerMeta, ToolResult } from '../../types.ts';
import { formatReminderDuration } from '../reminders.ts';
import { checkSecretaryAccess } from '../secretary-access.ts';
import { resolveScope } from '../shared.ts';
import { eventToSummary, locationParts, occurrenceToSummary, timeParts, weatherSuffix } from './presentation.ts';
import { resolveRangeInterval } from './range.ts';
import type { GetEventInput, GetEventsInput, GetUpcomingInput, SearchEventsInput } from './types.ts';

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

function eventDetailParts(ctx: AgentContext, event: CalendarEvent): string[] {
  const parts = [`id: ${event.id}`, `title: ${event.title}`];
  parts.push(...timeParts(event.start_at, event.end_at, event.all_day === 1, ctx.user.timezone));
  if (event.description) parts.push(`description: ${event.description}`);
  parts.push(...locationParts(event));
  if (event.recurrence_rule) parts.push(`recurrence: ${event.recurrence_rule}`);
  if (event.all_day) parts.push('all_day: true');
  return parts;
}

/** The group the event belongs to and who created it, as the assistant should name them. */
function ownershipParts(ctx: AgentContext, event: CalendarEvent): string[] {
  const parts: string[] = [];
  if (event.owner_type === 'group' && event.group_id) {
    const groupTitle = ctx.group?.groupChatRepo.findByChatId(event.group_id)?.title;
    parts.push(`group: ${groupTitle ?? event.group_id}`);
  }
  if (event.created_by) {
    const creator = ctx.userRepo.findByTelegramId(event.created_by);
    const creatorLabel = creator?.username ? `@${creator.username}` : `id:${event.created_by}`;
    parts.push(`created_by: ${creatorLabel}`);
  }
  return parts;
}

function pendingReminderParts(ctx: AgentContext, eventId: number): string[] {
  const reminders = ctx.eventReminderRepo.getForEvent(eventId).filter((r) => r.sent === 0);
  if (reminders.length === 0) return [];
  const unique = [...new Set(reminders.map((r) => formatReminderDuration(r.interval_minutes, ctx.user.language)))];
  return [`reminders: ${unique.join(', ')}`];
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
  const parts = [
    ...eventDetailParts(ctx, event),
    ...ownershipParts(ctx, event),
    ...pendingReminderParts(ctx, input.event_id),
  ];

  return { success: true, output: parts.join(', ') + weather, data: eventToSummary(event, ctx.user.timezone) };
}
handleGetEvent.meta = { readonly: true, skipActionLog: true } satisfies ToolHandlerMeta;
