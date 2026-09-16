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
//   • A block is bounded. An explicit provider reset is trusted (up to 32 days)
//     so a weekly/monthly cap is not retried every hour; a vague rate limit still
//     gets only two minutes because guessing long is the expensive mistake.
//   • A block never empties the chain. If every provider is blocked the request
//     is attempted anyway — a wasted round trip beats no answer at all.

import type { ProviderChainKind } from '../../utils/ai-provider-alert.ts';
import { logger } from '../../utils/logger.ts';
import type { ProviderId } from './provider-ids.ts';

const eligibilityLogger = logger.child({ module: 'ai-eligibility' });

const DAY_MS = 24 * 60 * 60 * 1000;
/** Longest an explicit provider reset is trusted. Covers monthly billing windows
 * while still bounding damage from a malformed far-future timestamp. */
const MAX_EXPLICIT_BLOCK_MS = 32 * DAY_MS;
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

/**
 * One deadline per scope, not one per provider. A provider can be out of quota
 * for two minutes and rejecting tool-sized requests for an hour at the same
 * time; keeping a single record meant the shorter block overwrote the longer
 * one, and the size rejection came back a request later.
 */
type ProviderBlocks = { [scope in BlockScope]?: Block };

/**
 * Keyed by provider AND chain, because the two chains talk to different models
 * of the same provider and fail independently — the alerting layer already
 * treats them apart. A per-minute limit hit by a background summary must not
 * bench the model that answers people; when the same account-wide quota does
 * apply to both, the other chain learns it from its own next request, at the
 * cost of one round trip.
 */
type BlockKey = `${ProviderId}:${ProviderChainKind}`;

const blocks = new Map<BlockKey, ProviderBlocks>();

function blockKey(provider: ProviderId, chain: ProviderChainKind): BlockKey {
  return `${provider}:${chain}`;
}

/**
 * A header from a plain object, whatever case it was serialized in. Wire casing
 * survives serialization, so looking only for the lowercase name would find
 * nothing on exactly the shape this branch exists to read.
 */
function plainHeader(headers: object, name: string): unknown {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

/**
 * Seconds in a `Retry-After` header, when the provider sent a sane one.
 *
 * Both shapes are read. The SDK types this as a fetch `Headers`, but the errors
 * this repo logs from production serialize as a plain object, and a header read
 * that quietly returns nothing would leave every rate limit on the two-minute
 * guess while the provider was telling us exactly when to come back.
 */
function retryAfterMs(headers: unknown, now: number): number | null {
  if (typeof headers !== 'object' || headers === null) return null;
  const raw =
    'get' in headers && typeof headers.get === 'function'
      ? headers.get('retry-after')
      : plainHeader(headers, 'retry-after');
  if (raw === null || raw === undefined) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds > 0 ? seconds * 1000 : null;
  // The header legally carries either a delay in seconds or an HTTP date, and
  // a date through Number() is NaN — which would silently become the guess.
  const at = Date.parse(String(raw));
  if (Number.isNaN(at)) return null;
  const duration = at - now;
  return duration > 0 ? duration : null;
}

/**
 * The reset time a provider states in its own message, as a duration from now.
 *
 * Converted to a duration deliberately: the timestamp carries no zone, and
 * reading it as UTC when the provider meant something else would bench a
 * provider for hours. A duration that comes out negative or absurd is discarded.
 */
function statedResetMs(message: string, now: number): number | null {
  const stated = message.match(
    /(?:reset|restored)(?:\s+\w+){0,4}\s+(?:at|on)\s+(\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?)/i,
  );
  if (!stated?.[1]) return null;
  const iso =
    stated[1].includes('T') || stated[1].includes(' ') ? `${stated[1].replace(' ', 'T')}Z` : `${stated[1]}T00:00:00Z`;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return null;
  const duration = parsed - now;
  return duration > 0 ? duration : null;
}

/**
 * The status decides when there is one. Error bodies echo the request and quote
 * the provider's own rate-limit documentation, so a 500 mentioning "rate limit"
 * would otherwise bench a provider that is merely having a bad minute — and the
 * text is partly ours, which makes it a bench a user could trigger.
 */
function saysWithoutStatus(status: number | undefined, message: string, pattern: RegExp): boolean {
  return status === undefined && pattern.test(message);
}

/** True when the provider said the request itself is too large for its tier. */
export function isRequestTooLarge(status: number | undefined, message: string): boolean {
  return status === 413 || saysWithoutStatus(status, message, /request too large/i);
}

/** True when the provider said its quota or rate limit is spent. */
export function isQuotaExhausted(status: number | undefined, message: string): boolean {
  return status === 429 || saysWithoutStatus(status, message, /rate limit|limit exhausted/i);
}

/**
 * Records what a failure implies about the provider's near future. Returns the
 * block it created, or null when the failure says nothing durable — a 500, a
 * timeout and a deleted model are all worth retrying immediately.
 */
export function noteFailureForEligibility(
  provider: ProviderId,
  chain: ProviderChainKind,
  hasTools: boolean,
  status: number | undefined,
  message: string,
  headers: unknown,
  now: number = Date.now(),
): Block | null {
  let block: Block | null = null;

  // Only a request carrying the catalog earns a size block. The catalog is a
  // fixed floor that no retry shrinks; a request that was too large without it
  // was too large because of its history, and the next one may not be.
  if (isRequestTooLarge(status, message)) {
    if (!hasTools) return null;
    block = {
      untilMs: now + TOO_LARGE_BLOCK_MS,
      scope: 'with-tools',
      reason: 'the tool catalog does not fit this tier',
    };
  } else if (isQuotaExhausted(status, message)) {
    const stated = retryAfterMs(headers, now) ?? statedResetMs(message, now);
    const duration = stated === null ? VAGUE_BLOCK_MS : Math.min(stated, MAX_EXPLICIT_BLOCK_MS);
    block = {
      untilMs: now + duration,
      scope: 'all',
      reason: stated === null ? 'rate limited, no stated reset' : 'quota spent until the stated reset',
    };
  }

  if (!block) return null;
  const key = blockKey(provider, chain);
  const existing = blocks.get(key) ?? {};
  const current = existing[block.scope];
  // A longer standing block is never shortened by a newer, briefer one.
  if (current && current.untilMs > block.untilMs) return current;
  blocks.set(key, { ...existing, [block.scope]: block });
  eligibilityLogger.info(
    {
      provider,
      chain,
      scope: block.scope,
      seconds: Math.round((block.untilMs - now) / 1000),
      reason: block.reason,
    },
    'Provider benched — skipping it until the block expires',
  );
  return block;
}

/**
 * Clears what this answer actually disproves. A short request getting through
 * says nothing about whether the catalog fits, so it must not erase a size
 * block — otherwise ordinary summary traffic wipes the evidence and the next
 * user round pays the same guaranteed rejection.
 */
export function clearBlock(provider: ProviderId, chain: ProviderChainKind, hasTools: boolean): void {
  const key = blockKey(provider, chain);
  const existing = blocks.get(key);
  if (!existing) return;
  if (hasTools) {
    blocks.delete(key);
    return;
  }
  const { all, ...rest } = existing;
  void all;
  blocks.set(key, rest);
}

function activeBlock(key: BlockKey, scope: BlockScope, now: number): Block | undefined {
  const block = blocks.get(key)?.[scope];
  if (!block) return undefined;
  if (block.untilMs > now) return block;
  const rest = { ...blocks.get(key) };
  delete rest[scope];
  blocks.set(key, rest);
  return undefined;
}

/** True when a request of this shape should skip the provider right now. */
export function isBlocked(
  provider: ProviderId,
  chain: ProviderChainKind,
  hasTools: boolean,
  now: number = Date.now(),
): boolean {
  const key = blockKey(provider, chain);
  if (activeBlock(key, 'all', now)) return true;
  return hasTools && activeBlock(key, 'with-tools', now) !== undefined;
}

/** For tests: forget every block. */
export function resetEligibility(): void {
  blocks.clear();
}
