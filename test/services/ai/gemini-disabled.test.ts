// Offline regression: retired Gemini cannot receive calendar context through either chain.
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type OpenAI from 'openai';
import { loadConfig } from '../../../src/config/env.ts';
import { resetModelRegistry } from '../../../src/services/ai/model-registry.ts';
import { resetProviderCircuit } from '../../../src/services/ai/provider-circuit.ts';
import { resetEligibility } from '../../../src/services/ai/provider-eligibility.ts';
import { aiStreamRound, providerClients } from '../../../src/services/ai/streaming.ts';
import { resetLogOnce } from '../../../src/utils/logger.ts';

const savedEnv = { ...process.env };
const savedClients = { ...providerClients };
const geminiCall = mock(async () => {
  throw new Error('Gemini must never receive a request');
});
const claudeCall = mock(async () =>
  (async function* () {
    yield { choices: [{ delta: { content: 'synthetic Claude answer' }, finish_reason: null }] };
    yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
  })(),
);
const failCall = mock(async () => {
  throw new Error('synthetic provider failure');
});
function client(create: typeof failCall | typeof claudeCall): OpenAI {
  // Test-only SDK seam; every provider is stubbed and no network is possible.
  return { chat: { completions: { create } } } as unknown as OpenAI;
}
beforeEach(() => {
  resetProviderCircuit();
  resetEligibility();
  resetModelRegistry();
  resetLogOnce();
  process.env = {
    BOT_TOKEN: 'synthetic',
    REDIS_URL: 'redis://localhost:6379',
    DATABASE_PATH: ':memory:',
    ZAI_API_KEY: 'synthetic',
    ZAI_BASE_URL: 'https://example.invalid',
    ZAI_MODEL: 'synthetic-zai',
    ZAI_FAST_MODEL: 'synthetic-zai-fast',
    HF_TOKEN: 'synthetic',
    HF_BASE_URL: 'https://example.invalid',
    HF_MODEL: 'synthetic-hf',
    HF_FAST_MODEL: 'synthetic-hf-fast',
    GROQ_API_KEY: 'synthetic',
    GROQ_MODEL: 'synthetic-groq',
    GROQ_FAST_MODEL: 'synthetic-groq-fast',
    GEMINI_API_KEY: 'synthetic',
    GEMINI_BASE_URL: 'https://example.invalid',
    GEMINI_MODEL: 'synthetic-gemini',
    GEMINI_FAST_MODEL: 'synthetic-gemini-fast',
    CLAUDE_API_TOKEN: 'synthetic',
    CLAUDE_MODEL: 'synthetic-claude',
    CLAUDE_FAST_MODEL: 'synthetic-claude-fast',
  };
  geminiCall.mockClear();
  claudeCall.mockClear();
  failCall.mockClear();
  providerClients.gemini = () => client(geminiCall);
  providerClients.claude = () => client(claudeCall);
  providerClients.groq = providerClients.hf = providerClients.zai = () => client(failCall);
});
afterEach(() => {
  resetProviderCircuit();
  resetEligibility();
  resetModelRegistry();
  process.env = { ...savedEnv };
  Object.assign(providerClients, savedClients);
});

test('starts without retired Gemini credentials', () => {
  for (const name of ['GEMINI_API_KEY', 'GEMINI_BASE_URL', 'GEMINI_MODEL', 'GEMINI_FAST_MODEL'])
    delete process.env[name];
  expect(() => loadConfig()).not.toThrow();
});
for (const fast of [false, true]) {
  for (const order of [undefined, 'gemini,groq,hf,zai,claude', 'gemini']) {
    test(`${fast ? 'fast' : 'smart'} skips Gemini with order ${order ?? 'default'} and reaches Claude`, async () => {
      if (order) process.env[fast ? 'AI_FAST_CHAIN' : 'AI_SMART_CHAIN'] = order;
      const result = await aiStreamRound({
        messages: [{ role: 'user', content: 'offline synthetic fixture' }],
        maxTokens: 32,
        fast,
      });
      expect(result.text).toBe('synthetic Claude answer');
      expect(result.metrics?.provider).toBe('claude');
      expect(geminiCall).not.toHaveBeenCalled();
      expect(claudeCall).toHaveBeenCalledTimes(1);
    });
  }
}

for (const fast of [false, true]) {
  test(`${fast ? 'fast' : 'smart'} exhaustion cannot activate Gemini as a last resort`, async () => {
    process.env[fast ? 'AI_FAST_CHAIN' : 'AI_SMART_CHAIN'] = 'gemini,groq,hf,zai,claude';
    providerClients.claude = () => client(failCall);
    await expect(
      aiStreamRound({ messages: [{ role: 'user', content: 'offline synthetic fixture' }], maxTokens: 32, fast }),
    ).rejects.toThrow('AI providers failed');
    expect(geminiCall).not.toHaveBeenCalled();
  });
}
