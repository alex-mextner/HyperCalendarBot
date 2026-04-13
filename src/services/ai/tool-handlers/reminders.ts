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

export function handleGetReminders(ctx: AgentContext, input: GetRemindersInput): ToolResult {
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
  const lang = ctx.user.language;

  // Single event by ID
  if (input.event_id !== undefined && input.event_ids === undefined && input.query === undefined) {
    const event =
      scope === 'group'
        ? ctx.eventService.getEventForGroup(input.event_id, ctx.groupChatId!)
        : ctx.eventService.getEvent(input.event_id, userId);
    if (!event) {
      return { success: false, error: `Event ${input.event_id} not found or not owned by you.` };
    }

    const reminders = ctx.eventReminderRepo.getForEvent(input.event_id).filter((r) => r.sent === 0);
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

  // Multiple events by IDs
  if (input.event_ids !== undefined) {
    const events: CalendarEvent[] = [];
    for (const id of input.event_ids) {
      const event =
        scope === 'group'
          ? ctx.eventService.getEventForGroup(id, ctx.groupChatId!)
          : ctx.eventService.getEvent(id, userId);
      if (event) events.push(event);
    }
    if (events.length === 0) {
      return { success: false, error: 'None of the specified events were found.' };
    }
    return buildMultiEventResult(events, ctx, lang);
  }

  // Search by query
  if (input.query !== undefined) {
    const events =
      scope === 'group'
        ? ctx.eventService.searchEventsForGroup(ctx.groupChatId!, input.query)
        : ctx.eventService.searchEvents(userId, input.query);
    if (events.length === 0) {
      return {
        success: true,
        output: t(lang).aiTools.reminders.noEventsForQuery(input.query),
      };
    }
    return buildMultiEventResult(events, ctx, lang);
  }

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
