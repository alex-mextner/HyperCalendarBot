// Server-owned stage machine: generate → fresh verify → (revise → next generate, at most N rounds)
// → awaiting_admin or needs_admin_revision. Workers deliver artifacts; they never decide transitions.
import { z } from 'zod';
import { jsonCodec } from '../../utils/json-codec.ts';
import { IntentLearningError, type LearningContext } from './context.ts';
import { sha256, stableHash } from './hashing.ts';
import { queueNotification } from './outbox.ts';
import {
  getProposalRow,
  loadJobSamples,
  type ProposalRow,
  StoredProposalBodyJson,
  type StoredReview,
  type WorkerSample,
} from './payload.ts';
import { validateProposal } from './proposal-validator.ts';
import { describeProposal, insertProposal, type ProposalBody, recordValidation } from './proposals.ts';
import { deferTransient, type JobRow, releaseLease, requireLease, sameHash } from './queue.ts';
import { readRegistryOrThrow } from './registry.ts';
import { responseQualityFindings } from './response-quality.ts';
import type { Comparison, FailureBodySchema, GenerationArtifact, ResultBodySchema, ReviewArtifact } from './schemas.ts';
import { appendAudit } from './store.ts';

const ResultOutcomeSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('verify_queued'), proposalId: z.number(), proposalHash: z.string() }),
  z.object({ outcome: z.literal('revision_queued'), round: z.number(), findings: z.array(z.string()) }),
  z.object({ outcome: z.literal('needs_admin_revision'), proposalId: z.number().nullable() }),
  z.object({ outcome: z.literal('awaiting_admin'), proposalId: z.number(), proposalHash: z.string() }),
]);
export type ResultOutcome = z.infer<typeof ResultOutcomeSchema>;
const ResultOutcomeJson = jsonCodec(ResultOutcomeSchema);

/** Comparisons must cite this job's samples; the previous AI response always comes from storage. */
function groundComparisons(comparisons: Comparison[], samples: WorkerSample[]): Comparison[] {
  const byId = new Map(samples.map((sample) => [sample.sampleId, sample]));
  return comparisons.map((comparison) => {
    const sample = byId.get(comparison.sampleId);
    if (!sample)
      throw new IntentLearningError(
        'invalid_artifact',
        `Comparison cites sample ${comparison.sampleId} outside this job`,
      );
    return { ...comparison, previousAiResponse: sample.previousAiResponse };
  });
}

/** Every required sample is compared exactly once; no sample is compared twice. */
export function coverageFindings(comparisons: readonly Comparison[], samples: readonly WorkerSample[]): string[] {
  const counts = new Map<number, number>();
  for (const comparison of comparisons) counts.set(comparison.sampleId, (counts.get(comparison.sampleId) ?? 0) + 1);
  const findings: string[] = [];
  for (const sample of samples)
    if (sample.required && !counts.has(sample.sampleId)) findings.push(`Sample ${sample.sampleId} has no comparison`);
  for (const [sampleId, count] of counts) if (count > 1) findings.push(`Sample ${sampleId} is compared ${count} times`);
  return findings;
}

function closeStageRun(ctx: LearningContext, job: JobRow, sessionId: string, outcome: string): void {
  ctx.store.run(
    'UPDATE stage_runs SET session_id = ?, ended_at = ?, outcome = ? WHERE lease_hash = ? AND ended_at IS NULL',
    [sessionId, ctx.now(), outcome, job.lease_hash],
  );
}

/** A failed quality check: the next generation round, or a stop for admin revision when exhausted. */
export function consumeQualityRound(
  ctx: LearningContext,
  job: JobRow,
  review: StoredReview,
  proposalId: number | null,
): ResultOutcome {
  const now = ctx.now();
  ctx.store.run('UPDATE jobs SET last_review = ?, transient_failures = 0 WHERE id = ?', [
    JSON.stringify(review),
    job.id,
  ]);
  if (job.round >= ctx.limits.maxGenerationRounds) {
    releaseLease(ctx, job.id, { status: 'needs_admin_revision' });
    if (proposalId !== null)
      ctx.store.run(
        "UPDATE proposals SET status = 'needs_admin_revision' WHERE id = ? AND status IN ('verifying', 'invalid')",
        [proposalId],
      );
    appendAudit(ctx.store, { at: now, actor: 'server', action: 'needs_admin_revision', jobId: job.id, proposalId });
    queueNotification(ctx, 'needs_admin_revision', `needs_admin_revision:${job.id}`, {
      text: `Intent learning job #${job.id} used ${job.round} rounds without a passing proposal.\n${review.findings.slice(0, 8).join('\n')}`,
      jobId: job.id,
      ...(proposalId === null ? {} : { proposalId }),
    });
    return { outcome: 'needs_admin_revision', proposalId };
  }
  if (proposalId !== null)
    ctx.store.run("UPDATE proposals SET status = 'superseded' WHERE id = ? AND status = 'verifying'", [proposalId]);
  releaseLease(ctx, job.id, { status: 'queued', dueAt: now });
  ctx.store.run("UPDATE jobs SET stage = 'generate', round = round + 1 WHERE id = ?", [job.id]);
  appendAudit(ctx.store, { at: now, actor: 'server', action: 'revision_queued', jobId: job.id, proposalId });
  return { outcome: 'revision_queued', round: job.round + 1, findings: review.findings };
}

function nativeRevise(findings: string[], proposalHash: string, comparisons: Comparison[] = []): StoredReview {
  return { verdict: 'revise', findings, source: 'native', proposalHash, comparisons };
}

function onGeneration(
  ctx: LearningContext,
  job: JobRow,
  artifact: GenerationArtifact,
  samples: WorkerSample[],
): ResultOutcome {
  const body: ProposalBody = {
    summary: artifact.summary,
    operations: artifact.operations,
    comparisons: artifact.comparisons,
    ...(artifact.primitiveSuggestions ? { primitiveSuggestions: artifact.primitiveSuggestions } : {}),
  };
  const validated = validateProposal(body, readRegistryOrThrow(ctx), samples);
  const errors = [...validated.errors, ...coverageFindings(artifact.comparisons, samples)];
  const validation = { ...validated, ok: errors.length === 0, errors };
  const stored = insertProposal(ctx, {
    jobId: job.id,
    origin: 'worker',
    status: validation.ok ? 'verifying' : 'invalid',
    body,
    validation,
  });
  ctx.store.run('UPDATE jobs SET proposal_id = ? WHERE id = ?', [stored.id, job.id]);
  if (!validation.ok) return consumeQualityRound(ctx, job, nativeRevise(errors, stored.hash), stored.id);
  releaseLease(ctx, job.id, { status: 'queued', dueAt: ctx.now() });
  ctx.store.run("UPDATE jobs SET stage = 'verify', transient_failures = 0 WHERE id = ?", [job.id]);
  appendAudit(ctx.store, {
    at: ctx.now(),
    actor: 'server',
    action: 'verify_queued',
    jobId: job.id,
    proposalId: stored.id,
  });
  return { outcome: 'verify_queued', proposalId: stored.id, proposalHash: stored.hash };
}

/**
 * A reviewer pass is not trusted blindly. It counts only when the review has no findings, covers
 * every required sample exactly once, and native validation holds for both the generator's and the
 * reviewer's comparisons (a matched sample judged worse or needing context blocks the proposal).
 */
function passBlockers(ctx: LearningContext, proposal: ProposalRow, artifact: ReviewArtifact, samples: WorkerSample[]) {
  const body = StoredProposalBodyJson.parse(proposal.body);
  const registry = readRegistryOrThrow(ctx);
  const generator = validateProposal(body, registry, samples);
  const reviewer = validateProposal({ ...body, comparisons: artifact.comparisons }, registry, samples);
  const blockers = [
    ...responseQualityFindings(artifact.comparisons),
    ...artifact.findings.map((finding) => `Reviewer finding: ${finding}`),
    ...coverageFindings(artifact.comparisons, samples).map((finding) => `Review: ${finding}`),
    ...generator.errors,
    ...reviewer.errors,
  ];
  return { blockers: [...new Set(blockers)], validation: generator };
}

function markAwaitingAdmin(ctx: LearningContext, job: JobRow, proposal: ProposalRow, review: StoredReview): void {
  ctx.store.run("UPDATE proposals SET status = 'awaiting_admin' WHERE id = ?", [proposal.id]);
  releaseLease(ctx, job.id, { status: 'awaiting_admin' });
  ctx.store.run('UPDATE jobs SET last_review = ?, transient_failures = 0 WHERE id = ?', [
    JSON.stringify(review),
    job.id,
  ]);
  appendAudit(ctx.store, {
    at: ctx.now(),
    actor: 'server',
    action: 'awaiting_admin',
    jobId: job.id,
    proposalId: proposal.id,
  });
  queueNotification(ctx, 'proposal_ready', `proposal_ready:${proposal.id}`, {
    text: describeProposal(proposal.id, StoredProposalBodyJson.parse(proposal.body), proposal.hash),
    proposalId: proposal.id,
    jobId: job.id,
    hashPrefix: proposal.hash.slice(0, 16),
  });
}

function onReview(ctx: LearningContext, job: JobRow, artifact: ReviewArtifact, samples: WorkerSample[]): ResultOutcome {
  const proposal = job.proposal_id === null ? null : getProposalRow(ctx, job.proposal_id);
  if (!proposal || proposal.status !== 'verifying')
    throw new IntentLearningError('invalid_state', 'No proposal is waiting for verification');
  if (artifact.proposalHash !== proposal.hash)
    throw new IntentLearningError('hash_mismatch', 'Review targets a different proposal hash');
  const review: StoredReview = {
    verdict: artifact.verdict,
    findings: artifact.findings,
    source: 'reviewer',
    proposalHash: artifact.proposalHash,
    comparisons: artifact.comparisons,
  };
  ctx.store.run('UPDATE proposals SET review = ? WHERE id = ?', [JSON.stringify(review), proposal.id]);
  if (artifact.verdict === 'revise') return consumeQualityRound(ctx, job, review, proposal.id);
  const { blockers, validation } = passBlockers(ctx, proposal, artifact, samples);
  recordValidation(ctx, proposal.id, validation);
  if (blockers.length)
    return consumeQualityRound(ctx, job, nativeRevise(blockers, proposal.hash, artifact.comparisons), proposal.id);
  markAwaitingAdmin(ctx, job, proposal, review);
  return { outcome: 'awaiting_admin', proposalId: proposal.id, proposalHash: proposal.hash };
}

/**
 * A result retried after a lost HTTP acknowledgement (same job, lease, session and artifact) returns
 * the recorded outcome without re-running the stage. Any other reuse of a session is refused.
 */
function priorOutcome(ctx: LearningContext, body: z.infer<typeof ResultBodySchema>): ResultOutcome | null {
  const prior = ctx.store
    .query<{ job_id: number; hash: string; outcome: string | null; lease_hash: string }, [string]>(
      `SELECT a.job_id, a.hash, a.outcome, r.lease_hash FROM artifacts a
       JOIN stage_runs r ON r.session_id = a.session_id WHERE a.session_id = ?`,
    )
    .get(body.sessionId);
  if (!prior) {
    if (ctx.store.query('SELECT 1 FROM stage_runs WHERE session_id = ?').get(body.sessionId))
      throw new IntentLearningError('reused_session', 'Every stage needs a fresh worker session');
    return null;
  }
  const same =
    prior.job_id === body.jobId &&
    sameHash(prior.lease_hash, sha256(body.leaseToken)) &&
    prior.hash === stableHash(body.artifact);
  const outcome = prior.outcome === null ? null : ResultOutcomeJson.safeParse(prior.outcome);
  if (!same || !outcome?.success)
    throw new IntentLearningError('reused_session', 'Every stage needs a fresh worker session');
  return outcome.data;
}

/** Accepts one stage artifact under the current lease with a session never used before. */
export function acceptResult(ctx: LearningContext, body: z.infer<typeof ResultBodySchema>): ResultOutcome {
  return ctx.store
    .transaction((): ResultOutcome => {
      const replay = priorOutcome(ctx, body);
      if (replay) return replay;
      const job = requireLease(ctx, body.jobId, body.leaseToken);
      const expected = job.stage === 'generate' ? 'proposal' : 'review';
      if (body.artifact.kind !== expected)
        throw new IntentLearningError('wrong_stage', `Stage ${job.stage} expects a ${expected} artifact`);
      const samples = loadJobSamples(ctx, job.id);
      const artifact = { ...body.artifact, comparisons: groundComparisons(body.artifact.comparisons, samples) };
      ctx.store.run(
        'INSERT INTO artifacts(job_id, stage, round, session_id, hash, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [job.id, job.stage, job.round, body.sessionId, stableHash(body.artifact), JSON.stringify(artifact), ctx.now()],
      );
      closeStageRun(ctx, job, body.sessionId, `result:${artifact.kind}`);
      const outcome =
        artifact.kind === 'proposal'
          ? onGeneration(ctx, job, artifact, samples)
          : onReview(ctx, job, artifact, samples);
      ctx.store.run('UPDATE artifacts SET outcome = ? WHERE session_id = ?', [JSON.stringify(outcome), body.sessionId]);
      return outcome;
    })
    .immediate();
}

export type FailureOutcome = { outcome: 'deferred'; dueAt: number; pausedUntil: number | null } | ResultOutcome;

/**
 * Transient classes defer the job with backoff and never consume a quality round. `invalid_output`
 * means the model produced nothing usable, which is a quality failure of this round.
 */
export function recordFailure(ctx: LearningContext, body: z.infer<typeof FailureBodySchema>): FailureOutcome {
  return ctx.store
    .transaction((): FailureOutcome => {
      const job = requireLease(ctx, body.jobId, body.leaseToken);
      appendAudit(ctx.store, { at: ctx.now(), actor: 'worker', action: `failure:${body.errorClass}`, jobId: job.id });
      if (body.errorClass === 'invalid_output') {
        ctx.store.run(
          "UPDATE stage_runs SET ended_at = ?, outcome = 'failure:invalid_output' WHERE lease_hash = ? AND ended_at IS NULL",
          [ctx.now(), job.lease_hash],
        );
        const review: StoredReview = {
          verdict: 'revise',
          findings: [`The ${job.stage} stage produced no valid artifact`],
          source: 'native',
          comparisons: [],
        };
        return consumeQualityRound(ctx, job, review, job.stage === 'verify' ? job.proposal_id : null);
      }
      const deferred = deferTransient(ctx, job, body.errorClass, body.retryAfterMs);
      if (deferred.pauseStarted)
        queueNotification(ctx, 'worker_paused', `worker_paused:${ctx.now()}`, {
          text: `Intent learning paused after a ${body.errorClass} failure until ${new Date(deferred.dueAt).toISOString()}. Jobs are kept.`,
          jobId: job.id,
        });
      return { outcome: 'deferred', dueAt: deferred.dueAt, pausedUntil: deferred.pausedUntil };
    })
    .immediate();
}
