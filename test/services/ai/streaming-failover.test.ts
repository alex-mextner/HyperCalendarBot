// test/services/ai/streaming-failover.test.ts
// Regression tests for the 2026-09-01 outage: Groq deleted both configured
// models, returned 404, and the chain ABORTED instead of falling through to a
// healthy Gemini. Also covers the model auto-detection path that keeps the bot
// alive when a provider deletes the model named in .env.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import OpenAI from 'openai';
import { resetModelRegistry } from '../../../src/services/ai/model-registry.ts';
import { resetEligibility } from '../../../src/services/ai/provider-eligibility.ts';
import {
  hasChainAnswered,
  initProviderAlerts,
  isAiChainDown,
  resetProviderAlertState,
} from '../../../src/utils/ai-provider-alert.ts';
import { resetLogOnce } from '../../../src/utils/logger.ts';

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
    // These tests are about what happens when a provider fails, not about which
    // one is tried first, so they pin the order rather than inherit the default
    // — which is configuration and will change again the next time a tier does.
    AI_SMART_CHAIN: 'zai,groq,gemini,hf',
    AI_FAST_CHAIN: 'zai,groq,gemini,hf',
  });
  resetLogOnce();
  resetEligibility();
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

  test('known-oversized Groq gpt-oss request is skipped before network dispatch', async () => {
    process.env.GROQ_MODEL = 'openai/gpt-oss-120b';
    groq = makeProvider({ behaviors: [{ kind: 'throw', error: new Error('Groq must not be called') }] });

    const result = await aiStreamRound({
      messages: [{ role: 'user', content: 'x'.repeat(50_000) }],
      maxTokens: 200,
    });

    expect(result.text).toBe('answer from Gemini');
    expect(groq.requestedModels).toEqual([]);
    expect(gemini.requestedModels).toEqual(['gemini-main']);
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

describe('benching a provider that said it is out', () => {
  beforeEach(() => {
    resetProviderAlertState();
    initProviderAlerts({ botToken: 't', adminId: 1, send: async () => {} });
  });

  afterEach(() => {
    resetProviderAlertState();
  });

  // The waste this exists to remove: z.ai answered 429 to every request for a
  // day, and the chain asked it again on every round of every message.
  test('a spent quota is not asked again on the next request', async () => {
    zai = makeProvider({
      behaviors: [{ kind: 'throw', error: apiError(429, 'Weekly/Monthly Limit Exhausted, resets tomorrow') }],
    });
    gemini = makeProvider({ behaviors: [{ kind: 'text', text: 'from gemini' }] });
    groq = unusedProvider();
    hf = unusedProvider();

    await aiStreamRound({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 }, {});
    await aiStreamRound({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 }, {});

    expect(zai.requestedModels).toHaveLength(1);
    expect(gemini.requestedModels).toHaveLength(2);
  });

  // Groq's tier cannot take a request carrying the tool catalog, but the short
  // summaries on the fast chain fit — benching it for everything would throw
  // away the one thing it is still good for.
  test('a size rejection benches only the requests that carry tools', async () => {
    groq = makeProvider({
      behaviors: [
        { kind: 'throw', error: apiError(413, 'Request too large ... tokens per minute (TPM): Limit 8000') },
        { kind: 'text', text: 'from groq' },
      ],
    });
    zai = makeProvider({ behaviors: [{ kind: 'throw', error: apiError(429, 'Rate limit reached') }] });
    gemini = makeProvider({ behaviors: [{ kind: 'text', text: 'from gemini' }] });
    hf = unusedProvider();
    process.env.AI_SMART_CHAIN = 'groq,gemini';

    const tools = [{ type: 'function' as const, function: { name: 'get_events', description: 'x', parameters: {} } }];
    await aiStreamRound({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100, tools }, {});
    const withTools = await aiStreamRound({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100, tools }, {});
    expect(withTools.text).toBe('from gemini');
    expect(groq.requestedModels).toHaveLength(1);

    const withoutTools = await aiStreamRound({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 }, {});
    expect(withoutTools.text).toBe('from groq');
  });

  // A memory of past failure must never turn into silence: if everything is
  // benched, everything is tried anyway.
  test('a chain where everything is benched is still attempted', async () => {
    const spent = apiError(429, 'Weekly/Monthly Limit Exhausted, resets tomorrow');
    zai = makeProvider({
      behaviors: [
        { kind: 'throw', error: spent },
        { kind: 'text', text: 'from zai' },
      ],
    });
    groq = makeProvider({ behaviors: [{ kind: 'throw', error: spent }] });
    gemini = makeProvider({ behaviors: [{ kind: 'throw', error: spent }] });
    hf = makeProvider({ behaviors: [{ kind: 'throw', error: spent }] });

    await aiStreamRound({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 }, {}).catch(() => null);
    const second = await aiStreamRound({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 }, {});

    expect(second.text).toBe('from zai');
  });

  // The bench suppresses calls, not observations: a chain that answers nobody
  // must still read as down.
  test('a benched chain still reports the outage', async () => {
    const spent = apiError(429, 'Weekly/Monthly Limit Exhausted, resets tomorrow');
    zai = makeProvider({ behaviors: [{ kind: 'throw', error: spent }] });
    groq = makeProvider({ behaviors: [{ kind: 'throw', error: spent }] });
    gemini = makeProvider({ behaviors: [{ kind: 'throw', error: spent }] });
    hf = makeProvider({ behaviors: [{ kind: 'throw', error: spent }] });

    await aiStreamRound({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 }, {}).catch(() => null);
    expect(isAiChainDown()).toBe(true);
  });
});

describe('provider order', () => {
  // The order is the whole point of the configuration: a provider that answers
  // 429 all week, or whose tier rejects every request of this size, must be
  // routed around without a deploy.
  test('tries providers in the configured order', async () => {
    process.env.AI_SMART_CHAIN = 'gemini,hf,zai,groq';
    gemini = makeProvider({ behaviors: [{ kind: 'throw', error: apiError(429, 'rate limited') }] });
    hf = makeProvider({ behaviors: [{ kind: 'text', text: 'from hf' }] });
    zai = unusedProvider();
    groq = unusedProvider();

    const result = await aiStreamRound({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 }, {});

    expect(result.text).toBe('from hf');
    expect(gemini.requestedModels).toEqual(['gemini-main']);
    expect(hf.requestedModels).toEqual(['hf-main']);
    expect(zai.requestedModels).toEqual([]);
  });

  // An order naming only unconfigured providers would leave the bot with
  // nothing to answer with, which is worse than ignoring the order — and the
  // fallback has to keep the preference the default order encodes, not the
  // order the provider ids happen to be declared in.
  test('an order naming nothing configured falls back to the default order', async () => {
    process.env.AI_SMART_CHAIN = 'groq';
    process.env.GROQ_API_KEY = '';
    hf = makeProvider({ behaviors: [{ kind: 'text', text: 'from hf' }] });
    zai = unusedProvider();
    gemini = unusedProvider();
    groq = unusedProvider();

    const result = await aiStreamRound({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 }, {});

    expect(result.text).toBe('from hf');
    expect(zai.requestedModels).toEqual([]);
  });

  // The fast chain has its own default for a reason — Groq is last there because
  // its empty 200s degrade summaries invisibly — so its fallback must be its own
  // order, not the smart one and not the order the ids happen to be declared in.
  test('the fast chain falls back to its own default order', async () => {
    process.env.AI_FAST_CHAIN = 'groq';
    process.env.GROQ_API_KEY = '';
    zai = makeProvider({ behaviors: [{ kind: 'text', text: 'from zai fast' }] });
    hf = unusedProvider();
    gemini = unusedProvider();
    groq = unusedProvider();

    const result = await aiStreamRound({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100, fast: true }, {});

    expect(result.text).toBe('from zai fast');
    expect(zai.requestedModels).toEqual(['glm-5.1-air']);
    expect(groq.requestedModels).toEqual([]);
  });

  // A name in the order is a preference, not a requirement: Groq is optional
  // configuration and the chain has to hold together without it.
  test('skips a provider that has no model configured', async () => {
    process.env.AI_SMART_CHAIN = 'groq,hf';
    process.env.GROQ_MODEL = '';
    hf = makeProvider({ behaviors: [{ kind: 'text', text: 'from hf' }] });
    zai = unusedProvider();
    groq = unusedProvider();
    gemini = unusedProvider();

    const result = await aiStreamRound({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 }, {});

    expect(result.text).toBe('from hf');
    expect(groq.requestedModels).toEqual([]);
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

// Everything the readiness signal does rests on one ternary in aiStreamRound
// deciding which chain a round belongs to. Invert it and a background
// summariser answering on the fast chain clears a real outage on the chain that
// talks to people — the 2026-09-01 blind spot, with every other test green.
describe('the chain a round runs on reaches the alert layer', () => {
  const DEAD = [{ kind: 'throw' as const, error: apiError(503, 'provider is down') }];

  function askOn(chain: 'smart' | 'fast') {
    return aiStreamRound({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100, fast: chain === 'fast' });
  }

  function allProvidersAnswer(): void {
    zai = makeProvider({ behaviors: [{ kind: 'text', text: 'answer' }] });
    groq = unusedProvider();
    gemini = unusedProvider();
    hf = unusedProvider();
  }

  function allProvidersDead(): void {
    zai = makeProvider({ behaviors: DEAD });
    groq = makeProvider({ behaviors: DEAD });
    gemini = makeProvider({ behaviors: DEAD });
    hf = makeProvider({ behaviors: DEAD });
  }

  beforeEach(() => {
    resetModelRegistry();
    resetProviderAlertState();
    initProviderAlerts({ botToken: 't', adminId: 1, send: async () => {} });
  });

  afterEach(() => {
    resetProviderAlertState();
  });

  test('a fast round answering is not proof a person can be served', async () => {
    allProvidersAnswer();
    await askOn('fast');
    expect(hasChainAnswered()).toBe(false);
  });

  test('a smart round answering is', async () => {
    allProvidersAnswer();
    await askOn('smart');
    expect(hasChainAnswered()).toBe(true);
  });

  test('a fast round failing everywhere leaves the bot ready', async () => {
    allProvidersDead();
    await expect(askOn('fast')).rejects.toThrow(AllProvidersFailedError);
    expect(isAiChainDown()).toBe(false);
  });

  test('a smart round failing everywhere makes the bot unready', async () => {
    allProvidersDead();
    await expect(askOn('smart')).rejects.toThrow(AllProvidersFailedError);
    expect(isAiChainDown()).toBe(true);
  });

  test('a fast round answering afterwards does not clear it', async () => {
    allProvidersDead();
    await expect(askOn('smart')).rejects.toThrow(AllProvidersFailedError);
    allProvidersAnswer();
    await askOn('fast');
    expect(isAiChainDown()).toBe(true);

    await askOn('smart');
    expect(isAiChainDown()).toBe(false);
  });
});
