// src/services/ai/streaming/round-budget.ts
// Time arithmetic of one streaming round: the per-provider cap and the shared overall deadline.
// An expired shared deadline must never launch another provider, so the check lives here, pure and testable.

import type { StreamRoundOptions } from './types.ts';

/** The whole round — every provider attempt together — ends by this wall time. */
export const ROUND_DEADLINE_MS = 30_000;

/** No single provider may be given longer than this, whatever the caller asks for. */
export const MAX_PROVIDER_TIMEOUT_MS = 15_000;

const DEFAULT_SMART_PROVIDER_TIMEOUT_MS = 15_000;
const DEFAULT_FAST_PROVIDER_TIMEOUT_MS = 8_000;

/** The wall-time cap for one provider attempt; rejects a caller value that is not positive or exceeds the maximum. */
export function providerTimeoutCapMs(options: Pick<StreamRoundOptions, 'providerTimeoutMs' | 'fast'>): number {
  const cap =
    options.providerTimeoutMs ?? (options.fast ? DEFAULT_FAST_PROVIDER_TIMEOUT_MS : DEFAULT_SMART_PROVIDER_TIMEOUT_MS);
  if (!Number.isFinite(cap) || cap <= 0 || cap > MAX_PROVIDER_TIMEOUT_MS)
    throw new Error('providerTimeoutMs must be positive and at most 15000');
  return cap;
}

/** What is left of the shared round deadline; negative once it has passed. */
export function remainingRoundMs(roundStartedAt: number, now: number = performance.now()): number {
  return ROUND_DEADLINE_MS - (now - roundStartedAt);
}

/**
 * True when the shared deadline leaves less than a provider could usefully be given: the provider's own
 * cap, but never demanding more than one second. The next provider is then skipped, not launched.
 */
export function roundDeadlineReached(remainingMs: number, providerCapMs: number): boolean {
  return remainingMs < Math.min(providerCapMs, 1000);
}
