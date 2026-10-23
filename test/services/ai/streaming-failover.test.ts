// test/services/ai/streaming-failover.test.ts
// Regression tests for the 2026-09-01 outage: a provider deleted both configured
// models, returned 404, and the chain ABORTED instead of falling through to a
// healthy Claude. Also covers the model auto-detection path that keeps the bot
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
  | { kind: 'hold'; gate: Promise<void>; text: string }
  /** Streams each part as its own chunk (text, or fragments of one tool call's arguments), counting what was read. */
  | { kind: 'chunks'; parts: string[]; served: { count: number }; toolName?: string };

/** The request fields these tests read. */
interface FakeRequest {
  model: string;
  temperature?: number;
  max_tokens?: number;
  reasoning_effort?: string;
  thinking?: unknown;
}

interface FakeProvider {
  client: {
    chat: {
      completions: { create: (params: FakeRequest) => Promise<AsyncIterable<StreamChunk>> };
    };
    models: { list: () => Promise<{ data: { id: string }[] }> };
  };
  /** Model id sent with each chat completion request, in order. */
  requestedModels: string[];
  /** Every chat completion request, in order. */
  requests: FakeRequest[];
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
    requests: [],
    modelsListCalls: 0,
    client: {
      chat: {
        completions: {
          create: async (params: FakeRequest) => {
            provider.requestedModels.push(params.model);
            provider.requests.push(params);
            const index = Math.min(provider.requestedModels.length - 1, options.behaviors.length - 1);
            const behavior = options.behaviors[index];
            if (!behavior) throw new Error('fake provider has no behavior scripted');
            if (behavior.kind === 'throw') throw behavior.error;
            if (behavior.kind === 'hold') await behavior.gate;
            if (behavior.kind === 'chunks') {
              const { parts, served, toolName } = behavior;
              async function* chunks(): AsyncGenerator<StreamChunk> {
                for (const [index, part] of parts.entries()) {
                  served.count += 1;
                  const delta = toolName
                    ? {
                        tool_calls: [
                          index === 0
                            ? { index: 0, id: 'call_1', function: { name: toolName, arguments: part } }
                            : { index: 0, function: { arguments: part } },
                        ],
                      }
                    : { content: part };
                  yield { choices: [{ delta, finish_reason: null }] };
                }
                yield { choices: [{ delta: {}, finish_reason: toolName ? 'tool_calls' : 'stop' }] };
              }
              return chunks();
            }
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
let hf: FakeProvider;
let claude: FakeProvider;

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
    CLAUDE_API_TOKEN: 'claude-key',
    CLAUDE_MODEL: 'claude-main',
    CLAUDE_FAST_MODEL: 'claude-fast',
    HF_TOKEN: 'hf-token',
    HF_BASE_URL: 'https://hf.example/v1',
    HF_MODEL: 'hf-main',
    HF_FAST_MODEL: 'hf-fast',
    // These tests are about what happens when a provider fails, not about which
    // one is tried first, so they pin the order rather than inherit the default
    // — which is configuration and will change again the next time a tier does.
    AI_SMART_CHAIN: 'zai,hf,claude',
    AI_FAST_CHAIN: 'zai,hf,claude',
  });
  resetLogOnce();
  resetEligibility();
  resetProviderCircuit();
  providerClients.zai = () => asOpenAIClient(zai.client);
  providerClients.hf = () => asOpenAIClient(hf.client);
  claude = unusedProvider();
  providerClients.claude = () => asOpenAIClient(claude.client);
});

afterEach(() => {
  resetProviderCircuit();
  providerCircuitClock.now = () => Date.now();
  process.env = { ...savedEnv };
  Object.assign(providerClients, realProviderClients);
});

const { AllProvidersFailedError, aiStreamRound } = await import('../../../src/services/ai/streaming.ts');

const ZAI_QUOTA = apiError(429, 'Weekly/Monthly Limit Exhausted, quota resets 2026-09-03');
const MODEL_GONE = apiError(
  404,
  'The model `hf-main` does not exist or you do not have access to it',
  'model_not_found',
);

function ask() {
  return aiStreamRound({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 });
}

describe('aiStreamRound — one broken provider never kills the chain', () => {
  beforeEach(() => {
    resetModelRegistry();
    zai = makeProvider({ behaviors: [{ kind: 'throw', error: ZAI_QUOTA }] });
    hf = makeProvider({ behaviors: [{ kind: 'throw', error: MODEL_GONE }] });
    claude = makeProvider({ behaviors: [{ kind: 'text', text: 'answer from Claude' }] });
  });

  test('regression: 404 model_not_found does not abort — Claude still answers', async () => {
    // 2026-09-01 outage: z.ai out of quota, another provider deleted the model, and the 404
    // propagated out of aiStreamRound, so healthy Claude was never tried.
    const result = await ask();

    expect(result.text).toBe('answer from Claude');
    expect(result.providerUsed).toContain('Claude');
    expect(hf.requestedModels).toEqual(['hf-main']);
  });

  test('401 and 403 fall through instead of aborting the chain', async () => {
    zai = makeProvider({ behaviors: [{ kind: 'throw', error: apiError(401, 'Invalid API key') }] });
    hf = makeProvider({ behaviors: [{ kind: 'throw', error: apiError(403, 'Forbidden') }] });

    const result = await ask();

    expect(result.text).toBe('answer from Claude');
  });

  test('every slot failing throws AllProvidersFailedError naming each provider and reason', async () => {
    claude = makeProvider({ behaviors: [{ kind: 'throw', error: apiError(500, 'claude overloaded') }] });

    const error = await ask().then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(AllProvidersFailedError);
    if (!(error instanceof AllProvidersFailedError)) throw new Error('expected AllProvidersFailedError');

    expect(error.failures.map((f) => f.status)).toEqual([429, 404, 500]);
    expect(error.failures.map((f) => f.provider)).toEqual(['z.ai (glm-5.1)', 'HF (hf-main)', 'Claude (claude-main)']);
    expect(error.failures[0]?.message).toContain('Weekly/Monthly Limit Exhausted');
    expect(error.failures[2]?.message).toContain('claude overloaded');
    // The aggregate message alone must be enough to diagnose the outage.
    expect(error.message).toContain('HF (hf-main)');
    expect(error.message).toContain('Claude (claude-main)');
  });

  test('partial text from a dying provider is discarded and the next provider answers', async () => {
    zai = makeProvider({ behaviors: [{ kind: 'throw', error: new Error('connection closed') }] });
    hf = makeProvider({ behaviors: [{ kind: 'throw', error: MODEL_GONE }] });
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

    expect(result.text).toBe('answer from Claude');
    expect(deltas).toEqual(['partial ', 'answer from Claude']);
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
    expect(result.text).toBe('answer from Claude');
    expect(switched).toBe(1);
  });

  test('a caller-initiated abort propagates instead of burning the whole chain', async () => {
    const controller = new AbortController();
    controller.abort();
    zai = makeProvider({ behaviors: [{ kind: 'throw', error: apiError(500, 'irrelevant') }] });

    await expect(
      aiStreamRound({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(hf.requestedModels).toEqual([]);
  });

  test('an exhausted caller deadline cannot start another provider', async () => {
    const signal = AbortSignal.timeout(1);
    await Bun.sleep(5);
    await expect(aiStreamRound({ messages: [], maxTokens: 100, signal })).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    expect(claude.requestedModels).toEqual([]);
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
    claude = makeProvider({ behaviors: [{ kind: 'text', text: 'from claude' }] });
    hf = unusedProvider();

    await aiStreamRound({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 }, {});
    await aiStreamRound({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 }, {});

    expect(zai.requestedModels).toHaveLength(1);
    expect(claude.requestedModels).toHaveLength(2);
  });

  // A provider's tier may not take a request carrying the tool catalog, but the short
  // summaries on the fast chain fit — benching it for everything would throw
  // away the one thing it is still good for.
  test.each([413, 429])('a size rejection %i benches only the requests that carry tools', async (sizeStatus) => {
    hf = makeProvider({
      behaviors: [
        { kind: 'throw', error: apiError(sizeStatus, 'Request too large ... tokens per minute (TPM): Limit 8000') },
        { kind: 'text', text: 'from hf' },
      ],
    });
    zai = makeProvider({ behaviors: [{ kind: 'throw', error: apiError(429, 'Rate limit reached') }] });
    claude = makeProvider({ behaviors: [{ kind: 'text', text: 'from claude' }] });
    process.env.AI_SMART_CHAIN = 'hf,claude';

    const tools = [{ type: 'function' as const, function: { name: 'get_events', description: 'x', parameters: {} } }];
    await aiStreamRound({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100, tools }, {});
    const withTools = await aiStreamRound({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100, tools }, {});
    expect(withTools.text).toBe('from claude');
    expect(hf.requestedModels).toHaveLength(1);

    const withoutTools = await aiStreamRound({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 }, {});
    expect(withoutTools.text).toBe('from hf');
  });

  // A provider that reported a spent account is never forced: while every
  // circuit is open the round fails with skipped diagnostics instead of paying
  // three guaranteed rejections (this used to be "try them anyway").
  test('a chain where every account is depleted is not forced', async () => {
    const spent = apiError(429, 'Weekly/Monthly Limit Exhausted, resets tomorrow');
    zai = makeProvider({
      behaviors: [
        { kind: 'throw', error: spent },
        { kind: 'text', text: 'from zai' },
      ],
    });
    hf = makeProvider({ behaviors: [{ kind: 'throw', error: spent }] });
    claude = makeProvider({ behaviors: [{ kind: 'throw', error: spent }] });

    await aiStreamRound({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 }, {}).catch(() => null);
    const second = await aiStreamRound({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 }, {}).catch(
      (error: unknown) => error,
    );

    expect(second).toBeInstanceOf(AllProvidersFailedError);
    if (!(second instanceof AllProvidersFailedError)) throw new Error('unreachable');
    expect(second.failures).toHaveLength(3);
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
    claude = makeProvider({ behaviors: [{ kind: 'throw', error: spent }] });
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

  test('two providers with different failures are skipped afterwards, one notice each', async () => {
    zai = makeProvider({ behaviors: [{ kind: 'throw', error: apiError(402, 'Payment Required') }] });
    hf = makeProvider({ behaviors: [{ kind: 'throw', error: apiError(401, 'Invalid API key') }] });
    claude = makeProvider({ behaviors: [{ kind: 'text', text: 'from claude' }] });

    await ask();
    await ask();
    const third = await ask();

    expect(third.text).toBe('from claude');
    expect(zai.requestedModels).toHaveLength(1);
    expect(hf.requestedModels).toHaveLength(1);
    expect(claude.requestedModels).toHaveLength(3);
    expect(incidentNotices()).toHaveLength(2);
  });

  test('a depleted account is skipped on the OTHER chain too', async () => {
    zai = makeProvider({ behaviors: [{ kind: 'throw', error: apiError(402, 'Payment Required') }] });
    claude = makeProvider({ behaviors: [{ kind: 'text', text: 'from claude' }] });

    await aiStreamRound({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100, fast: true });
    const smart = await ask();

    expect(smart.text).toBe('from claude');
    expect(zai.requestedModels).toEqual(['glm-5.1-air']);
  });

  test('a restart does not repeat the notice or re-ask the provider', async () => {
    zai = makeProvider({ behaviors: [{ kind: 'throw', error: apiError(402, 'Payment Required') }] });
    claude = makeProvider({ behaviors: [{ kind: 'text', text: 'from claude' }] });
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
    claude = makeProvider({ behaviors: [{ kind: 'text', text: 'from claude' }] });

    await ask();
    clock += 24 * 60 * MINUTE;
    const probe = await ask();
    expect(probe.text).toBe('from zai');
    expect(zai.requestedModels).toHaveLength(2);

    clock += 30 * MINUTE;
    const again = await ask(); // closed now: zai is asked again and fails again
    expect(again.text).toBe('from claude');
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
    claude = makeProvider({ behaviors: [{ kind: 'text', text: 'from claude' }] });
    await ask();
    clock += 24 * 60 * MINUTE;

    const first = ask();
    const second = ask();
    release();
    const texts = (await Promise.all([first, second])).map((r) => r.text).sort();

    expect(texts).toEqual(['from claude', 'from zai']);
    expect(zai.requestedModels).toHaveLength(2);
  });

  test('a provider dying mid-stream discards the partial output, opens its circuit and is not replayed', async () => {
    zai = makeProvider({
      behaviors: [{ kind: 'partial-then-throw', text: 'half an ans', error: apiError(402, 'Payment Required') }],
    });
    claude = makeProvider({ behaviors: [{ kind: 'text', text: 'from claude' }] });
    const events: string[] = [];
    const callbacks = {
      onTextDelta: (text: string) => events.push(`text:${text}`),
      onProviderSwitch: () => events.push('switch'),
    };

    const first = await aiStreamRound({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 }, callbacks);
    const second = await aiStreamRound({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 }, callbacks);

    expect(first.text).toBe('from claude');
    expect(second.text).toBe('from claude');
    expect(events).toEqual(['text:half an ans', 'switch', 'text:from claude', 'text:from claude']);
    expect(zai.requestedModels).toHaveLength(1);
    expect(claude.requestedModels).toHaveLength(2);
    expect(incidentNotices()).toHaveLength(1);
  });

  test('skipped providers stay visible in telemetry and are not counted as attempts', async () => {
    process.env.AI_SMART_CHAIN = 'zai,claude';
    zai = makeProvider({ behaviors: [{ kind: 'throw', error: apiError(402, 'Payment Required') }] });
    claude = makeProvider({ behaviors: [{ kind: 'text', text: 'from claude' }] });
    await ask();

    const result = await ask();

    expect(result.metrics?.skippedProviders).toEqual([{ provider: 'zai', model: 'glm-5.1' }]);
    expect(result.metrics?.failedProviders).toEqual([]);
    expect(result.metrics?.attemptCount).toBe(1);
  });

  test('a caller abort carrying a quota error does not open the circuit', async () => {
    zai = makeProvider({
      behaviors: [{ kind: 'text', text: 'from zai' }],
    });
    claude = unusedProvider();
    const controller = new AbortController();
    controller.abort(apiError(402, 'Payment Required'));
    expect(zai.requestedModels).toEqual([]);

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
    claude = makeProvider({ behaviors: [{ kind: 'text', text: 'from claude' }] });
    const tools = [{ type: 'function' as const, function: { name: 'get_events', description: 'x', parameters: {} } }];

    await ask();
    await aiStreamRound({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100, tools });
    const small = await ask();

    expect(small.text).toBe('from zai');
    expect(incidentNotices()).toHaveLength(0);
  });

  test('a rate-limit incident notifies once and is silently skipped afterward', async () => {
    zai = makeProvider({ behaviors: [{ kind: 'throw', error: apiError(429, 'Rate limit reached') }] });
    claude = makeProvider({ behaviors: [{ kind: 'text', text: 'from claude' }] });

    await ask();
    await ask();

    expect(incidentNotices()).toHaveLength(1);
    expect(zai.requestedModels).toHaveLength(1);
  });

  test('the incident notice never contains the provider error body', async () => {
    zai = makeProvider({ behaviors: [{ kind: 'throw', error: apiError(402, 'Payment Required SECRET-BODY-TEXT') }] });
    claude = makeProvider({ behaviors: [{ kind: 'text', text: 'from claude' }] });

    await ask();

    expect(incidentNotices()).toHaveLength(1);
    expect(notices.join('\n')).not.toContain('SECRET-BODY-TEXT');
  });
});

describe('provider order', () => {
  test('default main route starts with z.ai', async () => {
    delete process.env.AI_SMART_CHAIN;
    zai = makeProvider({ behaviors: [{ kind: 'text', text: 'main reply' }] });
    claude = unusedProvider();
    hf = unusedProvider();
    const result = await aiStreamRound({ messages: [{ role: 'user', content: 'synthetic request' }], maxTokens: 256 });
    expect(result.text).toBe('main reply');
    expect(result.metrics?.attemptCount).toBe(1);
    expect(zai.requestedModels).toEqual(['glm-5.1']);
    expect(claude.requestedModels).toEqual([]);
    expect(hf.requestedModels).toEqual([]);
  });
  test('default main failure falls directly to configured Claude main, not its fast model', async () => {
    delete process.env.AI_SMART_CHAIN;
    zai = makeProvider({ behaviors: [{ kind: 'throw', error: apiError(503, 'unavailable') }] });
    claude = makeProvider({ behaviors: [{ kind: 'text', text: 'main fallback' }] });
    hf = unusedProvider();
    const result = await aiStreamRound({ messages: [{ role: 'user', content: 'synthetic request' }], maxTokens: 256 });
    expect(result.text).toBe('main fallback');
    expect(result.metrics?.attemptCount).toBe(2);
    expect(claude.requestedModels).toEqual(['claude-main']);
    expect(hf.requestedModels).toEqual([]);
  });

  test('default main fallback reaches HF last after z.ai and Claude fail', async () => {
    delete process.env.AI_SMART_CHAIN;
    zai = makeProvider({ behaviors: [{ kind: 'throw', error: apiError(503, 'synthetic z.ai unavailable') }] });
    claude = makeProvider({ behaviors: [{ kind: 'throw', error: apiError(503, 'synthetic claude unavailable') }] });
    hf = makeProvider({ behaviors: [{ kind: 'text', text: 'verified HF recovery' }] });
    const result = await aiStreamRound({ messages: [{ role: 'user', content: 'synthetic request' }], maxTokens: 256 });
    expect(result.text).toBe('verified HF recovery');
    expect(result.metrics?.attemptCount).toBe(3);
    expect(result.metrics?.chain).toBe('smart');
    expect(hf.requestedModels).toEqual(['hf-main']);
  });
  // The order is the whole point of the configuration: a provider that answers
  // 429 all week, or whose tier rejects every request of this size, must be
  // routed around without a deploy.
  test('tries providers in the configured order', async () => {
    process.env.AI_SMART_CHAIN = 'claude,hf,zai';
    claude = makeProvider({ behaviors: [{ kind: 'throw', error: apiError(429, 'rate limited') }] });
    hf = makeProvider({ behaviors: [{ kind: 'text', text: 'from hf' }] });
    zai = unusedProvider();

    const result = await aiStreamRound({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 }, {});

    expect(result.text).toBe('from hf');
    expect(claude.requestedModels).toEqual(['claude-main']);
    expect(hf.requestedModels).toEqual(['hf-main']);
    expect(zai.requestedModels).toEqual([]);
  });

  // An order naming only unconfigured providers would leave the bot with
  // nothing to answer with, which is worse than ignoring the order — and the
  // fallback has to keep the preference the default order encodes, not the
  // order the provider ids happen to be declared in.
  test('an order naming nothing configured falls back to the default order', async () => {
    process.env.AI_SMART_CHAIN = 'claude';
    delete process.env.CLAUDE_API_TOKEN;
    hf = unusedProvider();
    zai = makeProvider({ behaviors: [{ kind: 'text', text: 'from z.ai' }] });
    claude = unusedProvider();

    const result = await aiStreamRound({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 }, {});

    expect(result.text).toBe('from z.ai');
    expect(zai.requestedModels).toEqual(['glm-5.1']);
    expect(hf.requestedModels).toEqual([]);
    expect(claude.requestedModels).toEqual([]);
  });

  // Missing configured fast providers fall back to the short-call default, not smart order.
  test('the fast chain falls back to its own default order', async () => {
    process.env.AI_FAST_CHAIN = 'claude';
    delete process.env.CLAUDE_API_TOKEN;
    zai = makeProvider({ behaviors: [{ kind: 'text', text: 'from z.ai fast' }] });
    hf = unusedProvider();
    claude = unusedProvider();

    const result = await aiStreamRound({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100, fast: true }, {});

    expect(result.text).toBe('from z.ai fast');
    expect(claude.requestedModels).toEqual([]);
    expect(zai.requestedModels).toEqual(['glm-5.1-air']);
    expect(hf.requestedModels).toEqual([]);
  });

  test.each([
    '',
    '   ',
  ])('empty first HF response %j falls through to the exact Claude fast model', async (emptyText) => {
    process.env.AI_FAST_CHAIN = 'hf,claude';
    hf = makeProvider({ behaviors: [{ kind: 'text', text: emptyText }] });
    claude = makeProvider({ behaviors: [{ kind: 'text', text: 'verified fallback' }] });
    zai = unusedProvider();
    const result = await aiStreamRound({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 128, fast: true });
    expect(result.text).toBe('verified fallback');
    expect(hf.requestedModels).toEqual(['hf-fast']);
    expect(claude.requestedModels).toEqual(['claude-fast']);
    expect(result.metrics?.attemptCount).toBe(2);
    expect(zai.requestedModels).toEqual([]);
  });

  // A name in the order is a preference, not a requirement: Claude is optional
  // configuration and the chain has to hold together without it.
  test('skips a provider that has no model configured', async () => {
    process.env.AI_SMART_CHAIN = 'claude,hf';
    process.env.CLAUDE_MODEL = '';
    hf = makeProvider({ behaviors: [{ kind: 'text', text: 'from hf' }] });
    zai = unusedProvider();
    claude = unusedProvider();

    const result = await aiStreamRound({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 }, {});

    expect(result.text).toBe('from hf');
    expect(claude.requestedModels).toEqual([]);
  });

  // Claude follows z.ai in both default orders and each chain uses its own
  // Claude model (Sonnet answers users, Haiku validates).
  test.each([
    { fast: false, chain: 'smart', model: 'claude-main' },
    { fast: true, chain: 'fast', model: 'claude-fast' },
  ])('default $chain chain reaches Claude $model directly after z.ai fails', async ({ fast, chain, model }) => {
    delete process.env.AI_SMART_CHAIN;
    delete process.env.AI_FAST_CHAIN;
    zai = makeProvider({ behaviors: [{ kind: 'throw', error: apiError(503, 'synthetic outage') }] });
    claude = makeProvider({ behaviors: [{ kind: 'text', text: 'answer from Claude' }] });

    const result = await aiStreamRound({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100, fast });

    expect(result.text).toBe('answer from Claude');
    expect(result.metrics?.chain).toBe(chain);
    expect(result.metrics?.attemptCount).toBe(2);
    expect(zai.requestedModels).toHaveLength(1);
    expect(claude.requestedModels).toEqual([model]);
  });

  // Claude 5.5 answers 400 "`temperature` is deprecated for this model" to any request
  // carrying it (live, 2026-10-09) — sending the default would make the reserve dead.
  test('Claude requests omit the sampling temperature that other providers still get', async () => {
    process.env.AI_SMART_CHAIN = 'zai,claude';
    Object.assign(process.env, { CLAUDE_API_TOKEN: 'claude-key', CLAUDE_MODEL: 'claude-main' });
    zai = makeProvider({ behaviors: [{ kind: 'throw', error: apiError(503, 'synthetic outage') }] });
    claude = makeProvider({ behaviors: [{ kind: 'text', text: 'answer from Claude' }] });

    const result = await aiStreamRound({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100, temperature: 0 });

    expect(result.text).toBe('answer from Claude');
    expect(zai.requests.map((request) => request.temperature)).toEqual([0]);
    expect(claude.requests.map((request) => request.temperature)).toEqual([undefined]);
  });

  // Claude 5.5 thinks before answering and the compatible endpoint streams none of it, yet
  // bills it against max_tokens (live, 2026-10-09/10): a 256-token Haiku summary came back empty
  // at `length`. No request field caps the thinking (reasoning_effort, output_config.effort and
  // thinking.budget_tokens all left it unchanged), so thinking must not count toward the
  // caller's limit: Claude gets its 128000-token ceiling and the limit is enforced on the
  // visible stream instead.
  test.each([
    { fast: true, model: 'claude-haiku-5-5', maxTokens: 256 },
    { fast: false, model: 'claude-sonnet-5-5', maxTokens: 4096 },
  ])('Claude $model is sent its output ceiling for a $maxTokens answer', async ({ fast, model, maxTokens }) => {
    process.env.AI_SMART_CHAIN = 'zai,claude';
    process.env.AI_FAST_CHAIN = 'zai,claude';
    Object.assign(process.env, { CLAUDE_API_TOKEN: 'claude-key', CLAUDE_MODEL: model, CLAUDE_FAST_MODEL: model });
    zai = makeProvider({ behaviors: [{ kind: 'throw', error: apiError(503, 'synthetic outage') }] });
    claude = makeProvider({ behaviors: [{ kind: 'text', text: 'summary' }] });

    await aiStreamRound({ messages: [{ role: 'user', content: 'hi' }], maxTokens, fast });

    expect(claude.requests).toMatchObject([{ max_tokens: 128_000 }]);
    expect(claude.requests[0]?.reasoning_effort).toBeUndefined();
    expect(claude.requests[0]?.thinking).toBeUndefined();
    expect(zai.requests).toMatchObject([{ max_tokens: maxTokens }]);
  });

  // The caller's limit binds Claude's visible output only, so the stream reader enforces it:
  // reading stops on the chunk that passes the limit, exactly like a provider stop at `length`.
  test('a Claude answer past the caller limit is cut at length on the visible stream', async () => {
    process.env.AI_FAST_CHAIN = 'claude';
    Object.assign(process.env, { CLAUDE_API_TOKEN: 'claude-key', CLAUDE_FAST_MODEL: 'claude-haiku-5-5' });
    const served = { count: 0 };
    // 35 ASCII characters estimate at 10 tokens each.
    claude = makeProvider({ behaviors: [{ kind: 'chunks', parts: Array(6).fill('a'.repeat(35)), served }] });

    const result = await aiStreamRound({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 20, fast: true });

    expect(result.finishReason).toBe('length');
    expect(result.text).toBe('a'.repeat(105));
    expect(served.count).toBe(3);
  });

  test('a Claude answer within the caller limit is read to the end', async () => {
    process.env.AI_FAST_CHAIN = 'claude';
    Object.assign(process.env, { CLAUDE_API_TOKEN: 'claude-key', CLAUDE_FAST_MODEL: 'claude-haiku-5-5' });
    const served = { count: 0 };
    claude = makeProvider({ behaviors: [{ kind: 'chunks', parts: Array(2).fill('a'.repeat(35)), served }] });

    const result = await aiStreamRound({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 20, fast: true });

    expect(result.finishReason).toBe('stop');
    expect(result.text).toBe('a'.repeat(70));
    expect(served.count).toBe(2);
  });

  // Tool-call names and argument fragments are visible output too: a runaway tool call is cut
  // by the same limit as text, and its truncated arguments fail like any tool call that a
  // provider stopped at `length`, so nothing half-written is executed.
  test('Claude tool-call arguments count toward the caller limit', async () => {
    process.env.AI_FAST_CHAIN = 'claude';
    Object.assign(process.env, { CLAUDE_API_TOKEN: 'claude-key', CLAUDE_FAST_MODEL: 'claude-haiku-5-5' });
    const served = { count: 0 };
    claude = makeProvider({
      behaviors: [{ kind: 'chunks', parts: Array(6).fill('a'.repeat(35)), served, toolName: 'create_event' }],
    });

    const failure = await aiStreamRound({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 20,
      fast: true,
    }).catch((error: unknown) => error);

    // 12 name characters + 70 argument characters estimate at 24 tokens, past the limit of 20.
    expect(failure).toBeInstanceOf(AllProvidersFailedError);
    expect(failure).toMatchObject({ failures: [{ emptyResponse: { finishReason: 'length' } }] });
    expect(served.count).toBe(2);
  });

  // An empty Claude answer is diagnosed against the cap actually sent: hidden thinking is
  // billed against it, so the caller's smaller budget would misstate what ran out.
  test('an empty Claude answer records the max_tokens actually sent', async () => {
    process.env.AI_FAST_CHAIN = 'claude';
    Object.assign(process.env, { CLAUDE_API_TOKEN: 'claude-key', CLAUDE_FAST_MODEL: 'claude-haiku-5-5' });
    claude = makeProvider({ behaviors: [{ kind: 'text', text: '' }] });

    const failure = await aiStreamRound({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 256,
      fast: true,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AllProvidersFailedError);
    expect(failure).toMatchObject({ failures: [{ emptyResponse: { maxOutputTokens: 128_000 } }] });
  });

  test('the default chain skips Claude without a token and falls through to HF', async () => {
    delete process.env.AI_SMART_CHAIN;
    delete process.env.CLAUDE_API_TOKEN;
    Object.assign(process.env, { CLAUDE_MODEL: 'claude-main', CLAUDE_FAST_MODEL: 'claude-fast' });
    zai = makeProvider({ behaviors: [{ kind: 'throw', error: apiError(503, 'synthetic outage') }] });
    hf = makeProvider({ behaviors: [{ kind: 'text', text: 'answer from hf' }] });

    const result = await ask();

    expect(result.text).toBe('answer from hf');
    expect(claude.requestedModels).toEqual([]);
    expect(result.metrics?.attemptCount).toBe(2);
  });
});

describe('aiStreamRound — auto-detecting a live model', () => {
  beforeEach(() => {
    resetModelRegistry();
    zai = makeProvider({ behaviors: [{ kind: 'throw', error: ZAI_QUOTA }] });
    claude = makeProvider({ behaviors: [{ kind: 'text', text: 'answer from Claude' }] });
    hf = unusedProvider();
  });

  test('deleted model → /v1/models probed → request retried on the live model and succeeds', async () => {
    hf = makeProvider({
      behaviors: [
        { kind: 'throw', error: MODEL_GONE },
        { kind: 'text', text: 'answer from HF' },
      ],
      liveModels: ['whisper-large-v3', 'replacement-model'],
    });

    const result = await ask();

    expect(result.text).toBe('answer from HF');
    expect(result.providerUsed).toBe('HF (replacement-model)');
    expect(hf.requestedModels).toEqual(['hf-main', 'replacement-model']);
    expect(claude.requestedModels).toEqual([]);
    expect(result.metrics?.attemptCount).toBe(3); // z.ai quota + dead HF model + replacement HF request
    expect(result.metrics?.fallbackCount).toBe(1);
  });

  test('the resolved model is cached: the next request skips the dead model and the second probe', async () => {
    hf = makeProvider({
      behaviors: [
        { kind: 'throw', error: MODEL_GONE },
        { kind: 'text', text: 'answer from HF' },
      ],
      liveModels: ['replacement-model'],
    });

    await ask();
    const second = await ask();

    expect(second.text).toBe('answer from HF');
    expect(hf.requestedModels).toEqual([
      'hf-main',
      'replacement-model',
      'replacement-model', // second request goes straight to the live model
    ]);
    expect(hf.modelsListCalls).toBe(1);
  });

  test('discovery failure degrades gracefully to the next provider', async () => {
    hf = makeProvider({
      behaviors: [{ kind: 'throw', error: MODEL_GONE }],
      modelsListError: new Error('models endpoint unreachable'),
    });

    const result = await ask();

    expect(result.text).toBe('answer from Claude');
    expect(hf.modelsListCalls).toBe(1);
    expect(hf.requestedModels).toEqual(['hf-main']);
  });

  test('discovery finding nothing usable falls through to the next provider', async () => {
    hf = makeProvider({
      behaviors: [{ kind: 'throw', error: MODEL_GONE }],
      liveModels: ['whisper-large-v3', 'playai-tts'],
    });

    const result = await ask();

    expect(result.text).toBe('answer from Claude');
    expect(hf.requestedModels).toEqual(['hf-main']);
  });

  test('a replacement that also dies triggers one re-probe, then falls through', async () => {
    hf = makeProvider({
      behaviors: [{ kind: 'throw', error: MODEL_GONE }],
      liveModels: ['replacement-model'],
    });

    await ask(); // caches replacement-model, which also 404s → falls through to Claude
    const result = await ask();

    expect(result.text).toBe('answer from Claude');
    // First request: dead configured model + retry on the replacement.
    // Second request: straight to the cached replacement, then one forced re-probe.
    expect(hf.modelsListCalls).toBe(2);

    // The re-probe found only the model that just died, so HF is recorded as
    // having nothing usable. Further requests must NOT probe /v1/models again —
    // otherwise a provider whose listing lies costs an extra HTTP round trip on
    // every single user message.
    await ask();
    await ask();
    expect(hf.modelsListCalls).toBe(2);
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
    claude = makeProvider({ behaviors: [{ kind: 'throw', error: rejection }] });
    hf = makeProvider({ behaviors: [{ kind: 'throw', error: rejection }] });
  }

  function allProvidersAnswer(): void {
    zai = makeProvider({ behaviors: [{ kind: 'text', text: 'answer' }] });
    claude = unusedProvider();
    hf = unusedProvider();
  }

  function allProvidersDead(): void {
    zai = makeProvider({ behaviors: DEAD });
    claude = makeProvider({ behaviors: DEAD });
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
  process.env.AI_SMART_CHAIN = 'zai,claude';
  zai = makeProvider({
    behaviors: [
      { kind: 'throw', error: apiError(400, 'Bad input text contains: payment required') },
      { kind: 'text', text: 'healthy next request' },
    ],
  });
  claude = makeProvider({ behaviors: [{ kind: 'text', text: 'fallback' }] });
  const options = { messages: [{ role: 'user' as const, content: 'synthetic' }], maxTokens: 80 };
  expect((await aiStreamRound(options)).text).toBe('fallback');
  expect((await aiStreamRound(options)).text).toBe('healthy next request');
  expect(zai.requestedModels).toHaveLength(2);
  expect(messages).toHaveLength(0);
});
