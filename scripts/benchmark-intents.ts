// Offline, deterministic intent benchmark on the model history (docs/intents/model-history) or the scrubbed real
// history (docs/intents/real-history). No network.
//   bun --no-env-file scripts/benchmark-intents.ts [--rules current|FILE.json] [--label NAME] [--matrix N]
//        [--rounds N] [--write] [--history synthetic|real]
//   bun --no-env-file scripts/benchmark-intents.ts --gate [--matrix N]
// --write appends the result to docs/intents/benchmarks/ (never overwrites; a result for the same rule set, engine
// digest and history is reused instead of duplicated). --gate measures BOTH histories (real with the TZ/DST matrix,
// synthetic as the second audit), appends both results and writes docs/intents/kpi-gate.json when the point-estimate
// rule in src/services/intent/kpi-gate.ts passes; otherwise it prints every reason, exits 3 and leaves the committed
// gate untouched.
import './intent-benchmark/quiet.ts';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import {
  gatePasses,
  KPI_FLOORS,
  type KpiGate,
  parseKpiGate,
  type RealSplitMeasurement,
  splitRatios,
} from '../src/services/intent/kpi-gate.ts';
import { type BenchmarkRun, loadHistory, loadRules, runBenchmark } from './intent-benchmark/benchmark.ts';
import { engineDigest } from './intent-benchmark/engine-digest.ts';
import { type Interval, type Slice, wilson } from './intent-benchmark/metrics.ts';
import { type LoadedRealHistory, loadRealHistory } from './intent-benchmark/real-history.ts';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    rules: { type: 'string', default: 'current' },
    label: { type: 'string', default: 'current' },
    matrix: { type: 'string' },
    rounds: { type: 'string', default: '3' },
    write: { type: 'boolean', default: false },
    gate: { type: 'boolean', default: false },
    history: { type: 'string' },
  },
  strict: true,
});

const ROOT = new URL('..', import.meta.url);
const BENCHMARKS = 'docs/intents/benchmarks';
const GATE_FILE = 'docs/intents/kpi-gate.json';
/** The synthetic audit replays every tenth conversation across the matrix; it is an audit, not the claim. */
const SYNTHETIC_MATRIX_STEP = 10;

const git = (...args: string[]): string => {
  const out = Bun.spawnSync(['git', ...args], { cwd: ROOT.pathname });
  return new TextDecoder().decode(out.stdout).trim();
};
const pct = (value: number | null): string => (value === null ? '   n/a' : `${(value * 100).toFixed(1).padStart(5)}%`);
const row = (name: string, slice: Slice): string =>
  `${name.padEnd(28)} n=${String(slice.conversations).padStart(4)} cov ${pct(slice.coverage)} prec ${pct(slice.precision)} rub ${pct(slice.rubricPass)} exec ${pct(slice.execution)} aiAvoid ${pct(slice.aiTurnAvoidedRate)}`;
const ci = (name: string, interval: Interval): string =>
  `${name} ${interval.k}/${interval.n} = ${pct(interval.rate)} [95% CI ${pct(interval.low)} .. ${pct(interval.high)}]`;

if (values.history !== undefined && values.history !== 'real' && values.history !== 'synthetic')
  throw new Error('--history is synthetic or real');
if (values.gate && values.history !== undefined) throw new Error('--gate measures both histories; drop --history');

const digest = engineDigest();

const StoredResult = z.object({
  ruleSet: z.object({ fingerprint: z.string() }),
  modelHistory: z.object({ checksum: z.string() }),
  source: z.object({ engineDigest: z.string() }),
  matrix: z.object({ cells: z.number() }).nullable(),
});

interface Measurement {
  kind: 'real' | 'synthetic';
  run: BenchmarkRun;
  real: LoadedRealHistory | null;
  resultFile: string | null;
}

/** An earlier result file for the same rule set, engine and history, so a gate refresh does not clutter the folder. */
function existingResult(report: BenchmarkRun['report']): string | null {
  for (const name of readdirSync(new URL(`${BENCHMARKS}/`, ROOT))) {
    if (!name.endsWith('.json')) continue;
    const parsed = StoredResult.safeParse(JSON.parse(readFileSync(new URL(`${BENCHMARKS}/${name}`, ROOT), 'utf8')));
    if (
      parsed.success &&
      parsed.data.ruleSet.fingerprint === report.ruleSet.fingerprint &&
      parsed.data.modelHistory.checksum === report.modelHistory.checksum &&
      parsed.data.source.engineDigest === digest &&
      (parsed.data.matrix?.cells ?? 0) >= (report.matrix?.cells ?? 0)
    )
      return `${BENCHMARKS}/${name}`;
  }
  return null;
}

function print(kind: 'real' | 'synthetic', report: BenchmarkRun['report']): void {
  if (report.real) {
    for (const side of ['heldout', 'dev'] as const) {
      const confirmed = report.real.confirmed[side].overall;
      const relabelled = report.real.unclear[side].falseMatch;
      console.log(
        `REAL ${side}, confirmed labels only (${confirmed.conversations} messages, ${confirmed.inScope} rule-eligible; unclear: ${report.real.unclear[side].conversations}):`,
      );
      console.log(`  ${ci('coverage of rule-eligible', confirmed.intervals.coverage)}`);
      console.log(`  ${ci('coverage of all messages ', confirmed.intervals.coverageOfAll)}`);
      console.log(`  ${ci('precision               ', confirmed.intervals.precision)}`);
      console.log(
        `  ${ci('strict precision        ', wilson(confirmed.correct, confirmed.correct + confirmed.wrong + confirmed.falseMatch + relabelled))} (${relabelled} relabelled-unclear false matches counted)`,
      );
      console.log(`  ${ci('rubric pass             ', confirmed.intervals.rubricPass)}`);
      console.log(`  ${ci('AI turn avoided         ', confirmed.intervals.aiTurnAvoided)}`);
    }
    if (report.matrix) console.log(`  ${ci('execution (matrix)      ', report.matrix.overall.intervals.execution)}`);
  }
  console.log(
    `${kind}: rule set ${report.ruleSet.rules} rules ${report.ruleSet.fingerprint.slice(0, 12)}  history v${report.modelHistory.version} ${report.modelHistory.checksum.slice(0, 12)}`,
  );
  console.log(row('dev', report.dev.overall));
  console.log(row('heldout', report.heldout.overall));
  console.log(row('all', report.all.overall));
  if (report.matrix) console.log(row(`matrix (${report.matrix.cells} cells)`, report.matrix.overall));
  console.log(
    `heldout: intent-like coverage ${pct(report.heldout.overall.intentLikeCoverage)}, quality coverage ${pct(report.heldout.overall.qualityCoverage)}, ai fallback correct ${pct(report.heldout.overall.aiFallbackCorrect)}, unconfirmed writes ${report.all.overall.unconfirmedWrites}, exceptions ${report.all.overall.exceptions}, harmful false matches ${report.all.overall.harmfulFalseMatch}, relabelled ${report.all.overall.relabelled}`,
  );
  console.log(
    `latency matcher p50 ${report.latency.matcherMicrosP50?.toFixed(1)}µs p95 ${report.latency.matcherMicrosP95?.toFixed(1)}µs, layer p50 ${report.latency.layerMsP50?.toFixed(1)}ms p95 ${report.latency.layerMsP95?.toFixed(1)}ms`,
  );
}

async function measure(kind: 'real' | 'synthetic', matrixStep: number, write: boolean): Promise<Measurement> {
  const startedAt = new Date();
  const real = kind === 'real' ? loadRealHistory() : null;
  const run = await runBenchmark(
    {
      rules: loadRules(values.rules ?? 'current'),
      label: values.label ?? 'current',
      matrixStep,
      latencyRounds: Number(values.rounds),
    },
    real ?? loadHistory(),
  );
  const { report } = run;
  print(kind, report);
  let resultFile: string | null = null;
  if (write) {
    resultFile = existingResult(report);
    if (resultFile) console.log(`reusing ${resultFile}`);
    else {
      const stamp = startedAt
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d+Z$/, 'Z');
      const payload = {
        ...report,
        historyKind: kind,
        ...(real
          ? {
              realHistory: {
                corpusChecksum: real.corpusChecksum,
                labelsChecksum: real.labelsChecksum,
                splitChecksum: real.splitChecksum,
                excludedQaProbes: real.excludedQaProbes,
                heldoutShare: real.heldout.length / (real.dev.length + real.heldout.length),
              },
            }
          : {}),
        generatedAt: startedAt.toISOString(),
        // INTENT_BENCH_SHA names the commit the tree was built on when the run happens in a mirror without that history.
        source: {
          sha: process.env.INTENT_BENCH_SHA ?? git('rev-parse', 'HEAD'),
          dirty: git('status', '--porcelain').length > 0,
          engineDigest: digest,
        },
      };
      const checksum = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
      resultFile = `${BENCHMARKS}/${stamp}-${kind}-${report.label}.json`;
      if (existsSync(new URL(resultFile, ROOT))) throw new Error(`${resultFile} exists; results are append-only`);
      writeFileSync(new URL(resultFile, ROOT), `${JSON.stringify({ ...payload, checksum }, null, 2)}\n`);
      console.log(`wrote ${resultFile}`);
    }
  }
  return { kind, run, real, resultFile };
}

/** One real split as the gate records it: confirmed labels, plus the answers on rows relabelled unclear after measuring. */
function splitOf(confirmed: Slice, relabelledFalseMatches: number): RealSplitMeasurement {
  const counts = {
    inScope: confirmed.inScope,
    correct: confirmed.correct,
    wrong: confirmed.wrong,
    falseMatches: confirmed.falseMatch,
    relabelledFalseMatches,
  };
  return { ...counts, ...splitRatios(counts), rubric: confirmed.rubricPass ?? 0 };
}

const interval = (value: Interval): { low: number; high: number } => ({ low: value.low ?? 0, high: value.high ?? 0 });

function buildGate(real: Measurement, synthetic: Measurement, realFile: string, syntheticFile: string): KpiGate {
  const { report } = real.run;
  const loaded = real.real;
  if (!report.real || !report.matrix || !loaded)
    throw new Error('the real measurement needs the TZ/DST matrix (--matrix 1)');
  const held = report.real.confirmed.heldout.overall;
  const dev = report.real.confirmed.dev.overall;
  const heldRelabelled = report.real.unclear.heldout.falseMatch;
  const devRelabelled = report.real.unclear.dev.falseMatch;
  const heldout = splitOf(held, heldRelabelled);
  const devSplit = splitOf(dev, devRelabelled);
  const pooledCorrect = held.correct + dev.correct;
  const pooledInScope = held.inScope + dev.inScope;
  const pooledAnswered = pooledCorrect + held.wrong + dev.wrong + held.falseMatch + dev.falseMatch;
  const everything = [report.all.overall];
  const syntheticHeld = synthetic.run.report.heldout.overall;
  const gate: KpiGate = {
    schemaVersion: 1,
    seedVersion: 6,
    seedFingerprint: report.ruleSet.fingerprint,
    rule: 'real-history-point-estimate',
    thresholds: { ...KPI_FLOORS },
    real: {
      heldout,
      dev: devSplit,
      pooled: {
        inScope: pooledInScope,
        correct: pooledCorrect,
        coverage: pooledCorrect / pooledInScope,
        precision: pooledCorrect / pooledAnswered,
        strictPrecision: pooledCorrect / (pooledAnswered + heldRelabelled),
        strictPrecisionAllRelabelled: pooledCorrect / (pooledAnswered + heldRelabelled + devRelabelled),
      },
      execution: report.matrix.overall.execution ?? 0,
      matrixCells: report.matrix.cells,
      harmfulFalseMatches: report.all.overall.harmfulFalseMatch + report.matrix.overall.harmfulFalseMatch,
      unconfirmedWrites:
        everything.reduce((sum, slice) => sum + slice.unconfirmedWrites, 0) + report.matrix.overall.unconfirmedWrites,
      exceptions: everything.reduce((sum, slice) => sum + slice.exceptions, 0) + report.matrix.overall.exceptions,
    },
    synthetic: {
      inScope: syntheticHeld.inScope,
      correct: syntheticHeld.correct,
      coverage: syntheticHeld.coverage ?? 0,
      precision: syntheticHeld.precision ?? 0,
      modelHistory: {
        version: String(synthetic.run.report.modelHistory.version),
        checksum: synthetic.run.report.modelHistory.checksum,
      },
      benchmarkResult: syntheticFile,
    },
    informational: {
      intervals95: {
        heldoutCoverage: interval(held.intervals.coverage),
        pooledCoverage: interval(wilson(pooledCorrect, pooledInScope)),
        heldoutPrecision: interval(held.intervals.precision),
        pooledPrecision: interval(wilson(pooledCorrect, pooledAnswered)),
        heldoutStrictPrecision: interval(
          wilson(held.correct, held.correct + held.wrong + held.falseMatch + heldRelabelled),
        ),
      },
      notes: [
        'The gate is on point estimates; the 95% lower bound of the held-out coverage is below 0.80 at this sample size and is informational only.',
        'The real held-out split is no longer pristine: two class-level reports without text were used while fixing the engine, and nine label entries changed after the labelling round (seven change a route or status, two add a title variant; labels-agreement.json, postAdjudication).',
        'Near-duplicate replicas of the same message (differing only in a pseudonym placeholder) can sit on both sides of the split, which makes the held-out figures optimistic; the split was stratified by user and family, not by message lineage.',
        `Sample sizes are small: ${held.inScope} rule-eligible held-out messages, ${pooledInScope} pooled; two users write most of the real messages.`,
        `Strict precision counts ${heldRelabelled} held-out answer(s) of an already approved rule outside the benchmark family set that were relabelled unclear after measuring; with the ${devRelabelled} dev rows relabelled the same way the pooled figure is ${((pooledCorrect / (pooledAnswered + heldRelabelled + devRelabelled)) * 100).toFixed(1)}% (strictPrecisionAllRelabelled).`,
      ],
    },
    realHistory: {
      corpusChecksum: loaded.corpusChecksum,
      labelsChecksum: loaded.labelsChecksum,
      splitChecksum: loaded.splitChecksum,
    },
    engineDigest: digest,
    benchmarkResult: realFile,
    autoActivate: true,
  };
  return gate;
}

if (values.gate) {
  const matrixStep = Number(values.matrix ?? '1');
  const real = await measure('real', matrixStep, true);
  const synthetic = await measure('synthetic', SYNTHETIC_MATRIX_STEP, true);
  if (!real.resultFile || !synthetic.resultFile) throw new Error('both measurements must be written before a gate');
  const gate = buildGate(real, synthetic, real.resultFile, synthetic.resultFile);
  const verdict = gatePasses(gate, gate.seedFingerprint);
  if (!verdict.ok) {
    console.error('gate not written; the point-estimate rule fails:');
    for (const reason of verdict.reasons) console.error(`  - ${reason}`);
    process.exit(3);
  }
  const text = `${JSON.stringify(gate, null, 2)}\n`;
  const reparsed = parseKpiGate(text);
  if (!reparsed.ok) throw new Error(`the gate this script builds does not parse: ${reparsed.reason}`);
  writeFileSync(new URL(GATE_FILE, ROOT), text);
  console.log(`wrote ${GATE_FILE}`);
} else {
  await measure(values.history === 'real' ? 'real' : 'synthetic', Number(values.matrix ?? '0'), values.write);
}
