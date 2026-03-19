import { expect, test } from 'bun:test';
import { createAnthropicClient } from '../../../src/services/ai/anthropic-client';

type ClientInternals = { apiKey: string; baseURL: string };

test('createAnthropicClient uses process.env values when no opts given', () => {
  process.env.ANTHROPIC_API_KEY = 'env-key';
  process.env.AI_BASE_URL = 'https://proxy.example.com';
  const client = createAnthropicClient() as unknown as ClientInternals;
  expect(client.apiKey).toBe('env-key');
  expect(client.baseURL).toBe('https://proxy.example.com');
});

test('createAnthropicClient overrides env with explicit opts', () => {
  process.env.ANTHROPIC_API_KEY = 'env-key';
  process.env.AI_BASE_URL = 'https://proxy.example.com';
  const client = createAnthropicClient({
    apiKey: 'override-key',
    baseURL: 'https://other.example.com',
  }) as unknown as ClientInternals;
  expect(client.apiKey).toBe('override-key');
  expect(client.baseURL).toBe('https://other.example.com');
});

test('createAnthropicClient partial override only replaces provided opts', () => {
  process.env.ANTHROPIC_API_KEY = 'env-key';
  process.env.AI_BASE_URL = 'https://proxy.example.com';
  const client = createAnthropicClient({ apiKey: 'other-key' }) as unknown as ClientInternals;
  expect(client.apiKey).toBe('other-key');
  expect(client.baseURL).toBe('https://proxy.example.com');
});
