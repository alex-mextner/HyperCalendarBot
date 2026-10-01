import { createHash } from 'node:crypto';
import { z } from 'zod';

export const answerScopeSchema = z
  .object({
    actorId: z.number().int().positive().safe(),
    chatId: z
      .number()
      .int()
      .safe()
      .refine((n) => n !== 0),
    turnId: z.string().min(1).max(128),
    evidenceRevision: z.string().min(1).max(256),
  })
  .strict();
export type AnswerScope = z.infer<typeof answerScopeSchema>;
export const answerBindingSchema = answerScopeSchema.extend({ textHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type AnswerBinding = z.infer<typeof answerBindingSchema>;
const check = z.enum(['passed', 'failed', 'unknown']);
const cosmeticRules = ['cosmetic_tone', 'cosmetic_punctuation', 'cosmetic_layout', 'cosmetic_verbosity'] as const;
export const qualityAssessmentSchema = z
  .object({
    binding: answerBindingSchema,
    taskFulfilled: check,
    factsSupported: check,
    scopeRespected: check,
    noUnsafeActions: check,
    noCosmeticDefects: check,
    violations: z
      .array(
        z.enum([
          ...cosmeticRules,
          'fact_mismatch',
          'missing_evidence',
          'wrong_scope',
          'unsafe_action',
          'incomplete_task',
        ]),
      )
      .max(32),
  })
  .strict();
export type QualityAssessment = z.infer<typeof qualityAssessmentSchema>;
export type ReleaseDecision = { kind: 'send' | 'send_then_correct' | 'hold'; reasons: string[] };

/** Bind trusted evidence to one exact plain-text draft. Hashes do not authenticate a model's claims. */
export function bindAnswer(scope: AnswerScope, text: string): AnswerBinding {
  return { ...answerScopeSchema.parse(scope), textHash: createHash('sha256').update(text).digest('hex') };
}
export function sameBinding(a: AnswerBinding, b: AnswerBinding): boolean {
  return (
    a.actorId === b.actorId &&
    a.chatId === b.chatId &&
    a.turnId === b.turnId &&
    a.evidenceRevision === b.evidenceRevision &&
    a.textHash === b.textHash
  );
}
/** Only application-owned trusted checks may supply an assessment; never parse model output as approval. */
export function decideAnswerRelease(binding: AnswerBinding, assessment: QualityAssessment): ReleaseDecision {
  const expected = answerBindingSchema.safeParse(binding),
    parsed = qualityAssessmentSchema.safeParse(assessment);
  if (!expected.success || !parsed.success) return { kind: 'hold', reasons: ['invalid_assessment'] };
  const value = parsed.data;
  if (!sameBinding(expected.data, value.binding)) return { kind: 'hold', reasons: ['assessment_binding_mismatch'] };
  const reasons: string[] = [];
  for (const key of ['taskFulfilled', 'factsSupported', 'scopeRespected', 'noUnsafeActions'] as const) {
    if (value[key] !== 'passed') reasons.push(`${key}:${value[key]}`);
  }
  const presentationOnly = value.violations.every((rule) => cosmeticRules.some((c) => c === rule));
  if (!presentationOnly) reasons.push('blocking_violation');
  if (reasons.length) return { kind: 'hold', reasons };
  if (value.noCosmeticDefects === 'passed' && value.violations.length === 0) return { kind: 'send', reasons: [] };
  if (value.noCosmeticDefects === 'failed' && value.violations.length > 0 && presentationOnly)
    return { kind: 'send_then_correct', reasons: [...value.violations] };
  return { kind: 'hold', reasons: ['presentation_not_established'] };
}
