import { afterEach, beforeEach, expect, test } from 'bun:test';
import { loadConfig } from '../../../src/config/env.ts';
import { claudeClient, resetClients } from '../../../src/services/ai/clients.ts';
import { buildFastChain, buildRoleChain, buildSmartChain } from '../../../src/services/ai/streaming/chains.ts';

const originalEnv = { ...process.env };
beforeEach(() => {
  resetClients();
  process.env = {
    BOT_TOKEN: 'synthetic',
    REDIS_URL: 'redis://localhost:6379',
    ZAI_API_KEY: 'synthetic',
    ZAI_BASE_URL: 'https://zai.example/v1',
    ZAI_MODEL: 'glm-test',
    ZAI_FAST_MODEL: 'glm-fast-test',
    HF_TOKEN: 'synthetic',
    HF_BASE_URL: 'https://hf.example/v1',
    HF_MODEL: 'hf-main',
    HF_FAST_MODEL: 'hf-fast',
    CLAUDE_API_TOKEN2: ' backup ',
    CLAUDE_MODEL: 'claude-synthetic',
    CLAUDE_FAST_MODEL: 'claude-fast-synthetic',
    AI_SMART_CHAIN: 'claude',
    AI_FAST_CHAIN: 'claude',
  };
});
afterEach(() => {
  process.env = { ...originalEnv };
  resetClients();
});

test('a configured backup alone enables the same Claude models in smart, fast and role chains', () => {
  const cfg = loadConfig();
  expect(claudeClient().apiKey).toBe('backup');
  expect(buildSmartChain(cfg).map((slot) => [slot.provider, slot.configuredModel])).toEqual([
    ['claude', 'claude-synthetic'],
  ]);
  expect(buildFastChain(cfg).map((slot) => [slot.provider, slot.configuredModel])).toEqual([
    ['claude', 'claude-fast-synthetic'],
  ]);
  cfg.AI_ROLE_CHAINS.planner = [{ provider: 'claude' }];
  expect(buildRoleChain('planner', cfg).map((slot) => [slot.provider, slot.configuredModel])).toEqual([
    ['claude', 'claude-synthetic'],
  ]);
});

test('rotating or adding the backup invalidates a previously exhausted durable circuit', () => {
  process.env.CLAUDE_API_TOKEN = 'primary';
  delete process.env.CLAUDE_API_TOKEN2;
  const before = buildSmartChain(loadConfig())[0]?.circuitKey;
  process.env.CLAUDE_API_TOKEN2 = 'backup';
  const added = buildSmartChain(loadConfig())[0]?.circuitKey;
  process.env.CLAUDE_API_TOKEN2 = 'replacement';
  const rotated = buildSmartChain(loadConfig())[0]?.circuitKey;
  expect(before).toBeTruthy();
  expect(added).not.toBe(before);
  expect(rotated).not.toBe(added);
});
