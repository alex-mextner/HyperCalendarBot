// src/bot/commands/search.ts
import type { EventService } from '../../services/event/event-service.ts';
import type { User } from '../../database/types.ts';
import { t, CB } from '../../config/constants.ts';
import { formatEventListItem } from '../../services/event/formatters.ts';
import { eventPickerKeyboard } from '../keyboards.ts';

export async function handleSearch(ctx: any, eventService: EventService): Promise<void> {
  const user = ctx.dbUser as User;
  const lang = user.language as 'en' | 'ru';
  const query = (ctx.args as string)?.trim();

  if (!query) {
    await ctx.send(lang === 'ru' ? 'Укажите текст для поиска: /search <запрос>' : 'Provide search text: /search <query>');
    return;
  }

  const results = eventService.searchEvents(user.telegram_id, query);

  if (results.length === 0) {
    await ctx.send(t(lang).search_no_results);
    return;
  }

  const lines = results.slice(0, 10).map((e, i) =>
    formatEventListItem(e, user.timezone, i)
  );

  await ctx.send(
    `🔍 ${lang === 'ru' ? `Найдено ${results.length}:` : `Found ${results.length}:`}\n\n${lines.join('\n')}`,
    { reply_markup: eventPickerKeyboard(results.slice(0, 10), user.timezone, CB.EVENT_VIEW) },
  );
}
