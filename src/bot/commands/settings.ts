// src/bot/commands/settings.ts
import type { User } from '../../database/types.ts';
import { getTimezoneDisplay } from '../../services/timezone/timezone-service.ts';
import type { BotCommandContext } from '../types.ts';

export async function handleSettings(ctx: BotCommandContext): Promise<void> {
  const user = ctx.dbUser as User;
  const lang = user.language as 'en' | 'ru';
  const tzDisplay = getTimezoneDisplay(user.timezone);
  const country = user.country_code ?? (lang === 'ru' ? 'не задана' : 'not set');

  const text =
    lang === 'ru'
      ? `⚙️ <b>Настройки</b>\n\n🌍 Часовой пояс: ${tzDisplay}\n🗣 Язык: Русский\n🏳️ Страна: ${country}\n\n/timezone — изменить пояс\n/help — все команды`
      : `⚙️ <b>Settings</b>\n\n🌍 Timezone: ${tzDisplay}\n🗣 Language: English\n🏳️ Country: ${country}\n\n/timezone — change timezone\n/help — all commands`;

  await ctx.send(text, { parse_mode: 'HTML' });
}
