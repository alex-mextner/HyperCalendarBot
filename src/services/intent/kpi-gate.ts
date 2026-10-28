// The KPI gate committed next to the seed (`docs/intents/kpi-gate.json`). A deploy may activate a
// new seed revision without a human only when this file names exactly that seed's fingerprint and
// its measurements on REAL scrubbed history clear the owner's bar. The bar lives in code (KPI_FLOORS):
// a gate file that lowers its own thresholds cannot lower it.
//
// The rule is on POINT ESTIMATES, with the 95% Wilson intervals recorded as information only. The real held-out
// split has 38 rule-eligible messages: 34 of 38 is 89.5% but its interval starts at 75.9%, and the lower end
// clears 80% only from 36 of 38. The owner's bar is therefore set on the point estimate; the intervals stay in
// the file, the benchmark output and every report, where nobody can mistake the point estimate for certainty.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const KPI_FLOORS = {
  /** Correct rule answers / rule-eligible confirmed messages of the real held-out split. */
  heldoutCoverage: 0.85,
  /** The same over real dev and held-out together. */
  pooledCoverage: 0.85,
  /** Correct / answered on each real split, confirmed labels only. At these sample sizes 0.99 means no wrong answer. */
  precision: 0.99,
  /** Pooled precision with the held-out answers that were relabelled after measuring counted as false matches. */
  strictPrecision: 0.975,
  /** Correct rule answers with no hard rubric finding (docs/intents/response-quality.md), real dev and held-out pooled. */
  rubric: 0.95,
  /** Correct / executed across the TZ/DST matrix on real messages. */
  execution: 0.99,
  /** Second audit on the synthetic held-out split. */
  syntheticCoverage: 0.8,
  syntheticPrecision: 0.99,
} as const;
type Floor = keyof typeof KPI_FLOORS;
const FLOORS = Object.keys(KPI_FLOORS) as Floor[];

const Ratio = z.number().min(0).max(1);
const Count = z.number().int().nonnegative();

const RealSplit = z
  .object({
    /** Confirmed messages a rule may answer. */
    inScope: Count,
    correct: Count,
    wrong: Count,
    /** A rule answered a confirmed message the AI should answer. */
    falseMatches: Count,
    /** A rule answered a message whose label said "AI" and was changed to "unclear" after measuring (counted by the strict figure). */
    relabelledFalseMatches: Count,
    coverage: Ratio,
    precision: Ratio,
    strictPrecision: Ratio,
    /** Correct answers with no hard rubric finding; `rubric` is this over `correct`. */
    rubricClean: Count,
    rubric: Ratio,
  })
  .strict();

const Interval = z.object({ low: Ratio, high: Ratio }).strict();

const KpiGateSchema = z
  .object({
    schemaVersion: z.literal(1),
    seedVersion: z.number().int().positive(),
    seedFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    rule: z.literal('real-history-point-estimate'),
    thresholds: z.object(Object.fromEntries(FLOORS.map((key) => [key, Ratio])) as Record<Floor, typeof Ratio>).strict(),
    real: z
      .object({
        heldout: RealSplit,
        dev: RealSplit,
        pooled: z
          .object({
            inScope: Count,
            correct: Count,
            coverage: Ratio,
            precision: Ratio,
            /** Rubric-clean over correct answers on both real splits together; the figure the rubric floor decides on. */
            rubric: Ratio,
            /** Counts the held-out relabelled answers only: dev rows were relabelled while developing on dev. */
            strictPrecision: Ratio,
            /** Informational: every relabelled answer, dev and held-out, counted. */
            strictPrecisionAllRelabelled: Ratio,
          })
          .strict(),
        execution: Ratio,
        matrixCells: Count,
        harmfulFalseMatches: Count,
        unconfirmedWrites: Count,
        exceptions: Count,
      })
      .strict(),
    synthetic: z
      .object({
        inScope: Count,
        correct: Count,
        coverage: Ratio,
        precision: Ratio,
        modelHistory: z.object({ version: z.string().min(1), checksum: z.string().regex(/^[0-9a-f]+$/) }).strict(),
        benchmarkResult: z.string().regex(/^docs\/intents\/benchmarks\/[A-Za-z0-9._-]+\.json$/),
      })
      .strict(),
    /** 95% Wilson intervals and caveats; never consulted by the verdict. */
    informational: z
      .object({
        intervals95: z
          .object({
            heldoutCoverage: Interval,
            pooledCoverage: Interval,
            heldoutPrecision: Interval,
            pooledPrecision: Interval,
            heldoutStrictPrecision: Interval,
          })
          .strict(),
        notes: z.array(z.string().min(1).max(400)).max(12),
      })
      .strict(),
    /** Checksums of the real corpus, labels and split the numbers come from. */
    realHistory: z
      .object({
        corpusChecksum: z.string().regex(/^[0-9a-f]{64}$/),
        labelsChecksum: z.string().regex(/^[0-9a-f]{64}$/),
        splitChecksum: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict(),
    /** Digest of the engine sources the measurement ran on; CI refuses a gate measured on other code. */
    engineDigest: z.string().regex(/^[0-9a-f]{64}$/),
    benchmarkResult: z.string().regex(/^docs\/intents\/benchmarks\/[A-Za-z0-9._-]+\.json$/),
    autoActivate: z.boolean(),
  })
  .strict();
export type KpiGate = z.infer<typeof KpiGateSchema>;
export type RealSplitMeasurement = z.infer<typeof RealSplit>;

export type KpiGateParse = { ok: true; gate: KpiGate } | { ok: false; reason: string };

export function parseKpiGate(text: string): KpiGateParse {
  let json: JsonText;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'gate file is not valid JSON' };
  }
  const parsed = KpiGateSchema.safeParse(json);
  if (parsed.success) return { ok: true, gate: parsed.data };
  const issue = parsed.error.issues[0];
  return {
    ok: false,
    reason: `gate file does not match the schema: ${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim(),
  };
}

/** `JSON.parse` output; only ever handed straight to the schema. */
type JsonText = string | number | boolean | null | JsonText[] | { [key: string]: JsonText };

export type KpiGateRead =
  | { status: 'ok'; gate: KpiGate }
  | { status: 'missing' }
  | { status: 'invalid'; reason: string };

/** Where the gate ships: beside the docs, resolved from this module so the image path needs no config. */
export const KPI_GATE_PATH = fileURLToPath(new URL('../../../docs/intents/kpi-gate.json', import.meta.url));

export function readKpiGate(path: string = KPI_GATE_PATH): KpiGateRead {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return { status: 'missing' };
    return {
      status: 'invalid',
      reason: `gate file is unreadable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const parsed = parseKpiGate(text);
  return parsed.ok ? { status: 'ok', gate: parsed.gate } : { status: 'invalid', reason: parsed.reason };
}

export type GateVerdict = { ok: true } | { ok: false; reasons: string[] };

const share = (numerator: number, denominator: number): number => (denominator === 0 ? 0 : numerator / denominator);
const RATIO_TOLERANCE = 1e-6;

/** The ratios of a split recomputed from its counts: the counts are the evidence, the ratios only a convenience. */
export function splitRatios(
  split: Pick<RealSplitMeasurement, 'inScope' | 'correct' | 'wrong' | 'falseMatches' | 'relabelledFalseMatches'>,
) {
  const answered = split.correct + split.wrong + split.falseMatches;
  return {
    coverage: share(split.correct, split.inScope),
    precision: share(split.correct, answered),
    strictPrecision: share(split.correct, answered + split.relabelledFalseMatches),
  };
}

/** What a recorded real split claims against what its own counts say. */
function splitConsistency(name: string, split: RealSplitMeasurement): string[] {
  const reasons: string[] = [];
  if (split.correct > split.inScope) reasons.push(`${name}: correct exceeds the in-scope count`);
  if (split.rubricClean > split.correct) reasons.push(`${name}: rubric-clean exceeds the correct count`);
  if (Math.abs(share(split.rubricClean, split.correct) - split.rubric) > RATIO_TOLERANCE)
    reasons.push(`${name}: recorded rubric ${split.rubric} does not follow from its counts`);
  const recomputed = splitRatios(split);
  for (const key of ['coverage', 'precision', 'strictPrecision'] as const)
    if (Math.abs(recomputed[key] - split[key]) > RATIO_TOLERANCE)
      reasons.push(`${name}: recorded ${key} ${split[key]} does not follow from its counts (${recomputed[key]})`);
  return reasons;
}

/** Every reason is collected so the boot log names all of them at once. */
export function gatePasses(gate: KpiGate, fingerprint: string): GateVerdict {
  const reasons: string[] = [];
  const { heldout, dev, pooled } = gate.real;
  if (gate.seedFingerprint !== fingerprint) reasons.push('gate fingerprint is not the fingerprint of this seed');
  if (!gate.autoActivate) reasons.push('autoActivate is not true');
  if (heldout.inScope === 0) reasons.push('the held-out in-scope set is empty');
  if (gate.synthetic.inScope === 0) reasons.push('the synthetic held-out in-scope set is empty');
  if (gate.real.matrixCells === 0) reasons.push('the TZ/DST matrix did not run (zero cells)');
  reasons.push(...splitConsistency('held-out', heldout), ...splitConsistency('dev', dev));
  const pooledInScope = heldout.inScope + dev.inScope;
  const pooledCorrect = heldout.correct + dev.correct;
  const pooledAnswered = pooledCorrect + heldout.wrong + dev.wrong + heldout.falseMatches + dev.falseMatches;
  if (pooled.inScope !== pooledInScope || pooled.correct !== pooledCorrect)
    reasons.push('pooled counts are not the sum of the two splits');
  const pooledFigures = {
    coverage: share(pooledCorrect, pooledInScope),
    rubric: share(heldout.rubricClean + dev.rubricClean, pooledCorrect),
    precision: share(pooledCorrect, pooledAnswered),
    strictPrecision: share(pooledCorrect, pooledAnswered + heldout.relabelledFalseMatches),
    strictPrecisionAllRelabelled: share(
      pooledCorrect,
      pooledAnswered + heldout.relabelledFalseMatches + dev.relabelledFalseMatches,
    ),
  };
  for (const key of Object.keys(pooledFigures) as (keyof typeof pooledFigures)[])
    if (Math.abs(pooledFigures[key] - pooled[key]) > RATIO_TOLERANCE)
      reasons.push(`pooled: recorded ${key} ${pooled[key]} does not follow from the counts (${pooledFigures[key]})`);
  if (gate.synthetic.correct > gate.synthetic.inScope) reasons.push('synthetic: correct exceeds the in-scope count');
  if (Math.abs(share(gate.synthetic.correct, gate.synthetic.inScope) - gate.synthetic.coverage) > RATIO_TOLERANCE)
    reasons.push('synthetic: recorded coverage does not follow from its counts');

  for (const key of FLOORS)
    if (gate.thresholds[key] < KPI_FLOORS[key])
      reasons.push(`${key} threshold ${gate.thresholds[key]} is below the floor ${KPI_FLOORS[key]}`);
  // Recomputed figures decide, never the recorded ratios; the recorded ones were checked against them above.
  const measured: { [key in Floor]: number } = {
    heldoutCoverage: share(heldout.correct, heldout.inScope),
    pooledCoverage: pooledFigures.coverage,
    precision: Math.min(splitRatios(heldout).precision, splitRatios(dev).precision),
    strictPrecision: pooledFigures.strictPrecision,
    rubric: pooledFigures.rubric,
    execution: gate.real.execution,
    syntheticCoverage: share(gate.synthetic.correct, gate.synthetic.inScope),
    syntheticPrecision: gate.synthetic.precision,
  };
  for (const key of FLOORS)
    if (measured[key] < gate.thresholds[key])
      reasons.push(`${key} ${measured[key]} is below its threshold ${gate.thresholds[key]}`);
  if (gate.real.harmfulFalseMatches !== 0) reasons.push(`${gate.real.harmfulFalseMatches} harmful false matches`);
  if (gate.real.unconfirmedWrites !== 0) reasons.push(`${gate.real.unconfirmedWrites} unconfirmed writes`);
  if (gate.real.exceptions !== 0) reasons.push(`${gate.real.exceptions} exceptions`);
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}
