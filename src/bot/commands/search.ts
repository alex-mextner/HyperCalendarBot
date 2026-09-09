// src/bot/commands/search.ts

import type { InlineKeyboard } from 'gramio';
import { CB, t } from '../../config/constants.ts';
import type { GroupChatRepository } from '../../database/repositories/group-chat.repository.ts';
import type { CalendarEvent, User } from '../../database/types.ts';
import { enrichAgendaEvents } from '../../services/event/agenda-enrichment.ts';
import type { EventService } from '../../services/event/event-service.ts';
import { formatEventListItem } from '../../services/event/formatters.ts';
import { getGroupId, isGroup } from '../group-context.ts';
import { EVENT_PICKER_PAGE_SIZE, eventPickerKeyboard } from '../keyboards.ts';
import type { BotCommandContext } from '../types.ts';
import { sendAgendaText } from './agenda-text.ts';

/** Telegram rejects callback_data longer than 64 bytes. */
const CALLBACK_DATA_MAX_BYTES = 64;

/**
 * Search the group's events (in a group chat) or the user's own, enriched for display.
 * Shared by /search and its page callbacks so every page shows the same list.
 */
export function findSearchResults(
  eventService: EventService,
  user: User,
  groupId: number | null,
  query: string,
): CalendarEvent[] {
  const language = user.language as 'en' | 'ru';
  return groupId !== null
    ? enrichAgendaEvents(
        eventService.searchEventsForGroup(groupId, query),
        { userId: user.telegram_id, language, groupId },
        eventService.agendaRepository,
      )
    : enrichAgendaEvents(
        eventService.searchEvents(user.telegram_id, query),
        { userId: user.telegram_id, language },
        eventService.agendaRepository,
      );
}

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
  const lines = pageItems.map((e, i) => formatEventListItem(e, timezone, start + i, lang));
  const text = `🔍 ${lang === 'ru' ? `Найдено ${results.length}:` : `Found ${results.length}:`}\n\n${lines.join('\n')}`;

  const onPage = (p: number) => `${CB.EVENT_VIEW}:page:${p}:${query}`;
  const withinCallbackBudget = new TextEncoder().encode(onPage(page + 1)).length <= CALLBACK_DATA_MAX_BYTES;
  const hasMore = results.length > start + EVENT_PICKER_PAGE_SIZE && withinCallbackBudget;

  return {
    text,
    keyboard: eventPickerKeyboard(pageItems, timezone, CB.EVENT_VIEW, lang, { page, hasMore, onPage }),
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

  const groupId = isGroup(ctx) ? getGroupId(ctx) : null;
  if (isGroup(ctx) && groupId === null) return;
  const timezone = groupId !== null ? (groupRepo?.getTimezone(groupId) ?? user.timezone) : user.timezone;
  const results = findSearchResults(eventService, user, groupId, query);

  if (results.length === 0) {
    await ctx.send(t(lang).search_no_results);
    return;
  }

  const { text, keyboard } = buildSearchResultsView(results, 0, timezone, lang, query);
  await sendAgendaText(ctx, text, { reply_markup: keyboard });
}
