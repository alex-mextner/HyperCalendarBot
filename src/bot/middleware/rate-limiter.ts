// src/bot/middleware/rate-limiter.ts
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

  constructor(config: RateLimiterConfig) {
    this.config = config;
  }

  check(userId: number): boolean {
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
