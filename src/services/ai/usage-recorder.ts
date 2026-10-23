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
import { dbLogger } from '../../utils/logger.ts';

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
}

/** What every attempt of one round shares. */
export interface AttemptScope {
  chain: string;
  purpose: AiCallPurpose | undefined;
  requestId: string | undefined;
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

function attempt(
  scope: AttemptScope,
  provider: string,
  model: string,
  at: number,
  fields: Pick<AiUsageEvent, 'outcome' | 'errorClass' | 'httpStatus' | 'skipReason' | 'durationMs'>,
  usage: AiTokenUsage | null,
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
  };
}

export function answeredAttempt(
  scope: AttemptScope,
  provider: string,
  model: string,
  at: number,
  durationMs: number,
  usage: AiTokenUsage | null,
): AiUsageEvent {
  const fields = { outcome: 'ok', errorClass: null, httpStatus: null, skipReason: null, durationMs } as const;
  return attempt(scope, provider, model, at, fields, usage);
}

export function failedAttempt(
  scope: AttemptScope,
  provider: string,
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
  provider: string,
  model: string,
  skipReason: AiSkipReason,
  httpStatus: number | null = null,
): AiUsageEvent {
  const fields = { outcome: 'skipped', errorClass: null, httpStatus, skipReason, durationMs: null } as const;
  return attempt(scope, provider, model, Date.now(), fields, null);
}
