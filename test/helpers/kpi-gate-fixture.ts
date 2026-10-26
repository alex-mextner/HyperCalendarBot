// A gate that clears every floor, shaped like the committed one (real held-out 34/38, dev 62/74), for tests of the
// verdict and of the activation path. Counts are the evidence; every ratio is derived from them.
import { KPI_FLOORS, type KpiGate, splitRatios } from '../../src/services/intent/kpi-gate.ts';

const counts = (inScope: number, correct: number, relabelledFalseMatches: number) => ({
  inScope,
  correct,
  wrong: 0,
  falseMatches: 0,
  relabelledFalseMatches,
});

export function passingGate(fingerprint: string): KpiGate {
  const heldCounts = counts(38, 34, 1);
  const devCounts = counts(74, 62, 4);
  const pooledCorrect = heldCounts.correct + devCounts.correct;
  return {
    schemaVersion: 1,
    seedVersion: 6,
    seedFingerprint: fingerprint,
    rule: 'real-history-point-estimate',
    thresholds: { ...KPI_FLOORS },
    real: {
      heldout: { ...heldCounts, ...splitRatios(heldCounts), rubric: 1 },
      dev: { ...devCounts, ...splitRatios(devCounts), rubric: 1 },
      pooled: {
        inScope: heldCounts.inScope + devCounts.inScope,
        correct: pooledCorrect,
        coverage: pooledCorrect / (heldCounts.inScope + devCounts.inScope),
        precision: 1,
        strictPrecision: pooledCorrect / (pooledCorrect + heldCounts.relabelledFalseMatches),
        strictPrecisionAllRelabelled:
          pooledCorrect / (pooledCorrect + heldCounts.relabelledFalseMatches + devCounts.relabelledFalseMatches),
      },
      execution: 1,
      matrixCells: 1000,
      harmfulFalseMatches: 0,
      unconfirmedWrites: 0,
      exceptions: 0,
    },
    synthetic: {
      inScope: 200,
      correct: 166,
      coverage: 0.83,
      precision: 1,
      modelHistory: { version: 'model-history-v1', checksum: 'abc123' },
      benchmarkResult: 'docs/intents/benchmarks/synthetic-v6.json',
    },
    informational: {
      intervals95: {
        heldoutCoverage: { low: 0.759, high: 0.958 },
        pooledCoverage: { low: 0.78, high: 0.91 },
        heldoutPrecision: { low: 0.898, high: 1 },
        pooledPrecision: { low: 0.96, high: 1 },
        heldoutStrictPrecision: { low: 0.85, high: 0.99 },
      },
      notes: ['fixture'],
    },
    realHistory: { corpusChecksum: 'c'.repeat(64), labelsChecksum: 'd'.repeat(64), splitChecksum: 'f'.repeat(64) },
    engineDigest: 'e'.repeat(64),
    benchmarkResult: 'docs/intents/benchmarks/real-v6.json',
    autoActivate: true,
  };
}
