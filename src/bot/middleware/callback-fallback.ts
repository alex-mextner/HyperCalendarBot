// src/bot/middleware/callback-fallback.ts

import type { User } from '../../database/types.ts';

interface Storage {
  get(key: string): Promise<unknown>;
}

interface CallbackContext {
  is(type: string): boolean;
  from?: { id: number };
  answer(opts?: { text?: string; show_alert?: boolean }): Promise<unknown>;
  dbUser?: User;
}

/**
 * Global fallback for unanswered callback queries.
 *
 * Wraps context.answer() to track whether downstream handlers
 * (scenes, callback router) answered the query. If not,
 * answers with a descriptive toast instead of leaving
 * Telegram's button spinner hanging forever.
 */
export function createCallbackFallback(sceneStorage: Storage) {
  return async (context: object, next: () => Promise<unknown>) => {
    const ctx = context as CallbackContext;
    if (!ctx.is('callback_query')) return next();

    let answered = false;
    const origAnswer = ctx.answer.bind(ctx);
    ctx.answer = async (opts?: { text?: string; show_alert?: boolean }) => {
      answered = true;
      return origAnswer(opts);
    };

    await next();

    if (answered) return;

    const lang = (ctx.dbUser?.language ?? 'en') as 'en' | 'ru';
    const userId = ctx.from?.id;

    if (userId) {
      const key = `@gramio/scenes:${userId}`;
      const sceneData = await sceneStorage.get(key);
      if (sceneData) {
        await origAnswer({
          text:
            lang === 'ru'
              ? 'Идёт другое действие. /cancel для отмены.'
              : 'Another action in progress. /cancel to cancel.',
        });
        return;
      }
    }

    await origAnswer({
      text: lang === 'ru' ? 'Действие устарело.' : 'Action expired.',
    });
  };
}
