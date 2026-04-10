// test/services/ai/streaming.test.ts
import { describe, expect, test } from 'bun:test';
import OpenAI from 'openai';
import { getBackoffDelay, isRetryableError } from '../../../src/services/ai/streaming.ts';

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

describe('getBackoffDelay', () => {
  test('exponential 2s → 6s → 18s', () => {
    const err = new Error('network');
    expect(getBackoffDelay(0, err)).toBe(2000);
    expect(getBackoffDelay(1, err)).toBe(6000);
    expect(getBackoffDelay(2, err)).toBe(18000);
  });

  test('caps at 30s for higher attempts', () => {
    const err = new Error('network');
    expect(getBackoffDelay(3, err)).toBe(30_000);
    expect(getBackoffDelay(10, err)).toBe(30_000);
  });

  test('429 without retry-after header → 5s', () => {
    expect(getBackoffDelay(0, makeApiError(429))).toBe(5000);
  });

  test('429 with numeric retry-after → honored (in ms)', () => {
    expect(getBackoffDelay(0, makeApiError(429, { 'retry-after': '7' }))).toBe(7000);
  });

  test('429 retry-after capped at 30s', () => {
    expect(getBackoffDelay(0, makeApiError(429, { 'retry-after': '120' }))).toBe(30_000);
  });

  test('429 with invalid retry-after falls back to 5s', () => {
    expect(getBackoffDelay(0, makeApiError(429, { 'retry-after': 'bogus' }))).toBe(5000);
  });
});
