// Facade over the learning modules. Direct methods are the contract for the HTTP route, the chat
// handlers and the admin CLI alike; none of them lets a worker approve or change active intents.
import type { Database } from 'bun:sqlite';
import type { z } from 'zod';
import { IntentRepository } from '../../database/repositories/intent.repository.ts';
import { cmdLogger } from '../../utils/logger.ts';
import { seedIntents } from '../intent/seed-catalog.ts';
import type { CanonicalSeed } from '../intent/seed-replacement.ts';
import { type ApprovalResult, approveProposal, recoverActivations } from './activation.ts';
import {
  DEFAULT_LIMITS,
  type IntentLearningLimits,
  sidecarPathFor,
  WORKER_MODEL,
  WORKER_PERMISSION_MODE,
} from './constants.ts';
import type { LearningContext } from './context.ts';
import { ledgerAccepts } from './ledger.ts';
import { type AdminNotification, drainOutbox } from './outbox.ts';
import { buildClaimPayload, type ClaimPayload, getProposalRow, jobEvidence } from './payload.ts';
import {
  authorizeAdmin,
  createManualProposal,
  type LearningActor,
  listProposals,
  type ProposalView,
  rejectProposal,
  viewProposal,
} from './proposals.ts';
import {
  createCorpusJob,
  type EnqueueResult,
  enqueueSample,
  extendLease,
  leaseNext,
  nextClaimAt,
  rateState,
  requireLease,
} from './queue.ts';
import { sanitizeEnqueueInput } from './redaction.ts';
import { readRegistry, registryIsIntact } from './registry.ts';
import type {
  EnqueueInput,
  EvidenceBodySchema,
  FailureBodySchema,
  ManualProposal,
  ResultBodySchema,
} from './schemas.ts';
import { acceptResult, type FailureOutcome, type ResultOutcome, recordFailure } from './stage-machine.ts';
import { openLearningStore } from './store.ts';

export interface IntentLearningServiceOptions {
  /** Main calendar database; active intents and the basis manifest stay there. */
  mainDb: Database;
  /** Sidecar path; defaults to `<mainDb.filename>.intent-learning.sqlite`. */
  sidecarPath?: string;
  /** BOT_ADMIN_ID. Without it no chat or CLI actor can approve. */
  adminId?: number | null;
  limits?: Partial<IntentLearningLimits>;
  now?: () => number;
  random?: () => number;
  sourceSeed?: readonly CanonicalSeed[];
  intentRepo?: IntentRepository;
  /** Called after an activation so the parent can reload the matcher. */
  onRegistryChanged?: () => void;
}

export interface ClaimResponse {
  jobId: number;
  leaseToken: string;
  stage: 'generate' | 'verify';
  round: number;
  model: typeof WORKER_MODEL;
  permissionMode: typeof WORKER_PERMISSION_MODE;
  payload: ClaimPayload;
  deadlineAt: number;
}

export interface LearningStatus {
  jobs: { status: string; count: number }[];
  nextClaimAt: number | null;
  rate: ReturnType<typeof rateState> & { limits: IntentLearningLimits };
  awaitingAdmin: { id: number; hash: string; origin: string; summary: string; createdAt: number }[];
  revisions: { id: number; proposalId: number; status: string; targetFingerprint: string; createdAt: number }[];
  registry: { managed: boolean; fingerprint: string; sourceFingerprint: string; intact: boolean } | { error: string };
  outboxPending: number;
}

export class IntentLearningService {
  private constructor(
    private readonly ctx: LearningContext,
    private readonly onRegistryChanged: () => void,
  ) {}

  static open(options: IntentLearningServiceOptions): IntentLearningService {
    const sidecarPath = options.sidecarPath ?? sidecarPathFor(options.mainDb.filename);
    const sourceSeed = options.sourceSeed ?? seedIntents;
    const store = openLearningStore(sidecarPath);
    const ctx: LearningContext = {
      store,
      mainDb: options.mainDb,
      intentRepo:
        options.intentRepo ??
        new IntentRepository(options.mainDb, sourceSeed, (fingerprint) => ledgerAccepts(store, fingerprint)),
      limits: { ...DEFAULT_LIMITS, ...options.limits },
      now: options.now ?? Date.now,
      random: options.random ?? Math.random,
      sourceSeed,
      adminId: options.adminId ?? null,
    };
    const service = new IntentLearningService(ctx, options.onRegistryChanged ?? (() => {}));
    service.recover();
    return service;
  }

  /** Reconciles interrupted activations. Safe at any time; never writes the main database. */
  recover(): void {
    try {
      const result = recoverActivations(this.ctx);
      if (result.acknowledged > 0) this.onRegistryChanged();
    } catch (err) {
      cmdLogger.error({ err }, 'Intent-learning activation recovery failed; retried on the next approval');
    }
  }

  enqueue(input: EnqueueInput): EnqueueResult {
    return enqueueSample(this.ctx, sanitizeEnqueueInput(input));
  }

  enqueueCorpus(sampleIds: number[], actor: LearningActor): { jobId: number } {
    return { jobId: createCorpusJob(this.ctx, sampleIds, authorizeAdmin(this.ctx, actor)) };
  }

  claim(workerId: string): ClaimResponse | null {
    const leased = leaseNext(this.ctx, workerId, (job) => buildClaimPayload(this.ctx, job));
    if (!leased) return null;
    const { job, leaseToken, deadlineAt } = leased.leased;
    return {
      jobId: job.id,
      leaseToken,
      stage: job.stage,
      round: job.round,
      model: WORKER_MODEL,
      permissionMode: WORKER_PERMISSION_MODE,
      payload: leased.prepared,
      deadlineAt,
    };
  }

  nextClaimAt(): number | null {
    return nextClaimAt(this.ctx);
  }

  heartbeat(jobId: number, leaseToken: string): { leaseExpiresAt: number } {
    return extendLease(this.ctx, jobId, leaseToken);
  }

  submitResult(body: z.infer<typeof ResultBodySchema>): ResultOutcome {
    return acceptResult(this.ctx, body);
  }

  reportFailure(body: z.infer<typeof FailureBodySchema>): FailureOutcome {
    return recordFailure(this.ctx, body);
  }

  evidence(body: z.infer<typeof EvidenceBodySchema>) {
    const job = requireLease(this.ctx, body.jobId, body.leaseToken);
    return jobEvidence(this.ctx, job, body.kind, body.limit ?? 16);
  }

  listProposals(status?: string): ProposalView[] {
    return listProposals(this.ctx, status);
  }

  getProposal(id: number): ProposalView | null {
    const row = getProposalRow(this.ctx, id);
    return row ? viewProposal(row) : null;
  }

  createManualProposal(proposal: ManualProposal, actor: LearningActor) {
    return createManualProposal(this.ctx, proposal, actor);
  }

  /** Chat approval passes `{ kind: 'telegram', userId }`; only the configured admin succeeds. */
  approve(input: { proposalId: number; expectedHash: string; actor: LearningActor }): ApprovalResult {
    const result = approveProposal(this.ctx, input);
    this.onRegistryChanged();
    return result;
  }

  reject(input: { proposalId: number; actor: LearningActor; reason?: string }): void {
    rejectProposal(this.ctx, input.proposalId, input.actor, input.reason);
  }

  drainOutbox(send: (notification: AdminNotification) => Promise<void>, limit?: number) {
    return drainOutbox(this.ctx, send, limit);
  }

  status(): LearningStatus {
    const { store } = this.ctx;
    return {
      jobs: store
        .query<{ status: string; count: number }, []>('SELECT status, COUNT(*) AS count FROM jobs GROUP BY status')
        .all(),
      nextClaimAt: nextClaimAt(this.ctx),
      rate: { ...rateState(this.ctx), limits: this.ctx.limits },
      awaitingAdmin: listProposals(this.ctx, 'awaiting_admin').map((p) => ({
        id: p.id,
        hash: p.hash,
        origin: p.origin,
        summary: p.summary,
        createdAt: p.createdAt,
      })),
      revisions: store
        .query<{ id: number; proposalId: number; status: string; targetFingerprint: string; createdAt: number }, []>(
          'SELECT id, proposal_id AS proposalId, status, target_fingerprint AS targetFingerprint, created_at AS createdAt FROM revisions ORDER BY id DESC LIMIT 10',
        )
        .all(),
      registry: this.registryStatus(),
      outboxPending:
        store.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM outbox WHERE status = 'pending'").get()?.n ?? 0,
    };
  }

  close(): void {
    this.ctx.store.close();
  }

  private registryStatus(): LearningStatus['registry'] {
    try {
      const registry = readRegistry(this.ctx.mainDb, this.ctx.sourceSeed);
      return {
        managed: registry.managed,
        fingerprint: registry.fingerprint,
        sourceFingerprint: registry.sourceFingerprint,
        intact: registryIsIntact(registry),
      };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'unreadable' };
    }
  }
}
