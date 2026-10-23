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
    provider: 'zai',
    model: 'glm-5.1',
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
    role: null,
    preset: null,
    costMicroUsd: null,
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
  // A provider retired from the code whose rows remain in the ledger.
  event({ provider: 'gemini', model: 'gemini-3-flash', promptTokens: null, completionTokens: null }),
];

describe('formatUsageReport', () => {
  test('states plainly that a provider had no traffic, so a quiet Claude is visible', () => {
    const text = formatUsageReport(summarizeAiUsage(rows, WINDOW), 7, t('en').aiStats);

    expect(text).toContain('claude: no traffic in window');
    expect(text).toContain('hf: no traffic in window');
  });

  test('prints the Russian wording through t(lang) for a Russian reader', () => {
    const text = formatUsageReport(summarizeAiUsage(rows, WINDOW), 7, t('ru').aiStats);

    expect(text).toContain('claude: за период запросов нет');
    expect(text).toContain('ИИ за 7 дн.');
    expect(text).not.toContain('no traffic');
  });

  test('gives each provider:model its counts, latency, answer range and last error', () => {
    const text = formatUsageReport(summarizeAiUsage(rows, WINDOW), 7, t('en').aiStats);

    expect(text).toContain('zai:glm-5.1');
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
    expect(text).toContain('zai: degraded');
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
    expect(text).toContain('hf: no traffic in window');
  });

  test('shows the cost of a model, a dash for an unknown one, and how many answers had none', () => {
    const text = formatUsageReport(
      summarizeAiUsage(
        [
          event({ provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash', costMicroUsd: 1500 }),
          event({ provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash', costMicroUsd: null }),
          event(),
        ],
        WINDOW,
      ),
      7,
      t('en').aiStats,
    );

    const priced = text.slice(text.indexOf('openrouter:deepseek'));
    expect(priced).toContain('cost: $0.0015');
    expect(priced).toContain('answers without a known cost: 1');
    const unpriced = text.slice(text.indexOf('zai:glm-5.1'), text.indexOf('openrouter:deepseek'));
    expect(unpriced).toContain('cost: —');
    expect(unpriced).not.toContain('$0');
  });

  test('lists cost and latency per role and provider only when some row has a role', () => {
    const roleRows = [
      event({
        provider: 'openrouter',
        model: 'z-ai/glm-5.3-flash',
        chain: 'role:executor',
        role: 'executor',
        preset: 'glm53-flash-low',
        durationMs: 700,
        costMicroUsd: 2500,
      }),
      event(),
    ];

    const text = formatUsageReport(summarizeAiUsage(roleRows, WINDOW), 7, t('en').aiStats);
    const section = text.slice(text.indexOf('Roles'), text.indexOf('Models'));
    expect(section).toContain('executor · openrouter');
    expect(section).toContain('legacy · zai');
    expect(section).toContain('p50 700 ms · p95 700 ms');
    expect(section).toContain('cost: $0.0025');
    expect(formatUsageReport(summarizeAiUsage(rows, WINDOW), 7, t('en').aiStats)).not.toContain('Roles');
  });

  test('prints the role section in Russian for a Russian reader', () => {
    const text = formatUsageReport(
      summarizeAiUsage([event({ chain: 'role:repair', role: 'repair', costMicroUsd: 400 })], WINDOW),
      7,
      t('ru').aiStats,
    );

    expect(text).toContain('Роли');
    expect(text).toContain('repair · zai');
    expect(text).toContain('стоимость: $0.0004');
  });

  test('a cost below a ten-thousandth of a dollar is still shown, not rounded to zero', () => {
    const text = formatUsageReport(summarizeAiUsage([event({ costMicroUsd: 3 })], WINDOW), 7, t('en').aiStats);

    expect(text).toContain('cost: <$0.0001');
  });

  test('a known zero cost is shown as a zero', () => {
    const text = formatUsageReport(summarizeAiUsage([event({ costMicroUsd: 0 })], WINDOW), 7, t('en').aiStats);

    expect(text).toContain('cost: $0.0000');
  });
});
