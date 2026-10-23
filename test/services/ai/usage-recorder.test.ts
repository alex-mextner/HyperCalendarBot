// test/services/ai/usage-recorder.test.ts
import { afterEach, describe, expect, test } from 'bun:test';
import OpenAI from 'openai';
import type { AiUsageEvent } from '../../../src/database/repositories/ai-usage.repository.ts';
import { classifyProviderError } from '../../../src/services/ai/usage-classification.ts';
import {
  configureAiUsageRecording,
  flushAiUsageEvents,
  recordAiUsage,
} from '../../../src/services/ai/usage-recorder.ts';

function nextImmediate(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}

function apiError(status: number, message = 'boom'): InstanceType<typeof OpenAI.APIError> {
  return new OpenAI.APIError(status, { error: { message } }, message, new Headers());
}

describe('classifyProviderError', () => {
  test.each([
    [402, 'quota'],
    [429, 'rate_limit'],
    [401, 'auth'],
    [403, 'auth'],
    [500, 'server'],
    [502, 'server'],
    [503, 'server'],
    [408, 'timeout'],
    [400, 'bad_request'],
    [404, 'bad_request'],
    [422, 'bad_request'],
    [413, 'rate_limit'],
  ] as const)('HTTP %d is %s and keeps its status', (status, errorClass) => {
    expect(classifyProviderError(apiError(status), false)).toEqual({ errorClass, httpStatus: status });
  });

  test('a 429 that says the quota or balance is spent is quota, not a transient rate limit', () => {
    expect(classifyProviderError(apiError(429, 'Weekly/Monthly Limit Exhausted, quota resets'), false)).toEqual({
      errorClass: 'quota',
      httpStatus: 429,
    });
  });

  test('a 400 about the credit balance is quota (Anthropic reports a drained balance as 400)', () => {
    expect(classifyProviderError(apiError(400, 'Your credit balance is too low to access the API'), false)).toEqual({
      errorClass: 'quota',
      httpStatus: 400,
    });
  });

  test("Groq's ordinary per-minute 429, which ends with a billing upsell link, is a rate limit and not a spent quota", () => {
    const groq429 =
      'Rate limit reached for model `openai/gpt-oss-120b` in organization `org_x` on tokens per minute (TPM): Limit 6000, Used 5000, Requested 2000. Please try again in 10s. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing';
    expect(classifyProviderError(apiError(429, groq429), false)).toEqual({ errorClass: 'rate_limit', httpStatus: 429 });
  });

  test('a 4xx that only links to a billing page is not quota', () => {
    expect(
      classifyProviderError(
        apiError(400, 'Invalid request. See https://example.com/account/billing for limits'),
        false,
      ),
    ).toEqual({ errorClass: 'bad_request', httpStatus: 400 });
  });

  test('the provider deadline firing is a timeout, whichever way it surfaces', () => {
    const deadline = new DOMException('Provider attempt timed out', 'TimeoutError');
    expect(classifyProviderError(deadline, false)).toEqual({ errorClass: 'timeout', httpStatus: null });
    expect(classifyProviderError(new OpenAI.APIConnectionTimeoutError(), false)).toEqual({
      errorClass: 'timeout',
      httpStatus: null,
    });
    expect(classifyProviderError(new OpenAI.APIUserAbortError(), false)).toEqual({
      errorClass: 'timeout',
      httpStatus: null,
    });
    expect(classifyProviderError(new Error('Request timed out.'), false)).toEqual({
      errorClass: 'timeout',
      httpStatus: null,
    });
  });

  test('an abort while the caller signal is aborted is aborted, not a provider timeout', () => {
    expect(classifyProviderError(new OpenAI.APIUserAbortError(), true)).toEqual({
      errorClass: 'aborted',
      httpStatus: null,
    });
    const abort = new DOMException('This operation was aborted', 'AbortError');
    expect(classifyProviderError(abort, true)).toEqual({ errorClass: 'aborted', httpStatus: null });
  });

  test('a dropped connection counts as a server fault with no status', () => {
    expect(classifyProviderError(new OpenAI.APIConnectionError({ message: 'socket hang up' }), false)).toEqual({
      errorClass: 'server',
      httpStatus: null,
    });
    const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    expect(classifyProviderError(reset, false)).toEqual({ errorClass: 'server', httpStatus: null });
  });

  test('anything unrecognised is other, never a guess', () => {
    expect(classifyProviderError(new Error('something else'), false)).toEqual({
      errorClass: 'other',
      httpStatus: null,
    });
    expect(classifyProviderError('a string', false)).toEqual({ errorClass: 'other', httpStatus: null });
    expect(classifyProviderError(new OpenAI.APIError(undefined, undefined, 'no status', new Headers()), false)).toEqual(
      {
        errorClass: 'other',
        httpStatus: null,
      },
    );
  });

  test('stores a class and a status only: the provider body never reaches the result', () => {
    const result = classifyProviderError(apiError(401, 'Incorrect API key provided: sk-live-SECRET'), false);
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });
});

function event(overrides: Partial<AiUsageEvent> = {}): AiUsageEvent {
  return {
    at: 1,
    provider: 'groq',
    model: 'm',
    chain: 'smart',
    purpose: 'agent',
    outcome: 'ok',
    errorClass: null,
    httpStatus: null,
    skipReason: null,
    durationMs: 1,
    promptTokens: null,
    completionTokens: null,
    reasoningTokens: null,
    cachedTokens: null,
    requestId: null,
    ...overrides,
  };
}

describe('AI usage recorder', () => {
  afterEach(() => configureAiUsageRecording(null));

  test('records nothing and does nothing until a sink is configured', () => {
    expect(() => recordAiUsage(event())).not.toThrow();
    expect(() => flushAiUsageEvents()).not.toThrow();
  });

  test('defers the write: recording returns before the sink sees the event, then one batch lands', async () => {
    const batches: (readonly AiUsageEvent[])[] = [];
    configureAiUsageRecording({ insertMany: (events) => void batches.push(events) });

    recordAiUsage(event({ at: 1 }));
    recordAiUsage(event({ at: 2 }));
    expect(batches).toEqual([]);

    await nextImmediate();

    expect(batches.map((batch) => batch.map((e) => e.at))).toEqual([[1, 2]]);
  });

  test('a failing sink is swallowed and the batch is dropped, not retried forever', async () => {
    let calls = 0;
    configureAiUsageRecording({
      insertMany: () => {
        calls++;
        throw new Error('database is locked');
      },
    });

    expect(() => recordAiUsage(event())).not.toThrow();
    await nextImmediate();
    await nextImmediate();

    expect(calls).toBe(1);
  });

  test('flush writes what is pending at once (shutdown path)', () => {
    const seen: number[] = [];
    configureAiUsageRecording({ insertMany: (events) => void seen.push(events.length) });
    recordAiUsage(event());

    flushAiUsageEvents();

    expect(seen).toEqual([1]);
  });
});
