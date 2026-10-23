// test/services/ai/role-ledger.test.ts
// Stage B4 on the real aiStreamRound with fake transports: a role round is told apart from a legacy one
// in the ledger and in the provider bench, carries its preset and cost, never runs on a heuristic
// replacement model, a revoked OpenRouter key opens one circuit, and a role chain that has nothing left
// to try falls through to the legacy chain instead of answering nobody.

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import OpenAI from 'openai';
import { migrations } from '../../../src/database/migrations.ts';
import { AiUsageRepository, type AiUsageRow } from '../../../src/database/repositories/ai-usage.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import type { ModelPreset } from '../../../src/services/ai/model-presets.ts';
import { resetModelRegistry } from '../../../src/services/ai/model-registry.ts';
import { resetProviderCircuit } from '../../../src/services/ai/provider-circuit.ts';
import { isBlocked, resetEligibility } from '../../../src/services/ai/provider-eligibility.ts';
import { configureAiUsageRecording, flushAiUsageEvents } from '../../../src/services/ai/usage-recorder.ts';
import { resetLogOnce } from '../../../src/utils/logger.ts';

type Script = { text: string; usage?: Record<string, unknown> } | { error: Error };

interface FakeRequest {
  model: string;
}
interface FakeProvider {
  client: OpenAI;
  requests: FakeRequest[];
  listCalls: number;
}

/** Answers the scripted behaviours in order, repeating the last one. */
function fakeProvider(...script: Script[]): FakeProvider {
  const requests: FakeRequest[] = [];
  const counters = { listCalls: 0 };
  const client = {
    models: {
      list: async () => {
        counters.listCalls++;
        return { data: [{ id: 'glm-9-replacement' }] };
      },
    },
    chat: {
      completions: {
        create: async (params: FakeRequest) => {
          requests.push(params);
          const step = script[Math.min(requests.length - 1, script.length - 1)];
          if (!step) throw new Error('fake provider has no behavior scripted');
          if ('error' in step) throw step.error;
          const { text, usage } = step;
          async function* chunks() {
            yield { choices: [{ delta: { content: text }, finish_reason: null }] };
            yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
            if (usage) yield { choices: [], usage };
          }
          return chunks();
        },
      },
    },
  };
  return {
    client: client as unknown as OpenAI,
    requests,
    get listCalls() {
      return counters.listCalls;
    },
  };
}

function apiError(status: number, message: string) {
  return new OpenAI.APIError(status, { error: { message } }, message, new Headers());
}

// Loaded after the imports above so the env this file sets is read by the config on first use, like the other streaming tests.
const { providerClients, aiStreamRound, roleRoutingSeams } = await import('../../../src/services/ai/streaming.ts');
const realClients = { ...providerClients };
const realPresetById = roleRoutingSeams.presetById;
const savedEnv = { ...process.env };

// A route the seeded price table knows (0.3 / 1.2 USD per million tokens), so the fallback price applies to a role row.
const OR_PRESET_MODEL = 'deepseek/deepseek-v4.1-flash';
const GATE = { sha: 'abc1234', measuredAt: '2026-10-23', rolePass: { executor: 1, repair: 1 }, historyPass: 1 };
const OPENROUTER_PRESET: ModelPreset = {
  id: 'or-test',
  models: { openrouter: OR_PRESET_MODEL },
  prices: {},
  roles: ['executor', 'repair'],
  qualifications: { openrouter: GATE },
};
const ZAI_PRESET: ModelPreset = {
  id: 'zai-test',
  models: { zai: 'zai-preset-model' },
  prices: {},
  roles: ['executor'],
  qualifications: { zai: GATE },
};

const USAGE = { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 };

let db: Database;
let repo: AiUsageRepository;
let openrouter: FakeProvider;
let zai: FakeProvider;
let claude: FakeProvider;
let hf: FakeProvider;

function rows(): AiUsageRow[] {
  flushAiUsageEvents();
  return [...repo.iterateSince(0)];
}

beforeEach(() => {
  Object.assign(process.env, {
    BOT_TOKEN: 'test-token',
    REDIS_URL: 'redis://localhost:6379',
    ZAI_API_KEY: 'zai-key',
    ZAI_BASE_URL: 'https://zai.example/v1',
    ZAI_MODEL: 'zai-main',
    ZAI_FAST_MODEL: 'zai-fast',
    HF_TOKEN: 'hf-token',
    HF_BASE_URL: 'https://hf.example/v1',
    HF_MODEL: 'hf-main',
    HF_FAST_MODEL: 'hf-fast',
    CLAUDE_API_TOKEN: 'claude-key',
    CLAUDE_MODEL: 'claude-main',
    CLAUDE_FAST_MODEL: 'claude-fast',
    OPENROUTER_API_KEY: 'or-key',
    OPENROUTER_MODEL: 'vendor/legacy-model',
    OPENROUTER_FAST_MODEL: 'vendor/legacy-fast',
    AI_ROUTING: 'roles',
    AI_EXECUTOR_CHAIN: 'openrouter:or-test,claude',
    AI_REPAIR_CHAIN: 'openrouter:or-test,claude',
    AI_SMART_CHAIN: 'zai,claude',
    AI_FAST_CHAIN: 'zai,claude',
  });
  for (const name of ['AI_ROUTING_USER_IDS', 'AI_PLANNER_CHAIN']) delete process.env[name];
  resetLogOnce();
  resetEligibility();
  resetProviderCircuit();
  resetModelRegistry();
  openrouter = fakeProvider({ text: 'from openrouter', usage: USAGE });
  zai = fakeProvider({ text: 'from zai', usage: USAGE });
  claude = fakeProvider({ text: 'from claude' });
  hf = fakeProvider({ text: 'from hf' });
  providerClients.openrouter = () => openrouter.client;
  providerClients.zai = () => zai.client;
  providerClients.claude = () => claude.client;
  providerClients.hf = () => hf.client;
  roleRoutingSeams.presetById = (id) =>
    ({ [OPENROUTER_PRESET.id]: OPENROUTER_PRESET, [ZAI_PRESET.id]: ZAI_PRESET })[id] ?? realPresetById(id);
  db = new Database(':memory:');
  runMigrations(db, migrations);
  repo = new AiUsageRepository(db);
  configureAiUsageRecording(repo);
});

afterEach(() => {
  configureAiUsageRecording(null);
  resetProviderCircuit();
  process.env = { ...savedEnv };
  Object.assign(providerClients, realClients);
  roleRoutingSeams.presetById = realPresetById;
  db.close();
});

const messages: OpenAI.ChatCompletionMessageParam[] = [{ role: 'user', content: 'hi' }];
const tools: OpenAI.ChatCompletionTool[] = [
  { type: 'function', function: { name: 'noop', parameters: { type: 'object', properties: {} } } },
];

describe('the ledger tells a role round from a legacy one', () => {
  test('an executor round records its role, preset, chain label and the cost from the price table', async () => {
    await aiStreamRound({ messages, maxTokens: 100, purpose: 'agent', userId: 5 });

    const [row, ...rest] = rows();
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      provider: 'openrouter',
      model: OR_PRESET_MODEL,
      chain: 'role:executor',
      purpose: 'agent',
      role: 'executor',
      preset: 'or-test',
      costMicroUsd: 900,
    });
  });

  test('the cost OpenRouter reports for the request wins over the price table', async () => {
    openrouter = fakeProvider({ text: 'ok', usage: { ...USAGE, cost: 0.000123 } });

    await aiStreamRound({ messages, maxTokens: 100, purpose: 'agent', userId: 5 });

    expect(rows()[0]?.costMicroUsd).toBe(123);
  });

  test('a repair round is labelled repair', async () => {
    await aiStreamRound({ messages, maxTokens: 100, purpose: 'retry', userId: 5 });

    expect(rows()[0]).toMatchObject({ chain: 'role:repair', role: 'repair', preset: 'or-test' });
  });

  test('a legacy round has no role and no preset, and an unpriced route has no cost (NULL, not 0)', async () => {
    delete process.env.AI_ROUTING;

    await aiStreamRound({ messages, maxTokens: 100, purpose: 'agent', userId: 5 });

    expect(rows()[0]).toMatchObject({
      provider: 'zai',
      chain: 'smart',
      role: null,
      preset: null,
      costMicroUsd: null,
    });
  });

  test('a plain provider entry in a role chain is a role row without a preset', async () => {
    process.env.AI_EXECUTOR_CHAIN = 'claude';

    await aiStreamRound({ messages, maxTokens: 100, purpose: 'agent', userId: 5 });

    expect(rows()[0]).toMatchObject({ provider: 'claude', chain: 'role:executor', role: 'executor', preset: null });
  });

  test('a skipped role slot keeps its role and preset', async () => {
    openrouter = fakeProvider({ error: apiError(413, 'Request too large') });
    await aiStreamRound({ messages, maxTokens: 100, purpose: 'agent', userId: 5, tools });
    await aiStreamRound({ messages, maxTokens: 100, purpose: 'agent', userId: 5, tools });

    const skipped = rows().find((row) => row.outcome === 'skipped');
    expect(skipped).toMatchObject({
      provider: 'openrouter',
      chain: 'role:executor',
      role: 'executor',
      preset: 'or-test',
      skipReason: 'eligibility_bench',
      costMicroUsd: null,
    });
  });
});

describe('a role round cannot bench a provider for legacy traffic', () => {
  test('a size rejection on the role slot benches that role and model only', async () => {
    process.env.AI_SMART_CHAIN = 'openrouter,zai';
    openrouter = fakeProvider({ error: apiError(413, 'Request too large') });

    await aiStreamRound({ messages, maxTokens: 100, purpose: 'agent', userId: 5, tools });

    expect(isBlocked('openrouter', `role:executor:${OR_PRESET_MODEL}`, true)).toBe(true);
    expect(isBlocked('openrouter', 'smart', true)).toBe(false);
    expect(isBlocked('openrouter', 'fast', true)).toBe(false);
  });

  test('a legacy round still reaches OpenRouter after the role slot was benched', async () => {
    process.env.AI_SMART_CHAIN = 'openrouter,zai';
    openrouter = fakeProvider({ error: apiError(413, 'Request too large') }, { text: 'legacy answer' });
    await aiStreamRound({ messages, maxTokens: 100, purpose: 'agent', userId: 5, tools });

    delete process.env.AI_ROUTING;
    const legacy = await aiStreamRound({ messages, maxTokens: 100, purpose: 'agent', userId: 5, tools });

    expect(legacy.text).toBe('legacy answer');
    expect(openrouter.requests.map((request) => request.model)).toEqual([OR_PRESET_MODEL, 'vendor/legacy-model']);
  });

  test('a legacy rejection does not bench the role slot either', async () => {
    delete process.env.AI_ROUTING;
    process.env.AI_SMART_CHAIN = 'openrouter,zai';
    openrouter = fakeProvider({ error: apiError(413, 'Request too large') }, { text: 'role answer', usage: USAGE });
    await aiStreamRound({ messages, maxTokens: 100, purpose: 'agent', userId: 5, tools });

    process.env.AI_ROUTING = 'roles';
    const role = await aiStreamRound({ messages, maxTokens: 100, purpose: 'agent', userId: 5, tools });

    expect(role.text).toBe('role answer');
  });
});

describe('a preset slot runs only the measured model', () => {
  test('a model that is gone is not swapped for a live-model guess, and the next entry serves', async () => {
    process.env.AI_EXECUTOR_CHAIN = 'zai:zai-test,claude';
    zai = fakeProvider({ error: apiError(404, 'model not found') });

    const result = await aiStreamRound({ messages, maxTokens: 100, purpose: 'agent', userId: 5 });

    expect(result.text).toBe('from claude');
    expect(zai.listCalls).toBe(0);
    expect(zai.requests.map((request) => request.model)).toEqual(['zai-preset-model']);
  });

  test('a cached replacement from the legacy chain is not used by the preset slot either', async () => {
    process.env.AI_EXECUTOR_CHAIN = 'zai:zai-test,claude';
    process.env.ZAI_MODEL = 'zai-preset-model';
    zai = fakeProvider({ error: apiError(404, 'model not found') }, { text: 'from replacement', usage: USAGE });
    delete process.env.AI_ROUTING;
    process.env.AI_SMART_CHAIN = 'zai';
    await aiStreamRound({ messages, maxTokens: 100, purpose: 'agent', userId: 5 });
    expect(zai.listCalls).toBe(1);

    process.env.AI_ROUTING = 'roles';
    const requestsBefore = zai.requests.length;
    await aiStreamRound({ messages, maxTokens: 100, purpose: 'agent', userId: 5 });

    expect(zai.requests.slice(requestsBefore).map((request) => request.model)).toEqual(['zai-preset-model']);
  });

  test('a plain provider entry keeps live-model discovery', async () => {
    process.env.AI_EXECUTOR_CHAIN = 'zai,claude';
    zai = fakeProvider({ error: apiError(404, 'model not found') }, { text: 'from replacement', usage: USAGE });

    const result = await aiStreamRound({ messages, maxTokens: 100, purpose: 'agent', userId: 5 });

    expect(result.text).toBe('from replacement');
    expect(zai.listCalls).toBe(1);
  });
});

describe('a role chain that has nothing left to try falls through to the legacy chain', () => {
  test('every role slot failing at runtime hands the round to the legacy chain', async () => {
    openrouter = fakeProvider({ error: apiError(500, 'upstream down') });
    claude = fakeProvider({ error: apiError(500, 'also down') });

    const result = await aiStreamRound({ messages, maxTokens: 100, purpose: 'agent', userId: 5 });

    expect(result.text).toBe('from zai');
    const written = rows();
    expect(written.map((row) => [row.provider, row.outcome, row.chain, row.role])).toEqual([
      ['openrouter', 'error', 'role:executor', 'executor'],
      ['claude', 'error', 'role:executor', 'executor'],
      ['zai', 'ok', 'smart', null],
    ]);
  });

  test('a model the role chain already tried is not asked again by the legacy tail', async () => {
    openrouter = fakeProvider({ error: apiError(500, 'upstream down') });
    claude = fakeProvider({ error: apiError(500, 'also down') });
    zai = fakeProvider({ error: apiError(500, 'zai down') });
    hf = fakeProvider({ text: 'from hf' });
    process.env.AI_SMART_CHAIN = 'zai,claude,hf';

    const result = await aiStreamRound({ messages, maxTokens: 100, purpose: 'agent', userId: 5 });

    expect(result.text).toBe('from hf');
    expect(claude.requests).toHaveLength(1);
  });

  test('role slots skipped by an open circuit leave the legacy chain to answer, the skips recorded as role rows', async () => {
    openrouter = fakeProvider({ error: apiError(401, 'No auth credentials found') });
    claude = fakeProvider({ error: apiError(401, 'invalid x-api-key') });
    await aiStreamRound({ messages, maxTokens: 100, purpose: 'agent', userId: 5 });

    const second = await aiStreamRound({ messages, maxTokens: 100, purpose: 'agent', userId: 5 });

    expect(second.text).toBe('from zai');
    expect(openrouter.requests).toHaveLength(1);
    const skipped = rows().filter((row) => row.skipReason === 'circuit_open');
    expect(skipped.map((row) => [row.provider, row.chain])).toEqual([
      ['openrouter', 'role:executor'],
      ['claude', 'role:executor'],
    ]);
  });

  test('the plain legacy twin of a preset slot stays in the tail and can still find a replacement model', async () => {
    process.env.AI_EXECUTOR_CHAIN = 'zai:zai-test';
    process.env.ZAI_MODEL = 'zai-preset-model';
    process.env.AI_SMART_CHAIN = 'zai';
    zai = fakeProvider(
      { error: apiError(404, 'model not found') },
      { error: apiError(404, 'model not found') },
      { text: 'from replacement', usage: USAGE },
    );

    const result = await aiStreamRound({ messages, maxTokens: 100, purpose: 'agent', userId: 5 });

    expect(result.text).toBe('from replacement');
    expect(zai.listCalls).toBe(1);
  });

  test('when role and legacy chains all fail the round fails as before', async () => {
    openrouter = fakeProvider({ error: apiError(500, 'down') });
    claude = fakeProvider({ error: apiError(500, 'down') });
    zai = fakeProvider({ error: apiError(500, 'down') });

    await expect(aiStreamRound({ messages, maxTokens: 100, purpose: 'agent', userId: 5 })).rejects.toThrow();
  });

  test('legacy mode never appends anything', async () => {
    delete process.env.AI_ROUTING;
    zai = fakeProvider({ error: apiError(500, 'down') });
    claude = fakeProvider({ text: 'from claude' });

    const result = await aiStreamRound({ messages, maxTokens: 100, purpose: 'agent', userId: 5 });

    expect(result.text).toBe('from claude');
    expect(openrouter.requests).toHaveLength(0);
  });
});

describe('one OpenRouter key, several models', () => {
  test('a revoked key skips every OpenRouter model after one rejection', async () => {
    process.env.AI_SMART_CHAIN = 'openrouter,zai';
    process.env.AI_EXECUTOR_CHAIN = 'openrouter:or-test';
    openrouter = fakeProvider({ error: apiError(401, 'No auth credentials found') });

    await aiStreamRound({ messages, maxTokens: 100, purpose: 'agent', userId: 5 });
    delete process.env.AI_ROUTING;
    const legacy = await aiStreamRound({ messages, maxTokens: 100, purpose: 'agent', userId: 5 });

    expect(legacy.text).toBe('from zai');
    expect(openrouter.requests).toHaveLength(1);
  });

  test('a rate limit of one model leaves the other OpenRouter model usable', async () => {
    process.env.AI_SMART_CHAIN = 'openrouter,zai';
    process.env.AI_EXECUTOR_CHAIN = 'openrouter:or-test';
    openrouter = fakeProvider(
      { error: apiError(429, 'Rate limit exceeded: upstream is busy') },
      { text: 'other model', usage: USAGE },
    );

    // The role model is rate limited; the legacy tail's other OpenRouter model answers in the same round.
    const result = await aiStreamRound({ messages, maxTokens: 100, purpose: 'agent', userId: 5 });

    expect(result.text).toBe('other model');
    expect(openrouter.requests.map((request) => request.model)).toEqual([OR_PRESET_MODEL, 'vendor/legacy-model']);
  });
});
