// test/services/ai/streaming-round-budget.test.ts
// Deadline arithmetic of a streaming round: the per-provider cap and the shared round deadline that
// stops another provider from being launched once it has expired.

import { describe, expect, test } from 'bun:test';
import {
  MAX_PROVIDER_TIMEOUT_MS,
  providerTimeoutCapMs,
  ROUND_DEADLINE_MS,
  remainingRoundMs,
  roundDeadlineReached,
} from '../../../src/services/ai/streaming/round-budget.ts';

describe('providerTimeoutCapMs', () => {
  test('defaults to 15s on the smart chain and 8s on the fast chain', () => {
    expect(providerTimeoutCapMs({})).toBe(15_000);
    expect(providerTimeoutCapMs({ fast: false })).toBe(15_000);
    expect(providerTimeoutCapMs({ fast: true })).toBe(8_000);
  });

  test('a caller value narrows the cap, up to the maximum', () => {
    expect(providerTimeoutCapMs({ providerTimeoutMs: 2_500, fast: true })).toBe(2_500);
    expect(providerTimeoutCapMs({ providerTimeoutMs: MAX_PROVIDER_TIMEOUT_MS })).toBe(MAX_PROVIDER_TIMEOUT_MS);
  });

  test.each([
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    MAX_PROVIDER_TIMEOUT_MS + 1,
  ])('rejects %p', (providerTimeoutMs) => {
    expect(() => providerTimeoutCapMs({ providerTimeoutMs })).toThrow(
      'providerTimeoutMs must be positive and at most 15000',
    );
  });
});

describe('remainingRoundMs', () => {
  test('counts down from the shared round deadline', () => {
    expect(remainingRoundMs(1_000, 1_000)).toBe(ROUND_DEADLINE_MS);
    expect(remainingRoundMs(1_000, 11_000)).toBe(ROUND_DEADLINE_MS - 10_000);
  });

  test('goes negative once the deadline has passed instead of clamping to zero', () => {
    expect(remainingRoundMs(0, ROUND_DEADLINE_MS + 250)).toBe(-250);
  });
});

describe('roundDeadlineReached', () => {
  test('a provider is launched while at least min(cap, 1s) remains', () => {
    expect(roundDeadlineReached(1_000, 8_000)).toBe(false);
    expect(roundDeadlineReached(999.9, 8_000)).toBe(true);
  });

  test('a cap below one second is the bar when it is smaller', () => {
    expect(roundDeadlineReached(500, 500)).toBe(false);
    expect(roundDeadlineReached(499, 500)).toBe(true);
  });

  test('an expired deadline never launches another provider', () => {
    expect(roundDeadlineReached(0, 15_000)).toBe(true);
    expect(roundDeadlineReached(-1, 1)).toBe(true);
  });
});
