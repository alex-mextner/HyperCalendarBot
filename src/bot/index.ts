// src/bot/index.ts
import { Bot } from 'gramio';
import type { DatabaseService } from '../database/index.ts';
import { EventService } from '../services/event/event-service.ts';
import { createUserResolver } from './middleware/user-resolver.ts';
import { RateLimiter } from './middleware/rate-limiter.ts';
import { RATE_LIMIT } from '../config/constants.ts';
import { t } from '../config/constants.ts';
import { botLogger } from '../utils/logger.ts';

// Commands — imported as they are created in later tasks
// import { handlePing } from './commands/ping.ts';
// import { handleHelp } from './commands/help.ts';
// ... etc

export function createBot(token: string, db: DatabaseService) {
  const eventService = new EventService(db.events, db.reminders);
  const rateLimiter = new RateLimiter({
    perMinute: RATE_LIMIT.MESSAGES_PER_MINUTE,
    cooldownMs: RATE_LIMIT.COOLDOWN_MS,
  });

  const bot = new Bot(token)
    // Derive user data
    .derive(createUserResolver(db))
    // Rate limiting middleware
    .use(async (context, next) => {
      const userId = context.from?.id;
      if (!userId) return next();

      const { allowed, firstBlock } = rateLimiter.checkWithWarning(userId);
      if (!allowed) {
        if (firstBlock && 'send' in context) {
          const lang = ((context as any).dbUser?.language ?? 'en') as 'en' | 'ru';
          await (context as any).send(t(lang).rate_limited);
        }
        return; // Drop silently
      }
      return next();
    })
    // Error handler
    .onError(({ context, kind, error }) => {
      botLogger.error({ kind, error: String(error) }, 'Unhandled bot error');
      if (context && 'send' in context) {
        try {
          const errLang = ((context as any).dbUser?.language ?? 'en') as 'en' | 'ru';
          (context as any).send(t(errLang).something_wrong);
        } catch {}
      }
    });

  // Register commands here as they are implemented.
  // Pattern: bot.command('name', (ctx) => handleName(ctx, db, eventService));

  return { bot, eventService, db };
}
