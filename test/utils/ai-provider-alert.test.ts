// test/utils/ai-provider-alert.test.ts
//
// Regression suite for the 2026-09-01 silent outage: every provider in the AI
// fallback chain failed at once (z.ai weekly/monthly cap, another provider deleted both
// configured models, revoked Hugging Face token) and the admin received zero
// alerts, because the alerting code only matched a few "balance exhausted"
// substrings. The error fixtures below are the real messages from that day.

import { beforeEach, describe, expect, test } from 'bun:test';
import OpenAI from 'openai';
import {
  ALERT_POLICY,
  classifyProviderError,
  classifyProviderFailure,
  initProviderAlerts,
  isBalanceExhausted,
  reportAllProvidersFailed,
  reportProviderAnswered,
  reportProviderFailure,
  resetProviderAlertState,
} from '../../src/utils/ai-provider-alert.ts';

// ── Real errors from the 2026-09-01 outage ────────────────────────────────

const ZAI_QUOTA_MESSAGE =
  '429 {"error":{"code":"1310","message":"API call limit reached: Weekly/Monthly Limit Exhausted. ' +
  'Quota will be restored at 2026-09-03."}}';
const MODEL_GONE_MESSAGE =
  '404 {"error":{"message":"The model `hf-main` does not exist or you do not have ' +
  'access to it","type":"invalid_request_error","code":"model_not_found"}}';
const HF_AUTH_MESSAGE = '401 Invalid username or password.';

function makeApiError(status: number, body: string): InstanceType<typeof OpenAI.APIError> {
  return new OpenAI.APIError(status, { error: { message: body } }, body, new Headers());
}

// ── Fake clock / transport harness ────────────────────────────────────────

interface ScheduledCallback {
  runAt: number;
  fn: () => void;
}

let clock = 0;
let sent: string[] = [];
let scheduled: ScheduledCallback[] = [];

function runDueCallbacks(): void {
  let due = scheduled.filter((cb) => cb.runAt <= clock);
  while (due.length > 0) {
    scheduled = scheduled.filter((cb) => cb.runAt > clock);
    for (const cb of due) cb.fn();
    due = scheduled.filter((cb) => cb.runAt <= clock);
  }
}

function advance(ms: number): void {
  clock += ms;
  runDueCallbacks();
}

/** Full alerts carry the "Do this" action line; digests and recovery notices do not. */
function isFullAlert(message: string): boolean {
  return message.includes('Do this');
}

function setupAlerts(): void {
  resetProviderAlertState();
  clock = 1_756_684_800_000; // 2026-09-01T00:00:00Z — fixed, no dependence on wall clock
  sent = [];
  scheduled = [];
  initProviderAlerts({
    botToken: 'test-token',
    adminId: 42,
    send: (html) => {
      sent.push(html);
    },
    now: () => clock,
    schedule: (fn, delayMs) => {
      scheduled.push({ fn, runAt: clock + delayMs });
    },
  });
  // Alerts are muted for the first minute of process life (restart-storm guard).
  advance(ALERT_POLICY.startupGraceMs + 1);
}

describe('classifyProviderFailure — the four real failure shapes of 2026-09-01', () => {
  test('z.ai weekly/monthly cap (HTTP 429, code 1310) is a quota exhaustion, not a transient 429', () => {
    expect(classifyProviderFailure({ provider: 'z.ai (glm-4.6)', status: 429, message: ZAI_QUOTA_MESSAGE })).toBe(
      'quota_exhausted',
    );
  });

  test('a deleted model (HTTP 404 model_not_found) is a stale model id', () => {
    expect(
      classifyProviderFailure({
        provider: 'HF (hf-main)',
        status: 404,
        message: MODEL_GONE_MESSAGE,
      }),
    ).toBe('model_gone');
  });

  test('Hugging Face revoked token (HTTP 401) is an authentication failure', () => {
    expect(classifyProviderFailure({ provider: 'HF (model)', status: 401, message: HF_AUTH_MESSAGE })).toBe(
      'auth_failed',
    );
  });

  test('classification works from the message alone when no HTTP status is available', () => {
    expect(classifyProviderFailure({ provider: 'z.ai', message: ZAI_QUOTA_MESSAGE })).toBe('quota_exhausted');
    expect(classifyProviderFailure({ provider: 'HF', message: MODEL_GONE_MESSAGE })).toBe('model_gone');
    expect(classifyProviderFailure({ provider: 'HF', message: HF_AUTH_MESSAGE })).toBe('auth_failed');
  });

  test('HTTP 403 that carries a quota message is a quota exhaustion, not an auth failure', () => {
    expect(classifyProviderFailure({ provider: 'z.ai', status: 403, message: 'Monthly limit exhausted' })).toBe(
      'quota_exhausted',
    );
  });
});

describe('classifyProviderFailure — transient failures must stay quiet', () => {
  test('ordinary per-minute 429 is transient', () => {
    expect(
      classifyProviderFailure({
        provider: 'HF',
        status: 429,
        message: 'Rate limit reached for model, please try again in 2.5s',
      }),
    ).toBe('transient');
  });

  test('5xx and 413 token-per-minute limits are transient', () => {
    expect(classifyProviderFailure({ provider: 'Claude', status: 503, message: 'model is overloaded' })).toBe(
      'transient',
    );
    expect(classifyProviderFailure({ provider: 'Claude', status: 500, message: 'internal error' })).toBe('transient');
    expect(
      classifyProviderFailure({
        provider: 'HF',
        status: 413,
        message:
          'Request too large for model on tokens per minute (TPM): Limit 12000, Requested 24355. ' +
          'Upgrade at https://provider.example/settings/billing',
      }),
    ).toBe('transient');
  });

  test('network-level errors without a status are transient', () => {
    expect(classifyProviderError(new Error('socket hang up'))).toBe('transient');
    expect(classifyProviderError(new Error('Request timed out.'))).toBe('transient');
  });
});

describe('isBalanceExhausted', () => {
  test('true for HTTP 402 Payment Required (status-based, body-agnostic)', () => {
    expect(isBalanceExhausted(makeApiError(402, 'whatever the body says'))).toBe(true);
  });

  test('true for the classic balance wordings', () => {
    expect(isBalanceExhausted(new Error('Your account has insufficient balance for this request'))).toBe(true);
    expect(isBalanceExhausted(new Error('You exceeded your current quota, please check your plan'))).toBe(true);
    expect(isBalanceExhausted(new Error('Your credit balance is too low to access the Anthropic API'))).toBe(true);
    expect(isBalanceExhausted(new Error('402 payment required'))).toBe(true);
  });

  test('false for a 413 TPM rate-limit message (regression — used to false-positive on "/billing" URL)', () => {
    const msg =
      '413 Request too large for model `some-model` in organization `org_x` ' +
      'service tier `on_demand` on tokens per minute (TPM): Limit 12000, Requested 24355, ' +
      'please reduce your message size and try again. Need more tokens? Upgrade to Dev Tier ' +
      'today at https://provider.example/settings/billing';
    expect(isBalanceExhausted(new Error(msg))).toBe(false);
  });

  test('false for unrelated errors and non-Error values', () => {
    expect(isBalanceExhausted(new Error('Request too large for this model'))).toBe(false);
    expect(isBalanceExhausted(new Error('socket hang up'))).toBe(false);
    expect(isBalanceExhausted(new Error('500 internal server error'))).toBe(false);
    expect(isBalanceExhausted('insufficient balance')).toBe(false);
    expect(isBalanceExhausted(null)).toBe(false);
  });
});

describe('single-provider alerts', () => {
  beforeEach(setupAlerts);

  test('a transient failure alone never reaches the admin', () => {
    reportProviderFailure({ provider: 'HF (hf-main)', status: 429, message: 'try again in 2s' }, 'smart');
    reportProviderFailure({ provider: 'Claude (claude-sonnet-5-5)', status: 503, message: 'overloaded' }, 'smart');
    advance(ALERT_POLICY.digestWindowMs * 3);
    expect(sent).toEqual([]);
  });

  test('a stale model id alerts once and names the env var to update', () => {
    reportProviderFailure(
      {
        provider: 'HF (hf-main)',
        status: 404,
        message: MODEL_GONE_MESSAGE,
      },
      'smart',
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('HF');
    expect(sent[0]).toContain('HF_MODEL');
    expect(sent[0]).toContain('hf-main');
  });

  test('a revoked Hugging Face token alerts and tells the operator to rotate HF_TOKEN', () => {
    reportProviderFailure({ provider: 'HF (Qwen/Qwen3-Coder)', status: 401, message: HF_AUTH_MESSAGE }, 'smart');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('HF_TOKEN');
  });

  test('a revoked Claude token alerts and tells the operator to rotate CLAUDE_API_TOKEN', () => {
    reportProviderFailure({ provider: 'Claude (claude-sonnet-5-5)', status: 401, message: HF_AUTH_MESSAGE }, 'smart');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('CLAUDE_API_TOKEN');
  });

  test('nothing is sent during the startup grace window (restart-storm guard)', () => {
    resetProviderAlertState();
    sent = [];
    scheduled = [];
    initProviderAlerts({
      botToken: 't',
      adminId: 42,
      send: (html) => sent.push(html),
      now: () => clock,
      schedule: (fn, delayMs) => scheduled.push({ fn, runAt: clock + delayMs }),
    });
    reportProviderFailure({ provider: 'HF (m)', status: 401, message: HF_AUTH_MESSAGE }, 'smart');
    expect(sent).toEqual([]);
  });
});

describe('burst coalescing and escalation', () => {
  beforeEach(setupAlerts);

  function failZai(): void {
    reportProviderFailure({ provider: 'z.ai (glm-4.6)', status: 429, message: ZAI_QUOTA_MESSAGE }, 'smart');
  }

  test('a quota outage alerts once and stays quiet until recovery', () => {
    for (let i = 0; i < 5; i++) {
      failZai();
      advance(30_000);
    }
    expect(sent).toHaveLength(1);

    advance(ALERT_POLICY.digestWindowMs + ALERT_POLICY.providerEscalationMs[0] + ALERT_POLICY.providerEscalationMs[1]);
    failZai();
    expect(sent).toHaveLength(1);
  });

  test('a quota alert surfaces the provider-reported reset time explicitly', () => {
    failZai();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('Quota reset');
    expect(sent[0]).toContain('2026-09-03');
  });

  test('z.ai production reset timestamp with seconds is shown verbatim', () => {
    reportProviderFailure(
      {
        provider: 'z.ai (glm-5.1)',
        status: 429,
        message: '429 Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-09-17 21:15:09',
      },
      'smart',
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('Quota reset');
    expect(sent[0]).toContain('2026-09-17 21:15:09');
  });

  test('a non-quota outage still re-notifies on the widening escalation schedule', () => {
    const failHf = () =>
      reportProviderFailure({ provider: 'HF (hf-main)', status: 404, message: MODEL_GONE_MESSAGE }, 'smart');

    failHf();
    expect(sent).toHaveLength(1);

    advance(ALERT_POLICY.providerEscalationMs[0] + 1000);
    failHf();
    expect(sent.filter(isFullAlert)).toHaveLength(2);
  });

  test('recovery is reported exactly once', () => {
    failZai();
    expect(sent).toHaveLength(1);

    advance(20 * 60_000);
    reportProviderAnswered('z.ai (glm-4.6)', 'smart');
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('z.ai');
    expect(sent[1]).toContain('again');

    reportProviderAnswered('z.ai (glm-4.6)', 'smart');
    advance(ALERT_POLICY.digestWindowMs);
    expect(sent).toHaveLength(2);
  });

  test('a provider that never alerted recovers silently', () => {
    reportProviderFailure({ provider: 'Claude (claude-sonnet-5-5)', status: 503, message: 'overloaded' }, 'smart');
    reportProviderAnswered('Claude (claude-sonnet-5-5)', 'smart');
    expect(sent).toEqual([]);
  });
});

describe('total chain outage', () => {
  beforeEach(setupAlerts);

  const chainFailures = [
    { provider: 'z.ai (glm-4.6)', status: 429, message: ZAI_QUOTA_MESSAGE },
    { provider: 'Claude (claude-sonnet-5-5)', status: 503, message: 'model is overloaded' },
    { provider: 'HF (hf-main)', status: 404, message: MODEL_GONE_MESSAGE },
  ];

  test('one alert names every provider with its own reason and the action to take', () => {
    reportAllProvidersFailed(chainFailures, 'smart');
    expect(sent).toHaveLength(1);
    const text = sent[0] ?? '';
    expect(text).toContain('z.ai');
    expect(text).toContain('Claude');
    expect(text).toContain('HF');
    expect(text).toContain('429');
    expect(text).toContain('404');
    expect(text).toContain('503');
    expect(text).toContain('HF_MODEL');
  });

  test('a repeated chain outage escalates instead of repeating every time', () => {
    reportAllProvidersFailed(chainFailures, 'smart');
    reportAllProvidersFailed(chainFailures, 'smart');
    reportAllProvidersFailed(chainFailures, 'smart');
    expect(sent).toHaveLength(1);

    advance(ALERT_POLICY.chainEscalationMs[0] + 1000);
    reportAllProvidersFailed(chainFailures, 'smart');
    expect(sent).toHaveLength(2);
  });

  test('any provider answering again clears the chain outage with one recovery notice', () => {
    reportAllProvidersFailed(chainFailures, 'smart');
    advance(60_000);
    reportProviderAnswered('Claude (claude-sonnet-5-5)', 'smart');
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('again');
  });
});

describe('hourly ceiling', () => {
  beforeEach(setupAlerts);

  function failProvider(index: number): void {
    reportProviderFailure(
      { provider: `Provider${index} (model-${index})`, status: 401, message: HF_AUTH_MESSAGE },
      'smart',
    );
  }

  test('the ceiling-filling message says the ceiling was reached and later ones are held back', () => {
    for (let i = 0; i < ALERT_POLICY.maxMessagesPerHour; i++) {
      failProvider(i);
      advance(1000);
    }
    expect(sent).toHaveLength(ALERT_POLICY.maxMessagesPerHour);
    expect(sent[ALERT_POLICY.maxMessagesPerHour - 1]).toContain('ceiling');

    failProvider(99);
    expect(sent).toHaveLength(ALERT_POLICY.maxMessagesPerHour);
  });

  test('a total chain outage still gets through a full ceiling', () => {
    for (let i = 0; i < ALERT_POLICY.maxMessagesPerHour; i++) {
      failProvider(i);
      advance(1000);
    }
    reportAllProvidersFailed([{ provider: 'z.ai (glm-4.6)', status: 429, message: ZAI_QUOTA_MESSAGE }], 'smart');
    expect(sent).toHaveLength(ALERT_POLICY.maxMessagesPerHour + 1);
    expect(sent[ALERT_POLICY.maxMessagesPerHour]).toContain('All AI providers');
  });

  test('an alert the ceiling held back is retried, not swallowed by the escalation ladder', () => {
    for (let i = 0; i < ALERT_POLICY.maxMessagesPerHour; i++) {
      failProvider(i);
      advance(1000);
    }
    // This provider never got its alert out.
    reportProviderFailure({ provider: 'HF (hf-main)', status: 404, message: MODEL_GONE_MESSAGE }, 'smart');
    expect(sent.filter((m) => m.includes('HF_MODEL'))).toHaveLength(0);

    advance(60 * 60_000 + 1000); // the rolling hour window empties
    reportProviderFailure({ provider: 'HF (hf-main)', status: 404, message: MODEL_GONE_MESSAGE }, 'smart');
    expect(sent.filter((m) => m.includes('HF_MODEL'))).toHaveLength(1);
  });

  test('held-back alerts are counted and reported in the next message that gets through', () => {
    for (let i = 0; i < ALERT_POLICY.maxMessagesPerHour; i++) {
      failProvider(i);
      advance(1000);
    }
    failProvider(97);
    failProvider(98);
    expect(sent).toHaveLength(ALERT_POLICY.maxMessagesPerHour);

    advance(60 * 60_000 + 1000); // the rolling hour window empties
    failProvider(96);
    const afterCeiling = sent.slice(ALERT_POLICY.maxMessagesPerHour);
    expect(afterCeiling.length).toBeGreaterThan(0);
    expect(afterCeiling.join('\n')).toContain('held back');
  });
});
