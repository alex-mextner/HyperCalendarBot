import { t } from '../../../config/constants.ts';
import { formatDateHeader, formatTime, localCalendarDate } from '../../../utils/date.ts';
import type { FreeSlot } from '../../event/event-service.ts';
import type { AgentContext, ToolHandlerMeta, ToolResult } from '../types.ts';
import { checkSecretaryAccess } from './secretary-access.ts';
import { resolveScope } from './shared.ts';

type Scope = 'personal' | 'group';

interface GetFreeSlotsInput {
  date: string;
  scope?: Scope;
  owner_id?: number;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** A bare calendar date is that local day; any other value is an instant whose local day is used. */
function resolveRequestedDate(value: string, timezone: string): Date | null {
  if (DATE_ONLY.test(value)) {
    try {
      return localCalendarDate(value, timezone);
    } catch {
      // Impossible calendar dates (2026-02-30) are reported to the caller as invalid input.
      return null;
    }
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatSlotLine(slot: FreeSlot, timezone: string): string {
  const hours = Math.floor(slot.durationMinutes / 60);
  const mins = slot.durationMinutes % 60;
  const duration = hours > 0 ? (mins > 0 ? `${hours}h ${mins}m` : `${hours}h`) : `${mins}m`;
  return `${formatTime(slot.start, timezone)}–${formatTime(slot.end, timezone)} (${duration})`;
}

export function handleGetFreeSlots(ctx: AgentContext, input: GetFreeSlotsInput): ToolResult {
  const access = checkSecretaryAccess(
    ctx.user.telegram_id,
    input.owner_id,
    ctx.secretary?.secretaryRepo ?? null,
    'read',
  );
  if (!access.ok) return { success: false, error: access.error };
  const userId = access.effectiveUserId;
  const lang = ctx.user.language;
  const timezone = ctx.user.timezone;
  const date = resolveRequestedDate(input.date, timezone);
  if (!date) {
    return { success: false, error: t(lang).aiTools.slots.invalidDate, mutationState: 'not_applied' };
  }
  const scope = resolveScope(input, ctx);

  if (scope === 'group' && ctx.groupChatId === undefined) {
    return { success: false, error: 'Group context required for group scope' };
  }

  let slots: FreeSlot[];
  if (scope === 'group') {
    slots = ctx.eventService.getFreeSlotsForGroup(ctx.groupChatId!, date, timezone);
  } else {
    slots = ctx.eventService.getFreeSlots(userId, date, timezone);
  }

  if (slots.length === 0) {
    return { success: true, output: t(lang).aiTools.slots.noFreeSlots, data: { slots } };
  }

  const dateLabel = formatDateHeader(date.toISOString(), timezone, lang);
  const lines = slots.map((s) => formatSlotLine(s, timezone));
  return {
    success: true,
    output: t(lang).aiTools.slots.freeSlots(`${dateLabel}\n${lines.join('\n')}`),
    data: { slots },
  };
}
handleGetFreeSlots.meta = { readonly: true, skipActionLog: true } satisfies ToolHandlerMeta;
