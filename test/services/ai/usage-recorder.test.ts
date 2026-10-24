// test/services/ai/usage-recorder.test.ts
import { afterEach, describe, expect, test } from 'bun:test';
import OpenAI from 'openai';
import type { AiUsageEvent } from '../../../src/database/repositories/ai-usage.repository.ts';
import { classifyProviderError } from '../../../src/services/ai/usage-classification.ts';
import {
  answeredAttempt,
  configureAiUsageRecording,
  failedAttempt,
  flushAiUsageEvents,
  recordAiUsage,
  skippedAttempt,
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

  test.each([
    'This model requires moderation and your input was flagged for harassment',
    'Rejected by the content policy',
    'blocked by the safety filter',
  ])('a 403 about one input (%s) is a bad request, not an auth failure of the key', (message) => {
    expect(classifyProviderError(apiError(403, message), false)).toEqual({
      errorClass: 'bad_request',
      httpStatus: 403,
    });
  });

  test('a plain 403 stays an auth failure', () => {
    expect(classifyProviderError(apiError(403, 'Forbidden: key disabled'), false)).toEqual({
      errorClass: 'auth',
      httpStatus: 403,
    });
  });

  test('an ordinary per-minute 429 that ends with a billing upsell link is a rate limit and not a spent quota', () => {
    const rateLimited =
      'Rate limit reached for model `some-model` in organization `org_x` on tokens per minute (TPM): Limit 6000, Used 5000, Requested 2000. Please try again in 10s. Need more tokens? Upgrade to Dev Tier today at https://provider.example/settings/billing';
    expect(classifyProviderError(apiError(429, rateLimited), false)).toEqual({
      errorClass: 'rate_limit',
      httpStatus: 429,
    });
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
    provider: 'zai',
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
    role: null,
    preset: null,
    costMicroUsd: null,
    firstTokenMs: null,
    generationMs: null,
    systemPromptTokens: null,
    toolCatalogTokens: null,
    historyTokens: null,
    userTokens: null,
    toolCount: null,
    messageCount: null,
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

describe('attempt rows carry role, preset and cost', () => {
  const scope = {
    chain: 'role:executor',
    purpose: 'agent',
    requestId: 'r1',
    role: 'executor',
    preset: 'deepseek41-flash',
  } as const;
  const tokens = { promptTokens: 1000, completionTokens: 500, reasoningTokens: null, cachedTokens: null };
  const OPENROUTER_DEEPSEEK = 'deepseek/deepseek-v4.1-flash';

  test('role and preset come from the slot, and a legacy slot has neither', () => {
    const row = answeredAttempt(scope, 'openrouter', OPENROUTER_DEEPSEEK, 5, 100, tokens);
    expect([row.chain, row.role, row.preset]).toEqual(['role:executor', 'executor', 'deepseek41-flash']);
    const legacy = answeredAttempt(
      { chain: 'smart', purpose: 'agent', requestId: undefined, role: null, preset: null },
      'zai',
      'm',
      5,
      100,
      null,
    );
    expect([legacy.chain, legacy.role, legacy.preset]).toEqual(['smart', null, null]);
  });

  test('the cost OpenRouter reported wins, converted from USD to micro-USD', () => {
    const row = answeredAttempt(scope, 'openrouter', OPENROUTER_DEEPSEEK, 5, 100, { ...tokens, costUsd: 0.000321 });
    expect(row.costMicroUsd).toBe(321);
  });

  test('a reported cost of zero is a known zero', () => {
    const row = answeredAttempt(scope, 'openrouter', OPENROUTER_DEEPSEEK, 5, 100, { ...tokens, costUsd: 0 });
    expect(row.costMicroUsd).toBe(0);
  });

  test('without a reported cost the dated price table prices a known route', () => {
    const row = answeredAttempt(scope, 'openrouter', OPENROUTER_DEEPSEEK, 5, 100, tokens);
    expect(row.costMicroUsd).toBe(900);
  });

  test.each([Number.NaN, -1, Number.POSITIVE_INFINITY])('an unusable reported cost (%p) is ignored', (costUsd) => {
    const row = answeredAttempt(scope, 'openrouter', 'unpriced/model', 5, 100, { ...tokens, costUsd });
    expect(row.costMicroUsd).toBeNull();
  });

  test('a route with no price and no reported cost is unknown, never zero', () => {
    expect(answeredAttempt(scope, 'claude', 'claude-haiku-5-5', 5, 100, tokens).costMicroUsd).toBeNull();
    expect(answeredAttempt(scope, 'openrouter', 'unpriced/model', 5, 100, tokens).costMicroUsd).toBeNull();
  });

  test('an answer without usage has an unknown cost', () => {
    expect(answeredAttempt(scope, 'openrouter', OPENROUTER_DEEPSEEK, 5, 100, null).costMicroUsd).toBeNull();
  });

  test('only OpenRouter is trusted to report a cost; another provider’s field is ignored', () => {
    const row = answeredAttempt(scope, 'zai', 'glm-5.1', 5, 100, { ...tokens, costUsd: 3 });
    expect(row.costMicroUsd).toBeNull();
  });

  test('a failed attempt that was billed carries its cost; a skipped one never does', () => {
    const failed = failedAttempt(
      scope,
      'openrouter',
      OPENROUTER_DEEPSEEK,
      5,
      100,
      { errorClass: 'empty', httpStatus: null },
      { ...tokens, costUsd: 0.0001 },
    );
    expect([failed.role, failed.preset, failed.costMicroUsd]).toEqual(['executor', 'deepseek41-flash', 100]);
    const skipped = skippedAttempt(scope, 'openrouter', OPENROUTER_DEEPSEEK, 'circuit_open');
    expect([skipped.role, skipped.preset, skipped.costMicroUsd]).toEqual(['executor', 'deepseek41-flash', null]);
  });
});

describe('attempt rows carry first-token and generation time', () => {
  const scope = { chain: 'smart', purpose: 'agent', requestId: undefined, role: null, preset: null } as const;
  const tokens = { promptTokens: 10, completionTokens: 20, reasoningTokens: null, cachedTokens: null };

  test('an answered attempt stores the measured times rounded to whole milliseconds', () => {
    const row = answeredAttempt(scope, 'claude', 'claude-haiku-5-5', 5, 900, tokens, {
      firstTokenMs: 612.4,
      generationMs: 287.6,
    });
    expect([row.firstTokenMs, row.generationMs]).toEqual([612, 288]);
  });

  test('an answer whose stream timing is unknown keeps both NULL, never 0', () => {
    const row = answeredAttempt(scope, 'claude', 'claude-haiku-5-5', 5, 900, tokens, {
      firstTokenMs: null,
      generationMs: null,
    });
    expect([row.firstTokenMs, row.generationMs]).toEqual([null, null]);
    const omitted = answeredAttempt(scope, 'claude', 'claude-haiku-5-5', 5, 900, tokens);
    expect([omitted.firstTokenMs, omitted.generationMs]).toEqual([null, null]);
  });

  test('a measured zero is kept as zero', () => {
    const row = answeredAttempt(scope, 'zai', 'm', 5, 900, tokens, { firstTokenMs: 0, generationMs: 0 });
    expect([row.firstTokenMs, row.generationMs]).toEqual([0, 0]);
  });

  test('failed and skipped attempts keep both NULL', () => {
    const failed = failedAttempt(scope, 'zai', 'm', 5, 100, { errorClass: 'empty', httpStatus: null }, tokens);
    const skipped = skippedAttempt(scope, 'zai', 'm', 'circuit_open');
    expect([failed.firstTokenMs, failed.generationMs, skipped.firstTokenMs, skipped.generationMs]).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });
});

describe('attempt rows carry the estimated prompt size', () => {
  const promptSize = {
    systemPromptTokens: 400,
    toolCatalogTokens: 9000,
    historyTokens: 1200,
    userTokens: 30,
    toolCount: 41,
    messageCount: 7,
  };
  const scope = {
    chain: 'smart',
    purpose: 'agent',
    requestId: undefined,
    role: null,
    preset: null,
    promptSize,
  } as const;
  const tokens = { promptTokens: 10600, completionTokens: 20, reasoningTokens: null, cachedTokens: null };

  test('answered and failed attempts carry the size of the round', () => {
    expect(answeredAttempt(scope, 'claude', 'm', 5, 900, tokens)).toMatchObject(promptSize);
    expect(failedAttempt(scope, 'claude', 'm', 5, 100, { errorClass: 'server', httpStatus: 503 }, null)).toMatchObject(
      promptSize,
    );
  });

  test('a skipped attempt sent no request and has no size', () => {
    expect(skippedAttempt(scope, 'claude', 'm', 'circuit_open')).toMatchObject({
      systemPromptTokens: null,
      toolCatalogTokens: null,
      historyTokens: null,
      userTokens: null,
      toolCount: null,
      messageCount: null,
    });
  });

  test('a scope that measured nothing leaves every component NULL', () => {
    const { promptSize: _unused, ...unmeasured } = scope;
    expect(answeredAttempt(unmeasured, 'claude', 'm', 5, 900, tokens)).toMatchObject({
      systemPromptTokens: null,
      toolCatalogTokens: null,
      historyTokens: null,
      userTokens: null,
      toolCount: null,
      messageCount: null,
    });
  });
});
