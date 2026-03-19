import { t } from '../../../config/constants.ts';
import type { AgentContext, ToolResult } from '../types.ts';
import { checkSecretaryAccess } from './secretary-access.ts';
import { resolveScope } from './shared.ts';

type Scope = 'personal' | 'group';

interface SetReminderInput {
  event_id: number;
  minutes_before: number[];
  scope?: Scope;
  owner_id?: number;
}

function formatReminderDuration(minutesBefore: number, lang: string): string {
  if (minutesBefore >= 60) {
    const hours = Math.floor(minutesBefore / 60);
    const mins = minutesBefore % 60;
    if (lang === 'ru') return mins > 0 ? `${hours}ч ${mins}мин` : `${hours}ч`;
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  }
  return lang === 'ru' ? `${minutesBefore}мин` : `${minutesBefore}min`;
}

export function handleSetReminder(ctx: AgentContext, input: SetReminderInput): ToolResult {
  const access = checkSecretaryAccess(ctx.user.telegram_id, input.owner_id, ctx.secretaryRepo ?? null, 'write');
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
    return {
      success: false,
      error: `Event ${input.event_id} not found or not owned by you.`,
    };
  }

  const lang = ctx.user.language;
  const reminders = ctx.reminderRepo.setForEvent(input.event_id, input.minutes_before);
  const descriptions = reminders.map((r) => formatReminderDuration(r.minutes_before, lang));

  return {
    success: true,
    output: t(lang).aiTools.reminders.remindersSet(event.title, descriptions.join(', ')),
  };
}

interface GetRemindersInput {
  event_id: number;
  scope?: Scope;
  owner_id?: number;
}

export function handleGetReminders(ctx: AgentContext, input: GetRemindersInput): ToolResult {
  const access = checkSecretaryAccess(ctx.user.telegram_id, input.owner_id, ctx.secretaryRepo ?? null, 'read');
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

  const reminders = ctx.reminderRepo.getByEventId(input.event_id);
  const lang = ctx.user.language;
  if (reminders.length === 0) {
    return { success: true, output: t(lang).aiTools.reminders.noReminders(event.title) };
  }

  const lines = reminders.map((r) => {
    const dur = formatReminderDuration(r.minutes_before, lang);
    return lang === 'ru' ? `за ${dur}` : `${dur} before`;
  });

  return { success: true, output: t(lang).aiTools.reminders.remindersFor(event.title, lines.join(', ')) };
}
