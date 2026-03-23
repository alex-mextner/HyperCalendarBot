// src/bot/commands/search.ts

import { CB, t } from '../../config/constants.ts';
import type { GroupChatRepository } from '../../database/repositories/group-chat.repository.ts';
import type { EventService } from '../../services/event/event-service.ts';
import { formatEventListItem } from '../../services/event/formatters.ts';
import { getGroupId, isGroup } from '../group-context.ts';
import { eventPickerKeyboard } from '../keyboards.ts';
import type { BotCommandContext } from '../types.ts';

export async function handleSearch(
  ctx: BotCommandContext,
  eventService: EventService,
  groupRepo?: GroupChatRepository,
): Promise<void> {
  const user = ctx.dbUser;
  if (!user) return;
  const lang = user.language as 'en' | 'ru';
  const query = (ctx.args as string)?.trim();

  if (!query) {
    await ctx.send(
      lang === 'ru' ? 'Укажите текст для поиска: /search <запрос>' : 'Provide search text: /search <query>',
    );
    return;
  }

  if (isGroup(ctx)) {
    const groupId = getGroupId(ctx);
    if (groupId === null) return;
    const timezone = groupRepo?.getTimezone(groupId) ?? user.timezone;
    const results = eventService.searchEventsForGroup(groupId, query);

    if (results.length === 0) {
      await ctx.send(t(lang).search_no_results);
      return;
    }

    const lines = results.slice(0, 10).map((e, i) => formatEventListItem(e, timezone, i, lang));
    await ctx.send(
      `🔍 ${lang === 'ru' ? `Найдено ${results.length}:` : `Found ${results.length}:`}\n\n${lines.join('\n')}`,
      { reply_markup: eventPickerKeyboard(results.slice(0, 10), timezone, CB.EVENT_VIEW) },
    );
    return;
  }

  const results = eventService.searchEvents(user.telegram_id, query);

  if (results.length === 0) {
    await ctx.send(t(lang).search_no_results);
    return;
  }

  const lines = results.slice(0, 10).map((e, i) => formatEventListItem(e, user.timezone, i, lang));

  await ctx.send(
    `🔍 ${lang === 'ru' ? `Найдено ${results.length}:` : `Found ${results.length}:`}\n\n${lines.join('\n')}`,
    { reply_markup: eventPickerKeyboard(results.slice(0, 10), user.timezone, CB.EVENT_VIEW) },
  );
}
