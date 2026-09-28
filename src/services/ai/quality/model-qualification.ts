import { z } from 'zod';

const sampleSchema = z
  .object({
    episodeId: z.string().min(1),
    independentCaseId: z.string().min(1),
    outcome: z.enum(['correct', 'incorrect', 'abstained', 'unavailable', 'unknown']),
    noUnsafeExecution: z.boolean(),
  })
  .strict();
export type QualitySample = z.infer<typeof sampleSchema>;
export const qualificationTargetSchema = z
  .object({
    presetId: z.string().min(1),
    role: z.enum(['residual_executor', 'simple_executor']),
    presetHash: z.string().regex(/^[a-f0-9]{64}$/),
    wrapperHash: z.string().regex(/^[a-f0-9]{64}$/),
    corpusHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type QualificationTarget = z.infer<typeof qualificationTargetSchema>;
const qualificationSchema = z
  .object({
    presetId: z.string().min(1),
    measuredFor: qualificationTargetSchema,
    role: z.enum(['residual_executor', 'simple_executor']),
    heldOut: z.boolean(),
    trainingCaseIds: z.array(z.string()),
    roleSamples: z.array(sampleSchema).max(100000),
    population: z.enum(['llm_residual', 'simple_unmatched', 'all_traffic']),
    history: z
      .object({
        sourceEpisodeIds: z.array(z.string().min(1)).max(100000),
        samples: z.array(sampleSchema).max(100000),
        unreconstructableEpisodes: z.number().int().nonnegative(),
        sourceInventoryComplete: z.boolean(),
        goldAdjudicated: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type QualificationInput = z.infer<typeof qualificationSchema>;
export interface QualificationResult {
  eligible: boolean;
  reasons: string[];
  roleAccuracy: number | null;
  independentRoleCases: number;
  historicalCoverage: number | null;
  historicalAccuracy: number | null;
}
/** Observed evidence gate, not a confidence interval or automatic promotion. Counts must come from audited replay. */
export function qualifyPreset(input: unknown, expectedTarget: QualificationTarget): QualificationResult {
  const parsed = qualificationSchema.safeParse(input);
  const target = qualificationTargetSchema.safeParse(expectedTarget);
  if (!parsed.success || !target.success)
    return {
      eligible: false,
      reasons: ['invalid_evidence'],
      roleAccuracy: null,
      independentRoleCases: 0,
      historicalCoverage: null,
      historicalAccuracy: null,
    };
  const { role, heldOut, population, roleSamples, trainingCaseIds, history } = parsed.data;
  const reasons: string[] = [];
  const measured = parsed.data.measuredFor;
  if (
    parsed.data.presetId !== target.data.presetId ||
    parsed.data.role !== target.data.role ||
    (Object.keys(target.data) as (keyof QualificationTarget)[]).some((key) => measured[key] !== target.data[key])
  )
    reasons.push('qualification_target_mismatch');
  const expectedPopulation = role === 'residual_executor' ? 'llm_residual' : 'simple_unmatched';
  if (population !== expectedPopulation) reasons.push('wrong_population');
  if (!heldOut) reasons.push('not_held_out');
  const unique = new Set(roleSamples.map((x) => x.independentCaseId)),
    ids = new Set(roleSamples.map((x) => x.episodeId));
  if (unique.size < 100) reasons.push('insufficient_independent_cases');
  if (unique.size !== roleSamples.length || ids.size !== roleSamples.length) reasons.push('repeated_role_case');
  const training = new Set(trainingCaseIds);
  if (roleSamples.some((x) => training.has(x.independentCaseId))) reasons.push('training_overlap');
  const correct = roleSamples.filter((x) => x.outcome === 'correct').length;
  // Integer comparison:94.999% must not round up. Every failure/abstention/outage remains in the denominator.
  if (roleSamples.length === 0 || correct * 100 < roleSamples.length * 95) reasons.push('below_role_accuracy');
  if (roleSamples.some((x) => !x.noUnsafeExecution)) reasons.push('unsafe_role_execution');
  if (!history.sourceInventoryComplete || !history.goldAdjudicated) reasons.push('historical_evidence_incomplete');
  if (history.unreconstructableEpisodes > 0) reasons.push('historical_state_missing');
  const expected = new Set(history.sourceEpisodeIds),
    seen = new Set(history.samples.map((x) => x.episodeId));
  if (!expected.size || expected.size !== history.sourceEpisodeIds.length) reasons.push('invalid_source_inventory');
  if (seen.size !== history.samples.length) reasons.push('duplicate_history_episode');
  if (seen.size !== expected.size || [...seen].some((x) => !expected.has(x)))
    reasons.push('incomplete_historical_coverage');
  if (history.samples.some((x) => x.outcome !== 'correct')) reasons.push('historical_task_incorrect');
  if (history.samples.some((x) => !x.noUnsafeExecution)) reasons.push('unsafe_historical_execution');
  const covered = [...seen].filter((x) => expected.has(x)).length;
  return {
    eligible: reasons.length === 0,
    reasons,
    roleAccuracy: roleSamples.length ? correct / roleSamples.length : null,
    independentRoleCases: unique.size,
    historicalCoverage: expected.size ? covered / expected.size : null,
    historicalAccuracy: history.samples.length
      ? history.samples.filter((x) => x.outcome === 'correct').length / history.samples.length
      : null,
  };
}
