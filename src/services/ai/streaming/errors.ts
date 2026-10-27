// src/services/ai/streaming/errors.ts
// Error classes a streaming round throws. Callers branch on these with instanceof, never on message text.

import type { ProviderChainKind } from '../../../utils/ai-provider-alert.ts';
import type { EmptyResponseDiagnostics, FailedRoundMetrics, ProviderFailure } from './types.ts';

/**
 * Sentinel error type: provider returned 200 OK but no usable output
 * (z.ai coding endpoint's reasoning-only quirk). We detect this via instanceof
 * rather than substring-matching the message — a future copy-edit to the
 * message text would otherwise silently break the fallback decision.
 */
export class EmptyProviderResponseError extends Error {
  constructor(
    provider: string,
    readonly diagnostics?: EmptyResponseDiagnostics,
  ) {
    super(
      diagnostics?.classification === 'malformed_tools'
        ? `Provider ${provider} returned malformed tool calls — nothing executed`
        : `Provider ${provider} returned 200 OK with no text and no tool calls`,
    );
    this.name = 'EmptyProviderResponseError';
  }
}

/** An explicit upstream safety stop is a result, not permission to try another provider. */
export class ProviderSafetyStopError extends Error {
  constructor(readonly diagnostics: EmptyResponseDiagnostics) {
    super('Provider stopped the response for safety; no automatic retry');
    this.name = 'ProviderSafetyStopError';
  }
}

const UNEXPOSED_TOOL_PATTERN = /attempted to call tool '([^']+)' which was not in request\.tools/;

export function unexposedToolNamesOf(failures: ProviderFailure[]): string[] {
  const names = new Set<string>();
  for (const failure of failures) {
    const name = UNEXPOSED_TOOL_PATTERN.exec(failure.message)?.[1];
    if (name) names.add(name);
  }
  return [...names];
}

/**
 * Thrown when every slot in the chain failed. Carries each provider's reason so
 * a single log line (or admin alert) explains the whole outage — the previous
 * behavior of rethrowing only the last error hid which providers died and why.
 */
export class AllProvidersFailedError extends Error {
  readonly failures: ProviderFailure[];
  readonly roundMetrics: FailedRoundMetrics;
  /** Set when the round held the outage alert back for its caller: the chain it ran on. */
  readonly deferredAlertChain?: ProviderChainKind;

  constructor(failures: ProviderFailure[], roundMetrics?: FailedRoundMetrics, deferredAlertChain?: ProviderChainKind) {
    const detail = failures.map((f) => `${f.provider}: ${f.status ?? 'no status'} ${f.message}`).join(' | ');
    super(`All ${failures.length} AI providers failed — ${detail}`);
    this.name = 'AllProvidersFailedError';
    this.failures = failures;
    this.roundMetrics = roundMetrics ?? {
      totalDurationMs: 0,
      attemptCount: failures.length,
      fallbackCount: Math.max(0, failures.length - 1),
    };
    this.deferredAlertChain = deferredAlertChain;
  }

  /** Tools the model called that the request did not offer — a provider validates this before answering. */
  unexposedToolNames(): string[] {
    return unexposedToolNamesOf(this.failures);
  }
}
