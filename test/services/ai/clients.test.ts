// test/services/ai/clients.test.ts
import { afterEach, beforeEach, expect, test } from 'bun:test';
import OpenAI from 'openai';
import { geminiClient, hfClient, resetClients, zaiClient } from '../../../src/services/ai/clients.ts';

const originalEnv = { ...process.env };

beforeEach(() => {
  resetClients();
  process.env = { ...originalEnv };
  process.env.BOT_TOKEN = 'test-token';
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.ZAI_API_KEY = 'zai-key';
  process.env.ZAI_BASE_URL = 'https://zai.example/v1';
  process.env.ZAI_MODEL = 'glm-test';
  process.env.ZAI_FAST_MODEL = 'glm-fast-test';
  process.env.HF_TOKEN = 'hf-token';
  process.env.HF_BASE_URL = 'https://hf.example/v1';
  process.env.HF_MODEL = 'hf-main';
  process.env.HF_FAST_MODEL = 'hf-fast';
  process.env.GEMINI_API_KEY = 'gemini-key';
  process.env.GEMINI_BASE_URL = 'https://gemini.example/v1/';
  process.env.GEMINI_MODEL = 'gemini-main';
  process.env.GEMINI_FAST_MODEL = 'gemini-fast';
});

afterEach(() => {
  resetClients();
  process.env = { ...originalEnv };
});

test('zaiClient returns an OpenAI instance wired to ZAI env vars', () => {
  const client = zaiClient();
  expect(client).toBeInstanceOf(OpenAI);
  expect(client.apiKey).toBe('zai-key');
  expect(client.baseURL).toBe('https://zai.example/v1');
  expect(client.maxRetries).toBe(0);
});

test('hfClient returns an OpenAI instance wired to HF env vars', () => {
  const client = hfClient();
  expect(client).toBeInstanceOf(OpenAI);
  expect(client.apiKey).toBe('hf-token');
  expect(client.baseURL).toBe('https://hf.example/v1');
});

test('geminiClient returns an OpenAI instance wired to GEMINI env vars', () => {
  const client = geminiClient();
  expect(client).toBeInstanceOf(OpenAI);
  expect(client.apiKey).toBe('gemini-key');
  expect(client.baseURL).toBe('https://gemini.example/v1/');
});

test('each factory returns the same singleton on repeat calls', () => {
  expect(zaiClient()).toBe(zaiClient());
  expect(hfClient()).toBe(hfClient());
  expect(geminiClient()).toBe(geminiClient());
});

test('resetClients clears the singletons so new instances are built', () => {
  const firstZai = zaiClient();
  resetClients();
  const secondZai = zaiClient();
  expect(secondZai).not.toBe(firstZai);
});

test('the three providers are independent singletons', () => {
  const z = zaiClient();
  const h = hfClient();
  const g = geminiClient();
  expect(z).not.toBe(h);
  expect(h).not.toBe(g);
  expect(z).not.toBe(g);
});

// Google's OpenAI-compatible endpoint can wrap one error in a JSON array. The
// SDK reads only `body.error`, so without unwrapping it reports a bodiless 400
// that the chain retries as a transient drop.
function geminiReplying(status: number, body: string, headers: { [name: string]: string } = {}): OpenAI {
  return geminiClient().withOptions({ fetch: async () => new Response(body, { status, headers }) });
}

test('a Gemini array error envelope keeps its status, message and request id', async () => {
  const client = geminiReplying(
    400,
    JSON.stringify([{ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Invalid synthetic tool schema' } }]),
    { 'content-type': 'application/json', 'x-request-id': 'synthetic-request' },
  );
  const error = await client.chat.completions.create({ model: 'synthetic', messages: [] }).catch((err) => err);
  expect(error).toBeInstanceOf(OpenAI.BadRequestError);
  expect(error).toMatchObject({
    status: 400,
    message: '400 Invalid synthetic tool schema',
    error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Invalid synthetic tool schema' },
    requestID: 'synthetic-request',
  });
});

test('a Gemini array rate-limit error keeps its quota details and retry-after header', async () => {
  const client = geminiReplying(
    429,
    JSON.stringify([
      {
        error: {
          code: 429,
          status: 'RESOURCE_EXHAUSTED',
          message: 'Synthetic requests per day quota exceeded',
          details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '60s' }],
        },
      },
    ]),
    { 'content-type': 'application/json', 'retry-after': '60' },
  );
  const error = await client.chat.completions.create({ model: 'synthetic', messages: [] }).catch((err) => err);
  expect(error).toBeInstanceOf(OpenAI.RateLimitError);
  expect(error).toMatchObject({
    status: 429,
    message: '429 Synthetic requests per day quota exceeded',
    error: { status: 'RESOURCE_EXHAUSTED', details: [{ retryDelay: '60s' }] },
  });
  expect(error.headers.get('retry-after')).toBe('60');
});

test('a genuinely empty Gemini error body stays a bodiless error', async () => {
  const error = await geminiReplying(400, '')
    .chat.completions.create({ model: 'synthetic', messages: [] })
    .catch((err) => err);
  expect(error).toMatchObject({ status: 400, message: '400 status code (no body)', error: undefined });
});

test('an array that is not a single Google error envelope is left to the SDK', async () => {
  const body = [{ unexpected: true }, { unexpected: false }];
  const error = await geminiReplying(400, JSON.stringify(body), { 'content-type': 'application/json' })
    .chat.completions.create({ model: 'synthetic', messages: [] })
    .catch((err) => err);
  expect(error).toMatchObject({ status: 400, message: '400 status code (no body)', error: undefined });
});

test('other providers keep the SDK error semantics for an array body', async () => {
  const body = JSON.stringify([{ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Synthetic' } }]);
  const error = await hfClient()
    .withOptions({ fetch: async () => new Response(body, { status: 400 }) })
    .chat.completions.create({ model: 'synthetic', messages: [] })
    .catch((err) => err);
  expect(error).toMatchObject({ status: 400, message: '400 status code (no body)', error: undefined });
});
