// Wire contracts: worker artifacts, enqueue input and request bodies. Every object is strict, so a
// draft can never smuggle status or approval fields past the schema.
import { z } from 'zod';
import type { WorkflowInputValue } from '../intent/workflow-input.ts';
import { PROPOSAL_LIMITS } from './constants.ts';
import { ResponseQualitySchema } from './response-quality.ts';

export type JsonValue = WorkflowInputValue;
export interface JsonObject {
  [key: string]: JsonValue;
}

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);
/** An arbitrary JSON object; the workflow inside a draft stays opaque until native validation. */
export const JsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), JsonValueSchema);

const Name = z.string().min(1).max(96);
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const IntentDraftSchema = z
  .object({
    canonical_name: Name,
    pattern: z.string().min(1).max(PROPOSAL_LIMITS.patternChars),
    workflow: JsonObjectSchema,
    phrases: z.array(z.string().min(1).max(512)).min(1).max(PROPOSAL_LIMITS.phrases),
    trigger_words: z.array(z.string().min(1).max(64)).min(1).max(PROPOSAL_LIMITS.triggerWords),
    source_message: z.string().min(1).max(1000),
    format: z.string().min(1).max(32).optional(),
  })
  .strict();
export type IntentDraft = z.infer<typeof IntentDraftSchema>;

export const OPERATION_KINDS = ['create', 'generalize', 'consolidate', 'retire'] as const;
export type OperationKind = (typeof OPERATION_KINDS)[number];

export const OperationSchema = z
  .object({
    kind: z.enum(OPERATION_KINDS),
    sourceNames: z.array(Name).max(PROPOSAL_LIMITS.rules),
    intents: z.array(IntentDraftSchema).max(PROPOSAL_LIMITS.rules),
    reason: z.string().min(1).max(2000),
  })
  .strict();
export type ProposalOperation = z.infer<typeof OperationSchema>;

export const COMPARISON_VERDICTS = ['better', 'equivalent', 'worse', 'needs_context'] as const;

/** `intentResponse` and `idealResponse` are model judgment, never native execution output. */
export const ComparisonSchema = z
  .object({
    sampleId: z.number().int().positive(),
    previousAiResponse: z.string().max(16000),
    intentResponse: z.string().max(8000),
    idealResponse: z.string().max(8000),
    expectedTools: z.array(z.string().min(1).max(64)).max(24),
    verdict: z.enum(COMPARISON_VERDICTS),
    rationale: z.string().max(4000),
    quality: ResponseQualitySchema.optional(),
  })
  .strict();
export type Comparison = z.infer<typeof ComparisonSchema>;

export const GenerationArtifactSchema = z
  .object({
    kind: z.literal('proposal'),
    summary: z.string().min(1).max(4000),
    operations: z.array(OperationSchema).min(1).max(PROPOSAL_LIMITS.operations),
    comparisons: z.array(ComparisonSchema).max(64),
    primitiveSuggestions: z.array(z.string().min(1).max(1000)).max(16).optional(),
  })
  .strict();
export type GenerationArtifact = z.infer<typeof GenerationArtifactSchema>;

export const ReviewArtifactSchema = z
  .object({
    kind: z.literal('review'),
    proposalHash: Sha256,
    verdict: z.enum(['pass', 'revise']),
    findings: z.array(z.string().min(1).max(2000)).max(64),
    comparisons: z.array(ComparisonSchema).max(64),
  })
  .strict();
export type ReviewArtifact = z.infer<typeof ReviewArtifactSchema>;

/** Admin-authored revision: same operations, no worker comparisons required. */
export const ManualProposalSchema = z
  .object({
    summary: z.string().min(1).max(4000),
    operations: z.array(OperationSchema).min(1).max(PROPOSAL_LIMITS.operations),
  })
  .strict();
export type ManualProposal = z.infer<typeof ManualProposalSchema>;

// ── Enqueue input ────────────────────────────────────────────────────────────

export const EnqueueInputSchema = z
  .object({
    actorId: z.number().int(),
    chatId: z.number().int(),
    messageId: z.number().int().optional(),
    request: z.string().min(1).max(64000),
    previousAiResponse: z.string().max(256000).default(''),
    toolCalls: z
      .array(z.object({ name: z.string().min(1).max(128), input: JsonObjectSchema }).strict())
      .max(256)
      .default([]),
    toolResults: z
      .array(z.object({ success: z.boolean(), output: z.string().max(256000).optional() }).strict())
      .max(256)
      .default([]),
    recentMessages: z
      .array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(64000) }).strict())
      .max(256)
      .default([]),
    /** Stored as evidence only; never schedules generation by itself. */
    evidenceOnly: z.boolean().optional(),
  })
  .strict();
export type EnqueueInput = z.input<typeof EnqueueInputSchema>;

// ── Worker request bodies ────────────────────────────────────────────────────

const LeaseToken = z.string().min(16).max(128);
const JobId = z.number().int().positive();

export const WORKER_ERROR_CLASSES = [
  'quota',
  'auth',
  'token',
  'network',
  'timeout',
  'rate_limit',
  'server',
  'invalid_output',
] as const;
export type WorkerErrorClass = (typeof WORKER_ERROR_CLASSES)[number];

export const EVIDENCE_KINDS = ['samples', 'catalog', 'operations', 'log-summary'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const ClaimBodySchema = z.object({ workerId: z.string().min(1).max(128) }).strict();
export const HeartbeatBodySchema = z.object({ jobId: JobId, leaseToken: LeaseToken }).strict();
export const ResultBodySchema = z
  .object({
    jobId: JobId,
    leaseToken: LeaseToken,
    sessionId: z.string().min(8).max(200),
    artifact: z.union([GenerationArtifactSchema, ReviewArtifactSchema]),
  })
  .strict();
export const FailureBodySchema = z
  .object({
    jobId: JobId,
    leaseToken: LeaseToken,
    errorClass: z.enum(WORKER_ERROR_CLASSES),
    retryAfterMs: z
      .number()
      .int()
      .nonnegative()
      .max(7 * 24 * 3600_000)
      .optional(),
  })
  .strict();
export const EvidenceBodySchema = z
  .object({
    jobId: JobId,
    leaseToken: LeaseToken,
    kind: z.enum(EVIDENCE_KINDS),
    limit: z.number().int().min(1).max(64).optional(),
  })
  .strict();

// ── Admin request bodies ─────────────────────────────────────────────────────

export const AdminEnqueueBodySchema = z.union([
  EnqueueInputSchema,
  z
    .object({
      kind: z.literal('corpus'),
      sampleIds: z.array(z.number().int().positive()).min(1).max(PROPOSAL_LIMITS.rules),
    })
    .strict(),
]);
export const ProposalsBodySchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('list'),
      status: z.string().min(1).max(32).optional(),
    })
    .strict(),
  z.object({ action: z.literal('get'), id: z.number().int().positive() }).strict(),
  z.object({ action: z.literal('create'), proposal: ManualProposalSchema }).strict(),
]);
/** A hash prefix of at least 16 hex characters fits Telegram callback data. */
export const ApproveBodySchema = z
  .object({ id: z.number().int().positive(), expectedHash: z.string().regex(/^[0-9a-f]{16,64}$/) })
  .strict();
export const RejectBodySchema = z
  .object({ id: z.number().int().positive(), reason: z.string().max(2000).optional() })
  .strict();

/** JSON Schema of both artifacts for non-TypeScript workers (served by GET /schema and in claims). */
export function artifactJsonSchema() {
  return {
    instructions: 'Stage generate returns `proposal`; stage verify returns `review` for the claimed proposal hash.',
    proposal: z.toJSONSchema(GenerationArtifactSchema, { io: 'input' }),
    review: z.toJSONSchema(ReviewArtifactSchema, { io: 'input' }),
  };
}
