import type { AgentContext, ToolResult } from '../types.ts';

interface GetFreeSlotsInput {
  date: string;
}

export function handleGetFreeSlots(ctx: AgentContext, input: GetFreeSlotsInput): ToolResult {
  const date = new Date(input.date);
  const slots = ctx.eventService.getFreeSlots(ctx.user.telegram_id, date, ctx.user.timezone);

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
