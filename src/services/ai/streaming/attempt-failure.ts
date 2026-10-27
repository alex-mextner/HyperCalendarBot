// src/services/ai/streaming/attempt-failure.ts
// What one failed slot attempt does to the round: a safety stop ends it without fallback, a caller abort
// rethrows, anything else is recorded, alerted, noted for eligibility and handed on to the next slot.

import OpenAI from 'openai';
import { settleInconclusive } from '../provider-circuit.ts';
import { noteFailureForEligibility } from '../provider-eligibility.ts';
import { failedAttempt, recordAiUsage } from '../usage-recorder.ts';
import { benchChainOf } from './chains.ts';
import { isCallerAbort } from './error-classification.ts';
import { ProviderSafetyStopError } from './errors.ts';
import { describeFailure, failureAttempt, reportSlotFailure, settleCircuitAfterFailure } from './failure.ts';
import { aiLogger } from './logger.ts';
import { type AdmittedAttempt, attemptScopeOf, type RoundState } from './round-attempts.ts';
import type { ProviderFailure } from './types.ts';

/** HTTP statuses that say the request was wrong, not that the provider is unavailable: they never bench a provider. */
const NON_BENCHING_STATUSES: readonly number[] = [400, 403, 422];

/**
 * A safety stop is the provider's answer, not an outage: the attempt is recorded as an inconclusive error,
 * the circuit probe is released without pushback, and the error ends the round — there is no fallback.
 */
function handleSafetyStop(state: RoundState, attempt: AdmittedAttempt, error: ProviderSafetyStopError): never {
  const { slot, requestModel } = attempt;
  recordAiUsage(
    failedAttempt(
      attemptScopeOf(state, slot),
      slot.provider,
      requestModel,
      attempt.attemptAt,
      Math.round(Math.max(0, performance.now() - attempt.attemptStartedAt)),
      { errorClass: 'other', httpStatus: null },
      error.diagnostics.usage,
    ),
  );
  settleInconclusive(attempt.admission, { pushBack: false });
  if (state.partialOutputShown) state.callbacks.onProviderSwitch?.();
  aiLogger.warn(
    { provider: slot.provider, model: requestModel, diagnostics: error.diagnostics },
    'Provider safety stop — no fallback',
  );
  throw error;
}

/**
 * Alerting first, then the bench: a bench suppresses calls, and the outage records must keep saying what
 * actually happened. The circuit-owned and request-shaped failures never bench.
 */
function noteFailureAfterAlert(
  state: RoundState,
  attempt: AdmittedAttempt,
  error: unknown,
  failure: ProviderFailure,
  ownedByCircuit: boolean,
): void {
  reportSlotFailure(failure, error, state.options.userId, state.chainKind, false);
  if (ownedByCircuit || NON_BENCHING_STATUSES.includes(failure.status ?? 0)) return;
  noteFailureForEligibility(
    attempt.slot.provider,
    benchChainOf(attempt.slot, state.chainKind),
    state.hasTools,
    failure.status === 429 ? 413 : failure.status,
    failure.message,
    error instanceof OpenAI.APIError ? error.headers : undefined,
  );
}

/** The failed slot already showed the user output: tell the caller to clear it before the next provider starts. */
function discardShownOutput(state: RoundState, failure: ProviderFailure): void {
  if (!state.partialOutputShown) return;
  aiLogger.error(
    { provider: failure.provider, userId: state.options.userId },
    'Provider died mid-stream after output was shown — discarding it and trying next provider',
  );
  state.callbacks.onProviderSwitch?.();
  state.partialOutputShown = false;
}

/**
 * Settles one failed attempt. Returns when the round should go on to the next slot; throws for a safety stop
 * (no fallback) and for a caller abort (propagates immediately, after the failure was recorded).
 */
export function handleAttemptFailure(state: RoundState, attempt: AdmittedAttempt, error: unknown): void {
  if (error instanceof ProviderSafetyStopError) handleSafetyStop(state, attempt, error);
  const { slot, circuit, admission } = attempt;
  const failure = describeFailure(slot, error);
  state.failures.push(failure);
  const callerAborted = isCallerAbort(state.options.signal);
  recordAiUsage(
    failureAttempt(
      attemptScopeOf(state, slot),
      slot,
      failure.model,
      error,
      callerAborted,
      attempt.attemptAt,
      attempt.attemptStartedAt,
    ),
  );
  // An account-level failure is owned by the durable circuit, which tells the
  // admin once per incident from stored facts; it is not reported again here.
  const ownedByCircuit = settleCircuitAfterFailure(circuit, admission, error, failure, callerAborted);
  if (!callerAborted) noteFailureAfterAlert(state, attempt, error, failure, ownedByCircuit);
  discardShownOutput(state, failure);
  if (callerAborted) throw error;
}
