import OpenAI from 'openai';
import type { AiErrorClass } from '../../database/repositories/ai-usage.repository.ts';

export interface ProviderErrorClassification {
  errorClass: AiErrorClass;
  /** HTTP status the provider answered with; null when it never answered. */
  httpStatus: number | null;
}

const CONNECTION_FAULT_CODES = ['ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'ENOTFOUND'];
/** Providers word a spent quota or balance differently; the status alone cannot tell it from a burst limit. */
const QUOTA_WORDING =
  /exceeded your current quota|quota (?:exceeded|exhausted|reset)|limit exhausted|insufficient (?:balance|funds|credit)|credit balance/i;

/**
 * A 403 that rejects one INPUT (the provider's content policy or moderation) says nothing about the
 * key. Shared with the circuit, which refuses to open on it for the same reason.
 */
export const MODERATION_REJECTION = /content policy|safety (?:policy|filter)|requires moderation|input was flagged/i;

function classifyStatus(status: number, message: string): AiErrorClass {
  if (status === 402) return 'quota';
  if (status === 403 && MODERATION_REJECTION.test(message)) return 'bad_request';
  if (status === 401 || status === 403) return 'auth';
  if (status === 408) return 'timeout';
  // 413 is a per-minute token limit; the chain treats it as a rate limit too.
  if (status === 413) return 'rate_limit';
  if (status === 429) return QUOTA_WORDING.test(message) ? 'quota' : 'rate_limit';
  if (status >= 500) return 'server';
  if (status >= 400) return QUOTA_WORDING.test(message) ? 'quota' : 'bad_request';
  return 'other';
}

/**
 * Reduces a provider failure to a fixed class and an HTTP status. The error's message is read to tell a
 * spent quota from a burst limit and is not kept: nothing the provider wrote reaches the result.
 *
 * `callerAborted` says the signal the caller handed in has fired. An abort seen while it has not
 * fired can only be the per-provider deadline, which is a timeout of that provider.
 */
export function classifyProviderError(error: unknown, callerAborted: boolean): ProviderErrorClassification {
  if (error instanceof OpenAI.APIError) return classifySdkError(error, callerAborted);
  if (error instanceof Error) return classifyPlainError(error, callerAborted);
  return { errorClass: 'other', httpStatus: null };
}

/** An error the OpenAI SDK raised: a transport fault, an abort, or an HTTP answer. */
function classifySdkError(
  error: InstanceType<typeof OpenAI.APIError>,
  callerAborted: boolean,
): ProviderErrorClassification {
  if (error instanceof OpenAI.APIConnectionTimeoutError) return { errorClass: 'timeout', httpStatus: null };
  if (error instanceof OpenAI.APIUserAbortError) {
    return { errorClass: callerAborted ? 'aborted' : 'timeout', httpStatus: null };
  }
  if (error instanceof OpenAI.APIConnectionError) return { errorClass: 'server', httpStatus: null };
  if (typeof error.status === 'number') {
    return { errorClass: classifyStatus(error.status, error.message), httpStatus: error.status };
  }
  return { errorClass: 'other', httpStatus: null };
}

/** A non-SDK error: a deadline or abort from the runtime, or a socket-level fault carrying an errno code. */
function classifyPlainError(error: Error, callerAborted: boolean): ProviderErrorClassification {
  if (error.name === 'TimeoutError') return { errorClass: 'timeout', httpStatus: null };
  if (error.name === 'AbortError') return { errorClass: callerAborted ? 'aborted' : 'timeout', httpStatus: null };
  if (error.message.includes('timed out')) return { errorClass: 'timeout', httpStatus: null };
  const code = 'code' in error ? error.code : undefined;
  if (typeof code === 'string' && CONNECTION_FAULT_CODES.includes(code)) {
    return { errorClass: 'server', httpStatus: null };
  }
  return { errorClass: 'other', httpStatus: null };
}
