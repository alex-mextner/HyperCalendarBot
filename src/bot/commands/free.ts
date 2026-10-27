// src/bot/commands/free.ts

import { t } from '../../config/constants.ts';
import type { GroupChatRepository } from '../../database/repositories/group-chat.repository.ts';
import type { EventService, FreeSlot } from '../../services/event/event-service.ts';
import type { HolidayService } from '../../services/holiday/holiday-service.ts';
import { formatDateHeader, formatTime, parseSimpleDate } from '../../utils/date.ts';
import { getGroupId, isGroup } from '../group-context.ts';
import type { BotCommandContext } from '../types.ts';

function formatFreeDuration(durationMinutes: number): string {
  const hours = Math.floor(durationMinutes / 60);
  const mins = durationMinutes % 60;
  if (hours === 0) return `${mins}m`;
  return mins > 0 ? `${hours}h${mins}m` : `${hours}h`;
}

function formatFreeSlotLines(slots: FreeSlot[], timezone: string): string {
  return slots
    .map(
      (s) =>
        `  ${formatTime(s.start, timezone)}–${formatTime(s.end, timezone)}  (${formatFreeDuration(s.durationMinutes)})`,
    )
    .join('\n');
}

/** Date from the command argument interpreted in `timezone`; today when absent or unparsable. */
function resolveFreeDate(args: string | undefined, timezone: string): Date {
  if (!args) return new Date();
  return parseSimpleDate(`${args} 00:00`, timezone) ?? new Date();
}

async function sendFreeSlots(
  ctx: BotCommandContext,
  lang: 'en' | 'ru',
  date: Date,
  timezone: string,
  slots: FreeSlot[],
): Promise<void> {
  if (slots.length === 0) {
    await ctx.send(lang === 'ru' ? 'Весь день занят!' : 'Full day busy!');
    return;
  }
  const dateLabel = formatDateHeader(date.toISOString(), timezone, lang);
  await ctx.send(`${t(lang).free_header(dateLabel)}\n\n${formatFreeSlotLines(slots, timezone)}`);
}

async function handleGroupFree(
  ctx: BotCommandContext,
  eventService: EventService,
  groupRepo: GroupChatRepository | undefined,
  lang: 'en' | 'ru',
  args: string | undefined,
): Promise<void> {
  const groupId = getGroupId(ctx);
  if (groupId === null) return;
  const timezone = groupRepo?.getTimezone(groupId) ?? null;
  if (!timezone) {
    await ctx.send(
      lang === 'ru'
        ? '⚙️ Сначала задайте таймзону группы через /settings'
        : '⚙️ Set the group timezone first via /settings',
    );
    return;
  }
  const date = resolveFreeDate(args, timezone);
  await sendFreeSlots(ctx, lang, date, timezone, eventService.getFreeSlotsForGroup(groupId, date, timezone));
}

export async function handleFree(
  ctx: BotCommandContext,
  eventService: EventService,
  holidayService?: HolidayService,
  groupRepo?: GroupChatRepository,
): Promise<void> {
  const user = ctx.dbUser;
  if (!user) return;
  const lang = user.language as 'en' | 'ru';
  const args = (ctx.args as string)?.trim();

  if (isGroup(ctx)) {
    await handleGroupFree(ctx, eventService, groupRepo, lang, args);
    return;
  }

  const date = resolveFreeDate(args, user.timezone);

  if (holidayService?.isDayOff(user.telegram_id, date.toISOString().slice(0, 10))) {
    const dateLabel = formatDateHeader(date.toISOString(), user.timezone, lang);
    await ctx.send(`${dateLabel}\n\n${t(lang).holidays_day_off}`);
    return;
  }

  await sendFreeSlots(ctx, lang, date, user.timezone, eventService.getFreeSlots(user.telegram_id, date, user.timezone));
}
