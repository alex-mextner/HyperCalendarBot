// test/services/ai/model-excluded-chain.test.ts
// An excluded model never serves a request, whatever the environment names, and a preset's measured
// settings reach the request.

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
  max_tokens?: number;
  reasoning?: { effort: string };
}

interface FakeProvider {
  client: OpenAI;
  requests: FakeRequest[];
}

function fakeProvider(text: string, onRequest?: () => void): FakeProvider {
  const requests: FakeRequest[] = [];
  const client = {
    chat: {
      completions: {
        create: async (params: FakeRequest) => {
          requests.push(params);
          onRequest?.();
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

const { providerClients, aiStreamRound, streamingSlot } = await import('../../../src/services/ai/streaming.ts');
const realProviderClients = { ...providerClients };
const savedEnv = { ...process.env };

let hf: FakeProvider;
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
    HF_MODEL: 'openai/gpt-oss-120b',
    HF_FAST_MODEL: 'meta/llama-fast',
    CLAUDE_API_TOKEN: 'claude-key',
    CLAUDE_MODEL: 'claude-main',
    CLAUDE_FAST_MODEL: 'claude-fast',
  });
  delete process.env.AI_SMART_CHAIN;
  delete process.env.AI_FAST_CHAIN;
  resetLogOnce();
  resetEligibility();
  resetProviderCircuit();
  resetModelRegistry();
  hf = fakeProvider('from hf');
  claude = fakeProvider('from claude');
  providerClients.hf = () => hf.client;
  providerClients.claude = () => claude.client;
});

afterEach(() => {
  resetProviderCircuit();
  process.env = { ...savedEnv };
  Object.assign(providerClients, realProviderClients);
});

const messages: OpenAI.ChatCompletionMessageParam[] = [{ role: 'user', content: 'hi' }];

describe('an excluded configured model', () => {
  test('is skipped even when its provider is named first', async () => {
    process.env.AI_SMART_CHAIN = 'hf,claude';
    const result = await aiStreamRound({ messages, maxTokens: 100 });

    expect(result.text).toBe('from claude');
    expect(hf.requests).toHaveLength(0);
  });

  test('does not exclude the same provider when its model is allowed', async () => {
    process.env.AI_FAST_CHAIN = 'hf';
    const result = await aiStreamRound({ messages, maxTokens: 100, fast: true });

    expect(result.text).toBe('from hf');
    expect(hf.requests[0]?.model).toBe('meta/llama-fast');
  });
});

describe('provider priority', () => {
  test.each([false, true])('Claude answers before configured reserves, fast=%s', async (fast) => {
    process.env.AI_SMART_CHAIN = 'hf,zai,claude';
    process.env.AI_FAST_CHAIN = 'hf,zai,claude';
    process.env.HF_MODEL = 'hf-main';
    const zai = fakeProvider('from zai');
    providerClients.zai = () => zai.client;
    const result = await aiStreamRound({ messages, maxTokens: 100, fast });
    expect(result.text).toBe('from claude');
    expect(zai.requests).toHaveLength(0);
    expect(hf.requests).toHaveLength(0);
  });

  test('HF runs only after Claude and the other selected priority providers fail', async () => {
    Object.assign(process.env, {
      AI_SMART_CHAIN: 'hf,openrouter,zai,claude',
      HF_MODEL: 'hf-main',
      OPENROUTER_API_KEY: 'or-key',
      OPENROUTER_MODEL: 'vendor/model',
    });
    const order: string[] = [];
    for (const id of ['claude', 'openrouter', 'zai', 'hf'] as const) {
      const fake = fakeProvider(`from ${id}`, () => {
        order.push(id);
        if (id !== 'hf') throw Object.assign(new Error('synthetic unavailable'), { status: 500 });
      });
      providerClients[id] = () => fake.client;
    }
    expect((await aiStreamRound({ messages, maxTokens: 100 })).text).toBe('from hf');
    expect(order).toEqual(['claude', 'openrouter', 'zai', 'hf']);
  });
});

describe('a preset on a slot', () => {
  const preset: ModelPreset = {
    id: 'glm53-flash-low',
    models: { openrouter: 'z-ai/glm-5.3-flash', zai: 'glm-5.3-flash' },
    effort: 'low',
    temperature: 1,
    maxOutputTokens: 8192,
    prices: {},
    roles: ['executor'],
    qualifications: {},
  };
  const MODEL_BY_PROVIDER = { openrouter: 'z-ai/glm-5.3-flash', zai: 'glm-5.3-flash' };
  interface RunOptions {
    provider?: 'openrouter' | 'zai';
    preset?: ModelPreset;
    model?: string;
    maxTokens?: number;
    temperature?: number;
    reply?: string;
  }
  const run = async ({
    provider = 'openrouter',
    preset: slotPreset,
    model,
    maxTokens = 100,
    temperature,
    reply = 'ok',
  }: RunOptions) => {
    const fake = fakeProvider(reply);
    const sent = model ?? MODEL_BY_PROVIDER[provider];
    const slot = streamingSlot('Test', provider, () => fake.client, sent, 'key', slotPreset);
    const result = await slot.stream(sent, { messages, maxTokens, temperature }, {}, () => {});
    return { request: fake.requests[0], result };
  };

  test('sets its temperature, effort and an output floor', async () => {
    expect((await run({ preset })).request).toMatchObject({
      temperature: 1,
      max_tokens: 8192,
      reasoning: { effort: 'low' },
    });
  });

  test('never lowers a caller limit that is already larger than the preset ceiling', async () => {
    expect((await run({ preset, maxTokens: 20000 })).request?.max_tokens).toBe(20000);
  });

  test('the raised server cap does not raise what the caller gets: the visible stream stops at its limit', async () => {
    const { result } = await run({ preset, maxTokens: 50, reply: 'word '.repeat(2000) });
    expect(result.finishReason).toBe('length');
  });

  test('without a preset the request is the legacy one', async () => {
    const { request } = await run({ temperature: 0.7 });
    expect(request).toMatchObject({ temperature: 0.7, max_tokens: 100 });
    expect(request).not.toHaveProperty('reasoning');
  });

  test('a provider whose effort field is unverified receives none', async () => {
    const { request } = await run({ provider: 'zai', preset });
    expect(request).toMatchObject({ temperature: 1 });
    expect(request).not.toHaveProperty('reasoning');
  });

  test('a replacement model is not run with the settings measured for another model', async () => {
    const { request } = await run({ preset, model: 'z-ai/glm-5.2', temperature: 0.4 });
    expect(request).toMatchObject({ temperature: 0.4, max_tokens: 100 });
    expect(request).not.toHaveProperty('reasoning');
  });
});
