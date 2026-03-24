// src/bot/handlers/inline.handler.ts

import { resolveTimezone } from '../../services/timezone/timezone-service.ts';
import { cmdLogger } from '../../utils/logger.ts';

/**
 * Result item produced by InlineService.buildResults().
 */
export interface InlineResultItem {
  id: string;
  type: 'article' | 'photo';
  title: string;
  description: string;
  messageText: string;
  photoUrl?: string;
  thumbnailUrl?: string;
  caption?: string;
}

/**
 * Parsed inline query intent from InlineService.parseQuery().
 */
export interface InlineQueryIntent {
  type: string;
}

/**
 * Subset of InlineService used by the handler (depend on abstraction, not concrete class).
 */
export interface InlineServiceLike {
  parseQuery(query: string): InlineQueryIntent;
  buildResults(userId: number, intent: InlineQueryIntent, timezone: string): InlineResultItem[];
  buildPhotoResult(userId: number, date: Date, timezone: string): Promise<InlineResultItem | null>;
}

/**
 * Subset of UserRepository used by the handler.
 */
export interface UserRepoLike {
  findByTelegramId(telegramId: number): { telegram_id: number; timezone: string; language?: string } | null;
  update?(telegramId: number, data: { timezone?: string }): unknown;
}

/**
 * Subset of SharingSettingsRepository used by the handler.
 */
export interface SettingsRepoLike {
  get(userId: number): { inline_mode_enabled: number } | null;
}

/**
 * Inline query context — minimal interface for Telegram inline queries.
 */
export interface InlineQueryContext {
  from?: { id: number };
  query: string;
  location?: { latitude: number; longitude: number };
  answerInlineQuery: (results: unknown[], options?: Record<string, unknown>) => Promise<true>;
}

export class InlineDebouncer {
  private lastQuery = new Map<number, number>();

  constructor(private windowMs: number) {}

  shouldProcess(userId: number): boolean {
    const now = Date.now();
    const last = this.lastQuery.get(userId);
    this.lastQuery.set(userId, now);

    // Cleanup old entries periodically
    if (this.lastQuery.size > 1000) {
      const cutoff = now - this.windowMs * 2;
      for (const [uid, ts] of this.lastQuery) {
        if (ts < cutoff) this.lastQuery.delete(uid);
      }
    }

    return !last || now - last >= this.windowMs;
  }
}

export function createInlineHandler(
  inlineService: InlineServiceLike,
  userRepo: UserRepoLike,
  settingsRepo: SettingsRepoLike,
) {
  const debouncer = new InlineDebouncer(300);

  return async (ctx: InlineQueryContext): Promise<void> => {
    const userId = ctx.from?.id;
    if (!userId) {
      await ctx.answerInlineQuery([]);
      return;
    }

    if (!debouncer.shouldProcess(userId)) {
      return; // Skip, newer query is coming
    }

    const user = userRepo.findByTelegramId(userId);
    if (!user) {
      await ctx.answerInlineQuery([]);
      return;
    }

    // Auto-update timezone from inline query location (requires /setinlinegeo in BotFather)
    if (ctx.location && userRepo.update) {
      try {
        const tz = resolveTimezone(ctx.location.latitude, ctx.location.longitude);
        if (tz !== user.timezone) {
          userRepo.update(userId, { timezone: tz });
          user.timezone = tz;
          cmdLogger.info({ userId, oldTz: user.timezone, newTz: tz }, 'Auto-updated timezone from inline location');
        }
      } catch {
        // geo-tz lookup failed, ignore
      }
    }

    // Check if inline mode is enabled for this user
    const settings = settingsRepo.get(userId);
    if (settings && !settings.inline_mode_enabled) {
      await ctx.answerInlineQuery([]);
      return;
    }

    try {
      const intent = inlineService.parseQuery(ctx.query);
      const items = inlineService.buildResults(userId, intent, user.timezone);

      // Photo result is optional — only included when available
      // const photoResult = await inlineService.buildPhotoResult(userId, new Date(), user.timezone);
      // Photo support will be enabled when image serving is configured

      // Convert to Telegram InlineQueryResult format
      const results = items.map((item) => ({
        type: item.type,
        id: item.id,
        title: item.title,
        description: item.description,
        input_message_content: {
          message_text: item.messageText,
          parse_mode: 'HTML',
        },
      }));

      await ctx.answerInlineQuery(results, { cache_time: 30 });
    } catch (error) {
      cmdLogger.error({ err: error, userId }, 'Inline query error');
      await ctx.answerInlineQuery([]);
    }
  };
}
