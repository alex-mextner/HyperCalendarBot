import { describe, expect, test } from 'bun:test';
import {
  bindAnswer,
  decideAnswerRelease,
  type QualityAssessment,
  qualityAssessmentSchema,
} from '../../../../src/services/ai/quality/answer-quality.ts';

const scope = { actorId: 123, chatId: 123, turnId: 'turn-1', evidenceRevision: 'event-101-v3' };
const binding = bindAnswer(scope, 'Событие завтра в 13:00.');
function quality(patch: Partial<QualityAssessment> = {}): QualityAssessment {
  return {
    binding,
    taskFulfilled: 'passed',
    factsSupported: 'passed',
    scopeRespected: 'passed',
    noUnsafeActions: 'passed',
    noCosmeticDefects: 'passed',
    violations: [],
    ...patch,
  };
}
describe('positive answer quality and cosmetic tolerance', () => {
  test('fully verified answer is released', () => expect(decideAnswerRelease(binding, quality()).kind).toBe('send'));
  for (const field of ['taskFulfilled', 'factsSupported', 'scopeRespected', 'noUnsafeActions'] as const)
    for (const status of ['failed', 'unknown'] as const) {
      test(`${field}=${status} must be checked before any send`, () =>
        expect(decideAnswerRelease(binding, quality({ [field]: status })).kind).toBe('hold'));
    }
  test('known cosmetic defect may be corrected after sending verified facts', () =>
    expect(
      decideAnswerRelease(binding, quality({ noCosmeticDefects: 'failed', violations: ['cosmetic_tone'] })).kind,
    ).toBe('send_then_correct'));
  test('unknown cosmetics are not described as clean', () =>
    expect(decideAnswerRelease(binding, quality({ noCosmeticDefects: 'unknown' })).kind).toBe('hold'));
  test('a cosmetic label cannot override a factual violation', () =>
    expect(
      decideAnswerRelease(
        binding,
        quality({ noCosmeticDefects: 'failed', violations: ['cosmetic_tone', 'fact_mismatch'] }),
      ).kind,
    ).toBe('hold'));
  test('empty findings cannot justify a failed cosmetic check', () =>
    expect(decideAnswerRelease(binding, quality({ noCosmeticDefects: 'failed' })).kind).toBe('hold'));
  test('contradictory passed cosmetic check and cosmetic findings is rejected', () =>
    expect(decideAnswerRelease(binding, quality({ violations: ['cosmetic_layout'] })).kind).toBe('hold'));
  test('approval of an earlier draft does not cover this text', () =>
    expect(decideAnswerRelease(bindAnswer(scope, 'Событие завтра в 14:00.'), quality()).kind).toBe('hold'));
  for (const patch of [
    { actorId: 456 },
    { chatId: -456 },
    { turnId: 'turn-2' },
    { evidenceRevision: 'event-101-v4' },
  ]) {
    test(`approval bound to changed scope ${JSON.stringify(patch)} is refused`, () =>
      expect(decideAnswerRelease(bindAnswer({ ...scope, ...patch }, 'Событие завтра в 13:00.'), quality()).kind).toBe(
        'hold',
      ));
  }
  test('unknown rule names and hidden approval flags are rejected by the schema', () => {
    expect(qualityAssessmentSchema.safeParse({ ...quality(), violations: ['date_change_is_cosmetic'] }).success).toBe(
      false,
    );
    expect(qualityAssessmentSchema.safeParse({ ...quality(), override: true }).success).toBe(false);
  });
  test('positive axes all refer to a desired state, not a severity label', () =>
    expect(Object.keys(quality())).toEqual([
      'binding',
      'taskFulfilled',
      'factsSupported',
      'scopeRespected',
      'noUnsafeActions',
      'noCosmeticDefects',
      'violations',
    ]));
});
