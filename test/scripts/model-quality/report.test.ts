import { expect, test } from 'bun:test';
import { aggregate, renderReport, wilson95 } from '../../../scripts/model-quality/report.ts';
import type { MeasuredRow } from '../../../scripts/model-quality/runner.ts';
import { ROLE_PASS_MIN } from '../../../src/services/ai/model-presets.ts';

function row(patch: Partial<MeasuredRow>): MeasuredRow {
  return {
    role: 'executor',
    candidate: 'deepseek41-flash@openrouter',
    presetId: 'deepseek41-flash',
    provider: 'openrouter',
    model: 'deepseek/deepseek-v4.1-flash',
    caseId: 'today',
    family: 'read',
    repetition: 0,
    pass: true,
    critical: false,
    reasons: [],
    durationMs: 1000,
    error: null,
    status: null,
    rounds: 2,
    roundMs: [400, 600],
    finishReasons: ['tool_calls', 'stop'],
    inputTokens: 40_000,
    outputTokens: 200,
    reasoningTokens: null,
    cachedTokens: null,
    usageMissing: false,
    costUsd: 0.01,
    costSource: 'reported',
    unknownCostReservationUsd: 0,
    ...patch,
  };
}

const meta = { sha: 'abc', generatedAt: '2026-10-23T20:00:00Z', runs: ['r1'] };

test('every attempt is in the denominator: errors and timeouts count as failures', () => {
  const rows = [row({}), row({ pass: false, error: 'TIMEOUT', reasons: ['error:TIMEOUT'] }), row({})];
  const cell = aggregate(rows, meta).cells[0]!;
  expect(cell.n).toBe(3);
  expect(cell.passed).toBe(2);
  expect(cell.passRate).toBeCloseTo(2 / 3, 9);
  expect(cell.errors).toBe(1);
});

test('the 95% own-role threshold is the registry constant and 30 of 32 does not clear it', () => {
  const rows = Array.from({ length: 32 }, (_, i) => row({ caseId: `c${i}`, pass: i >= 2 }));
  const cell = aggregate(rows, meta).cells[0]!;
  expect(cell.threshold).toBe(ROLE_PASS_MIN);
  expect(cell.meetsOwnRoleThreshold).toBe(false);
  const ok = aggregate(
    Array.from({ length: 32 }, (_, i) => row({ caseId: `c${i}`, pass: i >= 1 })),
    meta,
  ).cells[0]!;
  expect(ok.meetsOwnRoleThreshold).toBe(true);
});

test('qualification is null whatever the pass-rate: the history gate cannot be evaluated', () => {
  const report = aggregate([row({}), row({})], meta);
  expect(report.qualification).toBeNull();
  expect(report.cells[0]?.meetsOwnRoleThreshold).toBe(true);
  expect(report.historyGate.status).toBe('not_evaluated');
  expect(report.historyGate.reason).toContain('565');
  expect(JSON.stringify(report)).not.toContain('"qualified":true');
});

test('latency: median over every attempt, successful-only median beside it, per-round median', () => {
  const rows = [
    row({ durationMs: 1000 }),
    row({ durationMs: 3000 }),
    row({ durationMs: 30_000, pass: false, error: 'TIMEOUT', roundMs: [30_000] }),
  ];
  const cell = aggregate(rows, meta).cells[0]!;
  expect(cell.p50Ms).toBe(3000);
  expect(cell.passedP50Ms).toBe(1000);
  expect(cell.roundP50Ms).toBe(600);
});

test('cost per scenario uses only attempts whose usage arrived and counts the rest explicitly', () => {
  const rows = [
    row({ costUsd: 0.01 }),
    row({ costUsd: 0.03 }),
    row({ costUsd: 0.002, usageMissing: true, unknownCostReservationUsd: 0.05, pass: false, error: 'HTTP_500' }),
  ];
  const cell = aggregate(rows, meta).cells[0]!;
  expect(cell.costPerScenarioUsd).toBeCloseTo(0.02, 9);
  expect(cell.costKnownRows).toBe(2);
  expect(cell.usageMissingRows).toBe(1);
  expect(cell.totalCostKnownUsd).toBeCloseTo(0.042, 9);
  expect(cell.unknownReservationUsd).toBeCloseTo(0.05, 9);
});

test('a cell with no known cost reports null, never zero', () => {
  const cell = aggregate([row({ costUsd: null, costSource: 'unknown', usageMissing: true })], meta).cells[0]!;
  expect(cell.costPerScenarioUsd).toBeNull();
});

test('cells are kept apart per candidate and role', () => {
  const rows = [
    row({}),
    row({ role: 'repair' }),
    row({ candidate: 'haiku@claude', presetId: 'haiku', provider: 'claude', model: 'claude-haiku-5-5' }),
  ];
  const keys = aggregate(rows, meta).cells.map((c) => `${c.candidate}/${c.role}`);
  expect(keys).toEqual([
    'deepseek41-flash@openrouter/executor',
    'deepseek41-flash@openrouter/repair',
    'haiku@claude/executor',
  ]);
});

test('failure reasons are listed with counts so a pass-rate cannot hide what failed', () => {
  const rows = [
    row({ pass: false, reasons: ['missing_or_wrong:get_events', 'error:TIMEOUT'] }),
    row({ pass: false, reasons: ['missing_or_wrong:get_events'] }),
    row({}),
  ];
  expect(aggregate(rows, meta).cells[0]?.failureReasons).toEqual({
    'missing_or_wrong:get_events': 2,
    'error:TIMEOUT': 1,
  });
});

test('Wilson interval: 31 of 32 is not a guarantee of 95%', () => {
  const [low, high] = wilson95(31, 32);
  expect(low).toBeLessThan(0.95);
  expect(high).toBeGreaterThan(0.95);
  expect(wilson95(0, 0)).toEqual([null, null]);
});

test('the readable report states the null qualification and the unevaluated history gate', () => {
  const text = renderReport(aggregate([row({}), row({ pass: false, error: 'TIMEOUT' })], meta));
  expect(text).toContain('qualification: null');
  expect(text).toContain('#565');
  expect(text).toContain('deepseek41-flash@openrouter');
});
