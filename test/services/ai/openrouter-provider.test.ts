// test/services/ai/openrouter-provider.test.ts
// OpenRouter is an optional provider: it serves DeepSeek and GLM Flash behind one key. It only
// runs when the operator names it in a chain AND both its key and the chain's model are set.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import OpenAI from 'openai';
import { resetModelRegistry } from '../../../src/services/ai/model-registry.ts';
import { resetProviderCircuit } from '../../../src/services/ai/provider-circuit.ts';
import { resetEligibility } from '../../../src/services/ai/provider-eligibility.ts';
import { resetLogOnce } from '../../../src/utils/logger.ts';

interface FakeRequest {
  model: string;
  temperature?: number;
  max_tokens?: number;
  stream_options?: { include_usage?: boolean };
  messages: OpenAI.ChatCompletionMessageParam[];
}

interface FakeProvider {
  client: { chat: { completions: { create: (params: FakeRequest) => Promise<AsyncIterable<unknown>> } } };
  requests: FakeRequest[];
}

function makeProvider(behavior: { text: string } | { error: Error }): FakeProvider {
  const provider: FakeProvider = {
    requests: [],
    client: {
      chat: {
        completions: {
          create: async (params) => {
            provider.requests.push(params);
            if ('error' in behavior) throw behavior.error;
            const { text } = behavior;
            async function* chunks() {
              yield { choices: [{ delta: { content: text }, finish_reason: null }] };
              yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
              yield { choices: [], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } };
            }
            return chunks();
          },
        },
      },
    },
  };
  return provider;
}

function asOpenAIClient(fake: FakeProvider['client']): OpenAI {
  return fake as unknown as OpenAI;
}

let openrouter: FakeProvider;
let claude: FakeProvider;
let zai: FakeProvider;

const { providerClients, aiStreamRound } = await import('../../../src/services/ai/streaming.ts');
const realProviderClients = { ...providerClients };
const savedEnv = { ...process.env };

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
    OPENROUTER_MODEL: 'deepseek/deepseek-v4.1-flash',
    OPENROUTER_FAST_MODEL: 'z-ai/glm-5.3-flash',
  });
  delete process.env.AI_SMART_CHAIN;
  delete process.env.AI_FAST_CHAIN;
  resetLogOnce();
  resetEligibility();
  resetProviderCircuit();
  resetModelRegistry();
  openrouter = makeProvider({ text: 'from openrouter' });
  claude = makeProvider({ text: 'from claude' });
  zai = makeProvider({ text: 'from zai' });
  providerClients.openrouter = () => asOpenAIClient(openrouter.client);
  providerClients.claude = () => asOpenAIClient(claude.client);
  providerClients.zai = () => asOpenAIClient(zai.client);
});

afterEach(() => {
  resetProviderCircuit();
  process.env = { ...savedEnv };
  Object.assign(providerClients, realProviderClients);
});

const messages: OpenAI.ChatCompletionMessageParam[] = [{ role: 'user', content: 'hi' }];

describe('optional OpenRouter provider', () => {
  test('answers when named first in the smart chain, with the smart model and usage', async () => {
    process.env.AI_SMART_CHAIN = 'openrouter,claude';
    const result = await aiStreamRound({ messages, maxTokens: 100 });

    expect(result.text).toBe('from openrouter');
    expect(result.providerUsed).toBe('OpenRouter (deepseek/deepseek-v4.1-flash)');
    expect(result.metrics?.provider).toBe('openrouter');
    expect(result.metrics?.usage?.promptTokens).toBe(7);
    expect(openrouter.requests[0]).toMatchObject({
      model: 'deepseek/deepseek-v4.1-flash',
      temperature: 0.3,
      max_tokens: 100,
      stream_options: { include_usage: true },
    });
    expect(claude.requests).toHaveLength(0);
  });

  test('the fast chain uses the fast model', async () => {
    process.env.AI_FAST_CHAIN = 'openrouter,claude';
    const result = await aiStreamRound({ messages, maxTokens: 100, fast: true });

    expect(result.providerUsed).toBe('OpenRouter (z-ai/glm-5.3-flash)');
    expect(openrouter.requests[0]?.model).toBe('z-ai/glm-5.3-flash');
  });

  test('is never tried when the chains are the defaults, even if fully configured', async () => {
    const result = await aiStreamRound({ messages, maxTokens: 100 });

    expect(result.text).toBe('from zai');
    expect(openrouter.requests).toHaveLength(0);
  });

  test('is skipped without a key', async () => {
    process.env.AI_SMART_CHAIN = 'openrouter,claude';
    delete process.env.OPENROUTER_API_KEY;
    const result = await aiStreamRound({ messages, maxTokens: 100 });

    expect(result.text).toBe('from claude');
    expect(openrouter.requests).toHaveLength(0);
  });

  test('is skipped without the chain model', async () => {
    process.env.AI_FAST_CHAIN = 'openrouter,claude';
    delete process.env.OPENROUTER_FAST_MODEL;
    const result = await aiStreamRound({ messages, maxTokens: 100, fast: true });

    expect(result.text).toBe('from claude');
    expect(openrouter.requests).toHaveLength(0);
  });

  test('an OpenRouter failure falls through to the next provider like any other', async () => {
    process.env.AI_SMART_CHAIN = 'openrouter,claude';
    openrouter = makeProvider({
      error: new OpenAI.APIError(402, { error: { message: 'no credits' } }, 'no credits', new Headers()),
    });
    const result = await aiStreamRound({ messages, maxTokens: 100 });

    expect(result.text).toBe('from claude');
    expect(result.metrics?.failedProviders).toEqual([
      { provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash' },
    ]);
  });

  test('a rate limit on the smart model does not bench the fast model behind the same key', async () => {
    process.env.AI_SMART_CHAIN = 'openrouter,claude';
    process.env.AI_FAST_CHAIN = 'openrouter,claude';
    openrouter = makeProvider({
      error: new OpenAI.APIError(
        429,
        { error: { message: 'upstream rate limit' } },
        'upstream rate limit',
        new Headers(),
      ),
    });
    await aiStreamRound({ messages, maxTokens: 100 });
    expect(openrouter.requests.map((r) => r.model)).toEqual(['deepseek/deepseek-v4.1-flash']);

    openrouter = makeProvider({ text: 'fast answer' });
    const fast = await aiStreamRound({ messages, maxTokens: 100, fast: true });

    expect(fast.text).toBe('fast answer');
    expect(openrouter.requests.map((r) => r.model)).toEqual(['z-ai/glm-5.3-flash']);
  });

  test('a tool-call history with null assistant content reaches the provider unchanged', async () => {
    // Live-verified 2026-10-23: OpenRouter accepts `content: null` beside tool_calls for DeepSeek V4.1
    // Flash, GLM 5.3 Flash and Claude Haiku 5.5 (Together answered 400 to the same transcript).
    process.env.AI_SMART_CHAIN = 'openrouter';
    const history: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'user', content: 'what is on today?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_events', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '[]' },
    ];
    await aiStreamRound({ messages: history, maxTokens: 100 });

    expect(openrouter.requests[0]?.messages).toEqual(history);
  });
});
