// Proposal records: hashing, storage, admin authorization, manual drafts, listing and rejection.
import { IntentLearningError, type LearningContext } from './context.ts';
import { stableHash } from './hashing.ts';
import { queueNotification } from './outbox.ts';
import { getProposalRow, type ProposalRow, StoredProposalBodyJson } from './payload.ts';
import { type ProposalValidation, validateProposal } from './proposal-validator.ts';
import { readRegistryOrThrow } from './registry.ts';
import type { Comparison, ManualProposal, ProposalOperation } from './schemas.ts';
import { appendAudit } from './store.ts';

export type ProposalStatus =
  | 'verifying'
  | 'invalid'
  | 'superseded'
  | 'awaiting_admin'
  | 'needs_admin_revision'
  | 'activating'
  | 'active'
  | 'rejected'
  | 'conflict';

/** Who is acting. Chat and CLI actors must be the configured admin; the admin token is checked by the route. */
export type LearningActor =
  | { kind: 'admin_token' }
  | { kind: 'telegram'; userId: number }
  | { kind: 'cli'; userId: number };

export function authorizeAdmin(ctx: LearningContext, actor: LearningActor): string {
  if (actor.kind === 'admin_token') return 'admin_token';
  if (ctx.adminId === null || !Number.isSafeInteger(actor.userId) || actor.userId !== ctx.adminId) {
    appendAudit(ctx.store, {
      at: ctx.now(),
      actor: `${actor.kind}:${actor.userId}`,
      action: 'admin_action_refused',
    });
    throw new IntentLearningError('forbidden', 'Only the configured admin may decide on intent proposals');
  }
  return `${actor.kind}:${actor.userId}`;
}

export interface ProposalBody {
  summary: string;
  operations: ProposalOperation[];
  comparisons: Comparison[];
  primitiveSuggestions?: string[];
}

/** The hash covers what would be applied (summary and operations), not the model's comparisons. */
export function proposalHash(body: { summary: string; operations: ProposalOperation[] }): string {
  return stableHash({ summary: body.summary, operations: body.operations });
}

export function insertProposal(
  ctx: LearningContext,
  input: {
    jobId: number | null;
    origin: 'worker' | 'manual';
    status: ProposalStatus;
    body: ProposalBody;
    validation: ProposalValidation;
  },
): { id: number; hash: string } {
  const hash = proposalHash(input.body);
  const result = ctx.store.run(
    `INSERT INTO proposals(job_id, origin, status, hash, body, validation, base_fingerprint, target_fingerprint,
       source_digest, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.jobId,
      input.origin,
      input.status,
      hash,
      JSON.stringify(input.body),
      JSON.stringify({ errors: input.validation.errors, warnings: input.validation.warnings }),
      input.validation.baseFingerprint,
      input.validation.targetFingerprint,
      input.validation.sourceDigest,
      ctx.now(),
    ],
  );
  return { id: Number(result.lastInsertRowid), hash };
}

export function recordValidation(ctx: LearningContext, proposalId: number, validation: ProposalValidation): void {
  ctx.store.run(
    'UPDATE proposals SET validation = ?, base_fingerprint = ?, target_fingerprint = ?, source_digest = ? WHERE id = ?',
    [
      JSON.stringify({ errors: validation.errors, warnings: validation.warnings }),
      validation.baseFingerprint,
      validation.targetFingerprint,
      validation.sourceDigest,
      proposalId,
    ],
  );
}

export function describeProposal(
  id: number,
  body: { summary: string; operations: ProposalOperation[] },
  hash: string,
): string {
  const counts = new Map<string, number>();
  for (const op of body.operations) counts.set(op.kind, (counts.get(op.kind) ?? 0) + 1);
  const ops = [...counts].map(([kind, n]) => `${kind} ${n}`).join(', ');
  const names = body.operations
    .map(
      (op) =>
        `${op.kind}: ${op.sourceNames.join(' + ') || '∅'} → ${op.intents.map((i) => i.canonical_name).join(', ') || '∅'}`,
    )
    .slice(0, 16);
  return [`Intent proposal #${id} (${ops})`, body.summary.slice(0, 600), ...names, `Hash: ${hash.slice(0, 16)}`].join(
    '\n',
  );
}

/** An admin-authored revision. It waits for explicit approval like any worker proposal. */
export function createManualProposal(
  ctx: LearningContext,
  proposal: ManualProposal,
  actor: LearningActor,
): { id: number; hash: string; warnings: string[] } {
  const label = authorizeAdmin(ctx, actor);
  return ctx.store
    .transaction(() => {
      const body: ProposalBody = { summary: proposal.summary, operations: proposal.operations, comparisons: [] };
      const validation = validateProposal(body, readRegistryOrThrow(ctx));
      if (!validation.ok)
        throw new IntentLearningError(
          'validation_failed',
          'Manual proposal failed native validation',
          validation.errors,
        );
      const stored = insertProposal(ctx, { jobId: null, origin: 'manual', status: 'awaiting_admin', body, validation });
      appendAudit(ctx.store, { at: ctx.now(), actor: label, action: 'manual_proposal', proposalId: stored.id });
      queueNotification(ctx, 'proposal_ready', `proposal_ready:${stored.id}`, {
        text: describeProposal(stored.id, body, stored.hash),
        proposalId: stored.id,
        hashPrefix: stored.hash.slice(0, 16),
      });
      return { ...stored, warnings: validation.warnings };
    })
    .immediate();
}

export interface ProposalView {
  id: number;
  jobId: number | null;
  origin: 'worker' | 'manual';
  status: string;
  hash: string;
  summary: string;
  operations: ProposalOperation[];
  comparisons: Comparison[];
  validation: string;
  baseFingerprint: string;
  targetFingerprint: string;
  createdAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
}

export function viewProposal(row: ProposalRow): ProposalView {
  const body = StoredProposalBodyJson.safeParse(row.body);
  return {
    id: row.id,
    jobId: row.job_id,
    origin: row.origin,
    status: row.status,
    hash: row.hash,
    summary: body.data?.summary ?? '',
    operations: body.data?.operations ?? [],
    comparisons: body.data?.comparisons ?? [],
    validation: row.validation,
    baseFingerprint: row.base_fingerprint,
    targetFingerprint: row.target_fingerprint,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
  };
}

export function listProposals(ctx: LearningContext, status?: string, limit = 50): ProposalView[] {
  const rows =
    status === undefined
      ? ctx.store.query<ProposalRow, [number]>('SELECT * FROM proposals ORDER BY id DESC LIMIT ?').all(limit)
      : ctx.store
          .query<ProposalRow, [string, number]>('SELECT * FROM proposals WHERE status = ? ORDER BY id DESC LIMIT ?')
          .all(status, limit);
  return rows.map(viewProposal);
}

const REJECTABLE = new Set(['awaiting_admin', 'needs_admin_revision', 'verifying', 'conflict']);

export function rejectProposal(ctx: LearningContext, proposalId: number, actor: LearningActor, reason = ''): void {
  const label = authorizeAdmin(ctx, actor);
  ctx.store
    .transaction(() => {
      const row = getProposalRow(ctx, proposalId);
      if (!row) throw new IntentLearningError('not_found', 'Unknown proposal');
      if (!REJECTABLE.has(row.status)) throw new IntentLearningError('invalid_state', `Proposal is ${row.status}`);
      ctx.store.run("UPDATE proposals SET status = 'rejected', decided_at = ?, decided_by = ? WHERE id = ?", [
        ctx.now(),
        label,
        proposalId,
      ]);
      if (row.job_id !== null)
        ctx.store.run(
          "UPDATE jobs SET status = 'rejected', lease_hash = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND proposal_id = ?",
          [ctx.now(), row.job_id, proposalId],
        );
      appendAudit(ctx.store, {
        at: ctx.now(),
        actor: label,
        action: 'rejected',
        proposalId,
        detail: reason.slice(0, 2000),
      });
    })
    .immediate();
}
