import { beforeEach, describe, expect, test } from 'bun:test';
import {
  ALERT_POLICY,
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

  // A total chain failure is only recorded when a user message hits the dead
  // chain, and it is only cleared when a later message succeeds. With no traffic
  // in between there is no evidence either way — and holding "down" forever
  // would have the two-minute watchdog report an outage that ended by itself
  // while the bot sat idle overnight.
  test('a chain failure nobody has retried since goes stale rather than staying down', () => {
    let clock = 1_000_000;
    resetProviderAlertState();
    initProviderAlerts({ botToken: 't', adminId: 1, send: async () => {}, now: () => clock });

    clock += ALERT_POLICY.startupGraceMs + 1;
    reportAllProvidersFailed(DEAD);
    expect(isAiChainDown()).toBe(true);

    clock += ALERT_POLICY.chainDownStaleMs - 1;
    expect(isAiChainDown()).toBe(true);

    clock += 2;
    expect(isAiChainDown()).toBe(false);
  });

  // ...and a fresh failure re-arms it, so a genuine outage with live traffic
  // never flickers healthy between two user messages.
  test('a new failure after the stale window re-arms the chain', () => {
    let clock = 1_000_000;
    resetProviderAlertState();
    initProviderAlerts({ botToken: 't', adminId: 1, send: async () => {}, now: () => clock });

    clock += ALERT_POLICY.startupGraceMs + 1;
    reportAllProvidersFailed(DEAD);
    clock += ALERT_POLICY.chainDownStaleMs + 1;
    expect(isAiChainDown()).toBe(false);

    reportAllProvidersFailed(DEAD);
    expect(isAiChainDown()).toBe(true);
  });

  // A provider that answers and then dies again inside the flap guard resumes
  // the previous outage rather than opening a new one. The health signal has to
  // come back with it — the recovery cleared it, and a resumed outage is still
  // an outage no user can work around.
  test('an outage resumed inside the flap guard reads as down again', () => {
    let clock = 1_000_000;
    resetProviderAlertState();
    initProviderAlerts({ botToken: 't', adminId: 1, send: async () => {}, now: () => clock });

    clock += ALERT_POLICY.startupGraceMs + 1;
    reportAllProvidersFailed(DEAD);
    reportProviderRecovered('Gemini (models/gemini-2.5-flash)');
    expect(isAiChainDown()).toBe(false);

    clock += ALERT_POLICY.flapGuardMs - 1;
    reportAllProvidersFailed(DEAD);
    expect(isAiChainDown()).toBe(true);
  });

  test('a failure long after a recovery opens a fresh outage and reads as down', () => {
    let clock = 1_000_000;
    resetProviderAlertState();
    initProviderAlerts({ botToken: 't', adminId: 1, send: async () => {}, now: () => clock });

    clock += ALERT_POLICY.startupGraceMs + 1;
    reportAllProvidersFailed(DEAD);
    reportProviderRecovered('Gemini (models/gemini-2.5-flash)');

    clock += ALERT_POLICY.flapGuardMs + 1;
    reportAllProvidersFailed(DEAD);
    expect(isAiChainDown()).toBe(true);
  });
});
