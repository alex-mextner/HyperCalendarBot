// test/services/ai/streaming-failover.test.ts
// Regression tests for the 2026-09-01 outage: Groq deleted both configured
// models, returned 404, and the chain ABORTED instead of falling through to a
// healthy Gemini. Also covers the model auto-detection path that keeps the bot
// alive when a provider deletes the model named in .env.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import OpenAI from 'openai';
import { resetModelRegistry } from '../../../src/services/ai/model-registry.ts';

// ── Fake provider clients ──────────────────────────────────────────────────

type Behavior = { kind: 'text'; text: string } | { kind: 'throw'; error: Error };

interface FakeProvider {
  client: {
    chat: { completions: { create: (params: { model: string }) => Promise<AsyncIterable<StreamChunk>> } };
    models: { list: () => Promise<{ data: { id: string }[] }> };
  };
  /** Model id sent with each chat completion request, in order. */
  requestedModels: string[];
  modelsListCalls: number;
}

interface StreamToolCallDelta {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface StreamChunk {
  choices: { delta: { content?: string; tool_calls?: StreamToolCallDelta[] }; finish_reason: string | null }[];
}

interface FakeProviderOptions {
  /** One behavior per request; the last one repeats for further requests. */
  behaviors: Behavior[];
  /** Model ids returned by GET /v1/models. */
  liveModels?: string[];
  /** Make GET /v1/models reject. */
  modelsListError?: Error;
}

/**
 * The chain only ever touches `chat.completions.create` and `models.list`, so
 * the fakes implement just those. This is the one place the partial mock is
 * presented as a full client — the repo permits that cast only inside a
 * centralized factory, never inline at a call site.
 */
function asOpenAIClient(fake: FakeProvider['client']): OpenAI {
  return fake as unknown as OpenAI;
}

function makeProvider(options: FakeProviderOptions): FakeProvider {
  const provider: FakeProvider = {
    requestedModels: [],
    modelsListCalls: 0,
    client: {
      chat: {
        completions: {
          create: async (params: { model: string }) => {
            provider.requestedModels.push(params.model);
            const index = Math.min(provider.requestedModels.length - 1, options.behaviors.length - 1);
            const behavior = options.behaviors[index];
            if (!behavior) throw new Error('fake provider has no behavior scripted');
            if (behavior.kind === 'throw') throw behavior.error;
            const text = behavior.text;
            async function* gen(): AsyncGenerator<StreamChunk> {
              yield { choices: [{ delta: { content: text }, finish_reason: null }] };
              yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
            }
            return gen();
          },
        },
      },
      models: {
        list: async () => {
          provider.modelsListCalls += 1;
          if (options.modelsListError) throw options.modelsListError;
          return { data: (options.liveModels ?? []).map((id) => ({ id })) };
        },
      },
    },
  };
  return provider;
}

function unusedProvider(): FakeProvider {
  return makeProvider({ behaviors: [{ kind: 'throw', error: new Error('must not be called') }] });
}

function apiError(status: number, message: string, code?: string) {
  return new OpenAI.APIError(status, { error: { message, code } }, message, new Headers());
}

let zai: FakeProvider;
let groq: FakeProvider;
let gemini: FakeProvider;
let hf: FakeProvider;

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
    ZAI_MODEL: 'glm-5.1',
    ZAI_FAST_MODEL: 'glm-5.1-air',
    GROQ_API_KEY: 'test-groq-key',
    GROQ_MODEL: 'llama-3.3-70b-versatile',
    GROQ_FAST_MODEL: 'llama-3.1-8b-instant',
    GEMINI_API_KEY: 'gemini-key',
    GEMINI_BASE_URL: 'https://gemini.example/v1',
    GEMINI_MODEL: 'gemini-main',
    GEMINI_FAST_MODEL: 'gemini-fast',
    HF_TOKEN: 'hf-token',
    HF_BASE_URL: 'https://hf.example/v1',
    HF_MODEL: 'hf-main',
    HF_FAST_MODEL: 'hf-fast',
  });
  providerClients.zai = () => asOpenAIClient(zai.client);
  providerClients.groq = () => asOpenAIClient(groq.client);
  providerClients.gemini = () => asOpenAIClient(gemini.client);
  providerClients.hf = () => asOpenAIClient(hf.client);
});

afterEach(() => {
  process.env = { ...savedEnv };
  Object.assign(providerClients, realProviderClients);
});

const { AllProvidersFailedError, aiStreamRound } = await import('../../../src/services/ai/streaming.ts');

const ZAI_QUOTA = apiError(429, 'Weekly/Monthly Limit Exhausted, quota resets 2026-09-03');
const GROQ_MODEL_GONE = apiError(
  404,
  'The model `llama-3.3-70b-versatile` does not exist or you do not have access to it',
  'model_not_found',
);
const GROQ_HARMONY = apiError(400, 'failed to template request: HarmonyError: Tools should have a name!');

function ask() {
  return aiStreamRound({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 });
}

describe('aiStreamRound — one broken provider never kills the chain', () => {
  beforeEach(() => {
    resetModelRegistry();
    zai = makeProvider({ behaviors: [{ kind: 'throw', error: ZAI_QUOTA }] });
    groq = makeProvider({ behaviors: [{ kind: 'throw', error: GROQ_MODEL_GONE }] });
    gemini = makeProvider({ behaviors: [{ kind: 'text', text: 'answer from Gemini' }] });
    hf = unusedProvider();
  });

  test('regression: Groq 404 model_not_found does not abort — Gemini still answers', async () => {
    // 2026-09-01 outage: z.ai out of quota, Groq deleted the model, and the 404
    // propagated out of aiStreamRound, so healthy Gemini was never tried.
    const result = await ask();

    expect(result.text).toBe('answer from Gemini');
    expect(result.providerUsed).toContain('Gemini');
    expect(groq.requestedModels).toEqual(['llama-3.3-70b-versatile']);
    expect(hf.requestedModels).toEqual([]);
  });

  test('Groq 400 Harmony tool-template error falls through to the next provider', async () => {
    groq = makeProvider({ behaviors: [{ kind: 'throw', error: GROQ_HARMONY }] });

    const result = await ask();

    expect(result.text).toBe('answer from Gemini');
    // A tool-schema 400 is not a missing model — no /v1/models probe.
    expect(groq.modelsListCalls).toBe(0);
  });

  test('401 and 403 fall through instead of aborting the chain', async () => {
    zai = makeProvider({ behaviors: [{ kind: 'throw', error: apiError(401, 'Invalid API key') }] });
    groq = makeProvider({ behaviors: [{ kind: 'throw', error: apiError(403, 'Forbidden') }] });

    const result = await ask();

    expect(result.text).toBe('answer from Gemini');
  });

  test('every slot failing throws AllProvidersFailedError naming each provider and reason', async () => {
    gemini = makeProvider({ behaviors: [{ kind: 'throw', error: apiError(500, 'gemini overloaded') }] });
    hf = makeProvider({ behaviors: [{ kind: 'throw', error: apiError(503, 'hf unavailable') }] });

    const error = await ask().then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(AllProvidersFailedError);
    if (!(error instanceof AllProvidersFailedError)) throw new Error('expected AllProvidersFailedError');

    expect(error.failures.map((f) => f.status)).toEqual([429, 404, 500, 503]);
    expect(error.failures.map((f) => f.provider)).toEqual([
      'z.ai (glm-5.1)',
      'Groq (llama-3.3-70b-versatile)',
      'Gemini (gemini-main)',
      'HF (hf-main)',
    ]);
    expect(error.failures[0]?.message).toContain('Weekly/Monthly Limit Exhausted');
    expect(error.failures[3]?.message).toContain('hf unavailable');
    // The aggregate message alone must be enough to diagnose the outage.
    expect(error.message).toContain('Groq (llama-3.3-70b-versatile)');
    expect(error.message).toContain('Gemini (gemini-main)');
  });

  test('partial text from a dying provider is discarded and the next provider answers', async () => {
    zai = makeProvider({ behaviors: [{ kind: 'throw', error: new Error('connection closed') }] });
    groq = makeProvider({ behaviors: [{ kind: 'throw', error: GROQ_MODEL_GONE }] });
    // z.ai emits a delta before dying: simulate by scripting a stream that throws mid-iteration.
    zai.client.chat.completions.create = async (params: { model: string }) => {
      zai.requestedModels.push(params.model);
      async function* gen(): AsyncGenerator<StreamChunk> {
        yield { choices: [{ delta: { content: 'partial ' }, finish_reason: null }] };
        throw new Error('connection closed mid-stream');
      }
      return gen();
    };

    const deltas: string[] = [];
    let switched = 0;
    const result = await aiStreamRound(
      { messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 },
      {
        onTextDelta: (t) => deltas.push(t),
        onProviderSwitch: () => {
          switched += 1;
        },
      },
    );

    expect(result.text).toBe('answer from Gemini');
    expect(deltas).toEqual(['partial ', 'answer from Gemini']);
    expect(switched).toBe(1);
  });

  test('a provider that announced a tool call then died also triggers the partial-output reset', async () => {
    // The caller shows a "running <tool>" label as soon as onToolCallStart fires
    // (agent.ts: writer.setToolLabel). If that provider then dies, the label
    // belongs to a round that never happened and must be cleared like text is.
    zai.client.chat.completions.create = async (params: { model: string }) => {
      zai.requestedModels.push(params.model);
      async function* gen(): AsyncGenerator<StreamChunk> {
        yield {
          choices: [
            {
              delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_events', arguments: '{' } }] },
              finish_reason: null,
            },
          ],
        };
        throw new Error('connection closed mid-stream');
      }
      return gen();
    };

    const toolLabels: string[] = [];
    let switched = 0;
    const result = await aiStreamRound(
      { messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 },
      {
        onToolCallStart: (name) => toolLabels.push(name),
        onProviderSwitch: () => {
          switched += 1;
        },
      },
    );

    expect(toolLabels).toEqual(['get_events']);
    expect(result.text).toBe('answer from Gemini');
    expect(switched).toBe(1);
  });

  test('a caller-initiated abort propagates instead of burning the whole chain', async () => {
    const controller = new AbortController();
    controller.abort();
    zai = makeProvider({ behaviors: [{ kind: 'throw', error: apiError(500, 'irrelevant') }] });

    await expect(
      aiStreamRound({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100, signal: controller.signal }),
    ).rejects.toMatchObject({ status: 500 });

    expect(groq.requestedModels).toEqual([]);
  });

  test('a per-round timeout is not a caller abort — the chain keeps going', async () => {
    const timeoutSignal = AbortSignal.timeout(1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(timeoutSignal.aborted).toBe(true);

    const result = await aiStreamRound({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
      signal: timeoutSignal,
    });

    expect(result.text).toBe('answer from Gemini');
  });
});

describe('aiStreamRound — auto-detecting a live model', () => {
  beforeEach(() => {
    resetModelRegistry();
    zai = makeProvider({ behaviors: [{ kind: 'throw', error: ZAI_QUOTA }] });
    gemini = makeProvider({ behaviors: [{ kind: 'text', text: 'answer from Gemini' }] });
    hf = unusedProvider();
  });

  test('deleted Groq model → /v1/models probed → request retried on Groq and succeeds', async () => {
    groq = makeProvider({
      behaviors: [
        { kind: 'throw', error: GROQ_MODEL_GONE },
        { kind: 'text', text: 'answer from Groq' },
      ],
      liveModels: ['whisper-large-v3', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
    });

    const result = await ask();

    expect(result.text).toBe('answer from Groq');
    expect(result.providerUsed).toBe('Groq (openai/gpt-oss-120b)');
    expect(groq.requestedModels).toEqual(['llama-3.3-70b-versatile', 'openai/gpt-oss-120b']);
    expect(gemini.requestedModels).toEqual([]);
  });

  test('the resolved model is cached: the next request skips the dead model and the second probe', async () => {
    groq = makeProvider({
      behaviors: [
        { kind: 'throw', error: GROQ_MODEL_GONE },
        { kind: 'text', text: 'answer from Groq' },
      ],
      liveModels: ['openai/gpt-oss-120b'],
    });

    await ask();
    const second = await ask();

    expect(second.text).toBe('answer from Groq');
    expect(groq.requestedModels).toEqual([
      'llama-3.3-70b-versatile',
      'openai/gpt-oss-120b',
      'openai/gpt-oss-120b', // second request goes straight to the live model
    ]);
    expect(groq.modelsListCalls).toBe(1);
  });

  test('discovery failure degrades gracefully to the next provider', async () => {
    groq = makeProvider({
      behaviors: [{ kind: 'throw', error: GROQ_MODEL_GONE }],
      modelsListError: new Error('models endpoint unreachable'),
    });

    const result = await ask();

    expect(result.text).toBe('answer from Gemini');
    expect(groq.modelsListCalls).toBe(1);
    expect(groq.requestedModels).toEqual(['llama-3.3-70b-versatile']);
  });

  test('discovery finding nothing usable falls through to the next provider', async () => {
    groq = makeProvider({
      behaviors: [{ kind: 'throw', error: GROQ_MODEL_GONE }],
      liveModels: ['whisper-large-v3', 'playai-tts'],
    });

    const result = await ask();

    expect(result.text).toBe('answer from Gemini');
    expect(groq.requestedModels).toEqual(['llama-3.3-70b-versatile']);
  });

  test('a replacement that also dies triggers one re-probe, then falls through', async () => {
    groq = makeProvider({
      behaviors: [{ kind: 'throw', error: GROQ_MODEL_GONE }],
      liveModels: ['openai/gpt-oss-120b'],
    });

    await ask(); // caches openai/gpt-oss-120b, which also 404s → falls through to Gemini
    const result = await ask();

    expect(result.text).toBe('answer from Gemini');
    // First request: dead configured model + retry on the replacement.
    // Second request: straight to the cached replacement, then one forced re-probe.
    expect(groq.modelsListCalls).toBe(2);

    // The re-probe found only the model that just died, so Groq is recorded as
    // having nothing usable. Further requests must NOT probe /v1/models again —
    // otherwise a provider whose listing lies costs an extra HTTP round trip on
    // every single user message.
    await ask();
    await ask();
    expect(groq.modelsListCalls).toBe(2);
  });
});
