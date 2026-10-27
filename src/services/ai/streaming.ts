// src/services/ai/streaming.ts
// Unified AI streaming round with automatic provider fallback.
//
// Two chains, selected via options.fast:
//   SMART_CHAIN (main): configured order, otherwise z.ai ${ZAI_MODEL} → Claude ${CLAUDE_MODEL} → HF ${HF_MODEL}
//   FAST_CHAIN: configured order, otherwise z.ai ${ZAI_FAST_MODEL} → Claude ${CLAUDE_FAST_MODEL} → HF ${HF_FAST_MODEL}
//
// Callers that need live updates (agent.ts) pass `onTextDelta`/`onToolCallStart` callbacks.
// Callers that just want the final text (validator, intent-learner, city-resolver,
// tts-translation) omit callbacks — the full result is still returned either way.
//
// This file owns the round orchestration (`aiStreamRound`) and is the public import path; the pieces it
// composes live in ./streaming/ (types, errors, stream reading, slots, chains, per-round attempts, attempt
// failure handling, budget).

import { handleAttemptFailure } from './streaming/attempt-failure.ts';
import {
  admitSlot,
  buildRoundChain,
  createRoundState,
  exhaustedRoundError,
  recordDeadlineSkips,
  runAdmittedAttempt,
  selectAttempts,
} from './streaming/round-attempts.ts';
import { remainingRoundMs, roundDeadlineReached } from './streaming/round-budget.ts';
import type { StreamCallbacks, StreamRoundOptions, StreamRoundResult } from './streaming/types.ts';

export { openrouterCircuitScope, providerClients, roleRoutingSeams } from './streaming/chains.ts';
export { isTransientProviderError } from './streaming/error-classification.ts';
export { AllProvidersFailedError, EmptyProviderResponseError, ProviderSafetyStopError } from './streaming/errors.ts';
export { providerFailureMetrics } from './streaming/failure.ts';
export {
  _resetStreamingUsageCompatibilityForTest,
  acceptsSamplingTemperature,
  CLAUDE_MAX_OUTPUT_TOKENS,
  streamingSlot,
} from './streaming/slot.ts';
export type {
  EmptyResponseDiagnostics,
  FailedRoundMetrics,
  ProviderFailure,
  StreamCallbacks,
  StreamRoundMetrics,
  StreamRoundOptions,
  StreamRoundResult,
  StreamTokenUsage,
  StreamToolCall,
} from './streaming/types.ts';

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Execute one AI round with automatic provider fallback.
 *
 * With callbacks: streams text deltas and tool-call starts to the caller
 * (used by the main agent loop for live Telegram updates).
 *
 * Without callbacks: collects the full result and returns it at the end
 * (used by validator, intent-learner, city-resolver, tts-translation).
 *
 * Chains:
 *   fast=false → configured AI_SMART_CHAIN, otherwise the responsive DEFAULT_SMART_CHAIN
 *   fast=true  → configured AI_FAST_CHAIN, otherwise the short-call DEFAULT_FAST_CHAIN
 *
 * Fallback policy: ANY provider error moves on to the next slot. A 400/401/403/404
 * says that provider cannot serve this request — it never says the request is
 * unanswerable, and treating it as fatal once took the whole bot down while a
 * healthy provider sat unused further down the chain. Specifically:
 * - 5xx / timeout / connection error / 429 / 413   → next slot
 * - 400/401/403/404 and any other 4xx              → next slot
 * - balance exhausted                              → alert admin, next slot
 * - model deleted by the provider                  → auto-detect a live model,
 *                                                    retry the same slot once,
 *                                                    then next slot
 * - 200 OK but empty text AND no tool calls        → next slot (z.ai quirk)
 * - provider died mid-stream after text or a tool label reached the user
 *                                                    → discard that output, next slot
 * - caller cancelled via AbortSignal                → propagate immediately
 * When every slot fails, throws `AllProvidersFailedError` listing each reason.
 */
export async function aiStreamRound(
  options: StreamRoundOptions,
  callbacks: StreamCallbacks = {},
): Promise<StreamRoundResult> {
  options.signal?.throwIfAborted();
  const state = createRoundState(options, callbacks);
  const attempts = selectAttempts(state, buildRoundChain(options));

  for (const [position, slot] of attempts.entries()) {
    options.signal?.throwIfAborted();
    const remainingMs = remainingRoundMs(state.roundStartedAt);
    if (roundDeadlineReached(remainingMs, state.cap)) {
      recordDeadlineSkips(state, attempts.slice(position));
      break;
    }
    const attempt = admitSlot(state, slot);
    if (!attempt) continue;
    try {
      return await runAdmittedAttempt(state, attempt, remainingMs);
    } catch (error) {
      handleAttemptFailure(state, attempt, error);
    }
  }

  throw exhaustedRoundError(state);
}
