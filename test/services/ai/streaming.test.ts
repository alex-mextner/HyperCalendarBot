// test/services/ai/streaming.test.ts
import { describe, expect, test } from 'bun:test';
import OpenAI from 'openai';
import { EmptyProviderResponseError, isRetryableError } from '../../../src/services/ai/streaming.ts';

function makeApiError(status: number, headers?: Record<string, string>): InstanceType<typeof OpenAI.APIError> {
  return new OpenAI.APIError(status, { error: { message: 'boom' } }, `http ${status}`, new Headers(headers ?? {}));
}

describe('isRetryableError', () => {
  test('true for 429', () => {
    expect(isRetryableError(makeApiError(429))).toBe(true);
  });

  test('true for 500', () => {
    expect(isRetryableError(makeApiError(500))).toBe(true);
  });

  test('true for 503', () => {
    expect(isRetryableError(makeApiError(503))).toBe(true);
  });

  test('false for 400', () => {
    expect(isRetryableError(makeApiError(400))).toBe(false);
  });

  test('false for 401', () => {
    expect(isRetryableError(makeApiError(401))).toBe(false);
  });

  test('true for errors with "timed out" message', () => {
    expect(isRetryableError(new Error('Request timed out after 60s'))).toBe(true);
  });

  test('true for ECONNRESET', () => {
    const err = new Error('socket closed') as NodeJS.ErrnoException;
    err.code = 'ECONNRESET';
    expect(isRetryableError(err)).toBe(true);
  });

  test('true for ETIMEDOUT', () => {
    const err = new Error('timed out') as NodeJS.ErrnoException;
    err.code = 'ETIMEDOUT';
    expect(isRetryableError(err)).toBe(true);
  });

  test('true for AbortError', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    expect(isRetryableError(err)).toBe(true);
  });

  test('false for a plain Error', () => {
    expect(isRetryableError(new Error('something else'))).toBe(false);
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
