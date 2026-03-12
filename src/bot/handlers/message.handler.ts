// src/bot/handlers/message.handler.ts

import type { User } from '../../database/types.ts';
import type { BotCommandContext } from '../types.ts';

/**
 * Handle free-text messages.
 * All wizard routing is now handled by @gramio/scenes.
 * This is a simple fallback for unrecognized messages.
 */
export function createMessageHandler() {
  return async (ctx: BotCommandContext) => {
    const user = ctx.dbUser as User | undefined;
    if (!user) return;

    const text = ctx.text as string | undefined;
    if (!text) return;

    const lang = user.language as 'en' | 'ru';
    await ctx.send(
      lang === 'ru'
        ? 'Не понимаю. Используйте /help для списка команд.'
        : "I don't understand. Use /help for commands.",
    );
  };
}
