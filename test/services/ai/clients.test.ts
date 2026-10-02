// test/services/ai/clients.test.ts
import { afterEach, beforeEach, expect, test } from 'bun:test';
import OpenAI from 'openai';
import {
  cerebrasClient,
  geminiClient,
  hfClient,
  resetClients,
  togetherClient,
  zaiClient,
} from '../../../src/services/ai/clients.ts';

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
  process.env.CEREBRAS_KEY = 'cerebras-key';
  process.env.CEREBRAS_BASE_URL = 'https://cerebras.example/v1';
  process.env.TOGETHER_KEY = 'together-key';
  process.env.TOGETHER_BASE_URL = 'https://together.example/v1';
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

test('cerebrasClient returns an OpenAI instance wired to CEREBRAS env vars', () => {
  const client = cerebrasClient();
  expect(client).toBeInstanceOf(OpenAI);
  expect(client.apiKey).toBe('cerebras-key');
  expect(client.baseURL).toBe('https://cerebras.example/v1');
  expect(client.maxRetries).toBe(0);
});

test('togetherClient returns an OpenAI instance wired to TOGETHER env vars', () => {
  const client = togetherClient();
  expect(client).toBeInstanceOf(OpenAI);
  expect(client.apiKey).toBe('together-key');
  expect(client.baseURL).toBe('https://together.example/v1');
  expect(client.maxRetries).toBe(0);
});

test('cerebrasClient and togetherClient are singletons independent of the other providers', () => {
  expect(cerebrasClient()).toBe(cerebrasClient());
  expect(togetherClient()).toBe(togetherClient());
  expect(cerebrasClient()).not.toBe(togetherClient());
  expect(cerebrasClient()).not.toBe(zaiClient());
});

test('resetClients clears the Cerebras and Together singletons too', () => {
  const firstCerebras = cerebrasClient();
  const firstTogether = togetherClient();
  resetClients();
  expect(cerebrasClient()).not.toBe(firstCerebras);
  expect(togetherClient()).not.toBe(firstTogether);
});
