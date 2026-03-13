import { TZDate } from '@date-fns/tz';
import { addDays, format, startOfDay } from 'date-fns';
import type { AgentContext } from './types.ts';

function getEventsForPrompt(ctx: AgentContext, date: Date, label: string): string {
  const occurrences = ctx.eventService.getEventsForDay(ctx.user.telegram_id, date, ctx.user.timezone);
  if (occurrences.length === 0) return `${label}: No events.`;

  const lines = occurrences.map((occ) => {
    const start = format(new TZDate(occ.occurrence_start, ctx.user.timezone), 'HH:mm');
    const end = occ.occurrence_end ? format(new TZDate(occ.occurrence_end, ctx.user.timezone), 'HH:mm') : null;
    const time = end ? `${start}\u2013${end}` : start;
    const loc = occ.event.location ? ` (${occ.event.location})` : '';
    const desc = occ.event.description ? ` \u2014 ${occ.event.description}` : '';
    return `  - ${time} ${occ.event.title}${loc}${desc}`;
  });

  return `${label}:\n${lines.join('\n')}`;
}

export function buildSystemPrompt(ctx: AgentContext): string {
  const now = TZDate.tz(ctx.user.timezone);
  const currentDateTime = format(now, 'yyyy-MM-dd HH:mm EEEE');
  const today = startOfDay(now);
  const tomorrow = addDays(today, 1);

  const todayEvents = getEventsForPrompt(ctx, new Date(today.toISOString()), "Today's events");
  const tomorrowEvents = getEventsForPrompt(ctx, new Date(tomorrow.toISOString()), "Tomorrow's events");

  const langInstruction =
    ctx.user.language === 'ru'
      ? 'The user speaks Russian. Always respond in Russian.'
      : 'The user speaks English. Always respond in English.';

  return `You are a calendar assistant for a Telegram bot. You help users manage their schedule.

## User Info
- Name: ${ctx.user.first_name ?? ctx.user.username ?? 'User'}
- Language: ${ctx.user.language}
- Timezone: ${ctx.user.timezone}
- Current date/time: ${currentDateTime}

## ${todayEvents}

## ${tomorrowEvents}

## Rules
- ${langInstruction}
- All dates/times in tool calls must use ISO 8601 UTC format (e.g., "2026-03-15T14:00:00Z").
- Convert user's local times to UTC using their timezone (${ctx.user.timezone}) before passing to tools.
- When displaying times to the user, convert from UTC to their local timezone.
- Be concise. No unnecessary preamble.
- For event creation, always confirm the details before creating.
- Use Telegram-safe formatting: bold with *, italic with _, code with \`.
- Never invent events — only report what tools return.
- If a tool returns an error, explain it to the user clearly.
- When the user asks about free time, use the get_free_slots tool.
- For recurring events, use RRULE format (e.g., "FREQ=WEEKLY;INTERVAL=2").`;
}
