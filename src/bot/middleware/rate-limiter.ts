// src/bot/middleware/rate-limiter.ts
import type { Next, TelegramUpdate } from 'gramio';
import { t, toLang } from '../../config/constants.ts';
import type { User } from '../../database/types.ts';
import { cmdLogger } from '../../utils/logger.ts';

interface RateLimiterConfig {
  perMinute: number;
  cooldownMs: number;
}

interface UserBucket {
  timestamps: number[];
  silencedUntil: number;
}

export class RateLimiter {
  private buckets = new Map<number, UserBucket>();
  private config: RateLimiterConfig;
  private callsSinceCleanup = 0;

  constructor(config: RateLimiterConfig) {
    this.config = config;
  }

  private cleanup(): void {
    const now = Date.now();
    const staleMs = 5 * 60 * 1000;
    for (const [userId, bucket] of this.buckets) {
      const lastActivity = Math.max(bucket.silencedUntil, bucket.timestamps[bucket.timestamps.length - 1] ?? 0);
      if (now - lastActivity > staleMs) {
        this.buckets.delete(userId);
      }
    }
  }

  check(userId: number): boolean {
    this.callsSinceCleanup++;
    if (this.callsSinceCleanup >= 100) {
      this.callsSinceCleanup = 0;
      this.cleanup();
    }

    const now = Date.now();
    let bucket = this.buckets.get(userId);

    if (!bucket) {
      bucket = { timestamps: [], silencedUntil: 0 };
      this.buckets.set(userId, bucket);
    }

    // In cooldown period — silently drop
    if (now < bucket.silencedUntil) return false;

    // Prune old timestamps (older than 1 minute)
    const windowStart = now - 60_000;
    bucket.timestamps = bucket.timestamps.filter((t) => t > windowStart);

    if (bucket.timestamps.length >= this.config.perMinute) {
      bucket.silencedUntil = now + this.config.cooldownMs;
      cmdLogger.warn({ userId }, 'Rate limit exceeded');
      return false; // Caller should send one warning, then silence
    }

    bucket.timestamps.push(now);
    return true;
  }

  /** Returns true if this is the FIRST block (caller should send warning) */
  checkWithWarning(userId: number): { allowed: boolean; firstBlock: boolean } {
    const wasSilenced = (this.buckets.get(userId)?.silencedUntil ?? 0) > Date.now();
    const allowed = this.check(userId);
    return { allowed, firstBlock: !allowed && !wasSilenced };
  }
}

/** The part of a GramIO context the rate-limit middleware reads; `send` exists on message and callback contexts. */
interface RateLimitContext {
  update?: TelegramUpdate;
  dbUser?: User;
  send?: (text: string) => Promise<unknown>;
}

/**
 * Drops messages and button presses from a user over the limit; the first dropped one gets one warning.
 * `onDropped` hears of every dropped update (the connect-wizard guard audits dropped wizard input).
 */
export function createRateLimitMiddleware(rateLimiter: RateLimiter, onDropped: (context: RateLimitContext) => void) {
  return async (context: RateLimitContext, next: Next) => {
    const userId = context.update?.message?.from?.id ?? context.update?.callback_query?.from?.id;
    if (!userId) return next();
    const { allowed, firstBlock } = rateLimiter.checkWithWarning(userId);
    if (!allowed) {
      onDropped(context);
      if (firstBlock) await context.send?.(t(toLang(context.dbUser?.language)).rate_limited);
      return;
    }
    return next();
  };
}
