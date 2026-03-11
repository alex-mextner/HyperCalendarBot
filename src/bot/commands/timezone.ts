// src/bot/commands/timezone.ts
import type { DatabaseService } from '../../database/index.ts';
import type { User } from '../../database/types.ts';
import { getTimezoneDisplay } from '../../services/timezone/timezone-service.ts';
import { timezoneManualKeyboard, timezoneMethodKeyboard } from '../keyboards.ts';
import type { BotCommandContext } from '../types.ts';
import { setSession } from '../types.ts';

export async function handleTimezone(ctx: BotCommandContext, _db: DatabaseService): Promise<void> {
  const user = ctx.dbUser as User;
  const lang = user.language as 'en' | 'ru';
  const display = getTimezoneDisplay(user.timezone);

  const text =
    lang === 'ru'
      ? `🌍 Текущий часовой пояс: ${display}\n\nИзменить?`
      : `🌍 Current timezone: ${display}\n\nChange it?`;

  setSession(user.telegram_id, 'tz:select', { returnTo: 'settings' });

  await ctx.send(text, { reply_markup: timezoneManualKeyboard() });
  await ctx.send(lang === 'ru' ? 'Или отправьте геолокацию:' : 'Or share your location:', {
    reply_markup: timezoneMethodKeyboard(lang),
  });
}
