// src/services/ai/usage-recorder.ts
// Durable record of every provider attempt. Recording is best-effort and off the answer path: events are
// buffered and written in one batch on the next event-loop turn, a failed write is logged and dropped, and
// without a configured sink (scripts, tests) nothing happens at all.

import type {
  AiErrorClass,
  AiSkipReason,
  AiUsageEvent,
  AiUsageRepository,
} from '../../database/repositories/ai-usage.repository.ts';
import type { ProviderChainKind } from '../../utils/ai-provider-alert.ts';
import { dbLogger } from '../../utils/logger.ts';
import { estimateCostMicroUsd, MICRO_USD_PER_USD, type ModelRole } from './model-presets.ts';
import { type PromptSize, UNKNOWN_PROMPT_SIZE } from './prompt-size.ts';
import type { ProviderId } from './provider-ids.ts';

/** What an AI round is for; callers that name none are stored as `unlabeled`. */
export type AiCallPurpose =
  | 'agent'
  | 'history'
  | 'validator'
  | 'retry'
  | 'intent_edit'
  | 'intent_learner'
  | 'city_resolver'
  | 'tts_translation'
  | 'probe';

const UNLABELED_PURPOSE = 'unlabeled';

/** Token counts as the provider reported them; null is "not reported", never zero. */
export interface AiTokenUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  cachedTokens: number | null;
  /** Cost in USD the provider reported for the request (OpenRouter's `usage.cost`); absent when it did not. */
  costUsd?: number | null;
}

/**
 * Stream timing of an answered attempt, in milliseconds, as measured by the stream reader: request start
 * to the first content or tool-call delta, and first to last such delta. null is unknown, never zero.
 */
export interface AttemptSpeed {
  firstTokenMs: number | null;
  generationMs: number | null;
}

/**
 * What every attempt of one slot shares. `role` and `preset` are null on a legacy-chain slot, and its
 * `chain` is then `smart` or `fast`; a role slot's chain reads `role:<role>`.
 */
export interface AttemptScope {
  chain: ProviderChainKind | `role:${ModelRole}`;
  purpose: AiCallPurpose | undefined;
  requestId: string | undefined;
  role: ModelRole | null;
  preset: string | null;
  /** Estimated size of the request every attempt of the round sends; absent where nothing was measured. */
  promptSize?: PromptSize;
}

type AiUsageSink = Pick<AiUsageRepository, 'insertMany'>;

let sink: AiUsageSink | null = null;
let pending: AiUsageEvent[] = [];
let flushScheduled = false;

/** Starts (or, with null, stops) recording into `next`. Anything still buffered goes to the previous sink first. */
export function configureAiUsageRecording(next: AiUsageSink | null): void {
  flushAiUsageEvents();
  sink = next;
}

/** Queues one event. Never throws and never waits on the database. */
export function recordAiUsage(event: AiUsageEvent): void {
  if (!sink) return;
  pending.push(event);
  if (flushScheduled) return;
  flushScheduled = true;
  setImmediate(flushAiUsageEvents);
}

/**
 * Writes what is buffered as one batch. A failed write is logged and the batch dropped: the statistics are
 * best-effort and must neither retry forever nor hold memory.
 */
export function flushAiUsageEvents(): void {
  flushScheduled = false;
  if (!sink || pending.length === 0) return;
  const batch = pending;
  pending = [];
  try {
    sink.insertMany(batch);
  } catch (err) {
    dbLogger.warn({ err, events: batch.length }, 'AI usage events were not recorded');
  }
}

const NO_TOKENS: AiTokenUsage = {
  promptTokens: null,
  completionTokens: null,
  reasoningTokens: null,
  cachedTokens: null,
};

const NO_SPEED: AttemptSpeed = { firstTokenMs: null, generationMs: null };

function wholeMs(ms: number | null): number | null {
  return ms === null || !Number.isFinite(ms) ? null : Math.max(0, Math.round(ms));
}

/**
 * The cost of an attempt in micro-USD, or null when unknown. A cost OpenRouter reported for the request
 * is the billed truth and wins; any other provider's `cost` field is not trusted. Without one, the dated
 * list price of the route prices known tokens. Never 0 for "don't know".
 */
function costMicroUsdOf(provider: ProviderId, model: string, usage: AiTokenUsage): number | null {
  const reported = usage.costUsd;
  if (provider === 'openrouter' && typeof reported === 'number' && Number.isFinite(reported) && reported >= 0) {
    const micro = Math.round(reported * MICRO_USD_PER_USD);
    if (Number.isSafeInteger(micro)) return micro;
  }
  return estimateCostMicroUsd(provider, model, usage.promptTokens, usage.completionTokens);
}

function attempt(
  scope: AttemptScope,
  provider: ProviderId,
  model: string,
  at: number,
  fields: Pick<AiUsageEvent, 'outcome' | 'errorClass' | 'httpStatus' | 'skipReason' | 'durationMs'>,
  usage: AiTokenUsage | null,
  speed: AttemptSpeed = NO_SPEED,
): AiUsageEvent {
  const tokens = usage ?? NO_TOKENS;
  return {
    at,
    provider,
    model,
    chain: scope.chain,
    purpose: scope.purpose ?? UNLABELED_PURPOSE,
    ...fields,
    promptTokens: tokens.promptTokens,
    completionTokens: tokens.completionTokens,
    reasoningTokens: tokens.reasoningTokens,
    cachedTokens: tokens.cachedTokens,
    requestId: scope.requestId ?? null,
    role: scope.role,
    preset: scope.preset,
    costMicroUsd: usage ? costMicroUsdOf(provider, model, usage) : null,
    firstTokenMs: wholeMs(speed.firstTokenMs),
    generationMs: wholeMs(speed.generationMs),
    ...(fields.outcome === 'skipped' ? UNKNOWN_PROMPT_SIZE : (scope.promptSize ?? UNKNOWN_PROMPT_SIZE)),
  };
}

export function answeredAttempt(
  scope: AttemptScope,
  provider: ProviderId,
  model: string,
  at: number,
  durationMs: number,
  usage: AiTokenUsage | null,
  speed: AttemptSpeed = NO_SPEED,
): AiUsageEvent {
  const fields = { outcome: 'ok', errorClass: null, httpStatus: null, skipReason: null, durationMs } as const;
  return attempt(scope, provider, model, at, fields, usage, speed);
}

export function failedAttempt(
  scope: AttemptScope,
  provider: ProviderId,
  model: string,
  at: number,
  durationMs: number,
  failure: { errorClass: AiErrorClass; httpStatus: number | null },
  usage: AiTokenUsage | null,
): AiUsageEvent {
  const fields = { outcome: 'error', skipReason: null, durationMs, ...failure } as const;
  return attempt(scope, provider, model, at, fields, usage);
}

export function skippedAttempt(
  scope: AttemptScope,
  provider: ProviderId,
  model: string,
  skipReason: AiSkipReason,
  httpStatus: number | null = null,
): AiUsageEvent {
  const fields = { outcome: 'skipped', errorClass: null, httpStatus, skipReason, durationMs: null } as const;
  return attempt(scope, provider, model, Date.now(), fields, null);
}
