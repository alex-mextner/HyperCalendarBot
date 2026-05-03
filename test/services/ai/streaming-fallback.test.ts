// test/services/ai/streaming-fallback.test.ts
// Behavior tests for aiStreamRound: provider chain fallback, empty-response
// quirk, mid-stream error propagation. Uses Bun's `mock.module` scoped to
// this file (cleaned up in afterAll) to replace the cached OpenAI clients
// inside streaming.ts without hitting the real network.

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import OpenAI from 'openai';

// Build a fake OpenAI client whose chat.completions.create returns a scripted
// async-iterable stream. Each script entry is one "round" the provider emits.
// Throwing entries simulate provider errors.
type ScriptEvent =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; name: string; args: string; index?: number }
  | { kind: 'finish'; reason: string };

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

mock.module('../../../src/services/ai/clients.ts', () => ({
  zaiClient: () => fakeZai,
  hfClient: () => fakeHf,
  geminiClient: () => fakeGemini,
  resetClients: () => {},
}));

// Stub env.ts so loadConfig() doesn't throw on missing vars
mock.module('../../../src/config/env.ts', () => ({
  loadConfig: () => ({
    ZAI_MODEL: 'zai-main',
    ZAI_FAST_MODEL: 'zai-fast',
    GEMINI_MODEL: 'gemini-main',
    GEMINI_FAST_MODEL: 'gemini-fast',
    HF_MODEL: 'hf-main',
    HF_FAST_MODEL: 'hf-fast',
  }),
}));

const { aiStreamRound } = await import('../../../src/services/ai/streaming.ts');

describe('aiStreamRound — provider chain fallback', () => {
  beforeEach(() => {
    fakeZai = undefined;
    fakeGemini = undefined;
    fakeHf = undefined;
  });

  afterEach(() => {
    // Each fake is recreated per test
  });

  test('returns Gemini result on first success', async () => {
    fakeGemini = buildFakeClient([
      { kind: 'text', text: 'hello from Gemini' },
      { kind: 'finish', reason: 'stop' },
    ]);
    fakeZai = buildFakeClient(() => {
      throw new Error('z.ai should not be called');
    });
    fakeHf = buildFakeClient(() => {
      throw new Error('hf should not be called');
    });

    const result = await aiStreamRound({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
    });

    expect(result.text).toBe('hello from Gemini');
    expect(result.providerUsed).toContain('Gemini');
    expect(fakeGemini.chat.completions.create).toHaveBeenCalledTimes(1);
    expect(fakeZai.chat.completions.create).not.toHaveBeenCalled();
  });

  test('falls through to z.ai on Gemini 500', async () => {
    const apiError = new OpenAI.APIError(500, { error: { message: 'overloaded' } }, 'server error', new Headers());
    fakeGemini = {
      chat: {
        completions: {
          create: mock(async () => {
            throw apiError;
          }),
        },
      },
    };
    fakeZai = buildFakeClient([
      { kind: 'text', text: 'hello from z.ai' },
      { kind: 'finish', reason: 'stop' },
    ]);
    fakeHf = buildFakeClient(() => {
      throw new Error('hf should not be called');
    });

    const result = await aiStreamRound({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
    });

    expect(result.text).toBe('hello from z.ai');
    expect(result.providerUsed).toContain('z.ai');
    expect(fakeGemini.chat.completions.create).toHaveBeenCalledTimes(1);
    expect(fakeZai.chat.completions.create).toHaveBeenCalledTimes(1);
  });

  test('falls through on EmptyProviderResponseError (Gemini coding endpoint quirk)', async () => {
    // Gemini returns 200 OK but no text and no tool calls — streaming adapter
    // should throw EmptyProviderResponseError and chain should try z.ai.
    fakeGemini = buildFakeClient([{ kind: 'finish', reason: 'stop' }]);
    fakeZai = buildFakeClient([
      { kind: 'text', text: 'z.ai to the rescue' },
      { kind: 'finish', reason: 'stop' },
    ]);
    fakeHf = buildFakeClient(() => {
      throw new Error('hf should not be called');
    });

    const result = await aiStreamRound({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
    });

    expect(result.text).toBe('z.ai to the rescue');
    expect(result.providerUsed).toContain('z.ai');
  });

  test('all three providers fail → throws last error', async () => {
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

    await expect(
      aiStreamRound({
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 100,
      }),
    ).rejects.toMatchObject({ status: 504 });
  });

  test('4xx with body propagates immediately without fallthrough', async () => {
    // A real 400 with an error body means the request is bad — don't try next provider.
    const badRequest = new OpenAI.APIError(400, { error: { message: 'bad input' } }, 'bad input', new Headers());
    fakeGemini = {
      chat: {
        completions: {
          create: mock(async () => {
            throw badRequest;
          }),
        },
      },
    };
    fakeZai = buildFakeClient(() => {
      throw new Error('z.ai should not be called');
    });
    fakeHf = buildFakeClient(() => {
      throw new Error('hf should not be called');
    });

    await expect(
      aiStreamRound({
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 100,
      }),
    ).rejects.toMatchObject({ status: 400 });

    expect(fakeZai.chat.completions.create).not.toHaveBeenCalled();
  });

  test('400 with no body falls through to next provider', async () => {
    // Gemini sometimes returns 400 with no body for transient issues — treat as retryable.
    const noBody = new OpenAI.APIError(400, undefined, '400 status code (no body)', new Headers());
    fakeGemini = {
      chat: {
        completions: {
          create: mock(async () => {
            throw noBody;
          }),
        },
      },
    };
    fakeZai = buildFakeClient([
      { kind: 'text', text: 'z.ai picked up' },
      { kind: 'finish', reason: 'stop' },
    ]);
    fakeHf = buildFakeClient(() => {
      throw new Error('hf should not be called');
    });

    const result = await aiStreamRound({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
    });

    expect(result.text).toBe('z.ai picked up');
    expect(fakeZai.chat.completions.create).toHaveBeenCalledTimes(1);
  });

  test('mid-stream failure after text emitted propagates, does NOT fall through', async () => {
    // Gemini starts streaming, then the iterator throws. Since text was already
    // sent to the user's Telegram message, we cannot switch providers.
    fakeGemini = {
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
    fakeZai = buildFakeClient(() => {
      throw new Error('z.ai should not be called');
    });
    fakeHf = buildFakeClient(() => {
      throw new Error('hf should not be called');
    });

    const deltas: string[] = [];
    await expect(
      aiStreamRound(
        {
          messages: [{ role: 'user', content: 'hi' }],
          maxTokens: 100,
        },
        { onTextDelta: (t) => deltas.push(t) },
      ),
    ).rejects.toThrow();

    expect(deltas).toEqual(['partial ']);
    expect(fakeZai.chat.completions.create).not.toHaveBeenCalled();
  });

  test('aggregates tool_calls across chunks even when provider omits index field', async () => {
    // HF Router / early Gemini historical bug: tool_call deltas arrive without `index`.
    // Without a fallback the Map collapses both chunks into the same slot.
    fakeGemini = {
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
    fakeZai = buildFakeClient(() => {
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
