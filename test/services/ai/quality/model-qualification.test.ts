import { expect, test } from 'bun:test';
import {
  qualifyPreset as evaluateQualification,
  type QualificationInput,
  type QualitySample,
} from '../../../../src/services/ai/quality/model-qualification.ts';

const target = {
  presetId: 'candidate-low-v1',
  role: 'residual_executor' as const,
  presetHash: 'a'.repeat(64),
  wrapperHash: 'b'.repeat(64),
  corpusHash: 'c'.repeat(64),
};
const qualifyPreset = (value: QualificationInput) => evaluateQualification(value, { ...target, role: value.role });
function samples(n: number, passed = n): QualitySample[] {
  return Array.from({ length: n }, (_, i) => ({
    episodeId: `case-${i}`,
    independentCaseId: `independent-${i}`,
    outcome: i < passed ? 'correct' : 'incorrect',
    noUnsafeExecution: true,
  }));
}
function input(): QualificationInput {
  return {
    presetId: 'candidate-low-v1',
    measuredFor: { ...target },
    role: 'residual_executor',
    heldOut: true,
    trainingCaseIds: [],
    roleSamples: samples(100, 95),
    population: 'llm_residual',
    history: {
      sourceEpisodeIds: ['h1', 'h2'],
      samples: [
        { episodeId: 'h1', independentCaseId: 'h1', outcome: 'correct', noUnsafeExecution: true },
        { episodeId: 'h2', independentCaseId: 'h2', outcome: 'correct', noUnsafeExecution: true },
      ],
      unreconstructableEpisodes: 0,
      sourceInventoryComplete: true,
      goldAdjudicated: true,
    },
  };
}
test('95 percent on a held-out residual plus full historical success satisfies observed gate', () =>
  expect(qualifyPreset(input()).eligible).toBe(true));
test('94 percent cannot round up to pass', () =>
  expect(qualifyPreset({ ...input(), roleSamples: samples(100, 94) }).eligible).toBe(false));
test('all-traffic easy intent cases cannot qualify the complex residual executor', () =>
  expect(qualifyPreset({ ...input(), population: 'all_traffic' }).eligible).toBe(false));
test('simple unmatched role is distinct from residual executor', () =>
  expect(
    qualifyPreset({
      ...input(),
      role: 'simple_executor',
      measuredFor: { ...target, role: 'simple_executor' },
      population: 'simple_unmatched',
    }).eligible,
  ).toBe(true));
test('abstention on answerable cases stays in denominator', () => {
  const x = input();
  x.roleSamples = samples(100, 94);
  x.roleSamples[99] = { ...x.roleSamples[99]!, outcome: 'abstained' };
  expect(qualifyPreset(x).eligible).toBe(false);
});
test('20 repeated examples do not qualify as 100 independent cases', () => {
  const x = input();
  x.roleSamples = x.roleSamples.map((s, i) => ({ ...s, independentCaseId: `repeat-${i % 20}` }));
  expect(qualifyPreset(x).eligible).toBe(false);
});
test('small perfect set does not establish the intended qualification', () =>
  expect(qualifyPreset({ ...input(), roleSamples: samples(16) }).eligible).toBe(false));
test('training contamination prevents held-out qualification', () =>
  expect(qualifyPreset({ ...input(), trainingCaseIds: ['independent-2'] }).eligible).toBe(false));
test('declared non-held-out data is not silently accepted', () =>
  expect(qualifyPreset({ ...input(), heldOut: false }).eligible).toBe(false));
test('historical unknown is not a pass', () => {
  const x = input();
  x.history.samples[0] = { ...x.history.samples[0]!, outcome: 'unknown' };
  expect(qualifyPreset(x).eligible).toBe(false);
});
test('coverage missing from the retained log prevents whole-history claim', () => {
  const x = input();
  x.history.sourceEpisodeIds.push('h3');
  expect(qualifyPreset(x).eligible).toBe(false);
});
test('duplicate history rows cannot cover a different missing episode', () => {
  const x = input();
  x.history.samples[1] = { ...x.history.samples[0]! };
  expect(qualifyPreset(x).eligible).toBe(false);
});
test('unreconstructable history is visible and prevents whole-log green', () => {
  const x = input();
  x.history.unreconstructableEpisodes = 1;
  expect(qualifyPreset(x).eligible).toBe(false);
});
test('unsafe execution cannot hide in the allowed five-percent failure rate', () => {
  const x = input();
  x.roleSamples[99] = { ...x.roleSamples[99]!, noUnsafeExecution: false };
  expect(qualifyPreset(x).eligible).toBe(false);
});
test('unadjudicated historical answers are not gold', () => {
  const x = input();
  x.history.goldAdjudicated = false;
  expect(qualifyPreset(x).eligible).toBe(false);
});
test('empty or incomplete source inventory never gives 100percent', () => {
  const x = input();
  x.history.sourceEpisodeIds = [];
  x.history.samples = [];
  x.history.sourceInventoryComplete = false;
  expect(qualifyPreset(x).eligible).toBe(false);
});
test('reported axes expose rate,denominator,coverage and target status separately', () => {
  const r = qualifyPreset(input());
  expect(r.roleAccuracy).toBe(0.95);
  expect(r.independentRoleCases).toBe(100);
  expect(r.historicalCoverage).toBe(1);
  expect(r.historicalAccuracy).toBe(1);
});
test('qualification cannot accept metrics without an exact preset/wrapper/corpus binding', () => {
  const { measuredFor: _, ...unbound } = input();
  expect(evaluateQualification(unbound, target).eligible).toBe(false);
});
for (const field of ['presetHash', 'wrapperHash', 'corpusHash'] as const)
  test(`changed ${field} requires new qualification`, () =>
    expect(evaluateQualification(input(), { ...target, [field]: 'd'.repeat(64) }).eligible).toBe(false));
test('another preset ID cannot borrow these metrics', () =>
  expect(evaluateQualification(input(), { ...target, presetId: 'another' }).eligible).toBe(false));
