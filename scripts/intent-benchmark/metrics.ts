// KPI aggregation of benchmark runs. Every ratio keeps its numerator and denominator next to it so a reader can see
// the sample size; a ratio over zero cases is null, never 0 or 1.
import { type Finding, hardFindings } from './rubric.ts';
import type { RunResult } from './run.ts';

export const ratio = (numerator: number, denominator: number): number | null =>
  denominator === 0 ? null : numerator / denominator;

export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index] ?? null;
}

export interface Counts {
  conversations: number;
  /** Messages a rule should answer. */
  inScope: number;
  /** Calendar-related messages the AI should answer. */
  aiIntentLike: number;
  /** Messages the AI should answer that are not about the calendar. */
  aiOther: number;
  /** Rule answered, correctly. */
  correct: number;
  /** Rule answered an in-scope message wrongly. */
  wrong: number;
  /** In-scope message that fell through to the AI. */
  missed: number;
  /** Rule answered a message the AI should have answered. */
  falseMatch: number;
  /** A false match that went on to change the calendar. */
  harmfulFalseMatch: number;
  unconfirmedWrites: number;
  exceptions: number;
  /** Correct answers with no hard rubric finding. */
  rubricClean: number;
  /** Correct answers after which no AI supplement turn is needed. */
  aiTurnAvoided: number;
  /** Labels the frozen clock contradicted (past time, DST gap, same weekday) and the oracle re-labelled AI-correct. */
  relabelled: number;
}

export interface Kpis {
  /** correct / inScope: the share of rule-eligible messages (those one complete request a rule may answer) answered correctly. */
  coverage: number | null;
  /** correct / all messages of the slice, including chit-chat and requests only the AI can answer: the plain share of traffic. */
  coverageOfAll: number | null;
  /** correct / (correct + wrong + falseMatch) */
  precision: number | null;
  /** correct / (inScope + calendar-related AI-correct messages): the broader, harder denominator */
  intentLikeCoverage: number | null;
  /** rubricClean / correct */
  rubricPass: number | null;
  /** (correct and rubric-clean) / inScope */
  qualityCoverage: number | null;
  /** aiTurnAvoided / correct */
  aiTurnAvoidedRate: number | null;
  /** (correct + falseNegativeOnAi) ... the share of AI-correct messages that correctly stayed with the AI */
  aiFallbackCorrect: number | null;
  /** In the TZ/DST matrix: correct / answered-by-a-rule among in-scope messages. */
  execution: number | null;
}

/** A ratio with its numerator, denominator and 95% Wilson score interval. */
export interface Interval {
  k: number;
  n: number;
  rate: number | null;
  low: number | null;
  high: number | null;
}

export interface Intervals {
  coverage: Interval;
  coverageOfAll: Interval;
  precision: Interval;
  rubricPass: Interval;
  execution: Interval;
  aiTurnAvoided: Interval;
}

export interface Slice extends Counts, Kpis {
  /** The same ratios with n and a 95% Wilson interval, so a small sample cannot pass for a precise one. */
  intervals: Intervals;
}

const Z95 = 1.959963984540054;

/** 95% Wilson score interval of k successes in n trials; null bounds for n = 0. */
export function wilson(k: number, n: number): Interval {
  if (n === 0) return { k, n, rate: null, low: null, high: null };
  const p = k / n;
  const z2 = Z95 * Z95;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (Z95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return { k, n, rate: p, low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

export function intervalsOf(c: Counts): Intervals {
  return {
    coverage: wilson(c.correct, c.inScope),
    coverageOfAll: wilson(c.correct, c.conversations),
    precision: wilson(c.correct, c.correct + c.wrong + c.falseMatch),
    rubricPass: wilson(c.rubricClean, c.correct),
    execution: wilson(c.correct, c.correct + c.wrong),
    aiTurnAvoided: wilson(c.aiTurnAvoided, c.correct),
  };
}

const emptyCounts = (): Counts => ({
  conversations: 0,
  inScope: 0,
  aiIntentLike: 0,
  aiOther: 0,
  correct: 0,
  wrong: 0,
  missed: 0,
  falseMatch: 0,
  harmfulFalseMatch: 0,
  unconfirmedWrites: 0,
  exceptions: 0,
  rubricClean: 0,
  aiTurnAvoided: 0,
  relabelled: 0,
});

function tally(counts: Counts, result: RunResult): void {
  const { expected, verdict } = result;
  counts.conversations++;
  if (expected.kind === 'rule') counts.inScope++;
  else {
    if (expected.intentLike) counts.aiIntentLike++;
    else counts.aiOther++;
    if (expected.relabelledFrom) counts.relabelled++;
  }
  if (verdict.unconfirmedWrite) counts.unconfirmedWrites++;
  if (verdict.exception) counts.exceptions++;
  if (verdict.harmfulFalseMatch) counts.harmfulFalseMatch++;
  switch (verdict.outcome) {
    case 'correct':
      counts.correct++;
      if (hardFindings(result.findings).length === 0) counts.rubricClean++;
      if (result.aiTurnAvoided) counts.aiTurnAvoided++;
      break;
    case 'wrong':
      counts.wrong++;
      break;
    case 'missed':
      counts.missed++;
      break;
    case 'false_match':
      counts.falseMatch++;
      break;
    default:
      break;
  }
}

function kpisOf(c: Counts): Kpis {
  const aiExpected = c.aiIntentLike + c.aiOther;
  return {
    coverage: ratio(c.correct, c.inScope),
    coverageOfAll: ratio(c.correct, c.conversations),
    precision: ratio(c.correct, c.correct + c.wrong + c.falseMatch),
    intentLikeCoverage: ratio(c.correct, c.inScope + c.aiIntentLike),
    rubricPass: ratio(c.rubricClean, c.correct),
    qualityCoverage: ratio(c.rubricClean, c.inScope),
    aiTurnAvoidedRate: ratio(c.aiTurnAvoided, c.correct),
    aiFallbackCorrect: ratio(aiExpected - c.falseMatch, aiExpected),
    execution: ratio(c.correct, c.correct + c.wrong),
  };
}

export function summarize(results: readonly RunResult[]): Slice {
  const counts = emptyCounts();
  for (const result of results) tally(counts, result);
  return { ...counts, ...kpisOf(counts), intervals: intervalsOf(counts) };
}

export function groupBy(
  results: readonly RunResult[],
  key: (result: RunResult) => string | undefined,
): { [group: string]: Slice } {
  const groups = new Map<string, RunResult[]>();
  for (const result of results) {
    const name = key(result);
    if (name === undefined) continue;
    const list = groups.get(name) ?? [];
    list.push(result);
    groups.set(name, list);
  }
  return Object.fromEntries(
    [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([name, list]) => [name, summarize(list)]),
  );
}

export const familyOf = (result: RunResult): string =>
  result.conversation.expect.route === 'rule'
    ? result.conversation.expect.family
    : `ai:${result.conversation.expect.why}`;

/** Failure classes for the report: why in-scope messages were not handled correctly. */
export function failureClasses(results: readonly RunResult[]): { [reason: string]: number } {
  const classes: { [reason: string]: number } = {};
  for (const result of results) {
    const { outcome, problems } = result.verdict;
    if (outcome !== 'missed' && outcome !== 'wrong' && outcome !== 'false_match') continue;
    const reason =
      outcome === 'missed'
        ? 'missed:fell_through_to_ai'
        : `${outcome}:${(problems[0] ?? 'unspecified').replace(/[0-9#]+/g, 'N').slice(0, 60)}`;
    classes[reason] = (classes[reason] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(classes).sort((a, b) => b[1] - a[1]));
}

export function findingCodes(results: readonly RunResult[]): { [code: string]: number } {
  const codes: { [code: string]: number } = {};
  const add = (finding: Finding) => {
    codes[finding.code] = (codes[finding.code] ?? 0) + 1;
  };
  for (const result of results) if (result.verdict.outcome === 'correct') hardFindings(result.findings).forEach(add);
  return Object.fromEntries(Object.entries(codes).sort((a, b) => b[1] - a[1]));
}
