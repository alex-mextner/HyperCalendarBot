// src/bot/index.ts
import { Bot } from 'gramio';
import { RATE_LIMIT, t } from '../config/constants.ts';
import type { DatabaseService } from '../database/index.ts';
import type { User } from '../database/types.ts';
import { EventService } from '../services/event/event-service.ts';
import { botLogger } from '../utils/logger.ts';
import { handleAdd } from './commands/add.ts';
import { handleDelete } from './commands/delete.ts';
import { handleEdit } from './commands/edit.ts';
import { handleExport } from './commands/export.ts';
import { handleFree } from './commands/free.ts';
import { handleHelp } from './commands/help.ts';
import { handleImport } from './commands/import.ts';
import { handleMonth } from './commands/month.ts';
import { handlePing } from './commands/ping.ts';
import { handleSearch } from './commands/search.ts';
import { handleSettings } from './commands/settings.ts';
import { handleStart } from './commands/start.ts';
import { handleTimezone } from './commands/timezone.ts';
import { handleToday } from './commands/today.ts';
import { handleTomorrow } from './commands/tomorrow.ts';
import { handleWeek } from './commands/week.ts';
import { createCallbackHandler } from './handlers/callback.handler.ts';
import { createMessageHandler } from './handlers/message.handler.ts';
import { createCallbackFallback } from './middleware/callback-fallback.ts';
import { RateLimiter } from './middleware/rate-limiter.ts';
import { createUserResolver } from './middleware/user-resolver.ts';
import { createScenesPlugin } from './scenes/index.ts';
import type { BotCallbackContext, BotCommandContext } from './types.ts';

/**
 * GramIO's base Context class doesn't expose `from` or derived properties
 * in its type definition — they come from TargetMixin on specific update
 * contexts. We use a narrow interface and cast where needed.
 */
interface GramIOContextWithFrom {
  from?: { id: number };
}

interface GramIOContextWithDerived {
  dbUser?: User;
  send(text: string): Promise<unknown>;
}

export function createBot(token: string, db: DatabaseService) {
  const eventService = new EventService(db.events, db.reminders);
  const rateLimiter = new RateLimiter({
    perMinute: RATE_LIMIT.MESSAGES_PER_MINUTE,
    cooldownMs: RATE_LIMIT.COOLDOWN_MS,
  });

  const scenesSetup = createScenesPlugin(db, eventService, token);

  const bot = new Bot(token)
    .derive(createUserResolver(db))
    .use(async (context, next) => {
      const ctx = context as unknown as GramIOContextWithFrom;
      const userId = ctx.from?.id;
      if (!userId) return next();
      const { allowed, firstBlock } = rateLimiter.checkWithWarning(userId);
      if (!allowed) {
        if (firstBlock && 'send' in context) {
          const derived = context as unknown as GramIOContextWithDerived;
          const lang = (derived.dbUser?.language ?? 'en') as 'en' | 'ru';
          await derived.send(t(lang).rate_limited);
        }
        return;
      }
      return next();
    })
    .use(createCallbackFallback(scenesSetup.storage) as never)
    .extend(scenesSetup.plugin)
    // Commands
    .command('start', (ctx) => handleStart(ctx as unknown as BotCommandContext, scenesSetup.scenes.onboardingScene))
    .command('ping', (ctx) => handlePing(ctx as unknown as BotCommandContext))
    .command('help', (ctx) => handleHelp(ctx as unknown as BotCommandContext))
    .command('today', (ctx) => handleToday(ctx as unknown as BotCommandContext, eventService))
    .command('tomorrow', (ctx) => handleTomorrow(ctx as unknown as BotCommandContext, eventService))
    .command('week', (ctx) => handleWeek(ctx as unknown as BotCommandContext, eventService))
    .command('month', (ctx) => handleMonth(ctx as unknown as BotCommandContext, eventService))
    .command('add', (ctx) =>
      handleAdd(ctx as unknown as BotCommandContext, eventService, scenesSetup.scenes.addEventScene),
    )
    .command('edit', (ctx) => handleEdit(ctx as unknown as BotCommandContext, eventService))
    .command('delete', (ctx) => handleDelete(ctx as unknown as BotCommandContext, eventService))
    .command('search', (ctx) => handleSearch(ctx as unknown as BotCommandContext, eventService))
    .command('free', (ctx) => handleFree(ctx as unknown as BotCommandContext, eventService))
    .command('timezone', (ctx) => handleTimezone(ctx as unknown as BotCommandContext, scenesSetup.scenes.timezoneScene))
    .command('settings', (ctx) => handleSettings(ctx as unknown as BotCommandContext))
    .command('import', (ctx) => handleImport(ctx as unknown as BotCommandContext, scenesSetup.scenes.importScene))
    .command('export', (ctx) => handleExport(ctx as unknown as BotCommandContext, eventService))
    // Callback queries
    .on('callback_query', (ctx) =>
      createCallbackHandler(eventService, scenesSetup.scenes.editValueScene)(ctx as unknown as BotCallbackContext),
    )
    // Free-text messages (wizard routing handled by @gramio/scenes)
    .on('message', (ctx) => createMessageHandler()(ctx as unknown as BotCommandContext))
    // Error handler
    .onError(({ context, kind, error }) => {
      botLogger.error({ kind, error: String(error) }, 'Bot error');
      try {
        if (context && 'send' in context) {
          const derived = context as unknown as GramIOContextWithDerived;
          const errLang = (derived.dbUser?.language ?? 'en') as 'en' | 'ru';
          derived.send(t(errLang).something_wrong);
        }
      } catch {}
    });

  return { bot, eventService, db };
}
