// The committed KPI gate that lets a deploy activate a seed revision without a human: the gate must
// parse, name exactly this seed, clear every floor on REAL history by its point estimate and never lower
// the floors in the code. The 95% intervals it records are information and never decide.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  gatePasses,
  KPI_FLOORS,
  type KpiGate,
  parseKpiGate,
  readKpiGate,
  splitRatios,
} from '../../../src/services/intent/kpi-gate.ts';
import { passingGate as passingGateFor } from '../../helpers/kpi-gate-fixture.ts';

const FINGERPRINT = 'a'.repeat(64);
const passingGate = (): KpiGate => passingGateFor(FINGERPRINT);

type Split = KpiGate['real']['heldout'];

/** Change a split's counts and keep every recorded ratio consistent with them, as a real measurement would. */
function withSplit(gate: KpiGate, which: 'heldout' | 'dev', change: Partial<Split>): KpiGate {
  const split = { ...gate.real[which], ...change };
  const counts = { ...split, ...splitRatios(split) };
  const real = { ...gate.real, [which]: counts };
  const held = real.heldout;
  const dev = real.dev;
  const correct = held.correct + dev.correct;
  const answered = correct + held.wrong + dev.wrong + held.falseMatches + dev.falseMatches;
  real.pooled = {
    inScope: held.inScope + dev.inScope,
    correct,
    coverage: correct / (held.inScope + dev.inScope),
    precision: correct / answered,
    strictPrecision: correct / (answered + held.relabelledFalseMatches),
    strictPrecisionAllRelabelled: correct / (answered + held.relabelledFalseMatches + dev.relabelledFalseMatches),
  };
  return { ...gate, real };
}

function reasonsOf(gate: KpiGate): string {
  const result = gatePasses(gate, FINGERPRINT);
  expect(result.ok).toBe(false);
  return result.ok ? '' : result.reasons.join(' | ');
}

describe('gatePasses', () => {
  test('a gate that clears every floor for this fingerprint passes', () => {
    expect(gatePasses(passingGate(), FINGERPRINT)).toEqual({ ok: true });
  });

  test('the floors are the owner-set bar', () => {
    expect(KPI_FLOORS).toEqual({
      heldoutCoverage: 0.85,
      pooledCoverage: 0.85,
      precision: 0.99,
      strictPrecision: 0.975,
      rubric: 0.95,
      execution: 0.99,
      syntheticCoverage: 0.8,
      syntheticPrecision: 0.99,
    });
  });

  test('the point estimate decides: a 95% lower bound under 0.80 does not fail a gate that clears the floor', () => {
    const gate = passingGate();
    expect(gate.informational.intervals95.heldoutCoverage.low).toBeLessThan(0.8);
    expect(gate.real.heldout.coverage).toBeGreaterThanOrEqual(KPI_FLOORS.heldoutCoverage);
    expect(gatePasses(gate, FINGERPRINT)).toEqual({ ok: true });
  });

  for (const floor of Object.keys(KPI_FLOORS) as (keyof typeof KPI_FLOORS)[]) {
    test(`a doctored ${floor} threshold below the floor fails even when the measurement clears it`, () => {
      const gate = passingGate();
      gate.thresholds[floor] = KPI_FLOORS[floor] - 0.2;
      expect(reasonsOf(gate)).toContain(`${floor} threshold`);
    });
  }

  test('held-out coverage exactly at the floor passes', () => {
    // 34 of 40 is 85% exactly; 96 of 112 pooled stays above 85% with the dev split at 72 rule-eligible.
    const gate = withSplit(withSplit(passingGate(), 'heldout', { inScope: 40 }), 'dev', { inScope: 72 });
    expect(gate.real.heldout.coverage).toBe(KPI_FLOORS.heldoutCoverage);
    expect(gatePasses(gate, FINGERPRINT)).toEqual({ ok: true });
  });

  test('held-out coverage below its floor fails and names it', () => {
    // 32 of 38 is 84.2%; the pooled figure (94 of 112 = 83.9%) fails as well.
    const gate = withSplit(passingGate(), 'heldout', { correct: 32 });
    expect(reasonsOf(gate)).toContain('heldoutCoverage');
  });

  test('pooled coverage below its floor fails even when held-out clears it', () => {
    const gate = withSplit(passingGate(), 'dev', { inScope: 90 });
    const reasons = reasonsOf(gate);
    expect(reasons).toContain('pooledCoverage');
    expect(reasons).not.toContain('heldoutCoverage');
  });

  test('one wrong answer on either real split fails precision', () => {
    for (const which of ['heldout', 'dev'] as const) {
      const gate = withSplit(passingGate(), which, { wrong: 1 });
      expect(reasonsOf(gate)).toContain('precision');
    }
  });

  test('a rule answering a message the AI should answer fails precision', () => {
    expect(reasonsOf(withSplit(passingGate(), 'dev', { falseMatches: 1 }))).toContain('precision');
  });

  test('strict precision counts the held-out answers relabelled after measuring', () => {
    // 96 correct, 2 relabelled: 96/98 = 98.0% passes; 3 relabelled: 96/99 = 97.0% fails the 97.5% floor.
    expect(gatePasses(withSplit(passingGate(), 'heldout', { relabelledFalseMatches: 2 }), FINGERPRINT)).toEqual({
      ok: true,
    });
    expect(reasonsOf(withSplit(passingGate(), 'heldout', { relabelledFalseMatches: 3 }))).toContain('strictPrecision');
  });

  test('dev rows relabelled the same way are recorded but do not decide', () => {
    const gate = withSplit(passingGate(), 'dev', { relabelledFalseMatches: 30 });
    expect(gate.real.pooled.strictPrecisionAllRelabelled).toBeLessThan(KPI_FLOORS.strictPrecision);
    expect(gatePasses(gate, FINGERPRINT)).toEqual({ ok: true });
  });

  test('a recorded ratio that does not follow from its counts fails', () => {
    const gate = passingGate();
    gate.real.heldout.coverage = 0.99;
    expect(reasonsOf(gate)).toContain('does not follow from its counts');
  });

  test('pooled counts that are not the sum of the splits fail', () => {
    const gate = passingGate();
    gate.real.pooled.inScope += 1;
    expect(reasonsOf(gate)).toContain('pooled counts');
  });

  test('more correct answers than rule-eligible messages fail', () => {
    const gate = passingGate();
    gate.real.heldout.correct = gate.real.heldout.inScope + 1;
    expect(reasonsOf(gate)).toContain('correct exceeds');
  });

  test('rubric and execution below their floors fail', () => {
    const gate = passingGate();
    gate.real.heldout.rubric = 0.9;
    gate.real.execution = 0.98;
    const reasons = reasonsOf(gate);
    expect(reasons).toContain('rubric');
    expect(reasons).toContain('execution');
  });

  test('the synthetic audit must hold too', () => {
    const lowCoverage = passingGate();
    lowCoverage.synthetic.correct = 150;
    lowCoverage.synthetic.coverage = 150 / 200;
    expect(reasonsOf(lowCoverage)).toContain('syntheticCoverage');
    const lowPrecision = passingGate();
    lowPrecision.synthetic.precision = 0.97;
    expect(reasonsOf(lowPrecision)).toContain('syntheticPrecision');
  });

  test('a harmful false match, an unconfirmed write or an exception fails', () => {
    for (const key of ['harmfulFalseMatches', 'unconfirmedWrites', 'exceptions'] as const) {
      const gate = passingGate();
      gate.real[key] = 1;
      expect(reasonsOf(gate)).toContain(
        key === 'exceptions' ? 'exceptions' : key === 'harmfulFalseMatches' ? 'harmful' : 'unconfirmed',
      );
    }
  });

  test('a gate for another fingerprint fails', () => {
    const result = gatePasses(passingGate(), 'b'.repeat(64));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons.join(' ')).toContain('fingerprint');
  });

  test('autoActivate false fails', () => {
    const result = gatePasses({ ...passingGate(), autoActivate: false }, FINGERPRINT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons.join(' ')).toContain('autoActivate');
  });

  test('an empty held-out in-scope set proves nothing', () => {
    const gate = withSplit(passingGate(), 'heldout', { inScope: 0, correct: 0, relabelledFalseMatches: 0 });
    expect(reasonsOf(gate)).toContain('held-out in-scope set is empty');
  });

  test('every failing reason is reported, not only the first', () => {
    const gate = passingGate();
    gate.real.execution = 0.1;
    gate.real.heldout.rubric = 0.1;
    const result = gatePasses(gate, FINGERPRINT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons.length).toBe(2);
  });
});

describe('parseKpiGate', () => {
  test('accepts a well-formed gate', () => {
    expect(parseKpiGate(JSON.stringify(passingGate())).ok).toBe(true);
  });

  test('rejects text that is not JSON', () => {
    expect(parseKpiGate('{nope').ok).toBe(false);
  });

  test('rejects a gate with a missing field', () => {
    const { thresholds: _omitted, ...rest } = passingGate();
    expect(parseKpiGate(JSON.stringify(rest)).ok).toBe(false);
  });

  test('rejects a measurement outside 0..1', () => {
    const gate = passingGate();
    gate.real.execution = 1.5;
    expect(parseKpiGate(JSON.stringify(gate)).ok).toBe(false);
  });

  test('rejects a non-hex fingerprint', () => {
    expect(parseKpiGate(JSON.stringify({ ...passingGate(), seedFingerprint: 'zz' })).ok).toBe(false);
  });

  test('rejects an unknown rule', () => {
    expect(parseKpiGate(JSON.stringify({ ...passingGate(), rule: 'lower-bound' })).ok).toBe(false);
  });

  test('rejects an unknown schema version', () => {
    expect(parseKpiGate(JSON.stringify({ ...passingGate(), schemaVersion: 2 })).ok).toBe(false);
  });

  test('rejects keys the schema does not know', () => {
    expect(parseKpiGate(JSON.stringify({ ...passingGate(), skipChecks: true })).ok).toBe(false);
  });

  test('rejects a benchmark path outside the benchmarks directory', () => {
    expect(parseKpiGate(JSON.stringify({ ...passingGate(), benchmarkResult: '../../etc/passwd' })).ok).toBe(false);
  });
});

describe('readKpiGate', () => {
  function withFile(content: string | null, check: (path: string) => void) {
    const directory = mkdtempSync(join(tmpdir(), 'kpi-gate-'));
    try {
      const path = join(directory, 'kpi-gate.json');
      if (content !== null) writeFileSync(path, content);
      check(path);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  test('a missing file is reported as missing, not as an error', () => {
    withFile(null, (path) => expect(readKpiGate(path)).toEqual({ status: 'missing' }));
  });

  test('a readable valid file yields the gate', () => {
    withFile(JSON.stringify(passingGate()), (path) => {
      const read = readKpiGate(path);
      expect(read.status).toBe('ok');
      if (read.status === 'ok') expect(read.gate.seedVersion).toBe(6);
    });
  });

  test('an invalid file is reported as invalid with a reason', () => {
    withFile('[]', (path) => {
      const read = readKpiGate(path);
      expect(read.status).toBe('invalid');
      if (read.status === 'invalid') expect(read.reason.length).toBeGreaterThan(0);
    });
  });
});
