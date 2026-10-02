// Persisted job queue: sample dedup/accumulation, leases, the global rate bucket and backoff.
// Every mutation runs in an immediate sidecar transaction so concurrent processes never double-lease.
import { timingSafeEqual } from 'node:crypto';
import { normalize } from '../intent/normalizer.ts';
import type { IntentLearningLimits } from './constants.ts';
import { IntentLearningError, type LearningContext } from './context.ts';
import { newLeaseToken, sha256 } from './hashing.ts';
import type { SanitizedSample } from './redaction.ts';
import type { WorkerErrorClass } from './schemas.ts';
import { appendAudit, readMeta, writeMeta } from './store.ts';

export type JobStatus =
  | 'queued'
  | 'leased'
  | 'awaiting_admin'
  | 'needs_admin_revision'
  | 'active'
  | 'rejected'
  | 'conflict';
export type JobStage = 'generate' | 'verify';

export interface JobRow {
  id: number;
  scope_key: string;
  kind: 'scoped' | 'corpus';
  status: JobStatus;
  stage: JobStage;
  round: number;
  transient_failures: number;
  due_at: number;
  lease_hash: string | null;
  lease_expires_at: number | null;
  lease_started_at: number | null;
  lease_worker: string | null;
  proposal_id: number | null;
  last_review: string | null;
  last_error_class: string | null;
  created_at: number;
  updated_at: number;
}

export interface EnqueueResult {
  sampleId: number;
  /** Null when the sample is stored as evidence only. */
  jobId: number | null;
  deduplicated: boolean;
  /** True when the sample joined an already queued job. */
  accumulated: boolean;
}

const OPEN_STATUSES = "('queued', 'leased', 'awaiting_admin', 'needs_admin_revision')";
const DAY = 24 * 3600_000;
/** Provider-wide failures pause every claim, not just the failing job. */
const GLOBAL_PAUSE_CLASSES = new Set<WorkerErrorClass>(['quota', 'auth', 'token', 'rate_limit']);

export function scopeKeyOf(actorId: number, chatId: number): string {
  return `actor:${actorId}:chat:${chatId}`;
}

export function getJob(ctx: LearningContext, jobId: number): JobRow | null {
  return ctx.store.query<JobRow, [number]>('SELECT * FROM jobs WHERE id = ?').get(jobId);
}

function dedupKeyOf(scope: string, sample: SanitizedSample): string {
  const tools = [...new Set(sample.toolCalls.map((call) => call.name))].sort().join(',');
  return sha256(`${scope}\n${normalize(sample.request)}\n${tools}`);
}

function storeSample(
  ctx: LearningContext,
  scope: string,
  sample: SanitizedSample,
): { id: number; deduplicated: boolean } {
  const now = ctx.now();
  const key = dedupKeyOf(scope, sample);
  const existing = ctx.store.query<{ id: number }, [string]>('SELECT id FROM samples WHERE dedup_key = ?').get(key);
  if (existing) {
    // The first stored AI response stays the comparison baseline; repeats only count.
    ctx.store.run(
      'UPDATE samples SET occurrences = occurrences + 1, last_seen = ?, eligible = MAX(eligible, ?) WHERE id = ?',
      [now, sample.eligible ? 1 : 0, existing.id],
    );
    return { id: existing.id, deduplicated: true };
  }
  const inserted = ctx.store.run(
    `INSERT INTO samples(scope_key, actor_id, chat_id, message_id, dedup_key, request, previous_ai_response,
       tool_calls, tool_results, recent_messages, eligible, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      scope,
      sample.actorId,
      sample.chatId,
      sample.messageId,
      key,
      sample.request,
      sample.previousAiResponse,
      JSON.stringify(sample.toolCalls),
      JSON.stringify(sample.toolResults),
      JSON.stringify(sample.recentMessages),
      sample.eligible ? 1 : 0,
      now,
      now,
    ],
  );
  return { id: Number(inserted.lastInsertRowid), deduplicated: false };
}

function createJob(ctx: LearningContext, scope: string, kind: JobRow['kind']): number {
  const now = ctx.now();
  const result = ctx.store.run(
    `INSERT INTO jobs(scope_key, kind, status, stage, round, due_at, created_at, updated_at)
     VALUES (?, ?, 'queued', 'generate', 1, ?, ?, ?)`,
    [scope, kind, now, now, now],
  );
  return Number(result.lastInsertRowid);
}

/** Required samples must be compared by every stage; evidence only gives context. Never downgraded. */
function attachSample(ctx: LearningContext, jobId: number, sampleId: number, required: boolean): void {
  ctx.store.run(
    `INSERT INTO job_samples(job_id, sample_id, required) VALUES (?, ?, ?)
     ON CONFLICT(job_id, sample_id) DO UPDATE SET required = MAX(required, excluded.required)`,
    [jobId, sampleId, required ? 1 : 0],
  );
}

function findOpenScopedJob(ctx: LearningContext, scope: string): number | null {
  return (
    ctx.store
      .query<{ id: number }, [string, number]>(
        `SELECT id FROM jobs WHERE scope_key = ? AND kind = 'scoped' AND status = 'queued' AND stage = 'generate'
           AND round = 1 AND proposal_id IS NULL
           AND (SELECT COUNT(*) FROM job_samples WHERE job_id = jobs.id) < ?
         ORDER BY id LIMIT 1`,
      )
      .get(scope, ctx.limits.maxSamplesPerJob)?.id ?? null
  );
}

/** Stores one sanitized interaction; eligible samples accumulate into the scope's queued job. */
export function enqueueSample(ctx: LearningContext, sample: SanitizedSample): EnqueueResult {
  const scope = scopeKeyOf(sample.actorId, sample.chatId);
  return ctx.store
    .transaction((): EnqueueResult => {
      const stored = storeSample(ctx, scope, sample);
      const base = { sampleId: stored.id, deduplicated: stored.deduplicated };
      if (!sample.eligible) return { ...base, jobId: null, accumulated: false };
      const attached = ctx.store
        .query<{ id: number }, [number]>(
          `SELECT j.id FROM jobs j JOIN job_samples s ON s.job_id = j.id
           WHERE s.sample_id = ? AND s.required = 1 AND j.status IN ${OPEN_STATUSES} ORDER BY j.id LIMIT 1`,
        )
        .get(stored.id);
      if (attached) return { ...base, jobId: attached.id, accumulated: false };
      const open = findOpenScopedJob(ctx, scope);
      if (open !== null) {
        attachSample(ctx, open, stored.id, true);
        ctx.store.run('UPDATE jobs SET updated_at = ? WHERE id = ?', [ctx.now(), open]);
        return { ...base, jobId: open, accumulated: true };
      }
      const jobId = createJob(ctx, scope, 'scoped');
      attachSample(ctx, jobId, stored.id, true);
      attachRecentEvidence(ctx, jobId, scope);
      return { ...base, jobId, accumulated: false };
    })
    .immediate();
}

/** Recent evidence-only samples of the same scope give the worker conversational context. */
function attachRecentEvidence(ctx: LearningContext, jobId: number, scope: string): void {
  const evidence = ctx.store
    .query<{ id: number }, [string, number, number]>(
      'SELECT id FROM samples WHERE scope_key = ? AND eligible = 0 AND last_seen >= ? ORDER BY last_seen DESC LIMIT ?',
    )
    .all(scope, ctx.now() - DAY, ctx.limits.maxSamplesPerJob - 1);
  for (const row of evidence) attachSample(ctx, jobId, row.id, false);
}

/** Explicit admin batch across scopes; the only way samples of different chats meet in one job. */
export function createCorpusJob(ctx: LearningContext, sampleIds: number[], actor: string): number {
  return ctx.store
    .transaction(() => {
      const unique = [...new Set(sampleIds)];
      if (unique.length > ctx.limits.maxSamplesPerJob)
        throw new IntentLearningError('validation_failed', 'Too many samples for one corpus job');
      for (const id of unique)
        if (!ctx.store.query('SELECT 1 FROM samples WHERE id = ?').get(id))
          throw new IntentLearningError('not_found', `Sample ${id} does not exist`);
      const jobId = createJob(ctx, `corpus:${ctx.now()}`, 'corpus');
      for (const id of unique) attachSample(ctx, jobId, id, true);
      appendAudit(ctx.store, { at: ctx.now(), actor, action: 'corpus_enqueued', jobId, detail: unique.join(',') });
      return jobId;
    })
    .immediate();
}

/** Expired leases go back to the queue; the stage and round are kept, nothing is discarded. */
export function requeueStaleLeases(ctx: LearningContext): number {
  const now = ctx.now();
  const stale = ctx.store
    .query<{ id: number; lease_hash: string }, [number]>(
      "SELECT id, lease_hash FROM jobs WHERE status = 'leased' AND lease_expires_at <= ?",
    )
    .all(now);
  for (const job of stale) {
    ctx.store.run(
      "UPDATE stage_runs SET ended_at = ?, outcome = 'lease_expired' WHERE lease_hash = ? AND ended_at IS NULL",
      [now, job.lease_hash],
    );
    releaseLease(ctx, job.id, { status: 'queued', dueAt: now });
    appendAudit(ctx.store, { at: now, actor: 'server', action: 'lease_expired', jobId: job.id });
  }
  return stale.length;
}

export function releaseLease(ctx: LearningContext, jobId: number, next: { status: JobStatus; dueAt?: number }): void {
  ctx.store.run(
    `UPDATE jobs SET status = ?, due_at = COALESCE(?, due_at), lease_hash = NULL, lease_expires_at = NULL,
       lease_started_at = NULL, lease_worker = NULL, updated_at = ? WHERE id = ?`,
    [next.status, next.dueAt ?? null, ctx.now(), jobId],
  );
}

export interface RateState {
  activeLeases: number;
  startsLastMinute: number;
  startsLastHour: number;
  startsLastDay: number;
  pausedUntil: number | null;
}

export function rateState(ctx: LearningContext): RateState {
  const now = ctx.now();
  const count = (since: number) =>
    ctx.store.query<{ n: number }, [number]>('SELECT COUNT(*) AS n FROM lease_starts WHERE at > ?').get(since)?.n ?? 0;
  const paused = Number(readMeta(ctx.store, 'paused_until') ?? 0);
  return {
    activeLeases:
      ctx.store
        .query<{ n: number }, [number]>(
          "SELECT COUNT(*) AS n FROM jobs WHERE status = 'leased' AND lease_expires_at > ?",
        )
        .get(now)?.n ?? 0,
    startsLastMinute: count(now - 60_000),
    startsLastHour: count(now - 3600_000),
    startsLastDay: count(now - DAY),
    pausedUntil: paused > now ? paused : null,
  };
}

/** Earliest time another claim could succeed, or null when nothing is waiting. */
export function nextClaimAt(ctx: LearningContext): number | null {
  const now = ctx.now();
  const due = ctx.store
    .query<{ at: number | null }, []>("SELECT MIN(due_at) AS at FROM jobs WHERE status = 'queued'")
    .get()?.at;
  if (due === null || due === undefined) return null;
  const rate = rateState(ctx);
  const oldestIn = (windowMs: number) =>
    (ctx.store
      .query<{ at: number | null }, [number]>('SELECT MIN(at) AS at FROM lease_starts WHERE at > ?')
      .get(now - windowMs)?.at ?? now) + windowMs;
  const gates = [due, rate.pausedUntil ?? now];
  if (rate.startsLastMinute >= ctx.limits.startsPerMinute) gates.push(oldestIn(60_000));
  if (rate.startsLastHour >= ctx.limits.startsPerHour) gates.push(oldestIn(3600_000));
  if (rate.startsLastDay >= ctx.limits.startsPerDay) gates.push(oldestIn(DAY));
  return Math.max(now, ...gates);
}

function rateAllows(ctx: LearningContext, rate: RateState): boolean {
  const { limits } = ctx;
  return (
    rate.pausedUntil === null &&
    rate.activeLeases < limits.maxConcurrentLeases &&
    rate.startsLastMinute < limits.startsPerMinute &&
    rate.startsLastHour < limits.startsPerHour &&
    rate.startsLastDay < limits.startsPerDay
  );
}

export interface LeasedJob {
  job: JobRow;
  leaseToken: string;
  deadlineAt: number;
}

/**
 * Leases the job with the oldest due time when the global bucket allows a start. `prepare` runs
 * inside the transaction so a failure to build the payload leaves the job queued.
 */
export function leaseNext<T>(
  ctx: LearningContext,
  workerId: string,
  prepare: (job: JobRow) => T,
): { leased: LeasedJob; prepared: T } | null {
  return ctx.store
    .transaction(() => {
      requeueStaleLeases(ctx);
      if (!rateAllows(ctx, rateState(ctx))) return null;
      const now = ctx.now();
      const job = ctx.store
        .query<JobRow, [number]>(
          "SELECT * FROM jobs WHERE status = 'queued' AND due_at <= ? ORDER BY due_at, created_at, id LIMIT 1",
        )
        .get(now);
      if (!job) return null;
      const prepared = prepare(job);
      const leaseToken = newLeaseToken();
      const leaseHash = sha256(leaseToken);
      const deadlineAt = now + ctx.limits.leaseMs;
      ctx.store.run(
        `UPDATE jobs SET status = 'leased', lease_hash = ?, lease_expires_at = ?, lease_started_at = ?, lease_worker = ?,
           updated_at = ? WHERE id = ?`,
        [leaseHash, deadlineAt, now, workerId, now, job.id],
      );
      ctx.store.run(
        'INSERT INTO stage_runs(job_id, stage, round, worker_id, lease_hash, started_at) VALUES (?, ?, ?, ?, ?, ?)',
        [job.id, job.stage, job.round, workerId, leaseHash, now],
      );
      ctx.store.run('INSERT INTO lease_starts(at) VALUES (?)', [now]);
      ctx.store.run('DELETE FROM lease_starts WHERE at <= ?', [now - DAY]);
      return { leased: { job: { ...job, status: 'leased' as const }, leaseToken, deadlineAt }, prepared };
    })
    .immediate();
}

export function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** The job's current, unexpired lease for this token; anything else is a stale caller. */
export function requireLease(ctx: LearningContext, jobId: number, leaseToken: string): JobRow {
  const job = getJob(ctx, jobId);
  if (!job) throw new IntentLearningError('not_found', 'Unknown job');
  const valid =
    job.status === 'leased' &&
    job.lease_hash !== null &&
    sameHash(job.lease_hash, sha256(leaseToken)) &&
    (job.lease_expires_at ?? 0) > ctx.now();
  if (!valid) throw new IntentLearningError('stale_lease', 'Lease is not current for this job');
  return job;
}

export function extendLease(ctx: LearningContext, jobId: number, leaseToken: string): { leaseExpiresAt: number } {
  return ctx.store
    .transaction(() => {
      const job = requireLease(ctx, jobId, leaseToken);
      const cap = (job.lease_started_at ?? ctx.now()) + ctx.limits.maxLeaseLifetimeMs;
      const leaseExpiresAt = Math.min(ctx.now() + ctx.limits.leaseMs, cap);
      ctx.store.run('UPDATE jobs SET lease_expires_at = ?, updated_at = ? WHERE id = ?', [
        leaseExpiresAt,
        ctx.now(),
        jobId,
      ]);
      return { leaseExpiresAt };
    })
    .immediate();
}

/** Exponential growth from the minimum, ±20% jitter, never below `retryAfterMs`, clamped to the bounds. */
export function backoffDelayMs(
  limits: Pick<IntentLearningLimits, 'backoffMinMs' | 'backoffMaxMs'>,
  failures: number,
  retryAfterMs: number | undefined,
  random: () => number,
): number {
  const exponential = limits.backoffMinMs * 2 ** Math.min(Math.max(0, failures - 1), 20);
  const jittered = exponential * (0.8 + random() * 0.4);
  const delay = Math.max(jittered, retryAfterMs ?? 0);
  return Math.round(Math.min(limits.backoffMaxMs, Math.max(limits.backoffMinMs, delay)));
}

/**
 * Transient failure: the job keeps its stage and round, waits out a growing backoff and is never
 * discarded. Provider-wide classes pause every claim until the same time.
 */
export function deferTransient(
  ctx: LearningContext,
  job: JobRow,
  errorClass: WorkerErrorClass,
  retryAfterMs: number | undefined,
): { dueAt: number; pausedUntil: number | null; pauseStarted: boolean } {
  const now = ctx.now();
  const failures = job.transient_failures + 1;
  const dueAt = now + backoffDelayMs(ctx.limits, failures, retryAfterMs, ctx.random);
  ctx.store.run(`UPDATE stage_runs SET ended_at = ?, outcome = ? WHERE lease_hash = ? AND ended_at IS NULL`, [
    now,
    `failure:${errorClass}`,
    job.lease_hash,
  ]);
  ctx.store.run('UPDATE jobs SET transient_failures = ?, last_error_class = ? WHERE id = ?', [
    failures,
    errorClass,
    job.id,
  ]);
  releaseLease(ctx, job.id, { status: 'queued', dueAt });
  if (!GLOBAL_PAUSE_CLASSES.has(errorClass)) return { dueAt, pausedUntil: null, pauseStarted: false };
  const previous = Number(readMeta(ctx.store, 'paused_until') ?? 0);
  const pausedUntil = Math.max(previous, dueAt);
  writeMeta(ctx.store, 'paused_until', String(pausedUntil));
  return { dueAt, pausedUntil, pauseStarted: previous <= now };
}
