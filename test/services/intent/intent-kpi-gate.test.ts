// The owner's bar as a test: on the REAL scrubbed history the shipped seed must reach the coverage, precision, rubric and
// TZ/DST execution floors by its point estimates, with the synthetic held-out split as a second audit; nothing is
// written before a confirmation, and the committed activation gate must describe exactly this seed, this engine and
// these histories. Lowering a threshold here is not possible: the floors live in kpi-gate.ts.
import '../../../scripts/intent-benchmark/quiet.ts';
import { beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { type BenchmarkRun, loadHistory, runBenchmark } from '../../../scripts/intent-benchmark/benchmark.ts';
import { engineDigest } from '../../../scripts/intent-benchmark/engine-digest.ts';
import { type LoadedRealHistory, loadRealHistory } from '../../../scripts/intent-benchmark/real-history.ts';
import { gatePasses, KPI_FLOORS, KPI_GATE_PATH, readKpiGate } from '../../../src/services/intent/kpi-gate.ts';
import { seedFingerprint } from '../../../src/services/intent/rule-fingerprint.ts';
import { seedIntents } from '../../../src/services/intent/seed-catalog.ts';

const WRITE_FAMILIES = [
  'event.create',
  'event.create_invite',
  'reminder.after',
  'event.delete',
  'event.reschedule',
  'event.rename',
  'event.set_detail',
  'event.snooze',
  'event.hide',
  'reminder.set',
  'reminder.clear',
  'invite.send',
];

let synthetic: BenchmarkRun;
let real: BenchmarkRun;
let realHistory: LoadedRealHistory;
beforeAll(async () => {
  synthetic = await runBenchmark({ rules: seedIntents, label: 'ci', matrixStep: 10, latencyRounds: 1 });
  realHistory = loadRealHistory();
  real = await runBenchmark({ rules: seedIntents, label: 'ci-real', matrixStep: 10, latencyRounds: 1 }, realHistory);
}, 900_000);

function realConfirmed() {
  const confirmed = real.report.real?.confirmed;
  const unclear = real.report.real?.unclear;
  if (!confirmed || !unclear) throw new Error('the real benchmark carries no real report');
  return { held: confirmed.heldout.overall, dev: confirmed.dev.overall, unclear };
}

describe('intent KPI gate on the real history (the claim)', () => {
  test('the real held-out split is at least 30% of the real set', () => {
    expect(realHistory.heldout.length / (realHistory.dev.length + realHistory.heldout.length)).toBeGreaterThanOrEqual(
      0.3,
    );
  });

  test('held-out coverage of rule-eligible messages clears the floor by its point estimate', () => {
    expect(realConfirmed().held.coverage ?? 0).toBeGreaterThanOrEqual(KPI_FLOORS.heldoutCoverage);
  });

  test('coverage pooled over the real dev and held-out splits clears the floor', () => {
    const { held, dev } = realConfirmed();
    expect((held.correct + dev.correct) / (held.inScope + dev.inScope)).toBeGreaterThanOrEqual(
      KPI_FLOORS.pooledCoverage,
    );
  });

  test('precision on each real split, confirmed labels, clears the floor', () => {
    const { held, dev } = realConfirmed();
    expect(held.precision ?? 0).toBeGreaterThanOrEqual(KPI_FLOORS.precision);
    expect(dev.precision ?? 0).toBeGreaterThanOrEqual(KPI_FLOORS.precision);
  });

  test('strict precision counts the held-out answers relabelled unclear after measuring', () => {
    const { held, dev, unclear } = realConfirmed();
    const correct = held.correct + dev.correct;
    const answered = correct + held.wrong + dev.wrong + held.falseMatch + dev.falseMatch;
    expect(correct / (answered + unclear.heldout.falseMatch)).toBeGreaterThanOrEqual(KPI_FLOORS.strictPrecision);
  });

  test('rubric pass of the correct rule answers on the real dev and held-out splits pooled clears the floor', () => {
    const { held, dev } = realConfirmed();
    expect((held.rubricClean + dev.rubricClean) / (held.correct + dev.correct)).toBeGreaterThanOrEqual(
      KPI_FLOORS.rubric,
    );
  });

  test('execution across zones, DST transitions and the night after midnight clears the floor on real messages', () => {
    const matrix = real.report.matrix;
    expect(matrix?.cells ?? 0).toBeGreaterThan(1000);
    expect(matrix?.overall.execution ?? 0).toBeGreaterThanOrEqual(KPI_FLOORS.execution);
    expect(matrix?.overall.unconfirmedWrites).toBe(0);
  });

  test('nothing is written before a confirmation, nothing throws, no AI-correct message turns into a write', () => {
    for (const slice of [real.report.all, real.report.matrix ?? real.report.all]) {
      expect(slice.overall.unconfirmedWrites).toBe(0);
      expect(slice.overall.exceptions).toBe(0);
      expect(slice.overall.harmfulFalseMatch).toBe(0);
    }
  });

  test('no write family ever wrote the wrong thing on real messages', () => {
    for (const split of [real.report.dev, real.report.heldout, real.report.matrix ?? real.report.all])
      for (const family of WRITE_FAMILIES) expect(split.byFamily[family]?.wrong ?? 0, family).toBe(0);
  });
});

describe('intent KPI gate on the model history (second audit)', () => {
  test('synthetic held-out coverage and precision clear their floors', () => {
    const held = synthetic.report.heldout.overall;
    expect(held.coverage ?? 0).toBeGreaterThanOrEqual(KPI_FLOORS.syntheticCoverage);
    expect(held.precision ?? 0).toBeGreaterThanOrEqual(KPI_FLOORS.syntheticPrecision);
    expect(held.rubricPass ?? 0).toBeGreaterThanOrEqual(KPI_FLOORS.rubric);
  });

  test('the synthetic development split clears the same floors', () => {
    const dev = synthetic.report.dev.overall;
    expect(dev.coverage ?? 0).toBeGreaterThanOrEqual(KPI_FLOORS.syntheticCoverage);
    expect(dev.precision ?? 0).toBeGreaterThanOrEqual(KPI_FLOORS.syntheticPrecision);
  });

  test('synthetic execution across zones clears the floor and nothing is written unconfirmed', () => {
    const matrix = synthetic.report.matrix;
    expect(matrix?.cells ?? 0).toBeGreaterThan(1000);
    expect(matrix?.overall.execution ?? 0).toBeGreaterThanOrEqual(KPI_FLOORS.execution);
    for (const slice of [synthetic.report.all, matrix ?? synthetic.report.all]) {
      expect(slice.overall.unconfirmedWrites).toBe(0);
      expect(slice.overall.exceptions).toBe(0);
      expect(slice.overall.harmfulFalseMatch).toBe(0);
    }
  });

  test('no write family ever wrote the wrong thing on the model history', () => {
    for (const split of [
      synthetic.report.dev,
      synthetic.report.heldout,
      synthetic.report.matrix ?? synthetic.report.all,
    ])
      for (const family of WRITE_FAMILIES) expect(split.byFamily[family]?.wrong ?? 0, family).toBe(0);
  });
});

describe('committed activation gate', () => {
  function gateFile() {
    const read = readKpiGate();
    if (read.status !== 'ok') throw new Error(`kpi-gate.json is ${read.status}`);
    return read.gate;
  }

  test('exists and passes for this exact seed', () => {
    expect(existsSync(KPI_GATE_PATH)).toBe(true);
    expect(gatePasses(gateFile(), seedFingerprint(seedIntents))).toEqual({ ok: true });
  });

  test('was measured on this engine and on exactly these histories', () => {
    const gate = gateFile();
    expect(gate.engineDigest).toBe(engineDigest());
    expect(gate.synthetic.modelHistory.checksum).toBe(loadHistory().checksum);
    expect(gate.realHistory.corpusChecksum).toBe(realHistory.corpusChecksum);
    expect(gate.realHistory.labelsChecksum).toBe(realHistory.labelsChecksum);
    expect(gate.realHistory.splitChecksum).toBe(realHistory.splitChecksum);
  });

  test('records the counts a fresh run reproduces', () => {
    const gate = gateFile();
    const { held, dev, unclear } = realConfirmed();
    expect(gate.real.heldout).toMatchObject({
      inScope: held.inScope,
      correct: held.correct,
      wrong: held.wrong,
      falseMatches: held.falseMatch,
      relabelledFalseMatches: unclear.heldout.falseMatch,
    });
    expect(gate.real.dev).toMatchObject({
      inScope: dev.inScope,
      correct: dev.correct,
      wrong: dev.wrong,
      falseMatches: dev.falseMatch,
      relabelledFalseMatches: unclear.dev.falseMatch,
    });
    const syntheticHeld = synthetic.report.heldout.overall;
    expect(gate.synthetic.inScope).toBe(syntheticHeld.inScope);
    expect(gate.synthetic.correct).toBe(syntheticHeld.correct);
    expect(gate.real.heldout).toMatchObject({ rubricClean: held.rubricClean });
    expect(gate.real.dev).toMatchObject({ rubricClean: dev.rubricClean });
    expect(gate.real.pooled.rubric).toBeCloseTo((held.rubricClean + dev.rubricClean) / (held.correct + dev.correct), 6);
  });
});
