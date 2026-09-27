// test/services/ai/streaming-fallback.test.ts
// Behavior tests for aiStreamRound: provider chain fallback, empty-response
// quirk, mid-stream error propagation. Fake providers are injected through the
// `providerClients` seam exported by streaming.ts, so no network is touched and
// no other test file is affected.

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import OpenAI from 'openai';
import { closeGeminiQuotaStores } from '../../../src/services/ai/gemini-quota.ts';

// Build a fake OpenAI client whose chat.completions.create returns a scripted
// async-iterable stream. Each script entry is one "round" the provider emits.
// Throwing entries simulate provider errors.
type ScriptEvent =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; name: string; args: string; index?: number }
  | { kind: 'finish'; reason: string }
  | { kind: 'usage'; prompt: number; completion: number; cached?: number; reasoning?: number };

function buildFakeClient(script: ScriptEvent[] | (() => never)) {
  if (typeof script === 'function') {
    return {
      chat: {
        completions: {
          create: mock(async () => {
            script();
            throw new Error('unreachable');
          }),
        },
      },
    };
  }

  const events = script;
  return {
    chat: {
      completions: {
        create: mock(async () => {
          // Yields one ChatCompletionChunk per scripted event. The shape mirrors
          // what the real SDK produces enough for the adapter loop to consume it.
          async function* gen() {
            for (const evt of events) {
              if (evt.kind === 'text') {
                yield { choices: [{ delta: { content: evt.text }, finish_reason: null }] };
              } else if (evt.kind === 'tool') {
                yield {
                  choices: [
                    {
                      delta: {
                        tool_calls: [
                          {
                            index: evt.index ?? 0,
                            id: evt.id,
                            function: { name: evt.name, arguments: evt.args },
                          },
                        ],
                      },
                      finish_reason: null,
                    },
                  ],
                };
              } else if (evt.kind === 'finish') {
                yield { choices: [{ delta: {}, finish_reason: evt.reason }] };
              } else if (evt.kind === 'usage') {
                yield {
                  choices: [],
                  usage: {
                    prompt_tokens: evt.prompt,
                    completion_tokens: evt.completion,
                    total_tokens: evt.prompt + evt.completion,
                    prompt_tokens_details: { cached_tokens: evt.cached ?? 0 },
                    completion_tokens_details: { reasoning_tokens: evt.reasoning ?? 0 },
                  },
                };
              }
            }
          }
          return gen();
        }),
      },
    },
  };
}

// biome-ignore lint/suspicious/noExplicitAny: fake client shapes vary per test
let fakeZai: any;
// biome-ignore lint/suspicious/noExplicitAny: same reason
let fakeGemini: any;
// biome-ignore lint/suspicious/noExplicitAny: same reason
let fakeHf: any;

// biome-ignore lint/suspicious/noExplicitAny: fake client shapes vary per test
let fakeGroq: any;

// Provider fakes are injected through the exported `providerClients` seam in
// streaming.ts, and provider models come from real environment variables read
// by loadConfig(). Deliberately NOT `mock.module`: that call is process-global
// and outlives this file, so it handed these fakes to whichever test file bun
// loaded next — which turned CI red in clients.test.ts on Linux while staying
// green on macOS, because directory order differs between the two filesystems.
const { providerClients } = await import('../../../src/services/ai/streaming.ts');
const realProviderClients = { ...providerClients };

const savedEnv = { ...process.env };

beforeEach(() => {
  // Env is set per test and restored after, so this file cannot change what
  // another test file sees. Every variable loadConfig() requires is listed
  // here: locally Bun auto-loads .env and hides a missing one, but CI has no
  // .env and loadConfig() throws.
  Object.assign(process.env, {
    BOT_TOKEN: 'test-token',
    REDIS_URL: 'redis://localhost:6379',
    ZAI_API_KEY: 'zai-key',
    ZAI_BASE_URL: 'https://zai.example/v1',
    ZAI_MODEL: 'zai-main',
    ZAI_FAST_MODEL: 'zai-fast',
    GROQ_API_KEY: '',
    GEMINI_API_KEY: 'gemini-key',
    GEMINI_BASE_URL: 'https://gemini.example/v1',
    GEMINI_MODEL: 'gemini-main',
    GEMINI_FAST_MODEL: 'gemini-fast',
    HF_TOKEN: 'hf-token',
    HF_BASE_URL: 'https://hf.example/v1',
    HF_MODEL: 'hf-main',
    HF_FAST_MODEL: 'hf-fast',
    // Pinned: these tests assert on the order failures come back in, which is
    // configuration and changes whenever a provider's tier does.
    AI_SMART_CHAIN: 'zai,groq,gemini,hf',
    AI_FAST_CHAIN: 'zai,groq,gemini,hf',
  });
  providerClients.zai = () => fakeZai;
  providerClients.groq = () => fakeGroq;
  providerClients.gemini = () => fakeGemini;
  providerClients.hf = () => fakeHf;
});

afterEach(() => {
  closeGeminiQuotaStores();
  process.env = { ...savedEnv };
  Object.assign(providerClients, realProviderClients);
});

const { AllProvidersFailedError, aiStreamRound, _resetStreamingUsageCompatibilityForTest } = await import(
  '../../../src/services/ai/streaming.ts'
);

describe('aiStreamRound — provider chain fallback', () => {
  beforeEach(() => {
    _resetStreamingUsageCompatibilityForTest();
    fakeZai = undefined;
    fakeGroq = undefined;
    fakeGemini = undefined;
    fakeHf = undefined;
  });

  afterEach(() => {
    // Each fake is recreated per test
  });

  test('a safety stop is explicit and is not retried through another provider', async () => {
    process.env.AI_SMART_CHAIN = 'gemini,hf';
    fakeGemini = buildFakeClient([{ kind: 'finish', reason: 'content_filter' }]);
    fakeHf = buildFakeClient([{ kind: 'text', text: 'must not bypass stop' }]);
    await expect(aiStreamRound({ messages: [], maxTokens: 128 })).rejects.toMatchObject({
      name: 'ProviderSafetyStopError',
    });
    expect(fakeHf.chat.completions.create).not.toHaveBeenCalled();
  });

  test('a structured refusal delta stops fallback without exposing refusal contents', async () => {
    process.env.AI_SMART_CHAIN = 'gemini,hf';
    fakeGemini = {
      chat: {
        completions: {
          create: mock(async () =>
            (async function* () {
              yield { choices: [{ delta: { refusal: 'PRIVATE_REFUSAL' }, finish_reason: 'stop' }] };
            })(),
          ),
        },
      },
    };
    fakeHf = buildFakeClient([{ kind: 'text', text: 'must not bypass refusal' }]);
    await expect(aiStreamRound({ messages: [], maxTokens: 128 })).rejects.toMatchObject({
      name: 'ProviderSafetyStopError',
    });
    expect(fakeHf.chat.completions.create).not.toHaveBeenCalled();
  });

  test.each([
    '{"expression":',
    '[]',
    'null',
  ])('invalid or non-object tool arguments cannot become executable output: %s', async (args) => {
    process.env.AI_SMART_CHAIN = 'gemini';
    fakeGemini = buildFakeClient([{ kind: 'tool', id: 'bad-args', name: 'calculate', args }]);
    await expect(aiStreamRound({ messages: [], maxTokens: 128 })).rejects.toMatchObject({
      failures: [{ emptyResponse: { classification: 'malformed_tools' } }],
    });
  });

  test('orphan argument fragments are diagnosed as malformed tool output', async () => {
    process.env.AI_SMART_CHAIN = 'gemini';
    fakeGemini = {
      chat: {
        completions: {
          create: mock(async () =>
            (async function* () {
              yield { choices: [{ delta: { tool_calls: [{ function: { arguments: '{}' } }] } }] };
            })(),
          ),
        },
      },
    };
    await expect(aiStreamRound({ messages: [], maxTokens: 128 })).rejects.toMatchObject({
      failures: [{ emptyResponse: { classification: 'malformed_tools', toolFragmentCount: 1 } }],
    });
  });

  test('an incomplete tool declaration is not accepted as usable output', async () => {
    process.env.AI_SMART_CHAIN = 'gemini';
    fakeGemini = buildFakeClient([{ kind: 'tool', id: 'incomplete', name: '', args: '{}' }]);
    await expect(aiStreamRound({ messages: [], maxTokens: 128 })).rejects.toMatchObject({
      failures: [{ emptyResponse: { classification: 'malformed_tools', toolFragmentCount: 1, choiceCount: 1 } }],
    });
  });

  test('no chunks and usage-only streams remain distinguishable diagnostics', async () => {
    process.env.AI_SMART_CHAIN = 'gemini';
    fakeGemini = buildFakeClient([]);
    await expect(aiStreamRound({ messages: [], maxTokens: 128 })).rejects.toMatchObject({
      failures: [{ emptyResponse: { classification: 'no_chunks', chunkCount: 0, choiceCount: 0, usage: null } }],
    });
    fakeGemini = buildFakeClient([{ kind: 'usage', prompt: 10, completion: 128, reasoning: 128 }]);
    await expect(aiStreamRound({ messages: [], maxTokens: 128 })).rejects.toMatchObject({
      failures: [{ emptyResponse: { classification: 'reasoning_only', chunkCount: 1, choiceCount: 0 } }],
    });
  });

  test('aborting a stalled iterator requests closure without awaiting a stuck return', async () => {
    const close = mock(() => new Promise<IteratorResult<OpenAI.ChatCompletionChunk>>(() => {}));
    fakeZai = {
      chat: {
        completions: {
          create: mock(async () => ({
            [Symbol.asyncIterator]() {
              return { next: () => new Promise<IteratorResult<OpenAI.ChatCompletionChunk>>(() => {}), return: close };
            },
          })),
        },
      },
    };
    fakeGemini = buildFakeClient([{ kind: 'text', text: 'fallback after cleanup' }]);
    const started = performance.now();
    const result = await aiStreamRound({ messages: [], maxTokens: 128, providerTimeoutMs: 20 });
    expect(result.text).toBe('fallback after cleanup');
    expect(close).toHaveBeenCalledTimes(1);
    expect(performance.now() - started).toBeLessThan(300);
  });

  test('retains a terminal finish reason without a delta', async () => {
    fakeZai = {
      chat: {
        completions: {
          create: mock(async () =>
            (async function* () {
              yield { choices: [{ delta: { content: 'partial' }, finish_reason: null }] };
              yield { choices: [{ finish_reason: 'length' }] };
            })(),
          ),
        },
      },
    };
    const result = await aiStreamRound({ messages: [{ role: 'user', content: 'synthetic' }], maxTokens: 128 });
    expect(result.finishReason).toBe('length');
  });
  test('preserves finish/usage/request shape of empty output without prompt content', async () => {
    process.env.AI_SMART_CHAIN = 'gemini';
    fakeGemini = {
      chat: {
        completions: {
          create: mock(async () =>
            (async function* () {
              yield { choices: [{ finish_reason: 'length' }] };
              yield {
                choices: [],
                usage: {
                  prompt_tokens: 40,
                  completion_tokens: 0,
                  total_tokens: 168,
                  completion_tokens_details: { reasoning_tokens: 128 },
                },
              };
            })(),
          ),
        },
      },
    };
    let failure: InstanceType<typeof AllProvidersFailedError> | undefined;
    try {
      await aiStreamRound({ messages: [{ role: 'user', content: 'PRIVATE_CANARY_DO_NOT_LOG' }], maxTokens: 128 });
    } catch (e) {
      if (e instanceof AllProvidersFailedError) failure = e;
      else throw e;
    }
    expect(failure?.failures[0]).toMatchObject({
      emptyResponse: {
        finishReason: 'length',
        maxOutputTokens: 128,
        chunkCount: 2,
        usage: { promptTokens: 40, completionTokens: 0, reasoningTokens: 128 },
      },
    });
    expect(JSON.stringify(failure?.failures)).not.toContain('PRIVATE_CANARY_DO_NOT_LOG');
  });
  test('a stalled response body times out and a healthy fallback finishes the same round', async () => {
    let firstSignal: AbortSignal | undefined;
    fakeZai = {
      chat: {
        completions: {
          create: mock(async (_params: unknown, opts: { signal: AbortSignal }) => {
            firstSignal = opts.signal;
            return (async function* () {
              await Bun.sleep(200);
              yield { choices: [{ delta: { content: 'too late' } }] };
            })();
          }),
        },
      },
    };
    fakeGemini = buildFakeClient([{ kind: 'text', text: 'fallback ready' }]);
    const visible: string[] = [];
    const result = await aiStreamRound(
      { messages: [{ role: 'user', content: 'synthetic' }], maxTokens: 128, providerTimeoutMs: 20 },
      { onTextDelta: (t) => visible.push(t) },
    );
    expect(result.text).toBe('fallback ready');
    expect(firstSignal?.aborted).toBe(true);
    await Bun.sleep(220);
    expect(visible.join('')).not.toContain('too late');
  });
  test('a completed shared deadline starts no provider request', async () => {
    const signal = AbortSignal.timeout(1);
    await Bun.sleep(5);
    fakeZai = buildFakeClient([{ kind: 'text', text: 'should not run' }]);
    await expect(aiStreamRound({ messages: [], maxTokens: 128, signal })).rejects.toThrow();
    expect(fakeZai.chat.completions.create).not.toHaveBeenCalled();
  });
  test('tiny fast Gemini 2.5 Flash calls disable thinking, but main calls keep their reasoning policy', async () => {
    process.env.AI_SMART_CHAIN = 'gemini';
    process.env.AI_FAST_CHAIN = 'gemini';
    process.env.GEMINI_FAST_MODEL = 'models/gemini-2.5-flash';
    fakeGemini = buildFakeClient([{ kind: 'text', text: 'ready' }]);
    await aiStreamRound({ messages: [], maxTokens: 256, fast: true });
    expect(fakeGemini.chat.completions.create.mock.calls[0][0].reasoning_effort).toBe('none');
    await aiStreamRound({ messages: [], maxTokens: 4096 });
    expect(fakeGemini.chat.completions.create.mock.calls[1][0].reasoning_effort).toBeUndefined();
  });

  test('Gemini local budget skips network rather than waiting when exhausted', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'hcb-quota-'));
    process.env.DATABASE_PATH = join(dir, 'calendar.db');
    process.env.GEMINI_RATE_LIMITS = JSON.stringify({ scope: 'fake-project', rpm: 1, tpm: 50000, rpd: 10 });
    process.env.AI_SMART_CHAIN = 'gemini,hf';
    fakeGemini = buildFakeClient([{ kind: 'text', text: 'gemini' }]);
    fakeHf = buildFakeClient([{ kind: 'text', text: 'reserve' }]);
    try {
      expect((await aiStreamRound({ messages: [], maxTokens: 128 })).text).toBe('gemini');
      expect((await aiStreamRound({ messages: [], maxTokens: 128 })).text).toBe('reserve');
      expect(fakeGemini.chat.completions.create).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('unavailable local quota storage skips without blaming Gemini or sending HTTP', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'hcb-bad-quota-'));
    process.env.DATABASE_PATH = join(dir, 'missing', 'calendar.db');
    process.env.GEMINI_RATE_LIMITS = JSON.stringify({ scope: 'fake-project', rpm: 1, tpm: 50000, rpd: 10 });
    process.env.AI_SMART_CHAIN = 'gemini,hf';
    fakeGemini = buildFakeClient([{ kind: 'text', text: 'must not call' }]);
    fakeHf = buildFakeClient([{ kind: 'text', text: 'reserve' }]);
    try {
      const result = await aiStreamRound({ messages: [], maxTokens: 128 });
      expect(result.text).toBe('reserve');
      expect(result.metrics?.attemptCount).toBe(1);
      expect(result.metrics?.failedProviders).toEqual([]);
      expect(result.metrics?.skippedProviders).toEqual([{ provider: 'gemini', model: 'gemini-main' }]);
      expect(fakeGemini.chat.completions.create).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns z.ai result on first success', async () => {
    fakeZai = buildFakeClient([
      { kind: 'text', text: 'hello from z.ai' },
      { kind: 'finish', reason: 'stop' },
    ]);
    fakeGemini = buildFakeClient(() => {
      throw new Error('gemini should not be called');
    });
    fakeHf = buildFakeClient(() => {
      throw new Error('hf should not be called');
    });

    const result = await aiStreamRound({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
    });

    expect(result.text).toBe('hello from z.ai');
    expect(result.providerUsed).toContain('z.ai');
    expect(fakeZai.chat.completions.create).toHaveBeenCalledTimes(1);
    expect(fakeGemini.chat.completions.create).not.toHaveBeenCalled();
  });

  test('captures terminal usage-only chunk and requests streaming usage', async () => {
    fakeZai = buildFakeClient([
      { kind: 'text', text: 'measured' },
      { kind: 'finish', reason: 'stop' },
      { kind: 'usage', prompt: 120, completion: 30, cached: 40, reasoning: 7 },
    ]);
    const result = await aiStreamRound({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 });
    expect(result.metrics?.usage).toEqual({
      promptTokens: 120,
      completionTokens: 30,
      totalTokens: 150,
      cachedTokens: 40,
      reasoningTokens: 7,
    });
    expect(result.metrics?.firstUsableSinceAttemptMs).toBeNumber();
    expect(fakeZai.chat.completions.create.mock.calls[0]?.[0]?.stream_options).toEqual({ include_usage: true });
  });

  test('retries same provider without usage telemetry when compatibility rejects stream_options', async () => {
    let calls = 0;
    fakeZai = {
      chat: {
        completions: {
          create: mock(async (params: { stream_options?: unknown }) => {
            calls++;
            if (params.stream_options) {
              throw new OpenAI.APIError(
                400,
                { error: { message: 'Unknown parameter: stream_options' } },
                'Unknown parameter: stream_options',
                new Headers(),
              );
            }
            return buildFakeClient([
              { kind: 'text', text: 'compat' },
              { kind: 'finish', reason: 'stop' },
            ]).chat.completions.create();
          }),
        },
      },
    };
    const first = await aiStreamRound({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 });
    expect(first.text).toBe('compat');
    expect(calls).toBe(2);
    expect(first.metrics?.attemptCount).toBe(2);
    expect(first.metrics?.fallbackCount).toBe(0);
    expect(first.metrics?.usage).toBeNull();
    const second = await aiStreamRound({ messages: [{ role: 'user', content: 'again' }], maxTokens: 100 });
    expect(second.text).toBe('compat');
    expect(calls).toBe(3);
    expect(second.metrics?.attemptCount).toBe(1);
    expect(fakeZai.chat.completions.create.mock.calls[2]?.[0]?.stream_options).toBeUndefined();
  });

  test('falls through to Gemini on z.ai 500', async () => {
    const apiError = new OpenAI.APIError(500, { error: { message: 'overloaded' } }, 'server error', new Headers());
    fakeZai = {
      chat: {
        completions: {
          create: mock(async () => {
            throw apiError;
          }),
        },
      },
    };
    fakeGemini = buildFakeClient([
      { kind: 'text', text: 'hello from Gemini' },
      { kind: 'finish', reason: 'stop' },
    ]);
    fakeHf = buildFakeClient(() => {
      throw new Error('hf should not be called');
    });

    const result = await aiStreamRound({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
    });

    expect(result.text).toBe('hello from Gemini');
    expect(result.providerUsed).toContain('Gemini');
    expect(fakeZai.chat.completions.create).toHaveBeenCalledTimes(1);
    expect(fakeGemini.chat.completions.create).toHaveBeenCalledTimes(1);
  });

  test('falls through on EmptyProviderResponseError (z.ai coding endpoint quirk)', async () => {
    // z.ai returns 200 OK but no text and no tool calls — streaming adapter
    // should throw EmptyProviderResponseError and chain should try Gemini.
    fakeZai = buildFakeClient([{ kind: 'finish', reason: 'stop' }]);
    fakeGemini = buildFakeClient([
      { kind: 'text', text: 'gemini to the rescue' },
      { kind: 'finish', reason: 'stop' },
    ]);
    fakeHf = buildFakeClient(() => {
      throw new Error('hf should not be called');
    });

    const result = await aiStreamRound({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
    });

    expect(result.text).toBe('gemini to the rescue');
    expect(result.metrics).toMatchObject({ failedProviders: [{ provider: 'zai', model: 'zai-main' }] });
    expect(result.providerUsed).toContain('Gemini');
  });

  test('all three providers fail → throws an aggregate naming every provider', async () => {
    const err500 = new OpenAI.APIError(500, { error: { message: 'boom' } }, 'boom', new Headers());
    const err503 = new OpenAI.APIError(503, { error: { message: 'down' } }, 'down', new Headers());
    const err504 = new OpenAI.APIError(504, { error: { message: 'gateway' } }, 'gateway', new Headers());
    fakeZai = {
      chat: {
        completions: {
          create: mock(async () => {
            throw err500;
          }),
        },
      },
    };
    fakeGemini = {
      chat: {
        completions: {
          create: mock(async () => {
            throw err503;
          }),
        },
      },
    };
    fakeHf = {
      chat: {
        completions: {
          create: mock(async () => {
            throw err504;
          }),
        },
      },
    };

    const error = await aiStreamRound({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(AllProvidersFailedError);
    if (!(error instanceof AllProvidersFailedError)) throw new Error('expected AllProvidersFailedError');
    expect(error.failures.map((f) => f.status)).toEqual([500, 503, 504]);
    expect(error.message).toContain('boom');
    expect(error.message).toContain('gateway');
    expect(error.roundMetrics.attemptCount).toBe(3);
    expect(error.roundMetrics.fallbackCount).toBe(2);
    expect(error.roundMetrics.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  test('4xx with a body falls through — one provider rejecting us never ends the chain', async () => {
    // A real 400 with an error body says THIS provider cannot serve the request
    // (bad tool template, unsupported parameter). Another provider still can, so
    // the chain must continue — treating it as fatal took the bot down on 2026-09-01.
    const badRequest = new OpenAI.APIError(400, { error: { message: 'bad input' } }, 'bad input', new Headers());
    fakeZai = {
      chat: {
        completions: {
          create: mock(async () => {
            throw badRequest;
          }),
        },
      },
    };
    fakeGemini = buildFakeClient([
      { kind: 'text', text: 'gemini answered anyway' },
      { kind: 'finish', reason: 'stop' },
    ]);
    fakeHf = buildFakeClient(() => {
      throw new Error('hf should not be called');
    });

    const result = await aiStreamRound({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
    });

    expect(result.text).toBe('gemini answered anyway');
    expect(fakeGemini.chat.completions.create).toHaveBeenCalledTimes(1);
  });

  test('400 with no body falls through to next provider', async () => {
    // Providers sometimes return 400 with no body for transient issues — treat as retryable.
    const noBody = new OpenAI.APIError(400, undefined, '400 status code (no body)', new Headers());
    fakeZai = {
      chat: {
        completions: {
          create: mock(async () => {
            throw noBody;
          }),
        },
      },
    };
    fakeGemini = buildFakeClient([
      { kind: 'text', text: 'gemini picked up' },
      { kind: 'finish', reason: 'stop' },
    ]);
    fakeHf = buildFakeClient(() => {
      throw new Error('hf should not be called');
    });

    const result = await aiStreamRound({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
    });

    expect(result.text).toBe('gemini picked up');
    expect(fakeGemini.chat.completions.create).toHaveBeenCalledTimes(1);
  });

  test('400 with no body is retried once on the same provider before falling through', async () => {
    // With every other provider depleted, one bodiless 400 must not fail the whole turn.
    const noBody = new OpenAI.APIError(400, undefined, '400 status code (no body)', new Headers());
    const recovered = buildFakeClient([
      { kind: 'text', text: 'zai recovered' },
      { kind: 'finish', reason: 'stop' },
    ]);
    let calls = 0;
    fakeZai = {
      chat: {
        completions: {
          create: mock(async (...args: unknown[]) => {
            calls++;
            if (calls === 1) throw noBody;
            return recovered.chat.completions.create(...(args as []));
          }),
        },
      },
    };
    fakeGemini = buildFakeClient(() => {
      throw new Error('gemini should not be called');
    });
    fakeHf = buildFakeClient(() => {
      throw new Error('hf should not be called');
    });

    const result = await aiStreamRound({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
    });

    expect(result.text).toBe('zai recovered');
    expect(calls).toBe(2);
    expect(fakeGemini.chat.completions.create).not.toHaveBeenCalled();
  });

  test('retries a second empty 400 only once, then falls through', async () => {
    const noBody = new OpenAI.APIError(400, undefined, '400 status code (no body)', new Headers());
    fakeZai = {
      chat: {
        completions: {
          create: mock(async () => {
            throw noBody;
          }),
        },
      },
    };
    fakeGemini = buildFakeClient([
      { kind: 'text', text: 'gemini fallback' },
      { kind: 'finish', reason: 'stop' },
    ]);
    fakeHf = buildFakeClient(() => {
      throw new Error('hf should not be called');
    });
    const result = await aiStreamRound({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 });
    expect(result.text).toBe('gemini fallback');
    expect(fakeZai.chat.completions.create).toHaveBeenCalledTimes(2);
    expect(fakeGemini.chat.completions.create).toHaveBeenCalledTimes(1);
    expect(fakeHf.chat.completions.create).not.toHaveBeenCalled();
    expect(result.metrics?.attemptCount).toBe(3); // z.ai twice + Gemini once
  });

  test('caller abort never triggers the empty-400 retry', async () => {
    const controller = new AbortController();
    controller.abort();
    const noBody = new OpenAI.APIError(400, undefined, '400 status code (no body)', new Headers());
    fakeZai = {
      chat: {
        completions: {
          create: mock(async () => {
            throw noBody;
          }),
        },
      },
    };
    fakeGemini = buildFakeClient(() => {
      throw new Error('gemini should not be called');
    });
    fakeHf = buildFakeClient(() => {
      throw new Error('hf should not be called');
    });
    await expect(
      aiStreamRound({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100, signal: controller.signal }),
    ).rejects.toThrow();
    expect(fakeZai.chat.completions.create).toHaveBeenCalledTimes(0);
    expect(fakeGemini.chat.completions.create).not.toHaveBeenCalled();
    expect(fakeHf.chat.completions.create).not.toHaveBeenCalled();
  });

  test('a normal 400 body mentioning no body is not retried', async () => {
    const body = new OpenAI.APIError(
      400,
      { error: { message: 'not a no body retry' } },
      '400 no body mentioned',
      new Headers(),
    );
    fakeZai = {
      chat: {
        completions: {
          create: mock(async () => {
            throw body;
          }),
        },
      },
    };
    fakeGemini = buildFakeClient([
      { kind: 'text', text: 'normal fallback' },
      { kind: 'finish', reason: 'stop' },
    ]);
    fakeHf = buildFakeClient(() => {
      throw new Error('hf should not be called');
    });
    const result = await aiStreamRound({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 });
    expect(result.text).toBe('normal fallback');
    expect(fakeZai.chat.completions.create).toHaveBeenCalledTimes(1);
    expect(fakeGemini.chat.completions.create).toHaveBeenCalledTimes(1);
  });

  test('mid-stream failure after text emitted discards the partial text and falls through', async () => {
    // z.ai starts streaming, then the iterator throws. The partial text already
    // shown to the user is discarded via onProviderSwitch and the next provider
    // answers from scratch — a half-sent sentence is not a reason to fail the turn.
    fakeZai = {
      chat: {
        completions: {
          create: mock(async () => {
            async function* gen() {
              yield { choices: [{ delta: { content: 'partial ' }, finish_reason: null }] };
              throw new Error('connection closed');
            }
            return gen();
          }),
        },
      },
    };
    fakeGemini = buildFakeClient([
      { kind: 'text', text: 'full answer from Gemini' },
      { kind: 'finish', reason: 'stop' },
    ]);
    fakeHf = buildFakeClient(() => {
      throw new Error('hf should not be called');
    });

    const deltas: string[] = [];
    let switched = 0;
    const result = await aiStreamRound(
      {
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 100,
      },
      {
        onTextDelta: (t) => deltas.push(t),
        onProviderSwitch: () => {
          switched += 1;
        },
      },
    );

    expect(result.text).toBe('full answer from Gemini');
    expect(deltas).toEqual(['partial ', 'full answer from Gemini']);
    expect(switched).toBe(1);
  });

  test('aggregates tool_calls across chunks even when provider omits index field', async () => {
    // HF Router / early Gemini historical bug: tool_call deltas arrive without `index`.
    // Without a fallback the Map collapses both chunks into the same slot.
    fakeZai = {
      chat: {
        completions: {
          create: mock(async () => {
            async function* gen() {
              // First tool call: arrives as two chunks, no index
              yield {
                choices: [
                  {
                    delta: {
                      tool_calls: [{ id: 'call_a', function: { name: 'get_events', arguments: '{"d' } }],
                    },
                    finish_reason: null,
                  },
                ],
              };
              yield {
                choices: [
                  {
                    delta: {
                      tool_calls: [{ function: { arguments: 'ate":"2026-04-10"}' } }],
                    },
                    finish_reason: null,
                  },
                ],
              };
              yield { choices: [{ delta: {}, finish_reason: 'tool_calls' }] };
            }
            return gen();
          }),
        },
      },
    };
    fakeGemini = buildFakeClient(() => {
      throw new Error('unreachable');
    });
    fakeHf = buildFakeClient(() => {
      throw new Error('unreachable');
    });

    const result = await aiStreamRound({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_events',
            description: 'stub',
            parameters: { type: 'object', properties: {}, required: [] },
          },
        },
      ],
    });

    // Both chunks concatenated into one tool call
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.name).toBe('get_events');
    expect(result.toolCalls[0]!.arguments).toBe('{"date":"2026-04-10"}');
  });
});
