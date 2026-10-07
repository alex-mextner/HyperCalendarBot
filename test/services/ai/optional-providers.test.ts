// test/services/ai/optional-providers.test.ts
// Cerebras and Together (#379) through the real chain builder: they run only
// when named, keyed and given a model; they fall back like any other slot; and
// Together alone gets its transcript and /models adapters. Fakes go through the
// `providerClients` seam, so no network is touched.

import { afterEach, beforeEach, describe, expect, type Mock, mock, test } from 'bun:test';
import type { Server } from 'bun';
import type OpenAI from 'openai';
import { closeGeminiQuotaStores } from '../../../src/services/ai/gemini-quota.ts';
import { togetherModelListing } from '../../../src/services/ai/model-registry.ts';
import { PROVIDER_IDS, type ProviderId } from '../../../src/services/ai/provider-ids.ts';
import {
  _resetStreamingUsageCompatibilityForTest,
  aiStreamRound,
  providerClients,
} from '../../../src/services/ai/streaming.ts';

type Chunk = { [key: string]: unknown };

/** The one SDK call a slot makes, recorded so a test can read what each provider was sent. */
interface FakeClient {
  chat: {
    completions: {
      create: Mock<(params: OpenAI.ChatCompletionCreateParamsStreaming) => Promise<AsyncIterable<Chunk>>>;
    };
  };
}

function fakeClient(chunks: Chunk[] | Error): FakeClient {
  return {
    chat: {
      completions: {
        create: mock(async (_params: OpenAI.ChatCompletionCreateParamsStreaming) => {
          if (chunks instanceof Error) throw chunks;
          const scripted = chunks;
          async function* gen() {
            yield* scripted;
          }
          return gen();
        }),
      },
    },
  };
}

/** A slot only touches chat.completions.create; the partial fake is presented as a client here only. */
function asOpenAIClient(fake: FakeClient): OpenAI {
  return fake as unknown as OpenAI;
}

const text = (value: string): Chunk[] => [
  { choices: [{ delta: { content: value }, finish_reason: null }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }] },
];

let fakes: Record<ProviderId, FakeClient>;
const realProviderClients = { ...providerClients };
const savedEnv = { ...process.env };

beforeEach(() => {
  _resetStreamingUsageCompatibilityForTest();
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
    CEREBRAS_KEY: '',
    CEREBRAS_MODEL: '',
    CEREBRAS_FAST_MODEL: '',
    TOGETHER_KEY: '',
    TOGETHER_MODEL: '',
    TOGETHER_FAST_MODEL: '',
    AI_SMART_CHAIN: 'cerebras,together,zai',
    AI_FAST_CHAIN: 'cerebras,together,zai',
  });
  fakes = {
    zai: fakeClient(text('from zai')),
    groq: fakeClient(text('from groq')),
    gemini: fakeClient(text('from gemini')),
    hf: fakeClient(text('from hf')),
    cerebras: fakeClient(text('from cerebras')),
    together: fakeClient(text('from together')),
  };
  for (const id of PROVIDER_IDS) providerClients[id] = () => asOpenAIClient(fakes[id]);
});

afterEach(() => {
  closeGeminiQuotaStores();
  process.env = { ...savedEnv };
  Object.assign(providerClients, realProviderClients);
});

const user: OpenAI.ChatCompletionMessageParam[] = [{ role: 'user', content: 'synthetic question' }];

describe('optional Cerebras and Together slots', () => {
  test('named but unkeyed providers are skipped without a request', async () => {
    const result = await aiStreamRound({ messages: user, maxTokens: 64 });
    expect(result.text).toBe('from zai');
    expect(fakes.cerebras.chat.completions.create).not.toHaveBeenCalled();
    expect(fakes.together.chat.completions.create).not.toHaveBeenCalled();
  });

  test('a key without a model for that chain is skipped: no model id is defaulted', async () => {
    process.env.CEREBRAS_KEY = 'cerebras-key';
    process.env.TOGETHER_KEY = 'together-key';
    const result = await aiStreamRound({ messages: user, maxTokens: 64 });
    expect(result.text).toBe('from zai');
    expect(fakes.cerebras.chat.completions.create).not.toHaveBeenCalled();
    expect(fakes.together.chat.completions.create).not.toHaveBeenCalled();
  });

  test('a configured provider answers in chain order with the model of the requested chain', async () => {
    Object.assign(process.env, {
      CEREBRAS_KEY: 'cerebras-key',
      CEREBRAS_MODEL: 'cerebras-main',
      CEREBRAS_FAST_MODEL: 'cerebras-fast',
    });
    fakes.cerebras = fakeClient([
      ...text('from cerebras'),
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } },
    ]);
    const smart = await aiStreamRound({ messages: user, maxTokens: 64 });
    expect(smart.providerUsed).toBe('Cerebras (cerebras-main)');
    expect(smart.metrics?.provider).toBe('cerebras');
    expect(smart.metrics?.usage?.totalTokens).toBe(15);
    fakes.cerebras = fakeClient(text('fast cerebras'));
    const fast = await aiStreamRound({ messages: user, maxTokens: 64, fast: true });
    expect(fast.providerUsed).toBe('Cerebras (cerebras-fast)');
    expect(fakes.cerebras.chat.completions.create.mock.calls[0]?.[0]?.model).toBe('cerebras-fast');
    expect(fakes.zai.chat.completions.create).not.toHaveBeenCalled();
  });

  test('a failing Cerebras slot falls through to Together within the same round', async () => {
    Object.assign(process.env, {
      CEREBRAS_KEY: 'cerebras-key',
      CEREBRAS_MODEL: 'cerebras-main',
      TOGETHER_KEY: 'together-key',
      TOGETHER_MODEL: 'together-main',
    });
    fakes.cerebras = fakeClient(new Error('synthetic connection reset'));
    const result = await aiStreamRound({ messages: user, maxTokens: 64 });
    expect(result.providerUsed).toBe('Together (together-main)');
    expect(fakes.cerebras.chat.completions.create).toHaveBeenCalledTimes(1);
    expect(fakes.zai.chat.completions.create).not.toHaveBeenCalled();
  });

  test('only Together gets a tool-only assistant turn as empty content, on a copy', async () => {
    Object.assign(process.env, {
      CEREBRAS_KEY: 'cerebras-key',
      CEREBRAS_MODEL: 'cerebras-main',
      TOGETHER_KEY: 'together-key',
      TOGETHER_MODEL: 'together-main',
    });
    const assistant: OpenAI.ChatCompletionAssistantMessageParam = {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'calculate', arguments: '{}' } }],
    };
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      ...user,
      assistant,
      { role: 'tool', tool_call_id: 'call-1', content: '{"result":57}' },
      { role: 'assistant', content: null },
    ];
    fakes.cerebras = fakeClient(new Error('synthetic connection reset'));
    await aiStreamRound({ messages, maxTokens: 64 });

    const toCerebras = fakes.cerebras.chat.completions.create.mock.calls[0]?.[0]?.messages;
    const toTogether = fakes.together.chat.completions.create.mock.calls[0]?.[0]?.messages;
    expect(toCerebras?.[1]).toBe(assistant);
    expect(toTogether?.[1]).toEqual({ ...assistant, content: '' });
    expect(toTogether?.[1]).not.toBe(assistant);
    // Only the tool-call turn is rewritten; an assistant turn without tool calls is left as sent.
    expect(toTogether?.[3]).toBe(messages[3]);
    expect(assistant.content).toBeNull();
    expect(messages[1]).toBe(assistant);
  });

  test('the default orders never reach an optional provider, even when fully configured', async () => {
    Object.assign(process.env, {
      CEREBRAS_KEY: 'cerebras-key',
      CEREBRAS_MODEL: 'cerebras-main',
      TOGETHER_KEY: 'together-key',
      TOGETHER_MODEL: 'together-main',
    });
    delete process.env.AI_SMART_CHAIN;
    delete process.env.AI_FAST_CHAIN;
    fakes.gemini = fakeClient(new Error('synthetic gemini outage'));
    fakes.hf = fakeClient(new Error('synthetic hf outage'));
    fakes.zai = fakeClient(new Error('synthetic zai outage'));
    await expect(aiStreamRound({ messages: user, maxTokens: 64 })).rejects.toThrow();
    expect(fakes.cerebras.chat.completions.create).not.toHaveBeenCalled();
    expect(fakes.together.chat.completions.create).not.toHaveBeenCalled();
  });
});

describe('togetherModelListing', () => {
  let server: Server<undefined> | undefined;
  afterEach(() => {
    server?.stop(true);
    server = undefined;
  });

  function serve(status: number, body: string, seen: { auth?: string | null; path?: string } = {}) {
    server = Bun.serve({
      port: 0,
      fetch(request) {
        seen.auth = request.headers.get('authorization');
        seen.path = new URL(request.url).pathname;
        return new Response(body, { status, headers: { 'content-type': 'application/json' } });
      },
    });
    return { baseURL: `http://127.0.0.1:${server.port}/v1/`, apiKey: 'together-key' };
  }

  test('reads the bare array and keeps only chat models', async () => {
    const seen: { auth?: string | null; path?: string } = {};
    const client = serve(
      200,
      JSON.stringify([
        { id: 'vendor/chat-model', type: 'chat' },
        { id: 'vendor/image-model', type: 'image' },
        { id: 'vendor/embedding-model', type: 'embedding' },
        { id: 'vendor/untyped-model' },
      ]),
      seen,
    );
    const listed = await togetherModelListing(client).models.list({ timeout: 2_000 });
    expect(listed.data).toEqual([{ id: 'vendor/chat-model' }, { id: 'vendor/untyped-model' }]);
    expect(seen.path).toBe('/v1/models');
    expect(seen.auth).toBe('Bearer together-key');
  });

  test('an error status or an OpenAI-style envelope is a failed listing, not zero models', async () => {
    await expect(togetherModelListing(serve(401, '{"error":"bad key"}')).models.list()).rejects.toThrow('HTTP 401');
    server?.stop(true);
    await expect(togetherModelListing(serve(200, '{"data":[]}')).models.list()).rejects.toThrow('JSON array');
  });
});
