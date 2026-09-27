// Stored shapes of an intent revision: the body an author proposes and the validation the server
// computed for it. Only the server writes authorship and decisions; nothing in a body can name
// them, because unknown keys are stripped when a body is parsed.
import { z } from 'zod';
import { jsonCodec } from '../../utils/json-codec.ts';
import { digest, RuleDefinitionSchema } from './rule-fingerprint.ts';

const TextSchema = z.string().trim().min(1).max(2000);

const ExampleDispositionSchema = z.object({
  example: z.string().min(1).max(4000),
  disposition: z.enum(['covered_by', 'handled_by_ai', 'unsafe_removed']),
  coveredBy: z.string().max(128).optional(),
  note: TextSchema,
});
export type ExampleDisposition = z.infer<typeof ExampleDispositionSchema>;

const RevisionOperationSchema = z.object({
  kind: z.enum(['create', 'generalize', 'consolidate', 'retire']),
  sourceNames: z.array(z.string().max(128)).max(32),
  intents: z.array(RuleDefinitionSchema).max(32),
  reason: TextSchema,
  dispositions: z.array(ExampleDispositionSchema).max(256).default([]),
});
export type RevisionOperation = z.infer<typeof RevisionOperationSchema>;
export type RevisionOperationInput = z.input<typeof RevisionOperationSchema>;

export const RevisionBodySchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('operations'),
    summary: TextSchema,
    operations: z.array(RevisionOperationSchema).min(1).max(16),
  }),
  z.object({
    type: z.literal('replace_all'),
    summary: TextSchema,
    rules: z.array(RuleDefinitionSchema).max(256),
  }),
]);
export type RevisionBody = z.infer<typeof RevisionBodySchema>;
export type RevisionBodyInput = z.input<typeof RevisionBodySchema>;
export const RevisionBodyCodec = jsonCodec(RevisionBodySchema);

/** The exact hash an approval must name: sha256 of the canonical JSON of the parsed body. */
export const revisionBodyHash = (body: RevisionBody): string => digest(body);

const DroppedRulesSchema = z.object({
  learned: z.array(z.string()),
  manual: z.array(z.string()),
  source_baseline: z.array(z.string()),
});
export type DroppedRules = z.infer<typeof DroppedRulesSchema>;

export const RevisionValidationSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(false), errors: z.array(z.string()) }),
  z.object({
    ok: z.literal(true),
    removed: z.array(z.string()),
    inserted: z.array(z.string()),
    dropped: DroppedRulesSchema.optional(),
  }),
]);
export type RevisionValidation = z.infer<typeof RevisionValidationSchema>;
export const RevisionValidationCodec = jsonCodec(RevisionValidationSchema);
