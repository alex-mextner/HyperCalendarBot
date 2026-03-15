// test/bot/middleware/rate-limiter.test.ts
import { beforeEach, describe, expect, test } from 'bun:test';
import { RateLimiter } from '../../../src/bot/middleware/rate-limiter.ts';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter({ perMinute: 5, cooldownMs: 1000 });
  });

  test('allows requests under limit', () => {
    for (let i = 0; i < 5; i++) {
      expect(limiter.check(123)).toBe(true);
    }
  });

  test('blocks requests over limit', () => {
    for (let i = 0; i < 5; i++) limiter.check(123);
    expect(limiter.check(123)).toBe(false);
  });

  test('different users have independent limits', () => {
    for (let i = 0; i < 5; i++) limiter.check(123);
    expect(limiter.check(456)).toBe(true);
  });

  // ── cleanup (lines 23-30) ──

  test('cleanup removes stale buckets after 100 calls', () => {
    // Seed a bucket for user 999, then manipulate its timestamps to be old
    limiter.check(999);

    // Access internals to age the bucket
    const buckets = (limiter as unknown as { buckets: Map<number, { timestamps: number[]; silencedUntil: number }> })
      .buckets;
    const bucket = buckets.get(999)!;
    // Set timestamps to 6 minutes ago (staleMs is 5 min)
    bucket.timestamps = [Date.now() - 6 * 60 * 1000];
    bucket.silencedUntil = 0;

    // Fire 100 calls from another user to trigger cleanup
    const freshLimiter = limiter;
    for (let i = 0; i < 100; i++) {
      freshLimiter.check(1); // Uses user 1 — different from 999
    }

    // After cleanup, user 999's stale bucket should be gone
    expect(buckets.has(999)).toBe(false);
    // User 1 should still exist
    expect(buckets.has(1)).toBe(true);
  });

  test('cleanup keeps active buckets', () => {
    // Make a recent bucket
    limiter.check(777);

    const buckets = (limiter as unknown as { buckets: Map<number, { timestamps: number[]; silencedUntil: number }> })
      .buckets;

    // Fire 100 calls from another user to trigger cleanup
    for (let i = 0; i < 100; i++) {
      limiter.check(2);
    }

    // User 777 should survive — their timestamp is recent
    expect(buckets.has(777)).toBe(true);
  });

  test('cleanup considers silencedUntil as activity', () => {
    limiter.check(888);

    const buckets = (limiter as unknown as { buckets: Map<number, { timestamps: number[]; silencedUntil: number }> })
      .buckets;
    const bucket = buckets.get(888)!;
    // Old timestamps but silencedUntil is in the future
    bucket.timestamps = [Date.now() - 6 * 60 * 1000];
    bucket.silencedUntil = Date.now() + 60_000;

    // Trigger cleanup
    for (let i = 0; i < 100; i++) {
      limiter.check(3);
    }

    // Should survive because silencedUntil is recent
    expect(buckets.has(888)).toBe(true);
  });

  // ── checkWithWarning (lines 67-69) ──

  describe('checkWithWarning', () => {
    test('returns allowed=true, firstBlock=false when under limit', () => {
      const result = limiter.checkWithWarning(123);
      expect(result.allowed).toBe(true);
      expect(result.firstBlock).toBe(false);
    });

    test('returns allowed=false, firstBlock=true on first block', () => {
      // Exhaust the limit
      for (let i = 0; i < 5; i++) limiter.check(123);
      // Next call should be the first block
      const result = limiter.checkWithWarning(123);
      expect(result.allowed).toBe(false);
      expect(result.firstBlock).toBe(true);
    });

    test('returns allowed=false, firstBlock=false on subsequent blocks (in cooldown)', () => {
      // Exhaust limit
      for (let i = 0; i < 5; i++) limiter.check(123);
      // First block
      limiter.checkWithWarning(123);
      // Subsequent block — user is now silenced
      const result = limiter.checkWithWarning(123);
      expect(result.allowed).toBe(false);
      expect(result.firstBlock).toBe(false);
    });
  });
});
