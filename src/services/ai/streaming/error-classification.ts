// src/services/ai/streaming/error-classification.ts
// Pure predicates that read a provider error and say what kind of failure it is.
// They decide log level, circuit input and the one same-slot retry — never whether the chain continues.

import OpenAI from 'openai';

/**
 * Provider-level down/unavailable detection: 5xx, timeout, connection errors.
 * Distinct from 429 (rate limit) which is handled separately.
 */
export function isProviderDown(error: unknown): boolean {
  if (error instanceof OpenAI.APIError && typeof error.status === 'number' && error.status >= 500) {
    return true;
  }
  if (error instanceof Error) {
    if (error.message.includes('timed out')) return true;
    const code = (error as NodeJS.ErrnoException).code;
    if (code && ['ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'ENOTFOUND'].includes(code)) {
      return true;
    }
  }
  return false;
}

/**
 * True when the provider looked temporarily unavailable (5xx, rate limit,
 * timeout, aborted connection) rather than rejecting our request outright.
 *
 * This no longer decides whether the chain continues — every provider error
 * falls through to the next slot. It only picks the log level and marks the
 * failure in `AllProvidersFailedError`, so a transient blip reads differently
 * from a provider that will keep rejecting us until a human intervenes.
 */
export function isTransientProviderError(error: unknown): boolean {
  if (isProviderDown(error)) return true;
  if (error instanceof Error && error.name === 'AbortError') return true;
  // OpenAI SDK v6 throws APIUserAbortError (extends APIError, status=undefined)
  // when an AbortSignal fires. This comes from the agent's per-round timeout,
  // not from the user.
  if (error instanceof OpenAI.APIError && error.status === undefined) return true;
  if (error instanceof OpenAI.APIError && typeof error.status === 'number') {
    // 400 with no body is a transient provider issue (seen intermittently from providers).
    // A real 400 always includes a body describing the error.
    if (error.status === 400 && error.message.includes('no body')) return true;
    // 413 Request Too Large: a per-minute token limit (TPM) is a back-off, so fall through.
    if (error.status === 413) return true;
    return error.status === 429 || error.status >= 500;
  }
  // "Request timed out." from the OpenAI SDK's built-in connection timeout
  if (error instanceof Error && error.message.includes('timed out')) return true;
  return false;
}

/** Shared caller deadlines end the round; each provider has its own shorter deadline. */
export function isCallerAbort(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * A 400 with no body is the provider dropping the request before it starts (it
 * arrives within milliseconds and the identical request succeeds moments later),
 * so the request is repeated once on the same slot. When the other providers are
 * depleted or skipped, falling through would fail the whole turn on a blip.
 */
export function isBodilessRejection(error: unknown): boolean {
  return (
    error instanceof OpenAI.APIError &&
    error.status === 400 &&
    error.error === undefined &&
    error.message.includes('no body')
  );
}

/** The provider refused `stream_options.include_usage`: the request is repeated without usage telemetry. */
export function rejectsUsageStreamOption(error: unknown): boolean {
  if (!(error instanceof OpenAI.APIError) || error.status !== 400) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes('stream_options') || message.includes('include_usage') || message.includes('unknown parameter')
  );
}
