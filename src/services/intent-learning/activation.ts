// Explicit admin approval and activation. The ledger row is written as `activating` before the main
// database commit; the commit itself is one immediate compare-and-swap transaction; the sidecar is
// acknowledged afterwards. Recovery only reconciles the sidecar by fingerprint and never writes the
// main database or restores a backup.
import { RegistryRevisionError } from '../../database/repositories/intent.repository.ts';
import { cmdLogger } from '../../utils/logger.ts';
import { ACTIVE_SESSION_WINDOW_MS } from './constants.ts';
import { IntentLearningError, type LearningContext } from './context.ts';
import { queueNotification } from './outbox.ts';
import {
  getProposalRow,
  loadJobSamples,
  type ProposalRow,
  StoredProposalBodyJson,
  StoredReviewJson,
} from './payload.ts';
import { type ProposalValidation, validateProposal } from './proposal-validator.ts';
import { authorizeAdmin, describeProposal, type LearningActor, recordValidation } from './proposals.ts';
import { type RegistrySnapshot, readRegistryOrThrow, registryIsIntact } from './registry.ts';
import { responseQualityFindings } from './response-quality.ts';
import { appendAudit } from './store.ts';

export interface ApprovalResult {
  status: 'active';
  proposalId: number;
  revisionId: number;
  targetFingerprint: string;
  rebased: boolean;
}

interface RevisionRow {
  id: number;
  proposal_id: number;
  root_fingerprint: string | null;
  base_fingerprint: string;
  target_fingerprint: string;
  status: string;
}

/** Root of the accepted lineage the current registry belongs to; null for an unmanaged database. */
function lineageRoot(ctx: LearningContext, registry: RegistrySnapshot): string | null {
  if (!registry.managed) return null;
  if (!registryIsIntact(registry))
    throw new IntentLearningError('activation_refused', 'Active intents drifted from the basis manifest');
  if (registry.fingerprint === registry.sourceFingerprint) return registry.sourceFingerprint;
  const row = ctx.store
    .query<{ root_fingerprint: string | null }, [string]>(
      "SELECT root_fingerprint FROM revisions WHERE target_fingerprint = ? AND status IN ('active', 'activating') ORDER BY id DESC LIMIT 1",
    )
    .get(registry.fingerprint);
  if (!row)
    throw new IntentLearningError(
      'activation_refused',
      'Active intents are neither the shipped basis nor an admin-approved revision',
    );
  return row.root_fingerprint ?? registry.fingerprint;
}

function hashMatches(hash: string, expected: string): boolean {
  return expected.length >= 16 && hash.startsWith(expected);
}

/** Re-validates against the live registry; a moved base is accepted only if every affected rule is unchanged. */
function revalidate(ctx: LearningContext, row: ProposalRow, registry: RegistrySnapshot) {
  const body = StoredProposalBodyJson.parse(row.body);
  const samples = row.job_id === null ? [] : loadJobSamples(ctx, row.job_id);
  // Generator and reviewer judgments are both re-checked against the registry as it is now.
  const reviewer = row.review === null ? [] : (StoredReviewJson.safeParse(row.review).data?.comparisons ?? []);
  const validation = validateProposal({ ...body, comparisons: [...body.comparisons, ...reviewer] }, registry, samples);
  if (row.origin === 'worker') {
    const qualityErrors = responseQualityFindings(reviewer);
    if (qualityErrors.length) {
      validation.ok = false;
      validation.errors.push(...qualityErrors);
    }
  }
  const rebased = registry.fingerprint !== row.base_fingerprint;
  const conflict = !validation.ok || (rebased && validation.sourceDigest !== row.source_digest);
  return { ...validation, rebased, conflict };
}

function markConflict(ctx: LearningContext, row: ProposalRow, registry: RegistrySnapshot, errors: string[]): void {
  ctx.store.run("UPDATE proposals SET status = 'conflict' WHERE id = ?", [row.id]);
  appendAudit(ctx.store, {
    at: ctx.now(),
    actor: 'server',
    action: 'conflict',
    proposalId: row.id,
    detail: errors.join('\n'),
  });
  queueNotification(ctx, 'conflict', `conflict:${row.id}:${registry.fingerprint}`, {
    text: `Intent proposal #${row.id} no longer applies to the active intents and was not activated.`,
    proposalId: row.id,
  });
}

type Prepared =
  | { kind: 'ready'; row: ProposalRow; validation: ProposalValidation & { rebased: boolean }; revisionId: number }
  | { kind: 'conflict'; errors: string[] };

function prepareActivation(ctx: LearningContext, proposalId: number, expectedHash: string, label: string): Prepared {
  return ctx.store
    .transaction((): Prepared => {
      const row = getProposalRow(ctx, proposalId);
      if (!row) throw new IntentLearningError('not_found', 'Unknown proposal');
      if (row.status !== 'awaiting_admin') throw new IntentLearningError('invalid_state', `Proposal is ${row.status}`);
      if (!hashMatches(row.hash, expectedHash))
        throw new IntentLearningError('hash_mismatch', 'The approved hash does not match the proposal');
      const registry = readRegistryOrThrow(ctx);
      const root = lineageRoot(ctx, registry);
      const validation = revalidate(ctx, row, registry);
      if (validation.conflict) {
        const errors = validation.errors.length ? validation.errors : ['An affected intent changed after validation'];
        markConflict(ctx, row, registry, errors);
        return { kind: 'conflict', errors };
      }
      recordValidation(ctx, row.id, validation);
      const revision = ctx.store.run(
        `INSERT INTO revisions(proposal_id, root_fingerprint, base_fingerprint, target_fingerprint, status, actor, created_at)
         VALUES (?, ?, ?, ?, 'activating', ?, ?)`,
        [row.id, root, validation.baseFingerprint, validation.targetFingerprint, label, ctx.now()],
      );
      ctx.store.run("UPDATE proposals SET status = 'activating' WHERE id = ?", [row.id]);
      appendAudit(ctx.store, {
        at: ctx.now(),
        actor: label,
        action: validation.rebased ? 'activating_rebased' : 'activating',
        proposalId: row.id,
      });
      return { kind: 'ready', row, validation, revisionId: Number(revision.lastInsertRowid) };
    })
    .immediate();
}

function abandon(ctx: LearningContext, revisionId: number, proposalId: number, reason: string): void {
  ctx.store
    .transaction(() => {
      ctx.store.run("UPDATE revisions SET status = 'abandoned', acked_at = ? WHERE id = ?", [ctx.now(), revisionId]);
      ctx.store.run("UPDATE proposals SET status = 'awaiting_admin' WHERE id = ? AND status = 'activating'", [
        proposalId,
      ]);
      appendAudit(ctx.store, {
        at: ctx.now(),
        actor: 'server',
        action: 'activation_abandoned',
        proposalId,
        detail: reason,
      });
    })
    .immediate();
}

function acknowledge(ctx: LearningContext, revisionId: number, row: ProposalRow, label: string): void {
  ctx.store
    .transaction(() => {
      ctx.store.run("UPDATE revisions SET status = 'active', acked_at = ? WHERE id = ?", [ctx.now(), revisionId]);
      ctx.store.run("UPDATE proposals SET status = 'active', decided_at = ?, decided_by = ? WHERE id = ?", [
        ctx.now(),
        label,
        row.id,
      ]);
      if (row.job_id !== null)
        ctx.store.run("UPDATE jobs SET status = 'active', updated_at = ? WHERE id = ?", [ctx.now(), row.job_id]);
      appendAudit(ctx.store, { at: ctx.now(), actor: label, action: 'activated', proposalId: row.id });
      queueNotification(ctx, 'activated', `activated:${row.id}`, {
        text: `Activated: ${describeProposal(row.id, StoredProposalBodyJson.parse(row.body), row.hash)}`,
        proposalId: row.id,
      });
    })
    .immediate();
}

/** The only path that changes active intents: the configured admin approves one exact hash. */
export function approveProposal(
  ctx: LearningContext,
  input: { proposalId: number; expectedHash: string; actor: LearningActor },
): ApprovalResult {
  const label = authorizeAdmin(ctx, input.actor);
  recoverActivations(ctx);
  const prepared = prepareActivation(ctx, input.proposalId, input.expectedHash, label);
  if (prepared.kind === 'conflict')
    throw new IntentLearningError('activation_refused', 'Proposal conflicts with the active intents', prepared.errors);
  const { row, validation, revisionId } = prepared;
  try {
    ctx.intentRepo.applyRegistryRevision({
      baseFingerprint: validation.baseFingerprint,
      targetFingerprint: validation.targetFingerprint,
      removeNames: validation.affected,
      insert: validation.insert,
      protectSessionsSince: ctx.now() - ACTIVE_SESSION_WINDOW_MS,
    });
  } catch (err) {
    abandon(ctx, revisionId, row.id, err instanceof Error ? err.message : 'activation failed');
    if (err instanceof RegistryRevisionError)
      throw new IntentLearningError('activation_refused', err.message, [err.code]);
    throw err;
  }
  try {
    acknowledge(ctx, revisionId, row, label);
  } catch (err) {
    // The main database already holds the target; the `activating` ledger row keeps it loadable
    // and the next recovery acknowledges it by fingerprint.
    cmdLogger.error({ err, proposalId: row.id }, 'Intent revision applied but sidecar acknowledgement failed');
  }
  return {
    status: 'active',
    proposalId: row.id,
    revisionId,
    targetFingerprint: validation.targetFingerprint,
    rebased: validation.rebased,
  };
}

/** Reconciles `activating` revisions with the main database by fingerprint. Never writes the main database. */
export function recoverActivations(ctx: LearningContext): {
  acknowledged: number;
  abandoned: number;
  conflicts: number;
} {
  const pending = ctx.store
    .query<RevisionRow, []>("SELECT * FROM revisions WHERE status = 'activating' ORDER BY id")
    .all();
  const result = { acknowledged: 0, abandoned: 0, conflicts: 0 };
  if (pending.length === 0) return result;
  const registry = readRegistryOrThrow(ctx);
  const current = registry.managed ? registry.manifestFingerprint : registry.fingerprint;
  for (const revision of pending) {
    const row = getProposalRow(ctx, revision.proposal_id);
    if (!row) continue;
    if (current === revision.target_fingerprint && registry.fingerprint === revision.target_fingerprint) {
      acknowledge(ctx, revision.id, row, 'recovery');
      result.acknowledged++;
    } else if (current === revision.base_fingerprint) {
      abandon(ctx, revision.id, row.id, 'main database commit not found during recovery');
      result.abandoned++;
    } else {
      ctx.store.run("UPDATE revisions SET status = 'conflict', acked_at = ? WHERE id = ?", [ctx.now(), revision.id]);
      ctx.store.run("UPDATE proposals SET status = 'conflict' WHERE id = ?", [row.id]);
      queueNotification(ctx, 'conflict', `recovery_conflict:${revision.id}`, {
        text: `Intent revision for proposal #${row.id} matches neither its base nor its target; nothing was changed.`,
        proposalId: row.id,
      });
      result.conflicts++;
    }
  }
  return result;
}
