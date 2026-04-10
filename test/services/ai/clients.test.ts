// test/services/ai/clients.test.ts
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';

interface CapturedOpts {
  apiKey?: string;
  baseURL?: string;
  timeout?: number;
  maxRetries?: number;
}

const captured: CapturedOpts[] = [];

mock.module('openai', () => ({
  default: class MockOpenAI {
    constructor(opts: CapturedOpts = {}) {
      captured.push(opts);
    }
  },
}));

const { zaiClient, hfClient, geminiClient, resetClients } = await import('../../../src/services/ai/clients.ts');

const originalEnv = { ...process.env };

beforeEach(() => {
  captured.length = 0;
  resetClients();
  process.env = { ...originalEnv };
  process.env.BOT_TOKEN = 'test-token';
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
  process.env = { ...originalEnv };
});

test('zaiClient uses ZAI env vars', () => {
  zaiClient();
  expect(captured).toHaveLength(1);
  expect(captured[0]!.apiKey).toBe('zai-key');
  expect(captured[0]!.baseURL).toBe('https://zai.example/v1');
  expect(captured[0]!.maxRetries).toBe(0);
});

test('hfClient uses HF env vars', () => {
  hfClient();
  expect(captured).toHaveLength(1);
  expect(captured[0]!.apiKey).toBe('hf-token');
  expect(captured[0]!.baseURL).toBe('https://hf.example/v1');
});

test('geminiClient uses GEMINI env vars', () => {
  geminiClient();
  expect(captured).toHaveLength(1);
  expect(captured[0]!.apiKey).toBe('gemini-key');
  expect(captured[0]!.baseURL).toBe('https://gemini.example/v1/');
});

test('clients are cached as singletons', () => {
  zaiClient();
  zaiClient();
  zaiClient();
  expect(captured).toHaveLength(1);
});

test('resetClients clears the singletons', () => {
  zaiClient();
  resetClients();
  zaiClient();
  expect(captured).toHaveLength(2);
});

test('each provider has its own singleton', () => {
  zaiClient();
  hfClient();
  geminiClient();
  expect(captured).toHaveLength(3);
});
