// src/services/ai/provider-eligibility.ts
//
// Some provider failures are not bad luck — they are a standing fact with a
// known end. On 2026-09-02 z.ai answered every request with "Weekly/Monthly
// Limit Exhausted. Your limit will reset at 2026-09-03 21:15:09", and Groq
// answered 413 to every request carrying the tool catalog: 18 725 tokens
// against a tier that allows 8 000 per minute. Retrying either changes nothing;
// the chain simply paid two round trips before reaching a provider that works,
// on every round of every message.
//
// This remembers "that provider is out until T" so the chain can skip it. Three
// rules keep the memory from lying:
//
//   • A skip is not a failure. Nothing here touches the outage records the
//     readiness endpoint and the admin alerting read — those must keep saying
//     what actually happened, and silence is not health.
//   • A block is bounded. The deadline the provider states is trusted only up
//     to an hour, and anything vaguer gets two minutes: a cooldown that is too
//     short costs one wasted request, one that is too long is an incident.
//   • A block never empties the chain. If every provider is blocked the request
//     is attempted anyway — a wasted round trip beats no answer at all.

import { logger } from '../../utils/logger.ts';
import type { ProviderId } from './provider-ids.ts';

const eligibilityLogger = logger.child({ module: 'ai-eligibility' });

/** Longest a stated reset time is trusted. Beyond it, the state goes stale unnoticed. */
const MAX_BLOCK_MS = 60 * 60 * 1000;
/** Applied when the provider says it is rate-limited but not when it recovers. */
const VAGUE_BLOCK_MS = 2 * 60 * 1000;
/** How long a size rejection stands. The catalog changes only on deploy. */
const TOO_LARGE_BLOCK_MS = 60 * 60 * 1000;

/**
 * What a block covers. A spent quota blocks everything; a request rejected for
 * its size blocks only requests of that shape, and the fast chain's short
 * summaries still go through — that is most of what Groq is useful for here.
 */
export type BlockScope = 'all' | 'with-tools';

interface Block {
  untilMs: number;
  scope: BlockScope;
  reason: string;
}

const blocks = new Map<ProviderId, Block>();

/** Seconds in a `Retry-After` header, when the provider sent a sane one. */
function retryAfterMs(headers: unknown): number | null {
  if (typeof headers !== 'object' || headers === null) return null;
  const value = 'get' in headers && typeof headers.get === 'function' ? headers.get('retry-after') : undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return seconds * 1000;
}

/**
 * The reset time a provider states in its own message, as a duration from now.
 *
 * Converted to a duration deliberately: the timestamp carries no zone, and
 * reading it as UTC when the provider meant something else would bench a
 * provider for hours. A duration that comes out negative or absurd is discarded.
 */
function statedResetMs(message: string, now: number): number | null {
  const stated = message.match(/reset at (\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})/);
  if (!stated?.[1]) return null;
  const parsed = Date.parse(`${stated[1].replace(' ', 'T')}Z`);
  if (Number.isNaN(parsed)) return null;
  const duration = parsed - now;
  return duration > 0 ? duration : null;
}

/** True when the provider said the request itself is too large for its tier. */
export function isRequestTooLarge(status: number | undefined, message: string): boolean {
  return status === 413 || /request too large/i.test(message);
}

/** True when the provider said its quota or rate limit is spent. */
export function isQuotaExhausted(status: number | undefined, message: string): boolean {
  return status === 429 || /rate limit|limit exhausted/i.test(message);
}

/**
 * Records what a failure implies about the provider's near future. Returns the
 * block it created, or null when the failure says nothing durable — a 500, a
 * timeout and a deleted model are all worth retrying immediately.
 */
export function noteFailureForEligibility(
  provider: ProviderId,
  status: number | undefined,
  message: string,
  headers: unknown,
  now: number = Date.now(),
): Block | null {
  let block: Block | null = null;

  if (isRequestTooLarge(status, message)) {
    block = {
      untilMs: now + TOO_LARGE_BLOCK_MS,
      scope: 'with-tools',
      reason: 'the request was too large for this tier',
    };
  } else if (isQuotaExhausted(status, message)) {
    const stated = retryAfterMs(headers) ?? statedResetMs(message, now);
    const duration = stated === null ? VAGUE_BLOCK_MS : Math.min(stated, MAX_BLOCK_MS);
    block = {
      untilMs: now + duration,
      scope: 'all',
      reason: stated === null ? 'rate limited, no stated reset' : 'quota spent until the stated reset',
    };
  }

  if (!block) return null;
  blocks.set(provider, block);
  eligibilityLogger.info(
    { provider, scope: block.scope, seconds: Math.round((block.untilMs - now) / 1000), reason: block.reason },
    'Provider benched — skipping it until the block expires',
  );
  return block;
}

/** Clears any block: the provider just answered, so whatever it said is over. */
export function clearBlock(provider: ProviderId): void {
  blocks.delete(provider);
}

/** True when a request of this shape should skip the provider right now. */
export function isBlocked(provider: ProviderId, hasTools: boolean, now: number = Date.now()): boolean {
  const block = blocks.get(provider);
  if (!block) return false;
  if (block.untilMs <= now) {
    blocks.delete(provider);
    return false;
  }
  return block.scope === 'all' || hasTools;
}

/** For tests: forget every block. */
export function resetEligibility(): void {
  blocks.clear();
}
