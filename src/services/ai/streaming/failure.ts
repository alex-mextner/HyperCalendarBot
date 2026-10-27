// src/services/ai/streaming/failure.ts
// What a failed or skipped provider attempt turns into: the failure record carried by
// `AllProvidersFailedError`, the usage-ledger row, the circuit settlement and the log/alert line.

import OpenAI from 'openai';
import type { AiUsageEvent } from '../../../database/repositories/ai-usage.repository.ts';
import { type ProviderChainKind, reportProviderFailure } from '../../../utils/ai-provider-alert.ts';
import { type Admission, type CircuitContext, settleFailure, settleInconclusive } from '../provider-circuit.ts';
import type { ProviderId } from '../provider-ids.ts';
import { classifyProviderError } from '../usage-classification.ts';
import { type AttemptScope, failedAttempt } from '../usage-recorder.ts';
import { isProviderDown, isTransientProviderError } from './error-classification.ts';
import { EmptyProviderResponseError } from './errors.ts';
import { aiLogger } from './logger.ts';
import { modelRequestedFrom, type ProviderSlot, slotName } from './slot.ts';
import type { ProviderFailure } from './types.ts';

export function providerFailureMetrics(failures: readonly ProviderFailure[]) {
  const failedProviders: { provider: ProviderId; model: string }[] = [];
  const skippedProviders: { provider: ProviderId; model: string }[] = [];
  for (const failure of failures) {
    const list = failure.skippedBeforeRequest ? skippedProviders : failedProviders;
    list.push({ provider: failure.providerId, model: failure.model });
  }
  return { failedProviders, skippedProviders };
}

export function describeFailure(slot: ProviderSlot, error: unknown): ProviderFailure {
  const status = error instanceof OpenAI.APIError && typeof error.status === 'number' ? error.status : undefined;
  const message = error instanceof Error ? error.message : String(error);
  const model = modelRequestedFrom(slot);
  return {
    provider: slotName(slot.label, model),
    providerId: slot.provider,
    model,
    status,
    message,
    transient: isTransientProviderError(error),
    ...(error instanceof EmptyProviderResponseError && error.diagnostics ? { emptyResponse: error.diagnostics } : {}),
  };
}

/** The usage row for a slot that failed: a skip when it never reached the network, otherwise an error with its class. */
export function failureAttempt(
  scope: AttemptScope,
  slot: ProviderSlot,
  model: string,
  error: unknown,
  callerAborted: boolean,
  attemptAt: number,
  attemptStartedAt: number,
): AiUsageEvent {
  const durationMs = Math.round(Math.max(0, performance.now() - attemptStartedAt));
  if (error instanceof EmptyProviderResponseError) {
    const usage = error.diagnostics?.usage ?? null;
    return failedAttempt(
      scope,
      slot.provider,
      model,
      attemptAt,
      durationMs,
      { errorClass: 'empty', httpStatus: null },
      usage,
    );
  }
  return failedAttempt(
    scope,
    slot.provider,
    model,
    attemptAt,
    durationMs,
    classifyProviderError(error, callerAborted),
    null,
  );
}

/** A slot the durable circuit kept the request away from — reported like a preflight skip. */
export function skippedByCircuit(
  slot: ProviderSlot,
  model: string,
  admission: Extract<Admission, { kind: 'skip' }>,
): ProviderFailure {
  return {
    provider: slotName(slot.label, model),
    providerId: slot.provider,
    model,
    status: admission.status ?? undefined,
    message: 'Provider circuit open — request skipped without contacting the provider',
    transient: false,
    skippedBeforeRequest: true,
  };
}

/** Feeds the outcome of a failed attempt to the circuit; true when the circuit owns the failure. */
export function settleCircuitAfterFailure(
  circuit: CircuitContext,
  admission: Admission,
  error: unknown,
  failure: ProviderFailure,
  callerAborted: boolean,
): boolean {
  if (callerAborted) {
    settleInconclusive(admission, { pushBack: false });
    return false;
  }
  return settleFailure(circuit, admission, {
    status: failure.status,
    message: failure.message,
    headers: error instanceof OpenAI.APIError ? error.headers : undefined,
    providerDown: isProviderDown(error),
  });
}

export function reportSlotFailure(
  failure: ProviderFailure,
  error: unknown,
  userId: number | undefined,
  chain: ProviderChainKind,
  alertAdmin: boolean,
): void {
  const context = {
    err: error,
    provider: failure.provider,
    status: failure.status,
    userId,
    ...(failure.emptyResponse ? { emptyResponse: failure.emptyResponse } : {}),
  };
  if (failure.transient) {
    aiLogger.warn(context, 'Provider temporarily unavailable — trying next provider');
  } else {
    aiLogger.error(context, 'Provider rejected the request — trying next provider');
  }

  // The alert layer classifies and throttles; a transient blip never reaches the
  // admin on its own, so this is safe to call for every failure.
  if (alertAdmin) reportProviderFailure(failure, chain);
}
