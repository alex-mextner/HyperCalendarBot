// test/services/ai/streaming-failover.test.ts
// Regression tests for the 2026-09-01 outage: Groq deleted both configured
// models, returned 404, and the chain ABORTED instead of falling through to a
// healthy Gemini. Also covers the model auto-detection path that keeps the bot
// alive when a provider deletes the model named in .env.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import OpenAI from 'openai';
import { resetModelRegistry } from '../../../src/services/ai/model-registry.ts';
import {
  configureProviderCircuit,
  providerCircuitClock,
  resetProviderCircuit,
} from '../../../src/services/ai/provider-circuit.ts';
import { resetEligibility } from '../../../src/services/ai/provider-eligibility.ts';
import {
  hasChainAnswered,
  initProviderAlerts,
  isAiChainDown,
  resetProviderAlertState,
} from '../../../src/utils/ai-provider-alert.ts';
import { resetLogOnce } from '../../../src/utils/logger.ts';

// ── Fake provider clients ──────────────────────────────────────────────────

type Behavior =
  | { kind: 'text'; text: string }
  | { kind: 'throw'; error: Error }
  /** Streams `text`, then dies — the provider failed after output reached the caller. */
  | { kind: 'partial-then-throw'; text: string; error: Error }
  /** Waits for `gate` before answering, so two requests can be in flight together. */
  | { kind: 'hold'; gate: Promise<void>; text: string };

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
            if (behavior.kind === 'hold') await behavior.gate;
            const text = behavior.text;
            const failAfterText = behavior.kind === 'partial-then-throw' ? behavior.error : null;
            async function* gen(): AsyncGenerator<StreamChunk> {
              yield { choices: [{ delta: { content: text }, finish_reason: null }] };
              if (failAfterText) throw failAfterText;
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
  resetProviderCircuit();
  providerClients.zai = () => asOpenAIClient(zai.client);
  providerClients.groq = () => asOpenAIClient(groq.client);
  providerClients.gemini = () => asOpenAIClient(gemini.client);
  providerClients.hf = () => asOpenAIClient(hf.client);
});

afterEach(() => {
  resetProviderCircuit();
  providerCircuitClock.now = () => Date.now();
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
  test.each([413, 429])('a size rejection %i benches only the requests that carry tools', async (sizeStatus) => {
    groq = makeProvider({
      behaviors: [
        { kind: 'throw', error: apiError(sizeStatus, 'Request too large ... tokens per minute (TPM): Limit 8000') },
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

  // A provider that reported a spent account is never forced: while every
  // circuit is open the round fails with skipped diagnostics instead of paying
  // four guaranteed rejections (this used to be "try them anyway").
  test('a chain where every account is depleted is not forced', async () => {
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
    const second = await aiStreamRound({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 }, {}).catch(
      (error: unknown) => error,
    );

    expect(second).toBeInstanceOf(AllProvidersFailedError);
    if (!(second instanceof AllProvidersFailedError)) throw new Error('unreachable');
    expect(second.failures).toHaveLength(4);
    expect(second.failures.every((f) => f.skippedBeforeRequest === true)).toBe(true);
    expect(second.roundMetrics.attemptCount).toBe(0);
    expect(zai.requestedModels).toHaveLength(1);
    expect(hf.requestedModels).toHaveLength(1);
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

describe('durable provider circuit', () => {
  const T0 = 1_700_000_000_000;
  const MINUTE = 60_000;
  let clock: number;
  let notices: string[];
  let stateDir: string;
  let statePath: string;

  function startAlertLayer(): void {
    resetProviderAlertState();
    initProviderAlerts({
      botToken: 't',
      adminId: 1,
      send: (html) => {
        notices.push(html);
      },
      now: () => clock,
    });
    clock += 2 * MINUTE; // past the alert layer's startup grace
  }

  const incidentNotices = (): string[] => notices.filter((m) => m.includes('Флаг снимается только'));

  beforeEach(() => {
    clock = T0;
    notices = [];
    stateDir = mkdtempSync(join(tmpdir(), 'circuit-streaming-'));
    statePath = join(stateDir, 'calendar.db.provider-state.sqlite');
    providerCircuitClock.now = () => clock;
    configureProviderCircuit(statePath);
    startAlertLayer();
    hf = unusedProvider();
  });

  afterEach(() => {
    resetProviderAlertState();
    rmSync(stateDir, { recursive: true, force: true });
  });

  test('two non-HF providers with different failures are skipped afterwards, one notice each', async () => {
    zai = makeProvider({ behaviors: [{ kind: 'throw', error: apiError(402, 'Payment Required') }] });
    groq = makeProvider({ behaviors: [{ kind: 'throw', error: apiError(401, 'Invalid API key') }] });
    gemini = makeProvider({ behaviors: [{ kind: 'text', text: 'from gemini' }] });

    await ask();
    await ask();
    const third = await ask();

    expect(third.text).toBe('from gemini');
    expect(zai.requestedModels).toHaveLength(1);
    expect(groq.requestedModels).toHaveLength(1);
    expect(gemini.requestedModels).toHaveLength(3);
    expect(incidentNotices()).toHaveLength(2);
  });

  test('a depleted account is skipped on the OTHER chain too', async () => {
    zai = makeProvider({ behaviors: [{ kind: 'throw', error: apiError(402, 'Payment Required') }] });
    gemini = makeProvider({ behaviors: [{ kind: 'text', text: 'from gemini' }] });
    groq = unusedProvider();

    await aiStreamRound({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100, fast: true });
    const smart = await ask();

    expect(smart.text).toBe('from gemini');
    expect(zai.requestedModels).toEqual(['glm-5.1-air']);
  });

  test('a restart does not repeat the notice or re-ask the provider', async () => {
    zai = makeProvider({ behaviors: [{ kind: 'throw', error: apiError(402, 'Payment Required') }] });
    gemini = makeProvider({ behaviors: [{ kind: 'text', text: 'from gemini' }] });
    groq = unusedProvider();
    await ask();
    expect(incidentNotices()).toHaveLength(1);

    resetProviderCircuit();
    configureProviderCircuit(statePath);
    startAlertLayer();
    await ask();

    expect(zai.requestedModels).toHaveLength(1);
    expect(incidentNotices()).toHaveLength(1);
  });

  test('only a successful probe closes the circuit, and the next incident notifies again', async () => {
    zai = makeProvider({
      behaviors: [
        { kind: 'throw', error: apiError(402, 'Payment Required') },
        { kind: 'text', text: 'from zai' },
        { kind: 'throw', error: apiError(402, 'Payment Required') },
      ],
    });
    gemini = makeProvider({ behaviors: [{ kind: 'text', text: 'from gemini' }] });
    groq = unusedProvider();

    await ask();
    clock += 24 * 60 * MINUTE;
    const probe = await ask();
    expect(probe.text).toBe('from zai');
    expect(zai.requestedModels).toHaveLength(2);

    clock += 30 * MINUTE;
    const again = await ask(); // closed now: zai is asked again and fails again
    expect(again.text).toBe('from gemini');
    expect(zai.requestedModels).toHaveLength(3);
    expect(incidentNotices()).toHaveLength(2);
  });

  test('only one of two simultaneous requests probes a half-open provider', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    zai = makeProvider({
      behaviors: [
        { kind: 'throw', error: apiError(402, 'Payment Required') },
        { kind: 'hold', gate, text: 'from zai' },
      ],
    });
    gemini = makeProvider({ behaviors: [{ kind: 'text', text: 'from gemini' }] });
    groq = unusedProvider();
    await ask();
    clock += 24 * 60 * MINUTE;

    const first = ask();
    const second = ask();
    release();
    const texts = (await Promise.all([first, second])).map((r) => r.text).sort();

    expect(texts).toEqual(['from gemini', 'from zai']);
    expect(zai.requestedModels).toHaveLength(2);
  });

  test('a provider dying mid-stream discards the partial output, opens its circuit and is not replayed', async () => {
    zai = makeProvider({
      behaviors: [{ kind: 'partial-then-throw', text: 'half an ans', error: apiError(402, 'Payment Required') }],
    });
    gemini = makeProvider({ behaviors: [{ kind: 'text', text: 'from gemini' }] });
    groq = unusedProvider();
    const events: string[] = [];
    const callbacks = {
      onTextDelta: (text: string) => events.push(`text:${text}`),
      onProviderSwitch: () => events.push('switch'),
    };

    const first = await aiStreamRound({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 }, callbacks);
    const second = await aiStreamRound({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 }, callbacks);

    expect(first.text).toBe('from gemini');
    expect(second.text).toBe('from gemini');
    expect(events).toEqual(['text:half an ans', 'switch', 'text:from gemini', 'text:from gemini']);
    expect(zai.requestedModels).toHaveLength(1);
    expect(gemini.requestedModels).toHaveLength(2);
    expect(incidentNotices()).toHaveLength(1);
  });

  test('skipped providers stay visible in telemetry and are not counted as attempts', async () => {
    process.env.AI_SMART_CHAIN = 'zai,gemini';
    zai = makeProvider({ behaviors: [{ kind: 'throw', error: apiError(402, 'Payment Required') }] });
    gemini = makeProvider({ behaviors: [{ kind: 'text', text: 'from gemini' }] });
    groq = unusedProvider();
    await ask();

    const result = await ask();

    expect(result.metrics?.skippedProviders).toEqual([{ provider: 'zai', model: 'glm-5.1' }]);
    expect(result.metrics?.failedProviders).toEqual([]);
    expect(result.metrics?.attemptCount).toBe(1);
  });

  test('a caller abort carrying a quota error does not open the circuit', async () => {
    zai = makeProvider({
      behaviors: [
        { kind: 'throw', error: apiError(402, 'Payment Required') },
        { kind: 'text', text: 'from zai' },
      ],
    });
    gemini = unusedProvider();
    groq = unusedProvider();
    const controller = new AbortController();
    controller.abort();

    await expect(
      aiStreamRound({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100, signal: controller.signal }),
    ).rejects.toBeDefined();
    const next = await ask();

    expect(next.text).toBe('from zai');
    expect(incidentNotices()).toHaveLength(0);
  });

  test('a per-request rejection does not poison the provider for unrelated requests', async () => {
    zai = makeProvider({
      behaviors: [
        { kind: 'throw', error: apiError(400, 'invalid tool schema') },
        { kind: 'throw', error: apiError(413, 'Request too large for this tier') },
        { kind: 'text', text: 'from zai' },
      ],
    });
    gemini = makeProvider({ behaviors: [{ kind: 'text', text: 'from gemini' }] });
    groq = unusedProvider();
    const tools = [{ type: 'function' as const, function: { name: 'get_events', description: 'x', parameters: {} } }];

    await ask();
    await aiStreamRound({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100, tools });
    const small = await ask();

    expect(small.text).toBe('from zai');
    expect(incidentNotices()).toHaveLength(0);
  });

  test('a rate-limit incident notifies once and is silently skipped afterward', async () => {
    zai = makeProvider({ behaviors: [{ kind: 'throw', error: apiError(429, 'Rate limit reached') }] });
    gemini = makeProvider({ behaviors: [{ kind: 'text', text: 'from gemini' }] });
    groq = unusedProvider();

    await ask();
    await ask();

    expect(incidentNotices()).toHaveLength(1);
    expect(zai.requestedModels).toHaveLength(1);
  });

  test('the incident notice never contains the provider error body', async () => {
    zai = makeProvider({ behaviors: [{ kind: 'throw', error: apiError(402, 'Payment Required SECRET-BODY-TEXT') }] });
    gemini = makeProvider({ behaviors: [{ kind: 'text', text: 'from gemini' }] });
    groq = unusedProvider();

    await ask();

    expect(incidentNotices()).toHaveLength(1);
    expect(notices.join('\n')).not.toContain('SECRET-BODY-TEXT');
  });
});

describe('provider order', () => {
  test('verified account limit reaches actual Groq request preflight', async () => {
    process.env.AI_SMART_CHAIN = 'groq,gemini';
    process.env.GROQ_MODEL = 'openai/gpt-oss-120b';
    process.env.GROQ_TPM_LIMITS = '{"openai/gpt-oss-120b":250000}';
    groq = makeProvider({ behaviors: [{ kind: 'text', text: 'large request admitted' }] });
    gemini = unusedProvider();
    hf = unusedProvider();
    zai = unusedProvider();
    const result = await aiStreamRound({ messages: [{ role: 'user', content: 'x'.repeat(50000) }], maxTokens: 200 });
    expect(result.text).toBe('large request admitted');
    expect(result.metrics?.attemptCount).toBe(1);
    expect(groq.requestedModels).toEqual(['openai/gpt-oss-120b']);
    expect(gemini.requestedModels).toEqual([]);
  });

  test('default main route starts with configured OSS120 without waiting on z.ai', async () => {
    delete process.env.AI_SMART_CHAIN;
    process.env.GROQ_MODEL = 'openai/gpt-oss-120b';
    groq = makeProvider({ behaviors: [{ kind: 'text', text: 'main reply' }] });
    gemini = unusedProvider();
    hf = unusedProvider();
    zai = unusedProvider();
    const result = await aiStreamRound({ messages: [{ role: 'user', content: 'synthetic request' }], maxTokens: 256 });
    expect(result.text).toBe('main reply');
    expect(result.metrics?.attemptCount).toBe(1);
    expect(groq.requestedModels).toEqual(['openai/gpt-oss-120b']);
    expect(zai.requestedModels).toEqual([]);
    expect(hf.requestedModels).toEqual([]);
  });
  test('default main failure falls directly to configured Gemini main, not its fast model', async () => {
    delete process.env.AI_SMART_CHAIN;
    groq = makeProvider({ behaviors: [{ kind: 'throw', error: apiError(503, 'unavailable') }] });
    gemini = makeProvider({ behaviors: [{ kind: 'text', text: 'main fallback' }] });
    zai = unusedProvider();
    hf = unusedProvider();
    const result = await aiStreamRound({ messages: [{ role: 'user', content: 'synthetic request' }], maxTokens: 256 });
    expect(result.text).toBe('main fallback');
    expect(result.metrics?.attemptCount).toBe(2);
    expect(gemini.requestedModels).toEqual(['gemini-main']);
    expect(zai.requestedModels).toEqual([]);
  });

  test('default main fallback still reaches HF before z.ai after both responsive providers fail', async () => {
    delete process.env.AI_SMART_CHAIN;
    groq = makeProvider({ behaviors: [{ kind: 'throw', error: apiError(503, 'synthetic groq unavailable') }] });
    gemini = makeProvider({ behaviors: [{ kind: 'throw', error: apiError(503, 'synthetic google unavailable') }] });
    hf = makeProvider({ behaviors: [{ kind: 'text', text: 'verified HF recovery' }] });
    zai = unusedProvider();
    const result = await aiStreamRound({ messages: [{ role: 'user', content: 'synthetic request' }], maxTokens: 256 });
    expect(result.text).toBe('verified HF recovery');
    expect(result.metrics?.attemptCount).toBe(3);
    expect(result.metrics?.chain).toBe('smart');
    expect(hf.requestedModels).toEqual(['hf-main']);
    expect(zai.requestedModels).toEqual([]);
  });
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
    hf = unusedProvider();
    zai = unusedProvider();
    gemini = makeProvider({ behaviors: [{ kind: 'text', text: 'from gemini' }] });
    groq = unusedProvider();

    const result = await aiStreamRound({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 }, {});

    expect(result.text).toBe('from gemini');
    expect(gemini.requestedModels).toEqual(['gemini-main']);
    expect(hf.requestedModels).toEqual([]);
    expect(zai.requestedModels).toEqual([]);
  });

  // Missing configured fast providers fall back to the short-call default, not smart order.
  test('the fast chain falls back to its own default order', async () => {
    process.env.AI_FAST_CHAIN = 'groq';
    process.env.GROQ_API_KEY = '';
    zai = unusedProvider();
    hf = unusedProvider();
    gemini = makeProvider({ behaviors: [{ kind: 'text', text: 'from gemini fast' }] });
    groq = unusedProvider();

    const result = await aiStreamRound({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100, fast: true }, {});

    expect(result.text).toBe('from gemini fast');
    expect(zai.requestedModels).toEqual([]);
    expect(gemini.requestedModels).toEqual(['gemini-fast']);
    expect(groq.requestedModels).toEqual([]);
  });

  test.each([
    '',
    '   ',
  ])('empty first Groq response %j falls through to the exact Gemini fast model', async (emptyText) => {
    delete process.env.AI_FAST_CHAIN;
    process.env.GROQ_FAST_MODEL = 'openai/gpt-oss-20b';
    groq = makeProvider({ behaviors: [{ kind: 'text', text: emptyText }] });
    gemini = makeProvider({ behaviors: [{ kind: 'text', text: 'verified fallback' }] });
    zai = unusedProvider();
    hf = unusedProvider();
    const result = await aiStreamRound({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 128, fast: true });
    expect(result.text).toBe('verified fallback');
    expect(groq.requestedModels).toEqual(['openai/gpt-oss-20b']);
    expect(gemini.requestedModels).toEqual(['gemini-fast']);
    expect(result.metrics?.attemptCount).toBe(2);
    expect(zai.requestedModels).toEqual([]);
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
    expect(result.metrics?.attemptCount).toBe(3); // z.ai quota + dead Groq model + replacement Groq request
    expect(result.metrics?.fallbackCount).toBe(1);
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

  function askOn(chain: 'smart' | 'fast', deferOutageAlert = false) {
    return aiStreamRound({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
      fast: chain === 'fast',
      deferOutageAlert,
    });
  }

  function everyProviderRejectsUnexposedTool(): void {
    const rejection = apiError(
      400,
      "Tool call validation failed: tool call validation failed: attempted to call tool 'create_event' which was not in request.tools",
    );
    zai = makeProvider({ behaviors: [{ kind: 'throw', error: rejection }] });
    groq = makeProvider({ behaviors: [{ kind: 'throw', error: rejection }] });
    gemini = makeProvider({ behaviors: [{ kind: 'throw', error: rejection }] });
    hf = makeProvider({ behaviors: [{ kind: 'throw', error: rejection }] });
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

  test('a smart round rejected only for an unexposed tool call leaves the bot ready when the caller recovers', async () => {
    everyProviderRejectsUnexposedTool();
    const error = await askOn('smart', true).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AllProvidersFailedError);
    if (!(error instanceof AllProvidersFailedError)) throw new Error('unreachable');
    expect(error.unexposedToolNames()).toEqual(['create_event']);
    expect(error.deferredAlertChain).toBe('smart');
    expect(isAiChainDown()).toBe(false);
  });

  test('a fast round rejected for an unexposed tool call hands the fast chain to the caller', async () => {
    everyProviderRejectsUnexposedTool();
    const error = await askOn('fast', true).catch((e: unknown) => e);
    if (!(error instanceof AllProvidersFailedError)) throw new Error('expected AllProvidersFailedError');
    expect(error.deferredAlertChain).toBe('fast');
  });

  test('a caller that does not recover unexposed tools still gets the outage alert', async () => {
    everyProviderRejectsUnexposedTool();
    const error = await askOn('smart').catch((e: unknown) => e);
    if (!(error instanceof AllProvidersFailedError)) throw new Error('expected AllProvidersFailedError');
    expect(error.deferredAlertChain).toBeUndefined();
    expect(isAiChainDown()).toBe(true);
  });

  test('a recovering caller still gets the outage alert when the failure is not an unexposed tool call', async () => {
    allProvidersDead();
    const error = await askOn('smart', true).catch((e: unknown) => e);
    if (!(error instanceof AllProvidersFailedError)) throw new Error('expected AllProvidersFailedError');
    expect(error.deferredAlertChain).toBeUndefined();
    expect(isAiChainDown()).toBe(true);
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

test('request-specific failure does not trigger an account incident from echoed text', async () => {
  const messages: string[] = [];
  initProviderAlerts({ botToken: 'synthetic', adminId: 1, send: (text) => messages.push(text), schedule: () => {} });
  process.env.AI_SMART_CHAIN = 'zai,gemini';
  zai = makeProvider({
    behaviors: [
      { kind: 'throw', error: apiError(400, 'Bad input text contains: payment required') },
      { kind: 'text', text: 'healthy next request' },
    ],
  });
  gemini = makeProvider({ behaviors: [{ kind: 'text', text: 'fallback' }] });
  const options = { messages: [{ role: 'user' as const, content: 'synthetic' }], maxTokens: 80 };
  expect((await aiStreamRound(options)).text).toBe('fallback');
  expect((await aiStreamRound(options)).text).toBe('healthy next request');
  expect(zai.requestedModels).toHaveLength(2);
  expect(messages).toHaveLength(0);
});
