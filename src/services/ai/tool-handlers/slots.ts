import { t } from '../../../config/constants.ts';
import type { FreeSlot } from '../../event/event-service.ts';
import type { AgentContext, ToolResult } from '../types.ts';
import { checkSecretaryAccess } from './secretary-access.ts';
import { resolveScope } from './shared.ts';

type Scope = 'personal' | 'group';

interface GetFreeSlotsInput {
  date: string;
  scope?: Scope;
  owner_id?: number;
}

export function handleGetFreeSlots(ctx: AgentContext, input: GetFreeSlotsInput): ToolResult {
  const access = checkSecretaryAccess(ctx.user.telegram_id, input.owner_id, ctx.secretaryRepo ?? null, 'read');
  if (!access.ok) return { success: false, error: access.error };
  const userId = access.effectiveUserId;
  const date = new Date(input.date);
  const scope = resolveScope(input, ctx);

  if (scope === 'group' && ctx.groupChatId === undefined) {
    return { success: false, error: 'Group context required for group scope' };
  }

  let slots: FreeSlot[];
  if (scope === 'group') {
    slots = ctx.eventService.getFreeSlotsForGroup(ctx.groupChatId!, date, ctx.user.timezone);
  } else {
    slots = ctx.eventService.getFreeSlots(userId, date, ctx.user.timezone);
  }

  const lang = ctx.user.language;
  if (slots.length === 0) {
    return { success: true, output: t(lang).aiTools.slots.noFreeSlots };
  }

  const lines = slots.map((s) => {
    const hours = Math.floor(s.durationMinutes / 60);
    const mins = s.durationMinutes % 60;
    const duration = hours > 0 ? (mins > 0 ? `${hours}h ${mins}m` : `${hours}h`) : `${mins}m`;
    return `${s.start} — ${s.end} (${duration})`;
  });

  return { success: true, output: t(lang).aiTools.slots.freeSlots(lines.join('\n')) };
}
