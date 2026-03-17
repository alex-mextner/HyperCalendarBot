import { getDayRangeUtc } from '../../../utils/date.ts';
import type { FreeSlot } from '../../event/event-service.ts';
import type { AgentContext, ToolResult } from '../types.ts';

type Scope = 'personal' | 'group';

interface GetFreeSlotsInput {
  date: string;
  scope?: Scope;
}

function resolveScope(inputScope: Scope | undefined, isGroup: boolean): Scope {
  return inputScope ?? (isGroup ? 'group' : 'personal');
}

function computeFreeSlotsFromOccurrences(
  occurrences: { occurrence_start: string; occurrence_end: string | null }[],
  dayStart: string,
  dayEnd: string,
): FreeSlot[] {
  const busy = occurrences
    .filter((o) => o.occurrence_end)
    .map((o) => ({
      start: new Date(o.occurrence_start).getTime(),
      end: new Date(o.occurrence_end!).getTime(),
    }))
    .sort((a, b) => a.start - b.start);

  const slots: FreeSlot[] = [];
  let cursor = new Date(dayStart).getTime();
  const dayEndMs = new Date(dayEnd).getTime();

  for (const interval of busy) {
    if (interval.start > cursor) {
      const durationMinutes = Math.round((interval.start - cursor) / 60000);
      if (durationMinutes > 0) {
        slots.push({
          start: new Date(cursor).toISOString(),
          end: new Date(interval.start).toISOString(),
          durationMinutes,
        });
      }
    }
    cursor = Math.max(cursor, interval.end);
  }

  if (cursor < dayEndMs) {
    const durationMinutes = Math.round((dayEndMs - cursor) / 60000);
    slots.push({
      start: new Date(cursor).toISOString(),
      end: new Date(dayEndMs).toISOString(),
      durationMinutes,
    });
  }

  return slots;
}

export function handleGetFreeSlots(ctx: AgentContext, input: GetFreeSlotsInput): ToolResult {
  const date = new Date(input.date);
  const scope = resolveScope(input.scope, ctx.isGroup);

  let slots: FreeSlot[];
  if (scope === 'group') {
    const { start, end } = getDayRangeUtc(date, ctx.user.timezone);
    const occurrences = ctx.eventService.getEventsInRangeForGroup(ctx.groupChatId!, start, end);
    slots = computeFreeSlotsFromOccurrences(occurrences, start, end);
  } else {
    slots = ctx.eventService.getFreeSlots(ctx.user.telegram_id, date, ctx.user.timezone);
  }

  if (slots.length === 0) {
    return { success: true, output: 'No free slots — the entire day is busy.' };
  }

  const lines = slots.map((s) => {
    const hours = Math.floor(s.durationMinutes / 60);
    const mins = s.durationMinutes % 60;
    const duration = hours > 0 ? (mins > 0 ? `${hours}h ${mins}m` : `${hours}h`) : `${mins}m`;
    return `${s.start} — ${s.end} (${duration})`;
  });

  return { success: true, output: `Free slots:\n${lines.join('\n')}` };
}
