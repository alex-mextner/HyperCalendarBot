// test/services/ai/role-chain-streaming.test.ts
// AI_ROUTING=roles sends agent rounds down the executor chain and validator retries down the repair
// chain; legacy mode and every other purpose are untouched, and an unqualified preset never loads.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type OpenAI from 'openai';
import type { ModelPreset } from '../../../src/services/ai/model-presets.ts';
import { resetModelRegistry } from '../../../src/services/ai/model-registry.ts';
import { resetProviderCircuit } from '../../../src/services/ai/provider-circuit.ts';
import { resetEligibility } from '../../../src/services/ai/provider-eligibility.ts';
import { resetLogOnce } from '../../../src/utils/logger.ts';

interface FakeRequest {
  model: string;
  temperature?: number;
  reasoning?: { effort: string };
}
interface FakeProvider {
  client: OpenAI;
  requests: FakeRequest[];
}
function fakeProvider(text: string): FakeProvider {
  const requests: FakeRequest[] = [];
  const client = {
    chat: {
      completions: {
        create: async (params: FakeRequest) => {
          requests.push(params);
          async function* chunks() {
            yield { choices: [{ delta: { content: text }, finish_reason: null }] };
            yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
          }
          return chunks();
        },
      },
    },
  };
  return { client: client as unknown as OpenAI, requests };
}

const { providerClients, aiStreamRound, roleRoutingSeams } = await import('../../../src/services/ai/streaming.ts');
const realClients = { ...providerClients };
const realPresetById = roleRoutingSeams.presetById;
const savedEnv = { ...process.env };

const QUALIFIED: ModelPreset = {
  id: 'qualified-test',
  models: { openrouter: 'vendor/qualified-model' },
  effort: 'low',
  temperature: 1,
  prices: {},
  roles: ['executor', 'repair'],
  qualification: {
    sha: 'abc1234',
    measuredAt: '2026-10-23',
    rolePass: { executor: 0.97, repair: 0.5 },
    historyPass: 1,
  },
};

let openrouter: FakeProvider;
let zai: FakeProvider;
let claude: FakeProvider;

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
    AI_ROUTING: 'roles',
    AI_EXECUTOR_CHAIN: 'openrouter:qualified-test,claude',
    AI_REPAIR_CHAIN: 'openrouter:qualified-test,claude',
  });
  for (const name of ['AI_ROUTING_USER_IDS', 'AI_SMART_CHAIN', 'AI_FAST_CHAIN', 'AI_PLANNER_CHAIN']) {
    delete process.env[name];
  }
  resetLogOnce();
  resetEligibility();
  resetProviderCircuit();
  resetModelRegistry();
  openrouter = fakeProvider('from openrouter');
  zai = fakeProvider('from zai');
  claude = fakeProvider('from claude');
  providerClients.openrouter = () => openrouter.client;
  providerClients.zai = () => zai.client;
  providerClients.claude = () => claude.client;
  roleRoutingSeams.presetById = (id) => (id === QUALIFIED.id ? QUALIFIED : realPresetById(id));
});

afterEach(() => {
  resetProviderCircuit();
  process.env = { ...savedEnv };
  Object.assign(providerClients, realClients);
  roleRoutingSeams.presetById = realPresetById;
});

const messages: OpenAI.ChatCompletionMessageParam[] = [{ role: 'user', content: 'hi' }];

describe('AI_ROUTING=roles', () => {
  test('an agent round runs on the executor chain with the preset settings', async () => {
    const result = await aiStreamRound({ messages, maxTokens: 100, purpose: 'agent', userId: 5 });

    expect(result.text).toBe('from openrouter');
    expect(openrouter.requests[0]).toMatchObject({
      model: 'vendor/qualified-model',
      temperature: 1,
      reasoning: { effort: 'low' },
    });
    expect(zai.requests).toHaveLength(0);
  });

  test('a validator retry runs on the repair chain only when the preset is qualified for repair', async () => {
    // rolePass.repair is 0.5: below the gate, so the preset is refused and the entry after it serves.
    const result = await aiStreamRound({ messages, maxTokens: 100, purpose: 'retry', userId: 5 });

    expect(result.text).toBe('from claude');
    expect(openrouter.requests).toHaveLength(0);
  });

  test('an unqualified preset never loads, so the next entry answers', async () => {
    roleRoutingSeams.presetById = realPresetById;
    const result = await aiStreamRound({ messages, maxTokens: 100, purpose: 'agent', userId: 5 });

    expect(result.text).toBe('from claude');
    expect(openrouter.requests).toHaveLength(0);
  });

  test('a role chain with nothing loadable falls back to the legacy chain', async () => {
    process.env.AI_EXECUTOR_CHAIN = 'openrouter:no-such-preset';
    const result = await aiStreamRound({ messages, maxTokens: 100, purpose: 'agent', userId: 5 });

    expect(result.text).toBe('from zai');
  });

  test('other purposes stay on the legacy chains', async () => {
    const result = await aiStreamRound({ messages, maxTokens: 100, purpose: 'validator', userId: 5, fast: true });

    expect(result.text).toBe('from zai');
    expect(openrouter.requests).toHaveLength(0);
  });

  test('the canary list limits roles to the listed users', async () => {
    process.env.AI_ROUTING_USER_IDS = '7';
    const other = await aiStreamRound({ messages, maxTokens: 100, purpose: 'agent', userId: 5 });
    const listed = await aiStreamRound({ messages, maxTokens: 100, purpose: 'agent', userId: 7 });

    expect(other.text).toBe('from zai');
    expect(listed.text).toBe('from openrouter');
  });
});

describe('AI_ROUTING=legacy (the default)', () => {
  test('ignores role chains completely', async () => {
    delete process.env.AI_ROUTING;
    const result = await aiStreamRound({ messages, maxTokens: 100, purpose: 'agent', userId: 5 });

    expect(result.text).toBe('from zai');
    expect(openrouter.requests).toHaveLength(0);
  });
});
