// src/bot/commands/add.ts

import type { AnyScene } from '@gramio/scenes';
import { addMinutes } from 'date-fns';
import { t } from '../../config/constants.ts';
import type { GroupChatRepository } from '../../database/repositories/group-chat.repository.ts';
import type { User } from '../../database/types.ts';
import type { EventService } from '../../services/event/event-service.ts';
import { formatEventDetail } from '../../services/event/formatters.ts';
import { hasExplicitTime, parseSimpleDate } from '../../utils/date.ts';
import { getGroupId } from '../group-context.ts';
import { eventCreatedActionsKeyboard } from '../keyboards.ts';
import type { BotCommandContext } from '../types.ts';

export async function handleAdd(
  ctx: BotCommandContext,
  eventService: EventService,
  addEventScene: AnyScene,
  groupRepo?: GroupChatRepository,
): Promise<void> {
  const user = ctx.dbUser;
  if (!user) return;
  const lang = user.language as 'en' | 'ru';
  const args = ctx.args as string | undefined;

  const groupId = getGroupId(ctx);

  if (groupId !== null) {
    const timezone = groupRepo?.getTimezone(groupId) ?? null;
    if (!timezone) {
      await ctx.send(
        lang === 'ru'
          ? '⚙️ Сначала задайте таймзону группы через /settings'
          : '⚙️ Set the group timezone first via /settings',
      );
      return;
    }

    if (args && args.trim().length > 0) {
      return handleQuickAdd(ctx, eventService, user, args.trim(), addEventScene, { groupId, timezone });
    }

    await ctx.scene.enter(addEventScene);
    return;
  }

  if (args && args.trim().length > 0) {
    return handleQuickAdd(ctx, eventService, user, args.trim(), addEventScene, null);
  }

  await ctx.scene.enter(addEventScene);
}

async function handleQuickAdd(
  ctx: BotCommandContext,
  eventService: EventService,
  user: User,
  input: string,
  addEventScene: AnyScene,
  group: { groupId: number; timezone: string } | null,
): Promise<void> {
  const lang = user.language as 'en' | 'ru';
  const timezone = group?.timezone ?? user.timezone;

  // Try to parse "Title <date expression>"
  // Strategy: last part matching a date pattern is the date, rest is title
  const words = input.split(' ');
  let title = '';
  let dateStr = '';
  let pendingTitle = '';
  let pendingDate = '';

  // Try progressively: last 3 words as date, then last 2, then last 1.
  // A date-only match is useful too: keep it and let the wizard ask only for time.
  for (let dateWords = 3; dateWords >= 1; dateWords--) {
    if (words.length <= dateWords) continue;
    const candidate = words.slice(-dateWords).join(' ');
    const parsed = parseSimpleDate(candidate, timezone);
    if (!parsed) continue;

    const candidateTitle = words.slice(0, -dateWords).join(' ').trim();
    if (!candidateTitle) continue;

    if (hasExplicitTime(candidate)) {
      title = candidateTitle;
      dateStr = candidate;
      break;
    }

    if (!pendingTitle) {
      pendingTitle = candidateTitle;
      pendingDate = parsed.toISOString();
    }
  }

  if (!title || !dateStr) {
    if (pendingTitle && pendingDate) {
      await ctx.scene.enter(addEventScene, { initialTitle: pendingTitle, pendingDate });
    } else {
      await ctx.scene.enter(addEventScene);
    }
    return;
  }

  const startDate = parseSimpleDate(dateStr, timezone)!;
  const groupFields =
    group !== null
      ? {
          owner_type: 'group' as const,
          group_id: group.groupId,
          created_by: user.telegram_id,
        }
      : {};

  const defaultMins = user.default_event_duration_minutes ?? 60;
  const event = eventService.createEvent({
    user_id: user.telegram_id,
    title,
    start_at: startDate.toISOString(),
    end_at: addMinutes(startDate, defaultMins).toISOString(),
    timezone,
    ...groupFields,
  });

  const detail = formatEventDetail(event, timezone, lang);
  await ctx.send(`${t(lang).event_created(title)}\n\n${detail}`, {
    parse_mode: 'HTML',
    reply_markup: eventCreatedActionsKeyboard(event.id, lang),
  });
}
