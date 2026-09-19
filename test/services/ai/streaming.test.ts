// test/services/ai/streaming.test.ts
import { describe, expect, test } from 'bun:test';
import OpenAI from 'openai';
import {
  EmptyProviderResponseError,
  isTransientProviderError,
  preflightRequestFit,
} from '../../../src/services/ai/streaming.ts';

function makeApiError(status: number, headers?: Record<string, string>): InstanceType<typeof OpenAI.APIError> {
  return new OpenAI.APIError(status, { error: { message: 'boom' } }, `http ${status}`, new Headers(headers ?? {}));
}

describe('isTransientProviderError — classifies a failure for logging and the aggregate error', () => {
  test('true for 429', () => {
    expect(isTransientProviderError(makeApiError(429))).toBe(true);
  });

  test('true for 500', () => {
    expect(isTransientProviderError(makeApiError(500))).toBe(true);
  });

  test('true for 503', () => {
    expect(isTransientProviderError(makeApiError(503))).toBe(true);
  });

  test('false for 400 with a body — the provider rejected the request, it is not down', () => {
    expect(isTransientProviderError(makeApiError(400))).toBe(false);
  });

  test('false for 401 — a bad key is permanent until a human rotates it', () => {
    expect(isTransientProviderError(makeApiError(401))).toBe(false);
  });

  test('true for 413 (Groq TPM rate limit — chain should fall through)', () => {
    expect(isTransientProviderError(makeApiError(413))).toBe(true);
  });

  test('true for errors with "timed out" message', () => {
    expect(isTransientProviderError(new Error('Request timed out after 60s'))).toBe(true);
  });

  test('true for ECONNRESET', () => {
    const err = new Error('socket closed') as NodeJS.ErrnoException;
    err.code = 'ECONNRESET';
    expect(isTransientProviderError(err)).toBe(true);
  });

  test('true for ETIMEDOUT', () => {
    const err = new Error('timed out') as NodeJS.ErrnoException;
    err.code = 'ETIMEDOUT';
    expect(isTransientProviderError(err)).toBe(true);
  });

  test('true for AbortError', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    expect(isTransientProviderError(err)).toBe(true);
  });

  test('false for a plain Error', () => {
    expect(isTransientProviderError(new Error('something else'))).toBe(false);
  });
});

describe('preflightRequestFit', () => {
  test('paid account override admits a large request without lifting other model limits', () => {
    const large = { messages: [{ role: 'user' as const, content: 'x'.repeat(50000) }], maxTokens: 200 };
    const limits = { 'openai/gpt-oss-120b': 250000 };
    expect(preflightRequestFit('groq', 'openai/gpt-oss-120b', large, limits)).toBeNull();
    expect(preflightRequestFit('groq', 'openai/gpt-oss-20b', large, limits)?.limitTokens).toBe(8000);
    expect(
      preflightRequestFit('groq', 'openai/gpt-oss-120b', large, { 'openai/gpt-oss-120b': 1000 })?.limitTokens,
    ).toBe(1000);
  });

  test('rejects a Groq gpt-oss request that cannot fit even at the optimistic estimator bound', () => {
    const result = preflightRequestFit('groq', 'openai/gpt-oss-120b', {
      messages: [{ role: 'user', content: 'x'.repeat(50_000) }],
      maxTokens: 200,
    });
    expect(result).not.toBeNull();
    expect(result?.conservativeRequestedTokens).toBeGreaterThan(8_000);
    expect(result?.limitTokens).toBe(8_000);
  });

  test('keeps a small Groq request eligible', () => {
    expect(
      preflightRequestFit('groq', 'openai/gpt-oss-120b', {
        messages: [{ role: 'user', content: 'What is on my calendar today?' }],
        maxTokens: 200,
      }),
    ).toBeNull();
  });

  test('does not invent a budget for providers or Groq models whose limit is unknown', () => {
    const large = { messages: [{ role: 'user' as const, content: 'x'.repeat(50_000) }], maxTokens: 200 };
    expect(preflightRequestFit('gemini', 'models/gemini-2.5-flash', large)).toBeNull();
    expect(preflightRequestFit('groq', 'groq/compound', large)).toBeNull();
  });
});

describe('EmptyProviderResponseError', () => {
  test('is an Error subclass with name set', () => {
    const err = new EmptyProviderResponseError('z.ai (glm-5.1)');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('EmptyProviderResponseError');
    expect(err.message).toContain('z.ai (glm-5.1)');
  });

  test('instanceof check works across module boundaries (used by aiStreamRound fallback logic)', () => {
    const err: unknown = new EmptyProviderResponseError('provider-a');
    expect(err instanceof EmptyProviderResponseError).toBe(true);
    expect(err instanceof Error).toBe(true);
  });
});
