// test/bot/middleware/rate-limiter.test.ts
import { describe, test, expect, beforeEach } from 'bun:test';
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
});
