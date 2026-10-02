// Bounded, job-scoped data handed to a worker: the claim payload and the evidence kinds.
// Nothing here accepts a path, SQL or command from the worker; every query is fixed and job-scoped.
import { z } from 'zod';
import { jsonCodec } from '../../utils/json-codec.ts';
import { cmdLogger } from '../../utils/logger.ts';
import { toolSchemas } from '../ai/tool-schemas.ts';
import { INSTRUCTIONS_VERSION } from './constants.ts';
import type { LearningContext } from './context.ts';
import type { JobRow } from './queue.ts';
import { readRegistryOrThrow } from './registry.ts';
import { RESPONSE_QUALITY_RUBRIC } from './response-quality.ts';
import {
  artifactJsonSchema,
  type Comparison,
  ComparisonSchema,
  type EvidenceKind,
  type JsonObject,
  JsonObjectSchema,
  OperationSchema,
  type ProposalOperation,
} from './schemas.ts';

const ToolCallsJson = jsonCodec(z.array(z.object({ name: z.string(), input: JsonObjectSchema })));
const ToolResultsJson = jsonCodec(z.array(z.object({ success: z.boolean(), output: z.string().optional() })));
const RecentJson = jsonCodec(z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string() })));

export const StoredProposalBodySchema = z.object({
  summary: z.string(),
  operations: z.array(OperationSchema),
  comparisons: z.array(ComparisonSchema).default([]),
  primitiveSuggestions: z.array(z.string()).optional(),
});
export const StoredProposalBodyJson = jsonCodec(StoredProposalBodySchema);
export const StoredReviewJson = jsonCodec(
  z.object({
    verdict: z.enum(['pass', 'revise']),
    findings: z.array(z.string()),
    source: z.enum(['reviewer', 'native']),
    proposalHash: z.string().optional(),
    comparisons: z.array(ComparisonSchema).default([]),
  }),
);
export type StoredReview = z.infer<typeof StoredReviewJson>;

export interface WorkerSample {
  sampleId: number;
  request: string;
  previousAiResponse: string;
  toolCalls: { name: string; input: JsonObject }[];
  toolResults: { success: boolean; output?: string }[];
  recentMessages: { role: 'user' | 'assistant'; text: string }[];
  occurrences: number;
  /** False for evidence-only context (greetings, chatter without tool calls). */
  eligible: boolean;
  /** Every required sample must be compared exactly once by the generator and by the reviewer. */
  required: boolean;
}

interface SampleRow {
  id: number;
  request: string;
  previous_ai_response: string;
  tool_calls: string;
  tool_results: string;
  recent_messages: string;
  occurrences: number;
  eligible: number;
  required: number;
}

/** All samples attached to the job, required first. Attachment is bounded by `maxSamplesPerJob`. */
export function loadJobSamples(ctx: LearningContext, jobId: number): WorkerSample[] {
  const rows = ctx.store
    .query<SampleRow, [number]>(
      `SELECT s.*, j.required AS required FROM samples s JOIN job_samples j ON j.sample_id = s.id
       WHERE j.job_id = ? ORDER BY j.required DESC, s.id`,
    )
    .all(jobId);
  return rows.map((row) => ({
    sampleId: row.id,
    request: row.request,
    previousAiResponse: row.previous_ai_response,
    toolCalls: ToolCallsJson.safeParse(row.tool_calls).data ?? [],
    toolResults: ToolResultsJson.safeParse(row.tool_results).data ?? [],
    recentMessages: RecentJson.safeParse(row.recent_messages).data ?? [],
    occurrences: row.occurrences,
    eligible: row.eligible === 1,
    required: row.required === 1,
  }));
}

export interface ActiveIntentSummary {
  canonical_name: string;
  pattern: string;
  phrases: string[];
  trigger_words: string[];
  source_message: string;
  /** Omitted when larger than the per-rule bound; fetch it through the `catalog` evidence. */
  workflow?: JsonObject;
}

const WORKFLOW_CHARS = 8000;
const MAX_ACTIVE_INTENTS = 256;

export function activeIntentSummaries(ctx: LearningContext, withWorkflows = true): ActiveIntentSummary[] {
  return readRegistryOrThrow(ctx)
    .rules.slice(0, MAX_ACTIVE_INTENTS)
    .map((rule) => ({
      canonical_name: rule.canonical_name,
      pattern: rule.pattern,
      phrases: rule.phrases.slice(0, 16),
      trigger_words: rule.trigger_words.slice(0, 32),
      source_message: rule.source_message,
      ...(withWorkflows && JSON.stringify(rule.workflow).length <= WORKFLOW_CHARS ? { workflow: rule.workflow } : {}),
    }));
}

export interface ProposalRow {
  id: number;
  job_id: number | null;
  origin: 'worker' | 'manual';
  status: string;
  hash: string;
  body: string;
  validation: string;
  base_fingerprint: string;
  target_fingerprint: string;
  source_digest: string;
  review: string | null;
  created_at: number;
  decided_at: number | null;
  decided_by: string | null;
}

export function getProposalRow(ctx: LearningContext, id: number): ProposalRow | null {
  return ctx.store.query<ProposalRow, [number]>('SELECT * FROM proposals WHERE id = ?').get(id);
}

export interface WorkerProposal {
  id: number;
  hash: string;
  summary: string;
  operations: ProposalOperation[];
  comparisons: Comparison[];
  validationWarnings: string[];
}

const ValidationJson = jsonCodec(z.object({ errors: z.array(z.string()), warnings: z.array(z.string()) }));

export function workerProposal(row: ProposalRow): WorkerProposal {
  const body = StoredProposalBodyJson.parse(row.body);
  return {
    id: row.id,
    hash: row.hash,
    summary: body.summary,
    operations: body.operations,
    comparisons: body.comparisons,
    validationWarnings: ValidationJson.safeParse(row.validation).data?.warnings ?? [],
  };
}

export interface ClaimPayload {
  samples: WorkerSample[];
  /** Exactly these samples need one comparison each in the artifact. */
  requiredSampleIds: number[];
  /** Evidence-only samples left out to respect the size bound; fetch them via `samples` evidence. */
  omittedEvidenceSampleIds: number[];
  /** True when active workflows were left out; fetch them via `catalog` evidence. */
  workflowsOmitted: boolean;
  activeIntents: ActiveIntentSummary[];
  proposal?: WorkerProposal;
  previousReview?: StoredReview;
  instructionsVersion: string;
  responseQualityRubric: string;
  artifactSchema: ReturnType<typeof artifactJsonSchema>;
}

/** Soft bound: optional context is dropped first; required samples are never dropped. */
export const MAX_PAYLOAD_CHARS = 768 * 1024;

export function buildClaimPayload(ctx: LearningContext, job: JobRow): ClaimPayload {
  const proposalRow = job.proposal_id === null ? null : getProposalRow(ctx, job.proposal_id);
  const review = job.last_review === null ? undefined : StoredReviewJson.safeParse(job.last_review).data;
  const samples = loadJobSamples(ctx, job.id);
  const payload: ClaimPayload = {
    samples,
    requiredSampleIds: samples.filter((sample) => sample.required).map((sample) => sample.sampleId),
    omittedEvidenceSampleIds: [],
    workflowsOmitted: false,
    activeIntents: activeIntentSummaries(ctx),
    ...(proposalRow ? { proposal: workerProposal(proposalRow) } : {}),
    ...(job.stage === 'generate' && review ? { previousReview: review } : {}),
    instructionsVersion: INSTRUCTIONS_VERSION,
    responseQualityRubric: RESPONSE_QUALITY_RUBRIC,
    artifactSchema: artifactJsonSchema(),
  };
  const size = () => JSON.stringify(payload).length;
  if (size() > MAX_PAYLOAD_CHARS) {
    payload.activeIntents = activeIntentSummaries(ctx, false);
    payload.workflowsOmitted = true;
  }
  while (size() > MAX_PAYLOAD_CHARS) {
    const index = payload.samples.findLastIndex((sample) => !sample.required);
    if (index < 0) break;
    payload.omittedEvidenceSampleIds.push(payload.samples[index]!.sampleId);
    payload.samples.splice(index, 1);
  }
  if (size() > MAX_PAYLOAD_CHARS)
    cmdLogger.warn({ jobId: job.id, chars: size() }, 'Claim payload exceeds its soft bound; required samples kept');
  return payload;
}

/** Evidence limited to the leased job; the kinds are a closed list. */
export function jobEvidence(ctx: LearningContext, job: JobRow, kind: EvidenceKind, limit: number) {
  switch (kind) {
    case 'samples':
      return { kind, samples: loadJobSamples(ctx, job.id).slice(0, limit) };
    case 'catalog':
      return { kind, intents: activeIntentSummaries(ctx).slice(0, limit), tools: Object.keys(toolSchemas).sort() };
    case 'operations':
      return {
        kind,
        proposals: ctx.store
          .query<ProposalRow, [number, number]>('SELECT * FROM proposals WHERE job_id = ? ORDER BY id DESC LIMIT ?')
          .all(job.id, limit)
          .map((row) => ({ status: row.status, ...workerProposal(row) })),
      };
    case 'log-summary':
      return {
        kind,
        stageRuns: ctx.store
          .query<
            { stage: string; round: number; started_at: number; ended_at: number | null; outcome: string | null },
            [number, number]
          >(
            'SELECT stage, round, started_at, ended_at, outcome FROM stage_runs WHERE job_id = ? ORDER BY id DESC LIMIT ?',
          )
          .all(job.id, limit),
        audit: ctx.store
          .query<{ at: number; action: string; detail: string }, [number, number]>(
            'SELECT at, action, detail FROM audit WHERE job_id = ? ORDER BY id DESC LIMIT ?',
          )
          .all(job.id, limit),
      };
  }
}
