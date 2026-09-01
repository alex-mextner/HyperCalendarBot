import { beforeEach, describe, expect, test } from 'bun:test';
import {
  initProviderAlerts,
  isAiChainDown,
  type ProviderFailure,
  reportAllProvidersFailed,
  reportProviderFailure,
  reportProviderRecovered,
  resetProviderAlertState,
} from '../../src/utils/ai-provider-alert.ts';

const DEAD: ProviderFailure[] = [
  { provider: 'z.ai (glm-5.1)', status: 429, message: 'Weekly/Monthly Limit Exhausted' },
  { provider: 'Groq (openai/gpt-oss-120b)', status: 404, message: 'model does not exist' },
  { provider: 'Gemini (models/gemini-2.5-flash)', status: 401, message: 'invalid key' },
];

describe('isAiChainDown — what the health endpoint asks', () => {
  beforeEach(() => {
    resetProviderAlertState();
    initProviderAlerts({ botToken: 't', adminId: 1, send: async () => {} });
  });

  test('a healthy bot that has answered nobody yet is not down', () => {
    expect(isAiChainDown()).toBe(false);
  });

  // The 2026-09-01 outage in one assertion: every provider was dead for hours,
  // the process and Redis were both fine, so /health said "ok" and neither the
  // admin alert nor the automatic investigation ever fired.
  test('every provider dead → the chain reads as down', () => {
    reportAllProvidersFailed(DEAD);
    expect(isAiChainDown()).toBe(true);
  });

  test('a provider answering again clears it', () => {
    reportAllProvidersFailed(DEAD);
    reportProviderRecovered('Gemini (models/gemini-2.5-flash)');
    expect(isAiChainDown()).toBe(false);
  });

  // One slot failing is normal — that is what the fallback chain is for, and it
  // must never take the whole bot's health down with it.
  test('a single provider failing does not mark the chain down', () => {
    reportProviderFailure({ provider: 'z.ai (glm-5.1)', status: 429, message: 'overloaded' });
    expect(isAiChainDown()).toBe(false);
  });
});
