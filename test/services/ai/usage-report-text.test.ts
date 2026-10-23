// test/services/ai/usage-report-text.test.ts
import { describe, expect, test } from 'bun:test';
import { t } from '../../../src/config/constants.ts';
import type { AiUsageEvent } from '../../../src/database/repositories/ai-usage.repository.ts';
import { summarizeAiUsage } from '../../../src/services/ai/usage-report.ts';
import { formatUsageReport } from '../../../src/services/ai/usage-report-text.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 23, 12, 0);
const WINDOW = { sinceMs: NOW - 7 * DAY_MS, untilMs: NOW };

function event(overrides: Partial<AiUsageEvent> = {}): AiUsageEvent {
  return {
    at: Date.UTC(2026, 9, 22, 18, 3),
    provider: 'groq',
    model: 'openai/gpt-oss-120b',
    chain: 'smart',
    purpose: 'agent',
    outcome: 'ok',
    errorClass: null,
    httpStatus: null,
    skipReason: null,
    durationMs: 410,
    promptTokens: 1200,
    completionTokens: 80,
    reasoningTokens: null,
    cachedTokens: null,
    requestId: null,
    ...overrides,
  };
}

const rows = [
  event(),
  event({ durationMs: 1200 }),
  event({
    outcome: 'error',
    errorClass: 'rate_limit',
    httpStatus: 429,
    at: Date.UTC(2026, 9, 20, 4, 11),
    promptTokens: null,
    completionTokens: null,
  }),
  event({ provider: 'gemini', model: 'gemini-3-flash', promptTokens: null, completionTokens: null }),
];

describe('formatUsageReport', () => {
  test('states plainly that a provider had no traffic, so a quiet Claude is visible', () => {
    const text = formatUsageReport(summarizeAiUsage(rows, WINDOW), 7, t('en').aiStats);

    expect(text).toContain('claude: no traffic in window');
    expect(text).toContain('zai: no traffic in window');
  });

  test('prints the Russian wording through t(lang) for a Russian reader', () => {
    const text = formatUsageReport(summarizeAiUsage(rows, WINDOW), 7, t('ru').aiStats);

    expect(text).toContain('claude: за период запросов нет');
    expect(text).toContain('ИИ за 7 дн.');
    expect(text).not.toContain('no traffic');
  });

  test('gives each provider:model its counts, latency, answer range and last error', () => {
    const text = formatUsageReport(summarizeAiUsage(rows, WINDOW), 7, t('en').aiStats);

    expect(text).toContain('groq:openai/gpt-oss-120b');
    expect(text).toContain('2 ok · 1 err · 0 skipped · 66.7%');
    expect(text).toContain('errors: rate_limit 1');
    expect(text).toContain('p50 410 ms · p95 1200 ms');
    expect(text).toContain('first ok 2026-10-22 18:03Z · last ok 2026-10-22 18:03Z');
    expect(text).toContain('last error rate_limit 429 2026-10-20 04:11Z');
  });

  test('shows token sums as reported and never turns unknown usage into zero', () => {
    const text = formatUsageReport(summarizeAiUsage(rows, WINDOW), 7, t('en').aiStats);

    expect(text).toContain('tokens: in 2400 · out 160');
    // gemini reported nothing: dashes and a count of answers without usage, not 0.
    const gemini = text.slice(text.indexOf('gemini:gemini-3-flash'));
    expect(gemini).toContain('tokens: in — · out —');
    expect(gemini).toContain('answers without usage: 1');
    expect(gemini).not.toMatch(/in 0 /);
  });

  test('lists the provider verdicts before the models', () => {
    const text = formatUsageReport(summarizeAiUsage(rows, WINDOW), 7, t('en').aiStats);

    expect(text.indexOf('Providers')).toBeLessThan(text.indexOf('Models'));
    expect(text).toContain('groq: degraded');
    expect(text).toContain('gemini: healthy');
  });

  test('says skipped providers were never contacted and what skipped them', () => {
    const skipped = event({
      provider: 'claude',
      model: 'claude-sonnet-5-5',
      outcome: 'skipped',
      skipReason: 'circuit_open',
      durationMs: null,
      promptTokens: null,
      completionTokens: null,
    });

    const text = formatUsageReport(summarizeAiUsage([skipped], WINDOW), 7, t('en').aiStats);

    expect(text).toContain('claude: never contacted, 1 skipped');
    expect(text).toContain('skipped: circuit_open 1');
  });

  test('an empty window is still a complete, readable report', () => {
    const text = formatUsageReport(summarizeAiUsage([], WINDOW), 7, t('en').aiStats);

    expect(text).toContain('AI usage, last 7 d · attempts: 0');
    expect(text).toContain('groq: no traffic in window');
  });
});
