// src/services/ai/streaming/round-attempts.ts
// The attempt side of one streaming round: which slots a round tries and in what order, what is recorded for
// the ones it never tries, and one admitted slot's run under its provider deadline up to the success bookkeeping.
// Failure handling lives in ./attempt-failure.ts; `aiStreamRound` in ../streaming.ts only sequences the two.

import { loadConfig } from '../../../config/env.ts';
import {
  type ProviderChainKind,
  reportAllProvidersFailed,
  reportProviderAnswered,
} from '../../../utils/ai-provider-alert.ts';
import { type Admission, admitProvider, type CircuitContext, settleAnswered } from '../provider-circuit.ts';
import { withinProviderDeadline } from '../provider-deadline.ts';
import { clearBlock, isBlocked } from '../provider-eligibility.ts';
import { roleForPurpose, rolesApplyTo } from '../role-routing.ts';
import { type AttemptScope, answeredAttempt, recordAiUsage, skippedAttempt } from '../usage-recorder.ts';
import { benchChainOf, buildFastChain, buildRoleChain, buildSmartChain, withoutModelsOf } from './chains.ts';
import { AllProvidersFailedError, unexposedToolNamesOf } from './errors.ts';
import { providerFailureMetrics, skippedByCircuit } from './failure.ts';
import { aiLogger } from './logger.ts';
import { providerTimeoutCapMs } from './round-budget.ts';
import { modelRequestedFrom, type ProviderSlot, slotName } from './slot.ts';
import { runSlot } from './slot-runner.ts';
import type { ProviderFailure, StreamCallbacks, StreamRoundOptions, StreamRoundResult } from './types.ts';

/** Everything one round shares across its attempts. The mutable fields are the round's running bookkeeping. */
export interface RoundState {
  readonly options: StreamRoundOptions;
  readonly callbacks: StreamCallbacks;
  /** Callbacks handed to providers: they mark that the user has already been shown output. */
  readonly wrappedCallbacks: StreamCallbacks;
  readonly cap: number;
  readonly roundStartedAt: number;
  readonly chainKind: ProviderChainKind;
  readonly hasTools: boolean;
  readonly failures: ProviderFailure[];
  actualAttempts: number;
  // Anything the caller has already shown the user for this round: streamed text
  // or a "running <tool>" label. Both must be cleared before another provider
  // starts, otherwise the user sees output from a round that never finished.
  partialOutputShown: boolean;
}

/** A slot that passed circuit admission, with what its outcome handling needs. */
export interface AdmittedAttempt {
  readonly slot: ProviderSlot;
  readonly requestModel: string;
  readonly circuit: CircuitContext;
  readonly admission: Exclude<Admission, { kind: 'skip' }>;
  readonly attemptAt: number;
  readonly attemptStartedAt: number;
}

export function createRoundState(options: StreamRoundOptions, callbacks: StreamCallbacks): RoundState {
  const state: RoundState = {
    options,
    callbacks,
    wrappedCallbacks: {
      onTextDelta: (text) => {
        state.partialOutputShown = true;
        callbacks.onTextDelta?.(text);
      },
      onToolCallStart: (name) => {
        state.partialOutputShown = true;
        callbacks.onToolCallStart?.(name);
      },
    },
    cap: providerTimeoutCapMs(options),
    roundStartedAt: performance.now(),
    chainKind: options.fast ? 'fast' : 'smart',
    hasTools: (options.tools?.length ?? 0) > 0,
    failures: [],
    actualAttempts: 0,
    partialOutputShown: false,
  };
  return state;
}

export function attemptScopeOf(state: RoundState, slot: ProviderSlot): AttemptScope {
  return {
    chain: slot.role ? `role:${slot.role}` : state.chainKind,
    purpose: state.options.purpose,
    requestId: state.options.requestId,
    role: slot.role ?? null,
    preset: slot.presetId ?? null,
  };
}

/**
 * A role chain is tried first and the legacy chain follows it, minus models the role chain already asked:
 * roles can fail or be skipped at runtime (open circuit, bench, deadline) as well as fail to load, and a
 * user must not get no answer from a role chain while the legacy chain they were on yesterday is healthy.
 */
export function buildRoundChain(options: StreamRoundOptions): ProviderSlot[] {
  const cfg = loadConfig();
  const role = roleForPurpose(options.purpose);
  const roleChain = role && rolesApplyTo(cfg, options.userId) ? buildRoleChain(role, cfg) : [];
  const legacyChain = options.fast ? buildFastChain(cfg) : buildSmartChain(cfg);
  return roleChain.length > 0 ? [...roleChain, ...withoutModelsOf(roleChain, legacyChain)] : legacyChain;
}

function recordSkips(
  state: RoundState,
  slots: readonly ProviderSlot[],
  reason: 'eligibility_bench' | 'round_deadline',
) {
  for (const slot of slots) {
    recordAiUsage(skippedAttempt(attemptScopeOf(state, slot), slot.provider, modelRequestedFrom(slot), reason));
  }
}

/**
 * A provider that said it is out until T is skipped — unless every provider in
 * the chain is, in which case they are all tried anyway. A wasted round trip
 * beats no answer, and this is the one place a memory of past failure could
 * turn into silence.
 */
export function selectAttempts(state: RoundState, chain: readonly ProviderSlot[]): readonly ProviderSlot[] {
  const eligible = chain.filter(
    (slot) => !isBlocked(slot.provider, benchChainOf(slot, state.chainKind), state.hasTools),
  );
  if (eligible.length === 0) {
    if (chain.length > 0) {
      aiLogger.warn(
        { chain: state.chainKind },
        'Every provider is benched — trying them anyway rather than answering nobody',
      );
    }
    return chain;
  }
  recordSkips(
    state,
    chain.filter((slot) => !eligible.includes(slot)),
    'eligibility_bench',
  );
  return eligible;
}

/** The shared round deadline expired: the slots that never got a turn are recorded as skipped, not as failures. */
export function recordDeadlineSkips(state: RoundState, unattempted: readonly ProviderSlot[]): void {
  aiLogger.warn({ requestId: state.options.requestId }, 'AI round deadline reached before next provider');
  recordSkips(state, unattempted, 'round_deadline');
}

/**
 * Circuit admission is the last gate before the request: a slot skipped earlier never spends the half-open probe.
 * Returns null when the circuit skipped the slot (already recorded as a failure and a usage row).
 */
export function admitSlot(state: RoundState, slot: ProviderSlot): AdmittedAttempt | null {
  const requestModel = modelRequestedFrom(slot);
  const circuit: CircuitContext = {
    key: slot.circuitKey,
    ...(slot.accountCircuitKey ? { accountKey: slot.accountCircuitKey } : {}),
    provider: slot.provider,
    label: slotName(slot.label, requestModel),
    chain: state.chainKind,
  };
  const admission = admitProvider(circuit);
  if (admission.kind === 'skip') {
    state.failures.push(skippedByCircuit(slot, requestModel, admission));
    recordAiUsage(
      skippedAttempt(
        attemptScopeOf(state, slot),
        slot.provider,
        requestModel,
        'circuit_open',
        admission.status ?? null,
      ),
    );
    return null;
  }
  return { slot, requestModel, circuit, admission, attemptAt: Date.now(), attemptStartedAt: performance.now() };
}

/** The slot call under its provider deadline; callbacks and the attempt counter go quiet once the attempt's signal aborts. */
function runUnderDeadline(state: RoundState, slot: ProviderSlot, timeoutMs: number): Promise<StreamRoundResult> {
  const { options, wrappedCallbacks } = state;
  return withinProviderDeadline(
    async (signal) =>
      runSlot(
        slot,
        { ...options, signal },
        {
          onTextDelta: (text) => {
            if (!signal.aborted) wrappedCallbacks.onTextDelta?.(text);
          },
          onToolCallStart: (name) => {
            if (!signal.aborted) wrappedCallbacks.onToolCallStart?.(name);
          },
        },
        () => {
          signal.throwIfAborted();
          state.actualAttempts++;
        },
      ),
    timeoutMs,
    options.signal,
  );
}

function settleSuccess(state: RoundState, attempt: AdmittedAttempt, result: StreamRoundResult): void {
  const { slot, requestModel, circuit } = attempt;
  // A slot that answers settles any outstanding outage for it and for its own
  // chain. The alert layer decides whether that is worth telling the admin
  // about.
  reportProviderAnswered(slot.label, state.chainKind);
  settleAnswered(circuit);
  clearBlock(slot.provider, benchChainOf(slot, state.chainKind), state.hasTools);
  if (result.metrics) {
    result.metrics = {
      ...result.metrics,
      chain: state.chainKind,
      attemptCount: state.actualAttempts,
      fallbackCount: state.failures.length,
      ...providerFailureMetrics(state.failures),
      totalDurationMs: Math.max(0, performance.now() - state.roundStartedAt),
    };
  }
  recordAiUsage(
    answeredAttempt(
      attemptScopeOf(state, slot),
      slot.provider,
      result.metrics?.model ?? requestModel,
      attempt.attemptAt,
      Math.round(Math.max(0, performance.now() - attempt.attemptStartedAt)),
      result.metrics?.usage ?? null,
    ),
  );
}

/** Runs one admitted slot to an answer and settles the success bookkeeping; rejects with the attempt's failure. */
export async function runAdmittedAttempt(
  state: RoundState,
  attempt: AdmittedAttempt,
  remainingMs: number,
): Promise<StreamRoundResult> {
  const { slot } = attempt;
  aiLogger.info(
    {
      provider: slot.label,
      model: slot.configuredModel,
      userId: state.options.userId,
      requestId: state.options.requestId,
    },
    'Trying provider',
  );
  const result = await runUnderDeadline(state, slot, Math.min(state.cap, remainingMs));
  settleSuccess(state, attempt, result);
  return result;
}

/** Every slot failed or was skipped: logs, alerts (unless deferred to the caller) and builds the aggregate error. */
export function exhaustedRoundError(state: RoundState): AllProvidersFailedError {
  const { failures, options, chainKind } = state;
  const deferAlert = options.deferOutageAlert === true && unexposedToolNamesOf(failures).length > 0;
  const aggregate = new AllProvidersFailedError(
    failures,
    {
      totalDurationMs: Math.max(0, performance.now() - state.roundStartedAt),
      attemptCount: state.actualAttempts,
      fallbackCount: Math.max(0, failures.length - 1),
    },
    deferAlert ? chainKind : undefined,
  );
  aiLogger.error({ failures, userId: options.userId }, 'Every AI provider in the chain failed');
  // The loudest alert there is: nobody answered, so the user got nothing.
  if (!deferAlert) reportAllProvidersFailed(failures, chainKind);
  return aggregate;
}
