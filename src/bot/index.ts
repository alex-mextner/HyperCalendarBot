// src/bot/index.ts
import { Bot } from 'gramio';
import type { DatabaseService } from '../database/index.ts';
import { EventService } from '../services/event/event-service.ts';
import { createUserResolver } from './middleware/user-resolver.ts';
import { RateLimiter } from './middleware/rate-limiter.ts';
import { RATE_LIMIT, t } from '../config/constants.ts';
import { botLogger } from '../utils/logger.ts';

import { handlePing } from './commands/ping.ts';
import { handleHelp } from './commands/help.ts';
import { handleStart } from './commands/start.ts';
import { handleToday } from './commands/today.ts';
import { handleTomorrow } from './commands/tomorrow.ts';
import { handleWeek } from './commands/week.ts';
import { handleMonth } from './commands/month.ts';
import { handleAdd } from './commands/add.ts';
import { handleEdit } from './commands/edit.ts';
import { handleDelete } from './commands/delete.ts';
import { handleSearch } from './commands/search.ts';
import { handleFree } from './commands/free.ts';
import { handleTimezone } from './commands/timezone.ts';
import { handleSettings } from './commands/settings.ts';
import { handleImport } from './commands/import.ts';
import { handleExport } from './commands/export.ts';
import { createCallbackHandler } from './handlers/callback.handler.ts';
import { createMessageHandler } from './handlers/message.handler.ts';

export function createBot(token: string, db: DatabaseService) {
  const eventService = new EventService(db.events, db.reminders);
  const rateLimiter = new RateLimiter({
    perMinute: RATE_LIMIT.MESSAGES_PER_MINUTE,
    cooldownMs: RATE_LIMIT.COOLDOWN_MS,
  });

  const bot = new Bot(token)
    .derive(createUserResolver(db))
    .use(async (context, next) => {
      const userId = context.from?.id;
      if (!userId) return next();
      const { allowed, firstBlock } = rateLimiter.checkWithWarning(userId);
      if (!allowed) {
        if (firstBlock && 'send' in context) {
          const lang = ((context as any).dbUser?.language ?? 'en') as 'en' | 'ru';
          await (context as any).send(t(lang).rate_limited);
        }
        return;
      }
      return next();
    })
    // Commands
    .command('start', (ctx) => handleStart(ctx, db))
    .command('ping', (ctx) => handlePing(ctx))
    .command('help', (ctx) => handleHelp(ctx))
    .command('today', (ctx) => handleToday(ctx, eventService))
    .command('tomorrow', (ctx) => handleTomorrow(ctx, eventService))
    .command('week', (ctx) => handleWeek(ctx, eventService))
    .command('month', (ctx) => handleMonth(ctx, eventService))
    .command('add', (ctx) => handleAdd(ctx, eventService))
    .command('edit', (ctx) => handleEdit(ctx, eventService))
    .command('delete', (ctx) => handleDelete(ctx, eventService))
    .command('search', (ctx) => handleSearch(ctx, eventService))
    .command('free', (ctx) => handleFree(ctx, eventService))
    .command('timezone', (ctx) => handleTimezone(ctx, db))
    .command('settings', (ctx) => handleSettings(ctx))
    .command('import', (ctx) => handleImport(ctx, eventService))
    .command('export', (ctx) => handleExport(ctx, eventService))
    // Callback queries
    .on('callback_query', createCallbackHandler(db, eventService))
    // Free-text messages
    .on('message', createMessageHandler(db, eventService))
    // Error handler
    .onError(({ context, kind, error }) => {
      botLogger.error({ kind, error: String(error) }, 'Bot error');
      try {
        if (context && 'send' in context) {
          const errLang = ((context as any).dbUser?.language ?? 'en') as 'en' | 'ru';
          (context as any).send(t(errLang).something_wrong);
        }
      } catch {}
    });

  return { bot, eventService, db };
}
