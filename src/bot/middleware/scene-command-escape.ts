// src/bot/middleware/scene-command-escape.ts

import type { Next } from 'gramio';
import { t } from '../../config/constants.ts';
import type { User } from '../../database/types.ts';
import { abortConnectAuth, CONNECT_TELEGRAM_SCENE, deleteWizardInput } from '../scenes/connect-telegram.scene.ts';

interface SceneData {
  name: string;
  state?: unknown;
}

interface Storage {
  get(key: string): Promise<unknown>;
  delete(key: string): boolean | undefined | Promise<boolean | undefined>;
}

interface EscapeCtx {
  is(type: string): boolean;
  from?: { id: number };
  dbUser?: User;
  send(text: string, opts?: { reply_markup?: { remove_keyboard?: boolean } }): Promise<void>;
  delete(): Promise<unknown>;
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
 * then lets the command propagate to the command handlers — except inside the
 * Telegram-connect wizard, whose input may be a credential and goes nowhere.
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

    // At the connect wizard's prompts a "/…" text may be the 2FA password: end the wizard like its
    // cancel button (stop the login, drop its temp session), take the message off the chat, and
    // hand it to no command handler or AI.
    if (sceneData.name === CONNECT_TELEGRAM_SCENE) {
      await deleteWizardInput(ctx, userId);
      await abortConnectAuth(userId, sceneData.state);
      await ctx.send(t(lang).connectTelegram.authCancelled, { reply_markup: { remove_keyboard: true } });
      return;
    }

    const message = SCENE_CANCEL_MESSAGES[sceneData.name]?.[lang] ?? (lang === 'ru' ? 'Отменено.' : 'Cancelled.');

    await ctx.send(message, { reply_markup: { remove_keyboard: true } });

    // /cancel has no command handler — don't propagate to avoid "unknown command" fallback
    const isCancel = text === '/cancel' || text.startsWith('/cancel@');
    if (isCancel) return;

    return next();
  };
}
