import { type Lang, t } from '../../../config/constants.ts';
import type { CalendarEvent } from '../../../database/types.ts';
import type { AgentContext, ToolHandlerMeta, ToolResult } from '../types.ts';
import { checkSecretaryAccess } from './secretary-access.ts';
import { resolveScope } from './shared.ts';

type Scope = 'personal' | 'group';

interface SetReminderInput {
  event_id: number;
  minutes_before: number[];
  scope?: Scope;
  owner_id?: number;
}

export function formatReminderDuration(minutesBefore: number, lang: Lang): string {
  const msgs = t(lang).aiTools.reminders;
  if (minutesBefore >= 60) {
    const hours = Math.floor(minutesBefore / 60);
    const mins = minutesBefore % 60;
    return msgs.durationHourMin(hours, mins);
  }
  return msgs.durationMin(minutesBefore);
}

export function handleSetReminder(ctx: AgentContext, input: SetReminderInput): ToolResult {
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

  const overridesJson = JSON.stringify(input.minutes_before);
  const updated =
    scope === 'group'
      ? ctx.eventService.updateEventForGroup(input.event_id, ctx.groupChatId!, {
          reminder_overrides: overridesJson,
        })
      : ctx.eventService.updateEvent(input.event_id, userId, {
          reminder_overrides: overridesJson,
        });
  if (!updated) {
    return {
      success: false,
      error: `Event ${input.event_id} not found or not owned by you.`,
    };
  }

  const lang = ctx.user.language;
  if (input.minutes_before.length === 0) {
    return {
      success: true,
      output: t(lang).aiTools.reminders.remindersDisabled(updated.title),
    };
  }

  const descriptions = input.minutes_before.map((m) => formatReminderDuration(m, lang));
  return {
    success: true,
    output: t(lang).aiTools.reminders.remindersSet(updated.title, descriptions.join(', ')),
  };
}

interface GetRemindersInput {
  event_id?: number;
  event_ids?: number[];
  query?: string;
  scope?: Scope;
  owner_id?: number;
}

function formatEventReminders(event: CalendarEvent, ctx: AgentContext, lang: Lang): string | null {
  const reminders = ctx.eventReminderRepo.getForEvent(event.id).filter((r) => r.sent === 0);
  if (reminders.length === 0) return null;
  const durations = [...new Set(reminders.map((r) => formatReminderDuration(r.interval_minutes, lang)))];
  return `"${event.title}" (id:${event.id}): ${durations.join(', ')}`;
}

/** Event access for the resolved scope: group-scoped or the effective user's personal events. */
interface EventLookup {
  getEvent(id: number): CalendarEvent | null;
  searchEvents(query: string): CalendarEvent[];
}

function buildEventLookup(ctx: AgentContext, scope: Scope, userId: number): EventLookup {
  if (scope === 'group') {
    return {
      getEvent: (id) => ctx.eventService.getEventForGroup(id, ctx.groupChatId!),
      searchEvents: (query) => ctx.eventService.searchEventsForGroup(ctx.groupChatId!, query),
    };
  }
  return {
    getEvent: (id) => ctx.eventService.getEvent(id, userId),
    searchEvents: (query) => ctx.eventService.searchEvents(userId, query),
  };
}

function getSingleEventReminders(ctx: AgentContext, lookup: EventLookup, eventId: number, lang: Lang): ToolResult {
  const event = lookup.getEvent(eventId);
  if (!event) {
    return { success: false, error: `Event ${eventId} not found or not owned by you.` };
  }

  const reminders = ctx.eventReminderRepo.getForEvent(eventId).filter((r) => r.sent === 0);
  if (reminders.length === 0) {
    return { success: true, output: t(lang).aiTools.reminders.noReminders(event.title) };
  }
  const lines = reminders.map((r) => {
    const dur = formatReminderDuration(r.interval_minutes, lang);
    return t(lang).aiTools.reminders.beforeDuration(dur);
  });
  const unique = [...new Set(lines)];
  return { success: true, output: t(lang).aiTools.reminders.remindersFor(event.title, unique.join(', ')) };
}

function getRemindersByIds(ctx: AgentContext, lookup: EventLookup, eventIds: number[], lang: Lang): ToolResult {
  const events: CalendarEvent[] = [];
  for (const id of eventIds) {
    const event = lookup.getEvent(id);
    if (event) events.push(event);
  }
  if (events.length === 0) {
    return { success: false, error: 'None of the specified events were found.' };
  }
  return buildMultiEventResult(events, ctx, lang);
}

function getRemindersByQuery(ctx: AgentContext, lookup: EventLookup, query: string, lang: Lang): ToolResult {
  const events = lookup.searchEvents(query);
  if (events.length === 0) {
    return {
      success: true,
      output: t(lang).aiTools.reminders.noEventsForQuery(query),
    };
  }
  return buildMultiEventResult(events, ctx, lang);
}

export function handleGetReminders(ctx: AgentContext, input: GetRemindersInput): ToolResult {
  const access = checkSecretaryAccess(
    ctx.user.telegram_id,
    input.owner_id,
    ctx.secretary?.secretaryRepo ?? null,
    'read',
  );
  if (!access.ok) return { success: false, error: access.error };
  const scope = resolveScope(input, ctx);
  if (scope === 'group' && ctx.groupChatId === undefined) {
    return { success: false, error: 'Group context required for group scope' };
  }
  const lang = ctx.user.language;
  const lookup = buildEventLookup(ctx, scope, access.effectiveUserId);

  // Single event by ID (only when neither event_ids nor query is given)
  if (input.event_id !== undefined && input.event_ids === undefined && input.query === undefined) {
    return getSingleEventReminders(ctx, lookup, input.event_id, lang);
  }
  if (input.event_ids !== undefined) return getRemindersByIds(ctx, lookup, input.event_ids, lang);
  if (input.query !== undefined) return getRemindersByQuery(ctx, lookup, input.query, lang);

  return { success: false, error: 'Provide event_id, event_ids, or query.' };
}
handleGetReminders.meta = { readonly: true, skipActionLog: true } satisfies ToolHandlerMeta;

function buildMultiEventResult(events: CalendarEvent[], ctx: AgentContext, lang: Lang): ToolResult {
  const withReminders: string[] = [];
  const withoutReminders: string[] = [];

  for (const event of events) {
    const line = formatEventReminders(event, ctx, lang);
    if (line) {
      withReminders.push(line);
    } else {
      withoutReminders.push(`"${event.title}" (id:${event.id})`);
    }
  }

  const parts: string[] = [];
  if (withReminders.length > 0) {
    parts.push(withReminders.join('\n'));
  }
  if (withoutReminders.length > 0) {
    const label = t(lang).aiTools.reminders.noRemindersLabel;
    parts.push(`${label}: ${withoutReminders.join(', ')}`);
  }
  if (parts.length === 0) {
    return {
      success: true,
      output: t(lang).aiTools.reminders.noRemindersFound,
    };
  }
  return { success: true, output: parts.join('\n') };
}
