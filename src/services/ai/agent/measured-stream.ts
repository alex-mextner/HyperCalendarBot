// Wraps the provider stream for one agent request: bounds it by the request deadline, ignores late
// producers' callbacks, and records per-call metrics. Carries no user text, tool arguments or ids.
import { logger } from '../../../utils/logger.ts';
import { waitForAbort } from '../provider-deadline.ts';
import { type AgentRequestMetrics, elapsedMs } from '../request-metrics.ts';
import {
  AllProvidersFailedError,
  type aiStreamRound,
  providerFailureMetrics,
  type StreamCallbacks,
  type StreamRoundResult,
} from '../streaming.ts';

const aiLogger = logger.child({ module: 'ai-agent' });

export type StreamPurpose = 'history' | 'agent' | 'validator' | 'retry';

export interface MeasuredStreamEnv {
  /** The real provider stream, or a scripted one in tests. */
  streamImpl: typeof aiStreamRound;
  /** Aborts on the overall request deadline or a shutdown. */
  requestSignal: AbortSignal;
  requestMetrics: AgentRequestMetrics;
  requestId: string;
}

/**
 * Callbacks that go quiet the moment the call is over or aborted. A producer that outlives its
 * round (a timed-out provider still streaming) must not write into the next round's draft.
 */
export function guardCallbacks(
  callbacks: StreamCallbacks | undefined,
  signal: AbortSignal,
  isActive: () => boolean,
): StreamCallbacks {
  const live = () => isActive() && !signal.aborted;
  return {
    onTextDelta: (text) => {
      if (live()) callbacks?.onTextDelta?.(text);
    },
    onToolCallStart: (name) => {
      if (live()) callbacks?.onToolCallStart?.(name);
    },
    onProviderSwitch: () => {
      if (live()) callbacks?.onProviderSwitch?.();
    },
  };
}

type RoundMetrics = StreamRoundResult['metrics'];

function routeFields(metrics: RoundMetrics) {
  return {
    provider: metrics?.provider ?? null,
    model: metrics?.model ?? null,
    chain: metrics?.chain ?? null,
  };
}

function timingFields(metrics: RoundMetrics, startedAt: number) {
  return {
    firstUsableSinceAttemptMs: metrics?.firstUsableSinceAttemptMs ?? null,
    providerDurationMs: metrics?.providerDurationMs ?? null,
    totalDurationMs: metrics?.totalDurationMs ?? elapsedMs(startedAt),
    attemptCount: metrics?.attemptCount ?? null,
    fallbackCount: metrics?.fallbackCount ?? null,
  };
}

/** Unknown usage stays null: a provider that did not report tokens is not a zero-token call. */
function usageFields(metrics: RoundMetrics) {
  const usage = metrics?.usage;
  return {
    promptTokens: usage?.promptTokens ?? null,
    completionTokens: usage?.completionTokens ?? null,
    reasoningTokens: usage?.reasoningTokens ?? null,
    cachedTokens: usage?.cachedTokens ?? null,
  };
}

function logRoundSucceeded(
  requestId: string,
  purpose: StreamPurpose,
  result: StreamRoundResult,
  startedAt: number,
): void {
  const metrics = result.metrics;
  aiLogger.info(
    {
      requestId,
      purpose,
      ...routeFields(metrics),
      ...timingFields(metrics, startedAt),
      ...usageFields(metrics),
      failedProviders: metrics?.failedProviders ?? [],
      skippedProviders: metrics?.skippedProviders ?? [],
      success: true,
    },
    'AI model call metric',
  );
}

function logRoundFailed(requestId: string, purpose: StreamPurpose, error: unknown, startedAt: number): void {
  const failed = error instanceof AllProvidersFailedError ? error.roundMetrics : null;
  aiLogger.info(
    {
      requestId,
      purpose,
      totalDurationMs: failed?.totalDurationMs ?? elapsedMs(startedAt),
      attemptCount: failed?.attemptCount ?? null,
      fallbackCount: failed?.fallbackCount ?? null,
      ...(error instanceof AllProvidersFailedError
        ? providerFailureMetrics(error.failures)
        : { failedProviders: [], skippedProviders: [] }),
      success: false,
    },
    'AI model call metric',
  );
}

/**
 * One stream function per call purpose, all sharing the request's deadline and metrics. A call
 * never outlives the request signal, its callbacks are ignored after it settles or aborts, and a
 * failed call still counts its attempts and duration.
 */
export function createMeasuredStream(env: MeasuredStreamEnv, purpose: StreamPurpose): typeof aiStreamRound {
  const { streamImpl, requestSignal, requestMetrics, requestId } = env;
  return async (...args) => {
    const [options, callbacks] = args;
    const startedAt = performance.now();
    const signal = options.signal ? AbortSignal.any([requestSignal, options.signal]) : requestSignal;
    let active = true;
    const guardedCallbacks = guardCallbacks(callbacks, signal, () => active);
    try {
      const result = await waitForAbort(
        () => streamImpl({ ...options, requestId, signal, purpose }, guardedCallbacks),
        signal,
      );
      requestMetrics.recordRound(result.metrics);
      logRoundSucceeded(requestId, purpose, result, startedAt);
      return result;
    } catch (error) {
      const failed = error instanceof AllProvidersFailedError ? error.roundMetrics : null;
      requestMetrics.recordFailedRound(
        failed?.totalDurationMs ?? elapsedMs(startedAt),
        failed?.attemptCount ?? 0,
        failed?.fallbackCount ?? 0,
      );
      logRoundFailed(requestId, purpose, error, startedAt);
      throw error;
    } finally {
      active = false;
    }
  };
}
