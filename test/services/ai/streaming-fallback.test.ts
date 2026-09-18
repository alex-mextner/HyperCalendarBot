// test/services/ai/streaming-fallback.test.ts
// Behavior tests for aiStreamRound: provider chain fallback, empty-response
// quirk, mid-stream error propagation. Fake providers are injected through the
// `providerClients` seam exported by streaming.ts, so no network is touched and
// no other test file is affected.

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import OpenAI from 'openai';

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
