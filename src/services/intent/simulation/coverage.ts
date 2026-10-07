// Honest intent coverage: every case lands in exactly one bucket, and only `covered` counts as
// success. Covered means the simulated run behaved like the case's independent label (class,
// expected tool families, confirmed writes, grounded reply) — a regex match alone is reported in
// the separate matcher-only column. Methodology: docs/intents/coverage-methodology.md; spec:
// docs/specs/2026-09-28-intent-recovery-334-coverage.md. Historical AI answers are carried for the
// three-way comparison only and are never treated as the expected answer.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMutationTool } from '../../ai/tool-executor.ts';
import { seedFingerprint } from '../rule-fingerprint.ts';
import type { CanonicalSeed } from '../seed-replacement.ts';
import { runSimulationChild } from './child.ts';
import { ruleRouter } from './routing.ts';
import type { AbstentionReason, SimulationCase, SimulationOutcome } from './simulator.ts';

export const LABEL_CLASSES = [
  'direct',
  'contextual',
  'clarification',
  'out_of_scope',
  'sensitive',
  'unsupported',
] as const;
export type LabelClass = (typeof LABEL_CLASSES)[number];
export const BUCKETS = [
  'covered',
  'correct_clarification',
  'missing_context',
  'ambiguous',
  'unsafe',
  'wrong_behavior',
  'missing_capture',
  'abstained',
  'excluded_sensitive',
  'unlabelled',
] as const;
export type Bucket = (typeof BUCKETS)[number];

export interface CaseLabel {
  class: LabelClass;
  family: string;
  expectedTools: string[];
  /** Independently written ideal answer; `null` when no ideal label exists yet. */
  idealResponse: string | null;
}
export interface CoverageCase extends SimulationCase {
  label: CaseLabel | null;
  sensitive: boolean;
  historicalAnswer: string | null;
  labelProvenance: 'verified' | 'unverified' | 'missing';
}
export interface CaseResult {
  caseId: string;
  bucket: Bucket;
  labelClass: LabelClass | null;
  intent: string | null;
  matcherOnly: 'matched' | AbstentionReason;
  tools: string[];
  labelProvenance: CoverageCase['labelProvenance'];
}
export interface ThreeWayRow {
  caseId: string;
  bucket: Bucket;
  historicalAnswer: string | null;
  simulatedReply: string | null;
  idealResponse: string | null;
  idealMissing: boolean;
  /** Scoring by the answer-quality rubric (docs/intents/response-quality.md) is not automated yet. */
  rubric: 'unscored';
}
type BucketCounts = { [bucket in Bucket]: number };
export interface CoverageSummary {
  cases: number;
  ruleCount: number;
  ruleFingerprint: string;
  buckets: BucketCounts;
  byClass: { [labelClass in LabelClass]: BucketCounts } & { unlabelled: BucketCounts };
  matcherOnly: { [key in 'matched' | AbstentionReason]: number };
  labelProvenance: { verified: number; unverified: number; missing: number };
  stubbedRender: number;
  calendarPolicy: string;
}
export interface CoverageReport {
  summary: CoverageSummary;
  cases: CaseResult[];
  outcomes: SimulationOutcome[];
  threeWay: ThreeWayRow[];
}

const ABSTENTION_BUCKET: { [reason in AbstentionReason]: Bucket } = {
  no_match: 'abstained',
  input_too_long: 'abstained',
  ambiguous: 'ambiguous',
  missing_capture: 'missing_capture',
};
/** Tools that talk to the requester rather than act; they never decide a family match. */
const INTERACTION_TOOLS = new Set(['ask_user', 'pick_users', 'end_conversation', 'set_reaction']);
const TOOL_FAMILY: { [tool: string]: string } = {
  get_events: 'events_read',
  get_upcoming: 'events_read',
  search_events: 'events_read',
  get_event: 'events_read',
  render_day_image: 'image',
  render_week_image: 'image',
  render_month_image: 'image',
  render_table: 'image',
};
const familyOf = (tool: string) => TOOL_FAMILY[tool] ?? tool;
const familySet = (tools: string[]) =>
  [...new Set(tools.filter((tool) => !INTERACTION_TOOLS.has(tool)).map(familyOf))].sort();
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((item, index) => item === b[index]);

/** Exhaustive over the matcher's abstention reasons; a reason added later fails loudly here. */
function abstentionBucket(reason: AbstentionReason): Bucket {
  const bucket = ABSTENTION_BUCKET[reason];
  if (!bucket) throw new Error(`Unmapped matcher abstention reason: ${reason}`);
  return bucket;
}

/** Cases that are bucketed before, and instead of, simulation. */
export function preSimulationBucket(coverageCase: CoverageCase): Bucket | null {
  if (coverageCase.sensitive || coverageCase.label?.class === 'sensitive') return 'excluded_sensitive';
  // Prior-turn references reach the simulator only with the reference store (#557); until then a
  // contextual case has nothing to resolve against.
  if (coverageCase.label?.class === 'contextual') return 'missing_context';
  return null;
}

function isUnsafe(label: CaseLabel, outcome: SimulationOutcome): boolean {
  const readLabel = !label.expectedTools.some((tool) => isMutationTool(tool, {}));
  return (
    outcome.blockedExternal.length > 0 ||
    outcome.tools.some((tool) => tool.write && !tool.afterConfirmation) ||
    (readLabel && outcome.writeOutcome !== 'none')
  );
}

function behavesAsLabelled(label: CaseLabel, outcome: SimulationOutcome): boolean {
  if (!outcome.handled || outcome.askedClarification || !outcome.reply || !outcome.grounding.grounded) return false;
  const succeeded = outcome.tools.filter((tool) => tool.success);
  const expectedWrites = label.expectedTools.filter((tool) => isMutationTool(tool, {}));
  if (expectedWrites.length === 0)
    return (
      outcome.writeOutcome === 'none' &&
      sameSet(familySet(succeeded.map((t) => t.name)), familySet(label.expectedTools))
    );
  const writes = succeeded.filter((tool) => tool.write).map((tool) => tool.name);
  return outcome.writeOutcome === 'applied' && sameSet(familySet(writes), familySet(expectedWrites));
}

export function classifyOutcome(label: CaseLabel | null, outcome: SimulationOutcome): Bucket {
  if (!label) return 'unlabelled';
  if (outcome.routed.status === 'abstained') return abstentionBucket(outcome.routed.reason);
  if (isUnsafe(label, outcome)) return 'unsafe';
  if (outcome.error !== null) return 'wrong_behavior';
  if (label.class === 'clarification')
    return outcome.askedClarification && outcome.writeOutcome === 'none' ? 'correct_clarification' : 'wrong_behavior';
  if (label.class !== 'direct' && label.class !== 'contextual') return 'wrong_behavior';
  return behavesAsLabelled(label, outcome) ? 'covered' : 'wrong_behavior';
}

const emptyCounts = (): BucketCounts => ({
  covered: 0,
  correct_clarification: 0,
  missing_context: 0,
  ambiguous: 0,
  unsafe: 0,
  wrong_behavior: 0,
  missing_capture: 0,
  abstained: 0,
  excluded_sensitive: 0,
  unlabelled: 0,
});
const CALENDAR_POLICY =
  'Each case runs on its own synthetic calendar (fixtures) or an empty one (private corpus); production calendars are never read.';
const SIMULATION_TIMEOUT_MS = 30 * 60 * 1000;

function summarize(
  rules: readonly CanonicalSeed[],
  cases: CaseResult[],
  outcomes: SimulationOutcome[],
): CoverageSummary {
  const byClass = {
    direct: emptyCounts(),
    contextual: emptyCounts(),
    clarification: emptyCounts(),
    out_of_scope: emptyCounts(),
    sensitive: emptyCounts(),
    unsupported: emptyCounts(),
    unlabelled: emptyCounts(),
  };
  const buckets = emptyCounts();
  const matcherOnly = { matched: 0, no_match: 0, ambiguous: 0, missing_capture: 0, input_too_long: 0 };
  const labelProvenance = { verified: 0, unverified: 0, missing: 0 };
  for (const row of cases) {
    buckets[row.bucket] += 1;
    byClass[row.labelClass ?? 'unlabelled'][row.bucket] += 1;
    matcherOnly[row.matcherOnly] += 1;
    labelProvenance[row.labelProvenance] += 1;
  }
  return {
    cases: cases.length,
    ruleCount: rules.length,
    ruleFingerprint: seedFingerprint(rules),
    buckets,
    byClass,
    matcherOnly,
    labelProvenance,
    stubbedRender: outcomes.filter((outcome) => outcome.stubbed.length > 0).length,
    calendarPolicy: CALENDAR_POLICY,
  };
}

function caseResult(
  coverageCase: CoverageCase,
  bucket: Bucket,
  routed: 'matched' | AbstentionReason,
  intent: string | null,
  outcome: SimulationOutcome | undefined,
): CaseResult {
  return {
    caseId: coverageCase.caseId,
    bucket,
    labelClass: coverageCase.label?.class ?? null,
    intent,
    matcherOnly: routed,
    tools: outcome?.tools.map((tool) => tool.name) ?? [],
    labelProvenance: coverageCase.labelProvenance,
  };
}

/** Routes every case, simulates the ones not bucketed up front, and classifies each exactly once. */
export async function measureCoverage(
  rules: readonly CanonicalSeed[],
  cases: readonly CoverageCase[],
): Promise<CoverageReport> {
  const { matcher, nameOf } = ruleRouter(rules);
  const toSimulate = cases.filter((coverageCase) => preSimulationBucket(coverageCase) === null);
  const simulated = toSimulate.map(({ caseId, request, at, timezone, language, calendar }) => ({
    caseId,
    request,
    at,
    timezone,
    language,
    calendar,
  }));
  const outcomes =
    simulated.length > 0
      ? await runSimulationChild({ rules, cases: simulated }, { timeoutMs: SIMULATION_TIMEOUT_MS })
      : [];
  const byId = new Map(outcomes.map((outcome) => [outcome.caseId, outcome]));
  const results: CaseResult[] = [];
  const threeWay: ThreeWayRow[] = [];
  for (const coverageCase of cases) {
    const outcome = byId.get(coverageCase.caseId);
    // Simulated cases report the child's own routing; the rest are routed here, without a clock.
    let routed: CaseResult['matcherOnly'];
    let intent: string | null = null;
    if (outcome) {
      routed = outcome.routed.status === 'matched' ? 'matched' : outcome.routed.reason;
      if (outcome.routed.status === 'matched') intent = outcome.routed.intent;
    } else {
      const decision = matcher.explain(coverageCase.request);
      routed = decision.kind === 'matched' ? 'matched' : decision.reason;
      if (decision.kind === 'matched') intent = nameOf(decision.result.intentId);
    }
    const early = preSimulationBucket(coverageCase);
    if (early === null && !outcome) throw new Error(`Simulator returned no outcome for ${coverageCase.caseId}`);
    const bucket = early ?? classifyOutcome(coverageCase.label, outcome!);
    results.push(caseResult(coverageCase, bucket, routed, intent, outcome));
    const idealResponse = coverageCase.label?.idealResponse ?? null;
    threeWay.push({
      caseId: coverageCase.caseId,
      bucket,
      historicalAnswer: coverageCase.historicalAnswer,
      simulatedReply: outcome?.reply ?? null,
      idealResponse,
      idealMissing: idealResponse === null,
      rubric: 'unscored',
    });
  }
  return { summary: summarize(rules, results, outcomes), cases: results, outcomes, threeWay };
}

/** Per-case bucket changes from report `a` to report `b`; gains and losses count `covered` only. */
export function compareReports(
  a: CoverageReport,
  b: CoverageReport,
): { gained: string[]; lost: string[]; changed: { caseId: string; from: Bucket; to: Bucket }[] } {
  const after = new Map(b.cases.map((row) => [row.caseId, row.bucket]));
  const gained: string[] = [];
  const lost: string[] = [];
  const changed: { caseId: string; from: Bucket; to: Bucket }[] = [];
  for (const row of a.cases) {
    const to = after.get(row.caseId);
    if (to === undefined) throw new Error(`Case ${row.caseId} is missing from the second report`);
    if (to === row.bucket) continue;
    changed.push({ caseId: row.caseId, from: row.bucket, to });
    if (to === 'covered') gained.push(row.caseId);
    if (row.bucket === 'covered') lost.push(row.caseId);
  }
  return { gained, lost, changed };
}

export type Comparison = ReturnType<typeof compareReports>;

/**
 * Private output: counts in summary.json (with the gained/lost case ids of a comparison), per-case
 * buckets without request text in cases.jsonl, per-case bucket changes in comparison.jsonl, and
 * the three-answer comparison (which does carry answer texts) in three-way.jsonl. The caller
 * checks the directory with assertPrivateOutputDir first.
 */
export function writeReport(dir: string, report: CoverageReport, comparison: Comparison | null = null): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lines = (rows: readonly unknown[]) => `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
  const summary = {
    ...report.summary,
    comparison: comparison && { gained: comparison.gained, lost: comparison.lost },
  };
  writeFileSync(join(dir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(join(dir, 'cases.jsonl'), lines(report.cases), { mode: 0o600 });
  writeFileSync(join(dir, 'three-way.jsonl'), lines(report.threeWay), { mode: 0o600 });
  if (comparison) writeFileSync(join(dir, 'comparison.jsonl'), lines(comparison.changed), { mode: 0o600 });
}
