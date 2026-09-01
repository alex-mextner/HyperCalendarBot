import { beforeEach, describe, expect, test } from 'bun:test';
import {
  ALERT_POLICY,
  hasChainAnswered,
  initProviderAlerts,
  isAiChainDown,
  type ProviderFailure,
  reportAllProvidersFailed,
  reportProviderAnswered,
  reportProviderFailure,
  resetProviderAlertState,
} from '../../src/utils/ai-provider-alert.ts';

const DEAD: ProviderFailure[] = [
  { provider: 'z.ai (glm-5.1)', status: 429, message: 'Weekly/Monthly Limit Exhausted' },
  { provider: 'Groq (openai/gpt-oss-120b)', status: 404, message: 'model does not exist' },
  { provider: 'Gemini (models/gemini-2.5-flash)', status: 401, message: 'invalid key' },
];

describe('isAiChainDown — what the readiness endpoint asks', () => {
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
    reportAllProvidersFailed(DEAD, 'smart');
    expect(isAiChainDown()).toBe(true);
  });

  test('a provider answering again clears it', () => {
    reportAllProvidersFailed(DEAD, 'smart');
    reportProviderAnswered('Gemini (models/gemini-2.5-flash)', 'smart');
    expect(isAiChainDown()).toBe(false);
  });

  // One slot failing is normal — that is what the fallback chain is for, and it
  // must never take the whole bot's health down with it.
  test('a single provider failing does not mark the chain down', () => {
    reportProviderFailure({ provider: 'z.ai (glm-5.1)', status: 429, message: 'overloaded' }, 'smart');
    expect(isAiChainDown()).toBe(false);
  });

  // The flag stays armed until a provider actually answers, however long that
  // takes. An earlier version expired it after fifteen quiet minutes, on the
  // theory that an idle bot has no evidence either way. That theory cost more
  // than it bought: with sporadic traffic — a message every twenty minutes or
  // so, an ordinary overnight pattern — the readiness endpoint flipped back to
  // ready between messages, and the cron watchdog, which has none of this
  // module's throttling, sent the admin an alternating stream of "down" and
  // "recovered" all night. One source of truth for "the outage is open" is
  // worth more than a possibly-stale answer during silence.
  test('stays down through a long silence, with no message to clear it', () => {
    let clock = 1_000_000;
    resetProviderAlertState();
    initProviderAlerts({ botToken: 't', adminId: 1, send: async () => {}, now: () => clock });

    clock += ALERT_POLICY.startupGraceMs + 1;
    reportAllProvidersFailed(DEAD, 'smart');
    expect(isAiChainDown()).toBe(true);

    clock += 12 * 60 * 60 * 1000;
    expect(isAiChainDown()).toBe(true);
  });

  // The corollary: only a provider answering clears it, and that is the same
  // event the alerting layer uses to close the outage, so the two never
  // disagree about whether the chain is down.
  test('a successful answer after a long silence clears it', () => {
    let clock = 1_000_000;
    resetProviderAlertState();
    initProviderAlerts({ botToken: 't', adminId: 1, send: async () => {}, now: () => clock });

    clock += ALERT_POLICY.startupGraceMs + 1;
    reportAllProvidersFailed(DEAD, 'smart');
    clock += 12 * 60 * 60 * 1000;
    reportProviderAnswered('Gemini (models/gemini-2.5-flash)', 'smart');
    expect(isAiChainDown()).toBe(false);
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
    reportAllProvidersFailed(DEAD, 'smart');
    reportProviderAnswered('Gemini (models/gemini-2.5-flash)', 'smart');
    expect(isAiChainDown()).toBe(false);

    clock += ALERT_POLICY.flapGuardMs - 1;
    reportAllProvidersFailed(DEAD, 'smart');
    expect(isAiChainDown()).toBe(true);
  });

  test('a failure long after a recovery opens a fresh outage and reads as down', () => {
    let clock = 1_000_000;
    resetProviderAlertState();
    initProviderAlerts({ botToken: 't', adminId: 1, send: async () => {}, now: () => clock });

    clock += ALERT_POLICY.startupGraceMs + 1;
    reportAllProvidersFailed(DEAD, 'smart');
    reportProviderAnswered('Gemini (models/gemini-2.5-flash)', 'smart');

    clock += ALERT_POLICY.flapGuardMs + 1;
    reportAllProvidersFailed(DEAD, 'smart');
    expect(isAiChainDown()).toBe(true);
  });
});

// The in-memory record dies with the process, and the most likely reaction to a
// "bot is down" alert is restarting the container. A fresh process therefore
// knows nothing — which is not the same as knowing the chain is fine. Readiness
// says so, and the watchdog script uses it to keep quiet instead of announcing a
// recovery that nobody verified.
describe('hasChainAnswered — whether this process has proof either way', () => {
  beforeEach(() => {
    resetProviderAlertState();
    initProviderAlerts({ botToken: 't', adminId: 1, send: async () => {} });
  });

  test('a process that has served nobody yet has no proof', () => {
    expect(hasChainAnswered()).toBe(false);
  });

  test('a provider answering is the proof', () => {
    reportProviderAnswered('Gemini (models/gemini-2.5-flash)', 'smart');
    expect(hasChainAnswered()).toBe(true);
  });

  // Failures are not proof of anything but their own failure: the chain flag
  // already carries that. What is missing after a restart is a success.
  test('failures alone leave the process without proof', () => {
    reportAllProvidersFailed(DEAD, 'smart');
    expect(hasChainAnswered()).toBe(false);
  });
});

// The bot runs two provider chains: the smart one answers people, the fast one
// does auxiliary work — resolving a city, translating for speech, summarising
// history, validating a response. Readiness is about whether a person can be
// served, so only the smart chain decides it.
describe('isAiChainDown — the two chains are tracked apart', () => {
  beforeEach(() => {
    resetProviderAlertState();
    initProviderAlerts({ botToken: 't', adminId: 1, send: async () => {} });
  });

  test('the fast chain failing does not make the bot unready', () => {
    reportAllProvidersFailed(DEAD, 'fast');
    expect(isAiChainDown()).toBe(false);
  });

  // The dangerous direction: the smart chain is dead and nobody can be served,
  // then some background summariser gets an answer out of the fast chain. If
  // that cleared the outage, readiness would go green and the watchdog would
  // announce a recovery — the exact blind spot this work exists to close.
  test('a fast-chain answer does not clear a smart-chain outage', () => {
    reportAllProvidersFailed(DEAD, 'smart');
    reportProviderAnswered('Gemini (models/gemini-2.5-flash)', 'fast');
    expect(isAiChainDown()).toBe(true);
  });

  test('a smart-chain answer clears it', () => {
    reportAllProvidersFailed(DEAD, 'smart');
    reportProviderAnswered('Gemini (models/gemini-2.5-flash)', 'smart');
    expect(isAiChainDown()).toBe(false);
  });

  test('only a smart-chain answer counts as proof the bot works', () => {
    reportProviderAnswered('Gemini (models/gemini-2.5-flash)', 'fast');
    expect(hasChainAnswered()).toBe(false);
    reportProviderAnswered('Gemini (models/gemini-2.5-flash)', 'smart');
    expect(hasChainAnswered()).toBe(true);
  });

  // The same false recovery one level down. Groq runs a large model in the smart
  // chain and a small one in the fast chain; the large one going stale is
  // exactly the 2026-09-01 failure. If the small one answering closed that
  // outage, the admin would be told Groq is working again while every
  // conversation still failed on it.
  test('a fast-chain answer does not announce the smart chain provider as working', () => {
    const sent: string[] = [];
    let clock = 1_000_000;
    resetProviderAlertState();
    initProviderAlerts({
      botToken: 't',
      adminId: 1,
      now: () => clock,
      send: async (text) => {
        sent.push(text);
      },
    });
    clock += ALERT_POLICY.startupGraceMs + 1;

    reportProviderFailure(
      { provider: 'Groq (openai/gpt-oss-120b)', status: 404, message: 'model does not exist' },
      'smart',
    );
    expect(sent.some((m) => m.includes('Groq'))).toBe(true);

    reportProviderAnswered('Groq (llama-3.1-8b-instant)', 'fast');
    expect(sent.some((m) => m.includes('working again'))).toBe(false);

    reportProviderAnswered('Groq (openai/gpt-oss-120b)', 'smart');
    expect(sent.some((m) => m.includes('working again'))).toBe(true);
  });
});
