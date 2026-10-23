// test/services/ai/usage-report.test.ts
import { describe, expect, test } from 'bun:test';
import { AI_USAGE_RETENTION_DAYS, type AiUsageEvent } from '../../../src/database/repositories/ai-usage.repository.ts';
import { parseReportDays, summarizeAiUsage } from '../../../src/services/ai/usage-report.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY_MS;
const WINDOW = { sinceMs: NOW - 7 * DAY_MS, untilMs: NOW };

function event(overrides: Partial<AiUsageEvent> = {}): AiUsageEvent {
  return {
    at: NOW - DAY_MS,
    provider: 'zai',
    model: 'glm-5.1',
    chain: 'smart',
    purpose: 'agent',
    outcome: 'ok',
    errorClass: null,
    httpStatus: null,
    skipReason: null,
    durationMs: 100,
    promptTokens: 10,
    completionTokens: 5,
    reasoningTokens: null,
    cachedTokens: null,
    requestId: null,
    role: null,
    preset: null,
    costMicroUsd: null,
    ...overrides,
  };
}

function failed(errorClass: NonNullable<AiUsageEvent['errorClass']>, httpStatus: number | null, at = NOW - DAY_MS) {
  return event({
    outcome: 'error',
    errorClass,
    httpStatus,
    at,
    durationMs: 50,
    promptTokens: null,
    completionTokens: null,
  });
}

function skipped(skipReason: NonNullable<AiUsageEvent['skipReason']>, overrides: Partial<AiUsageEvent> = {}) {
  return event({
    outcome: 'skipped',
    skipReason,
    durationMs: null,
    promptTokens: null,
    completionTokens: null,
    ...overrides,
  });
}

function groupOf(rows: AiUsageEvent[], key: string) {
  const group = summarizeAiUsage(rows, WINDOW).models.find(
    (candidate) => `${candidate.provider}:${candidate.model}` === key,
  );
  if (!group) throw new Error(`no group ${key}`);
  return group;
}

describe('summarizeAiUsage — per provider:model', () => {
  test('counts attempts by outcome, errors by class and skips by reason, and keeps models apart', () => {
    const rows = [
      event(),
      event(),
      failed('rate_limit', 429),
      failed('rate_limit', 429),
      failed('server', 503),
      skipped('circuit_open'),
      event({ model: 'other-model' }),
    ];

    const summary = summarizeAiUsage(rows, WINDOW);

    expect(summary.models.map((m) => `${m.provider}:${m.model}`)).toEqual(['zai:glm-5.1', 'zai:other-model']);
    expect(summary.models[0]).toMatchObject({
      attempts: 6,
      ok: 2,
      errors: 3,
      skipped: 1,
      errorsByClass: { rate_limit: 2, server: 1 },
      skippedByReason: { circuit_open: 1 },
    });
    expect(summary.totalAttempts).toBe(7);
  });

  test('success rate counts only attempts that reached the provider: a skip is not a failure', () => {
    const group = groupOf(
      [event(), event(), event(), failed('timeout', null), skipped('eligibility_bench')],
      'zai:glm-5.1',
    );
    expect(group.successRate).toBeCloseTo(0.75, 5);
  });

  test('success rate is unknown, not zero, when nothing was sent', () => {
    expect(groupOf([skipped('circuit_open')], 'zai:glm-5.1').successRate).toBeNull();
  });

  test('token sums skip unknown values and count answered rows that reported none — unknown is never zero', () => {
    const group = groupOf(
      [
        event({ promptTokens: 100, completionTokens: 10, reasoningTokens: 4, cachedTokens: 60 }),
        event({ promptTokens: 50, completionTokens: 0, reasoningTokens: null, cachedTokens: null }),
        event({ promptTokens: null, completionTokens: null, reasoningTokens: null, cachedTokens: null }),
      ],
      'zai:glm-5.1',
    );

    expect(group.tokens).toEqual({
      prompt: { sum: 150, reportedRows: 2, unknownRows: 1 },
      completion: { sum: 10, reportedRows: 2, unknownRows: 1 },
      reasoning: { sum: 4, reportedRows: 1, unknownRows: 2 },
      cached: { sum: 60, reportedRows: 1, unknownRows: 2 },
    });
  });

  test('a failed attempt that still reported billed tokens adds them; one that reported none is not "unknown usage"', () => {
    const group = groupOf(
      [
        event({ promptTokens: 10, completionTokens: 1 }),
        event({ outcome: 'error', errorClass: 'empty', promptTokens: 200, completionTokens: 30 }),
        failed('server', 503),
      ],
      'zai:glm-5.1',
    );

    expect(group.tokens.prompt).toEqual({ sum: 210, reportedRows: 2, unknownRows: 0 });
    expect(group.tokens.completion).toEqual({ sum: 31, reportedRows: 2, unknownRows: 0 });
  });

  test('a group with no token value at all reports a null sum, not 0', () => {
    const group = groupOf(
      [event({ promptTokens: null, completionTokens: null }), event({ promptTokens: null, completionTokens: null })],
      'zai:glm-5.1',
    );
    expect(group.tokens.prompt).toEqual({ sum: null, reportedRows: 0, unknownRows: 2 });
  });

  test('p50 and p95 duration are nearest-rank over answered attempts only', () => {
    const rows = Array.from({ length: 20 }, (_, index) => event({ durationMs: (index + 1) * 10 }));
    rows.push(failed('timeout', null));

    const group = groupOf(rows, 'zai:glm-5.1');

    expect(group.p50DurationMs).toBe(100);
    expect(group.p95DurationMs).toBe(190);
  });

  test('duration is unknown when no answered attempt carries one', () => {
    expect(groupOf([failed('server', 500)], 'zai:glm-5.1')).toMatchObject({
      p50DurationMs: null,
      p95DurationMs: null,
    });
  });

  test('first and last answered time, and the last error class with its time', () => {
    const group = groupOf(
      [
        event({ at: NOW - 5 * DAY_MS }),
        failed('auth', 401, NOW - 4 * DAY_MS),
        event({ at: NOW - 2 * DAY_MS }),
        failed('quota', 402, NOW - 3 * DAY_MS),
        failed('timeout', null, NOW - 1 * DAY_MS),
      ],
      'zai:glm-5.1',
    );

    expect(group.firstOkAt).toBe(NOW - 5 * DAY_MS);
    expect(group.lastOkAt).toBe(NOW - 2 * DAY_MS);
    expect(group.lastError).toEqual({ errorClass: 'timeout', httpStatus: null, at: NOW - 1 * DAY_MS });
  });

  test('a group that never failed has no last error and one that never answered has no ok times', () => {
    expect(groupOf([event()], 'zai:glm-5.1').lastError).toBeNull();
    expect(groupOf([failed('auth', 401)], 'zai:glm-5.1')).toMatchObject({ firstOkAt: null, lastOkAt: null });
  });

  test('the input may be any iterable (the repository hands rows out lazily)', () => {
    function* lazy() {
      yield event();
      yield event();
    }
    expect(summarizeAiUsage(lazy(), WINDOW).totalAttempts).toBe(2);
  });
});

describe('summarizeAiUsage — one verdict per provider', () => {
  function verdictOf(rows: AiUsageEvent[], provider: string) {
    const entry = summarizeAiUsage(rows, WINDOW).providers.find((candidate) => candidate.provider === provider);
    if (!entry) throw new Error(`no provider ${provider}`);
    return entry;
  }

  test('lists every known provider, so a provider with no rows says so explicitly', () => {
    const summary = summarizeAiUsage([event()], WINDOW);

    expect(summary.providers.map((p) => p.provider)).toEqual(['zai', 'claude', 'hf', 'openrouter']);
    expect(verdictOf([event()], 'claude')).toMatchObject({ verdict: 'no_traffic', attempts: 0, successRate: null });
  });

  test('healthy: it answered and almost nothing failed', () => {
    expect(verdictOf(Array.from({ length: 19 }, () => event()).concat(failed('server', 500)), 'zai')).toMatchObject({
      verdict: 'healthy',
      ok: 19,
      errors: 1,
    });
  });

  test('degraded: it answered but too often failed', () => {
    expect(verdictOf([event(), failed('rate_limit', 429), failed('rate_limit', 429)], 'zai').verdict).toBe('degraded');
  });

  test('failing: it never answered in the window, and the last error is named', () => {
    const verdict = verdictOf([failed('quota', 402, NOW - 3 * DAY_MS), failed('auth', 401, NOW - DAY_MS)], 'zai');
    expect(verdict).toMatchObject({
      verdict: 'failing',
      ok: 0,
      lastError: { errorClass: 'auth', httpStatus: 401, at: NOW - DAY_MS },
    });
  });

  test('skipped only: the provider was never contacted', () => {
    expect(verdictOf([skipped('circuit_open'), skipped('eligibility_bench')], 'zai')).toMatchObject({
      verdict: 'skipped_only',
      attempts: 2,
      successRate: null,
    });
  });

  test('a provider id the code no longer knows still appears, after the known ones', () => {
    const summary = summarizeAiUsage([event({ provider: 'retired' }), event()], WINDOW);
    expect(summary.providers.map((p) => p.provider)).toEqual(['zai', 'claude', 'hf', 'openrouter', 'retired']);
  });

  test('a historical gemini ledger row still appears after the configured providers and does not throw', () => {
    const summary = summarizeAiUsage([event({ provider: 'gemini', model: 'gemini-3-flash' }), event()], WINDOW);
    expect(summary.providers.map((p) => p.provider)).toEqual(['zai', 'claude', 'hf', 'openrouter', 'gemini']);
    expect(summary.providers.find((p) => p.provider === 'gemini')).toMatchObject({ verdict: 'healthy', ok: 1 });
  });

  test('a historical groq ledger row still appears after the configured providers and does not throw', () => {
    const summary = summarizeAiUsage([event({ provider: 'groq', model: 'openai/gpt-oss-120b' }), event()], WINDOW);
    expect(summary.providers.map((p) => p.provider)).toEqual(['zai', 'claude', 'hf', 'openrouter', 'groq']);
    expect(summary.providers.find((p) => p.provider === 'groq')).toMatchObject({ verdict: 'healthy', ok: 1 });
    expect(summary.models.map((m) => `${m.provider}:${m.model}`)).toContain('groq:openai/gpt-oss-120b');
  });

  test('a historical gemini local_budget skip row is counted, not rejected', () => {
    const summary = summarizeAiUsage(
      [event({ provider: 'gemini', model: 'gemini-3-flash', outcome: 'skipped', skipReason: 'local_budget' })],
      WINDOW,
    );
    const gemini = summary.providers.find((p) => p.provider === 'gemini');
    expect(gemini).toMatchObject({ verdict: 'skipped_only', skipped: 1 });
    expect(summary.models[0]?.skippedByReason).toEqual({ local_budget: 1 });
  });

  test('carries the window it summarised', () => {
    expect(summarizeAiUsage([], WINDOW).window).toEqual(WINDOW);
  });
});

describe('summarizeAiUsage — cost', () => {
  test('sums the known costs, billed failures included, and counts answers with an unknown cost apart', () => {
    const group = groupOf(
      [
        event({ costMicroUsd: 100 }),
        event({ costMicroUsd: 250 }),
        event({ costMicroUsd: null }),
        { ...failed('empty', null), costMicroUsd: 30 },
      ],
      'zai:glm-5.1',
    );

    expect(group.cost).toEqual({ sumMicroUsd: 380, reportedRows: 3, unknownRows: 1 });
  });

  test('a group with no known cost is unknown, never zero; a known zero stays zero', () => {
    expect(groupOf([event(), event()], 'zai:glm-5.1').cost).toEqual({
      sumMicroUsd: null,
      reportedRows: 0,
      unknownRows: 2,
    });
    expect(groupOf([event({ costMicroUsd: 0 })], 'zai:glm-5.1').cost).toEqual({
      sumMicroUsd: 0,
      reportedRows: 1,
      unknownRows: 0,
    });
  });
});

describe('summarizeAiUsage — roles', () => {
  const executor = (overrides: Partial<AiUsageEvent> = {}) =>
    event({
      provider: 'openrouter',
      model: 'z-ai/glm-5.3-flash',
      chain: 'role:executor',
      role: 'executor',
      preset: 'glm53-flash-low',
      ...overrides,
    });

  test('there is no role view while no row carries a role, so the legacy report is unchanged', () => {
    expect(summarizeAiUsage([event(), event()], WINDOW).roles).toEqual([]);
  });

  test('groups by role and provider, with latency, tokens and cost, and calls role-less rows legacy', () => {
    const summary = summarizeAiUsage(
      [
        executor({ durationMs: 100, costMicroUsd: 10 }),
        executor({ durationMs: 300, costMicroUsd: 30 }),
        executor({ durationMs: 900, costMicroUsd: null }),
        { ...executor(), outcome: 'error', errorClass: 'server', durationMs: 50, costMicroUsd: null },
        event({ durationMs: 40 }),
      ],
      WINDOW,
    );

    expect(summary.roles.map((r) => [r.role, r.provider])).toEqual([
      ['executor', 'openrouter'],
      ['legacy', 'zai'],
    ]);
    expect(summary.roles[0]).toMatchObject({
      ok: 3,
      errors: 1,
      p50DurationMs: 300,
      p95DurationMs: 900,
      cost: { sumMicroUsd: 40, reportedRows: 2, unknownRows: 1 },
    });
    // Every row of the fixture carries 10 prompt tokens, the failed attempt included.
    expect(summary.roles[0]?.tokens.prompt.sum).toBe(40);
    expect(summary.roles[1]).toMatchObject({ ok: 1, p50DurationMs: 40 });
  });

  test('orders planner, executor, repair, then legacy, and providers within a role in chain order', () => {
    const summary = summarizeAiUsage(
      [
        event(),
        executor({ role: 'repair', chain: 'role:repair' }),
        executor({ provider: 'claude', model: 'claude-haiku-5-5' }),
        executor(),
        executor({ role: 'planner', chain: 'role:planner' }),
      ],
      WINDOW,
    );

    expect(summary.roles.map((r) => `${r.role}/${r.provider}`)).toEqual([
      'planner/openrouter',
      'executor/claude',
      'executor/openrouter',
      'repair/openrouter',
      'legacy/zai',
    ]);
  });

  test('a skipped row is counted as skipped in the role view and does not lower its success rate', () => {
    const summary = summarizeAiUsage(
      [executor(), skipped('circuit_open', { role: 'executor', provider: 'openrouter' })],
      WINDOW,
    );

    expect(summary.roles[0]).toMatchObject({ ok: 1, skipped: 1, attempts: 2 });
    expect(summary.roles[0]?.successRate).toBe(1);
  });
});

describe('parseReportDays', () => {
  test('defaults to a week when no value is given', () => {
    expect(parseReportDays(undefined)).toBe(7);
    expect(parseReportDays('')).toBe(7);
  });

  test('accepts whole days from 1 to the retention horizon', () => {
    expect(parseReportDays('1')).toBe(1);
    expect(parseReportDays('30')).toBe(30);
    expect(parseReportDays(String(AI_USAGE_RETENTION_DAYS))).toBe(180);
  });

  test.each([
    '0',
    '181',
    '-3',
    '2.5',
    'abc',
    '7d',
    '1e2',
  ])('refuses %s, so a mistyped window is never silently widened', (raw) => {
    expect(parseReportDays(raw)).toBeNull();
  });
});
