// src/bot/commands/search.ts

import type { InlineKeyboard } from 'gramio';
import { CB, t } from '../../config/constants.ts';
import type { GroupChatRepository } from '../../database/repositories/group-chat.repository.ts';
import type { CalendarEvent } from '../../database/types.ts';
import type { EventService } from '../../services/event/event-service.ts';
import { formatEventListItem } from '../../services/event/formatters.ts';
import { getGroupId, isGroup } from '../group-context.ts';
import { EVENT_PICKER_PAGE_SIZE, eventPickerKeyboard } from '../keyboards.ts';
import type { BotCommandContext } from '../types.ts';

/**
 * Build the text and keyboard for one page of search results.
 * The callback data for paging carries the original query text (there is no
 * server-side session for search), so a long query can push a page callback
 * past Telegram's 64-byte callback_data limit — when that would happen, the
 * forward button is suppressed rather than sending an oversized payload.
 */
export function buildSearchResultsView(
  results: CalendarEvent[],
  page: number,
  timezone: string,
  lang: 'en' | 'ru',
  query: string,
): { text: string; keyboard: InlineKeyboard } {
  const start = page * EVENT_PICKER_PAGE_SIZE;
  const pageItems = results.slice(start, start + EVENT_PICKER_PAGE_SIZE);
  const lines = pageItems.map((e, i) => formatEventListItem(e, timezone, i, lang));
  const text = `🔍 ${lang === 'ru' ? `Найдено ${results.length}:` : `Found ${results.length}:`}\n\n${lines.join('\n')}`;

  const rawHasMore = results.length > start + EVENT_PICKER_PAGE_SIZE;
  const nextPageCallback = `${CB.EVENT_VIEW}:page:${page + 1}:${query}`;
  const withinCallbackBudget = new TextEncoder().encode(nextPageCallback).length <= 64;
  const hasMore = rawHasMore && withinCallbackBudget;

  return {
    text,
    keyboard: eventPickerKeyboard(pageItems, timezone, CB.EVENT_VIEW, lang, {
      page,
      hasMore,
      onPage: (p) => `${CB.EVENT_VIEW}:page:${p}:${query}`,
    }),
  };
}

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

    const { text, keyboard } = buildSearchResultsView(results, 0, timezone, lang, query);
    await ctx.send(text, { reply_markup: keyboard });
    return;
  }

  const results = eventService.searchEvents(user.telegram_id, query);

  if (results.length === 0) {
    await ctx.send(t(lang).search_no_results);
    return;
  }

  const { text, keyboard } = buildSearchResultsView(results, 0, user.timezone, lang, query);
  await ctx.send(text, { reply_markup: keyboard });
}
