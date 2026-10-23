// scripts/model-quality/report.ts
// Turns raw run rows into per-candidate, per-role measurements against the registry's own-role threshold.
// It never admits a preset: `qualification` is always null here, because the other half of the gate (every
// case of the labelled history, #565) has no corpus to run on. Raw rows are read, never rewritten.
//
//   bun scripts/model-quality/report.ts --out <new dir> <run dir> [<run dir> ...]

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { HISTORY_PASS_REQUIRED, MODEL_ROLES, ROLE_PASS_MIN } from '../../src/services/ai/model-presets.ts';
import type { MeasuredRow } from './runner.ts';

const rowSchema = z.object({
  role: z.enum(MODEL_ROLES),
  candidate: z.string(),
  presetId: z.string(),
  provider: z.string(),
  model: z.string(),
  caseId: z.string(),
  family: z.string(),
  repetition: z.number(),
  pass: z.boolean(),
  critical: z.boolean(),
  reasons: z.array(z.string()),
  durationMs: z.number(),
  error: z.string().nullable(),
  status: z.number().nullable(),
  rounds: z.number(),
  roundMs: z.array(z.number()),
  finishReasons: z.array(z.string()),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  reasoningTokens: z.number().nullable(),
  cachedTokens: z.number().nullable(),
  usageMissing: z.boolean(),
  costUsd: z.number().nullable(),
  costSource: z.enum(['reported', 'list-estimate', 'unknown']),
  unknownCostReservationUsd: z.number(),
});

export interface ReportMeta {
  sha: string;
  generatedAt: string;
  /** Names of the run directories the rows came from. */
  runs: string[];
}

export interface Cell {
  candidate: string;
  role: string;
  model: string;
  n: number;
  passed: number;
  passRate: number;
  wilson95: [number | null, number | null];
  threshold: number;
  /** Own-role threshold only; says nothing about the history gate. */
  meetsOwnRoleThreshold: boolean;
  critical: number;
  errors: number;
  byFamily: Record<string, { n: number; passed: number }>;
  failureReasons: Record<string, number>;
  p50Ms: number | null;
  p95Ms: number | null;
  passedP50Ms: number | null;
  roundP50Ms: number | null;
  costKnownRows: number;
  usageMissingRows: number;
  costPerScenarioUsd: number | null;
  totalCostKnownUsd: number | null;
  unknownReservationUsd: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface Report {
  schema: 'hcb-role-measurements/1';
  meta: ReportMeta;
  thresholds: { ownRolePassMin: number; historyPassRequired: number };
  historyGate: { status: 'not_evaluated'; reason: string };
  /** Always null: this report cannot qualify a preset. */
  qualification: null;
  cells: Cell[];
}

function percentile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] ?? null;
}

function sum(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) : null;
}

export function wilson95(passed: number, n: number): [number | null, number | null] {
  if (n === 0) return [null, null];
  const z = 1.96;
  const p = passed / n;
  const denominator = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

function cellOf(rows: MeasuredRow[]): Cell {
  const first = rows[0]!;
  const passed = rows.filter((r) => r.pass).length;
  const costRows = rows.filter((r) => !r.usageMissing && r.costUsd !== null);
  const known = rows.flatMap((r) => (r.costUsd === null ? [] : [r.costUsd]));
  const byFamily: Cell['byFamily'] = {};
  const failureReasons: Cell['failureReasons'] = {};
  for (const r of rows) {
    const bucket = byFamily[r.family] ?? { n: 0, passed: 0 };
    bucket.n++;
    if (r.pass) bucket.passed++;
    byFamily[r.family] = bucket;
    if (!r.pass) for (const reason of r.reasons) failureReasons[reason] = (failureReasons[reason] ?? 0) + 1;
  }
  const costTotal = sum(costRows.map((r) => r.costUsd ?? 0));
  const tokens = (pick: (r: MeasuredRow) => number | null) =>
    sum(rows.flatMap((r) => (pick(r) === null ? [] : [pick(r)!])));
  return {
    candidate: first.candidate,
    role: first.role,
    model: first.model,
    n: rows.length,
    passed,
    passRate: passed / rows.length,
    wilson95: wilson95(passed, rows.length),
    threshold: ROLE_PASS_MIN,
    meetsOwnRoleThreshold: passed / rows.length >= ROLE_PASS_MIN,
    critical: rows.filter((r) => r.critical).length,
    errors: rows.filter((r) => r.error !== null).length,
    byFamily,
    failureReasons,
    p50Ms: percentile(
      rows.map((r) => r.durationMs),
      0.5,
    ),
    p95Ms: percentile(
      rows.map((r) => r.durationMs),
      0.95,
    ),
    passedP50Ms: percentile(
      rows.filter((r) => r.pass).map((r) => r.durationMs),
      0.5,
    ),
    roundP50Ms: percentile(
      rows.flatMap((r) => r.roundMs),
      0.5,
    ),
    costKnownRows: costRows.length,
    usageMissingRows: rows.filter((r) => r.usageMissing).length,
    costPerScenarioUsd: costTotal === null ? null : costTotal / costRows.length,
    totalCostKnownUsd: sum(known),
    unknownReservationUsd: rows.reduce((a, r) => a + r.unknownCostReservationUsd, 0),
    inputTokens: tokens((r) => r.inputTokens),
    outputTokens: tokens((r) => r.outputTokens),
  };
}

export function aggregate(rows: MeasuredRow[], meta: ReportMeta): Report {
  const groups = new Map<string, MeasuredRow[]>();
  for (const r of rows) {
    const key = `${r.candidate}/${r.role}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return {
    schema: 'hcb-role-measurements/1',
    meta,
    thresholds: { ownRolePassMin: ROLE_PASS_MIN, historyPassRequired: HISTORY_PASS_REQUIRED },
    historyGate: {
      status: 'not_evaluated',
      reason:
        'The history gate needs a labelled corpus of real LLM conversations (#565), which does not exist; the #562 corpus is 667 deterministic parser cases with zero LLM calls.',
    },
    qualification: null,
    cells: [...groups.values()].map(cellOf),
  };
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const ms = (x: number | null): string => (x === null ? 'n/a' : `${Math.round(x)} ms`);
const usd = (x: number | null): string => (x === null ? 'n/a' : `$${x.toFixed(5)}`);

export function renderReport(report: Report): string {
  const lines = [
    '# Измерение ролей planner / executor / repair',
    '',
    `Источник: \`${report.meta.sha}\`. Сформировано ${report.meta.generatedAt}. Прогоны: ${report.meta.runs.join(', ')}.`,
    '',
    `qualification: null. Порог собственной роли ${pct(report.thresholds.ownRolePassMin)} проверен, второй критерий (100% размеченной истории) не вычислен: ${report.historyGate.reason} Пока #565 не существует, ни один пресет не получает квалификацию.`,
    '',
    '| модель | роль | n | pass | pass-rate | Wilson 95% | порог 95% | p50 | p50 успешных | p50 раунда | стоимость/сценарий | без usage |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const c of report.cells) {
    const [low, high] = c.wilson95;
    lines.push(
      `| ${c.candidate} | ${c.role} | ${c.n} | ${c.passed} | ${pct(c.passRate)} | ${low === null || high === null ? 'n/a' : `${pct(low)}–${pct(high)}`} | ${c.meetsOwnRoleThreshold ? 'да' : 'нет'} | ${ms(c.p50Ms)} | ${ms(c.passedP50Ms)} | ${ms(c.roundP50Ms)} | ${usd(c.costPerScenarioUsd)} | ${c.usageMissingRows} |`,
    );
  }
  lines.push('', '## Причины неудач', '');
  for (const c of report.cells) {
    const reasons = Object.entries(c.failureReasons).sort(([, a], [, b]) => b - a);
    lines.push(
      `- ${c.candidate} / ${c.role}: ${reasons.length ? reasons.map(([r, n]) => `${r} ×${n}`).join(', ') : 'нет'}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

function readRows(dir: string): { rows: MeasuredRow[]; sha256: string } {
  const file = join(dir, 'results.jsonl');
  const text = readFileSync(file, 'utf8');
  const rows = text
    .split('\n')
    .filter(Boolean)
    .map((line) => rowSchema.parse(JSON.parse(line)));
  return { rows: rows as MeasuredRow[], sha256: createHash('sha256').update(text).digest('hex') };
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: { out: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  });
  if (!values.out || !positionals.length) throw new Error('usage: report.ts --out <new dir> <run dir>...');
  const out = resolve(values.out);
  if (existsSync(out)) throw new Error('Report directory already exists; evidence is append-only');
  const inputs = positionals.map((p) => resolve(p));
  const read = inputs.map(readRows);
  const sha = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { stdout: 'pipe' }).stdout.toString().trim();
  const report = aggregate(
    read.flatMap((r) => r.rows),
    { sha, generatedAt: new Date().toISOString(), runs: inputs.map((p) => p.split('/').pop() ?? p) },
  );
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const sources = Object.fromEntries(inputs.map((p, i) => [p.split('/').pop() ?? p, read[i]?.sha256]));
  writeFileSync(join(out, 'report.json'), `${JSON.stringify({ ...report, sourceResultsSha256: sources }, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  writeFileSync(join(out, 'report.ru.md'), renderReport(report), { flag: 'wx', mode: 0o600 });
  console.log(`REPORT_WRITTEN ${out}`);
}
