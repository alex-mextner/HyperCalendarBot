import { beforeEach, expect, mock, test } from 'bun:test';

let capturedOpts: { apiKey?: string; baseURL?: string } = {};

mock.module('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    constructor(opts: { apiKey?: string; baseURL?: string } = {}) {
      capturedOpts = opts;
    }
  },
}));

const { createAnthropicClient } = await import('../../../src/services/ai/anthropic-client');

beforeEach(() => {
  capturedOpts = {};
});

test('createAnthropicClient uses process.env values when no opts given', () => {
  process.env.ZAI_API_KEY = 'env-key';
  process.env.ZAI_BASE_URL = 'https://proxy.example.com';
  createAnthropicClient();
  expect(capturedOpts.apiKey).toBe('env-key');
  expect(capturedOpts.baseURL).toBe('https://proxy.example.com');
});

test('createAnthropicClient overrides env with explicit opts', () => {
  process.env.ZAI_API_KEY = 'env-key';
  process.env.ZAI_BASE_URL = 'https://proxy.example.com';
  createAnthropicClient({ apiKey: 'override-key', baseURL: 'https://other.example.com' });
  expect(capturedOpts.apiKey).toBe('override-key');
  expect(capturedOpts.baseURL).toBe('https://other.example.com');
});

test('createAnthropicClient partial override only replaces provided opts', () => {
  process.env.ZAI_API_KEY = 'env-key';
  process.env.ZAI_BASE_URL = 'https://proxy.example.com';
  createAnthropicClient({ apiKey: 'other-key' });
  expect(capturedOpts.apiKey).toBe('other-key');
  expect(capturedOpts.baseURL).toBe('https://proxy.example.com');
});
