// src/bot/handlers/message.handler.ts
import type { DatabaseService } from '../../database/index.ts';
import type { User } from '../../database/types.ts';
import type { EventService } from '../../services/event/event-service.ts';
import { getTimezoneDisplay, resolveTimezone } from '../../services/timezone/timezone-service.ts';
import { handleAddWizardStep } from '../commands/add.ts';
import { handleEditWizardStep } from '../commands/edit.ts';
import { handleImportFile } from '../commands/import.ts';
import { handleOnboardingLocation } from '../commands/start.ts';
import type { BotCommandContext } from '../types.ts';
import { clearSession, getSession } from '../types.ts';

/**
 * Handle free-text messages and file uploads.
 * Routes to active wizard sessions or falls back to "use /help".
 */
export function createMessageHandler(db: DatabaseService, eventService: EventService) {
  return async (ctx: BotCommandContext) => {
    const user = ctx.dbUser as User | undefined;
    if (!user) return;

    // Handle location (for onboarding or /timezone)
    if (ctx.location) {
      const { latitude, longitude } = ctx.location;
      const session = getSession(user.telegram_id);

      if (session?.step.startsWith('onboard:tz')) {
        return handleOnboardingLocation(ctx, db, latitude, longitude);
      }

      if (session?.step === 'tz:select') {
        const tz = resolveTimezone(latitude, longitude);
        db.users.update(user.telegram_id, { timezone: tz });
        clearSession(user.telegram_id);
        const _lang = user.language as 'en' | 'ru';
        await ctx.send(`✅ ${getTimezoneDisplay(tz)}`, { reply_markup: { remove_keyboard: true } });
        return;
      }

      return; // Ignore unsolicited location
    }

    // Handle document (for /import)
    if (ctx.document) {
      const session = getSession(user.telegram_id);
      if (session?.step === 'import:waiting') {
        clearSession(user.telegram_id);
        try {
          const file = await ctx.getFile();
          const response = await fetch(`https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`);
          const content = await response.text();
          return handleImportFile(ctx, eventService, user, content);
        } catch {
          const lang = user.language as 'en' | 'ru';
          await ctx.send(lang === 'ru' ? 'Не удалось прочитать файл.' : 'Failed to read file.');
        }
        return;
      }
    }

    const text = ctx.text as string | undefined;
    if (!text) return;

    // Route to active wizard sessions
    if (await handleAddWizardStep(ctx, eventService, user, text)) return;
    if (await handleEditWizardStep(ctx, eventService, user, text)) return;

    // No active session, no command — hint
    const lang = user.language as 'en' | 'ru';
    await ctx.send(
      lang === 'ru'
        ? 'Не понимаю. Используйте /help для списка команд.'
        : "I don't understand. Use /help for commands.",
    );
  };
}
