import type { AgentContext, ToolResult } from '../types.ts';

interface SetReminderInput {
  event_id: number;
  minutes_before: number[];
}

export function handleSetReminder(ctx: AgentContext, input: SetReminderInput): ToolResult {
  const event = ctx.eventService.getEvent(input.event_id, ctx.user.telegram_id);
  if (!event) {
    return {
      success: false,
      error: `Event ${input.event_id} not found or not owned by you.`,
    };
  }

  const reminders = ctx.reminderRepo.setForEvent(input.event_id, input.minutes_before);

  const descriptions = reminders.map((r) => {
    if (r.minutes_before >= 60) {
      const hours = Math.floor(r.minutes_before / 60);
      const mins = r.minutes_before % 60;
      const label = mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
      return `${r.minutes_before}min (${label})`;
    }
    return `${r.minutes_before}min`;
  });

  return {
    success: true,
    output: `Reminders set for "${event.title}": ${descriptions.join(', ')}`,
  };
}
