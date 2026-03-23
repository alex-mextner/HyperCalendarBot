// src/bot/middleware/scene-command-escape.ts

import type { Next } from 'gramio';
import type { User } from '../../database/types.ts';

interface SceneData {
  name: string;
}

interface Storage {
  get(key: string): Promise<unknown>;
  delete(key: string): boolean | undefined | Promise<boolean | undefined>;
}

interface EscapeCtx {
  is(type: string): boolean;
  from?: { id: number };
  dbUser?: User;
  send(text: string, opts?: Record<string, unknown>): Promise<void>;
  text?: string;
}

const SCENE_CANCEL_MESSAGES: Record<string, Record<string, string>> = {
  add_event: { ru: 'Добавление события отменено.', en: 'Event creation cancelled.' },
  edit_value: { ru: 'Редактирование отменено.', en: 'Editing cancelled.' },
  import: { ru: 'Импорт отменён.', en: 'Import cancelled.' },
  timezone: { ru: 'Настройка часового пояса отменена.', en: 'Timezone setup cancelled.' },
  onboarding: { ru: 'Настройка отменена.', en: 'Setup cancelled.' },
};

/**
 * Middleware that intercepts commands while a scene is active.
 * Clears the scene from storage and sends a named cancellation message,
 * then lets the command propagate to the command handlers.
 *
 * Must be registered BEFORE the scenes plugin.
 */
export function createSceneCommandEscape(storage: Storage) {
  return async (context: unknown, next: Next) => {
    const ctx = context as EscapeCtx;
    if (!ctx.is('message')) return next();

    const text = ctx.text;
    if (!text?.startsWith('/')) return next();

    const userId = ctx.from?.id;
    if (!userId) return next();

    const key = `@gramio/scenes:${userId}`;
    const sceneData = (await storage.get(key)) as SceneData | null;
    if (!sceneData) return next();

    await storage.delete(key);

    const lang = (ctx.dbUser?.language ?? 'en') as 'en' | 'ru';
    const message = SCENE_CANCEL_MESSAGES[sceneData.name]?.[lang] ?? (lang === 'ru' ? 'Отменено.' : 'Cancelled.');

    await ctx.send(message, { reply_markup: { remove_keyboard: true } });

    // /cancel has no command handler — don't propagate to avoid "unknown command" fallback
    const isCancel = text === '/cancel' || text.startsWith('/cancel@');
    if (isCancel) return;

    return next();
  };
}
