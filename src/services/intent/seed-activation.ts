// Deploy-time activation of the build's seed, without a human, once the KPI gate committed with it
// passes. It runs at bot start, after the source catalogue was recorded as a draft and before the
// matcher loads, so the new rules serve from this boot. It only ever approves that recorded draft,
// through the ordinary approval path (exact id, hash, base, revalidation, live-session guard, one
// IMMEDIATE transaction), after a verified backup. A fingerprint that was ever activated before is
// never activated again here: an operator who rolled it back keeps the rollback until a human acts.
import type { Database } from 'bun:sqlite';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { IntentRevisionRepository } from '../../database/repositories/intent-revision.repository.ts';
import type { WorkflowSessionRepository } from '../../database/repositories/workflow-session.repository.ts';
import { snapshotDatabase } from './db-backup.ts';
import { gatePasses, type KpiGate, type KpiGateRead } from './kpi-gate.ts';
import { registryIntegrity } from './revision-ledger.ts';
import { adminFromDeployGate, IntentRevisionService } from './revision-service.ts';
import { seedFingerprint } from './rule-fingerprint.ts';
import type { CanonicalSeed } from './seed-replacement.ts';

export interface ActivationLog {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
}

export interface ActivationInput {
  db: Database;
  /** Directory that holds the database; backups go to `<dataDir>/intent-basis-backups`. */
  dataDir: string;
  seed: readonly CanonicalSeed[];
  gate: KpiGateRead;
  sessions: Pick<WorkflowSessionRepository, 'liveIntentIds'>;
  now: () => number;
  log: ActivationLog;
}

export type ActivationResult =
  | {
      status: 'activated';
      revisionId: number;
      fingerprint: string;
      backup: string;
      removed: string[];
      inserted: string[];
    }
  | { status: 'already_active'; fingerprint: string }
  | { status: 'no_gate' }
  | { status: 'gate_invalid'; reason: string }
  | { status: 'gate_failed'; reasons: string[] }
  | { status: 'previously_decided'; fingerprint: string }
  | { status: 'no_draft' }
  | { status: 'registry_refused'; state: 'unmanaged' | 'tampered' | 'unledgered' }
  | { status: 'deferred'; code: 'session_active' | 'session_unreadable' }
  | { status: 'backup_failed'; reason: string }
  | { status: 'refused'; code: string };

const BACKUP_DIRECTORY = 'intent-basis-backups';

/** `20300317T174640Z`: sortable, filesystem-safe, UTC. */
const utcStamp = (ms: number) =>
  new Date(ms)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');

function decide(input: ActivationInput, fingerprint: string): ActivationResult {
  const { db, dataDir, gate: gateRead, sessions, now } = input;
  const revisions = new IntentRevisionRepository(db);
  const integrity = registryIntegrity(revisions);
  if (integrity.state !== 'intact') return { status: 'registry_refused', state: integrity.state };
  if (integrity.fingerprint === fingerprint) return { status: 'already_active', fingerprint };

  if (gateRead.status === 'missing') return { status: 'no_gate' };
  if (gateRead.status === 'invalid') return { status: 'gate_invalid', reason: gateRead.reason };
  const gate: KpiGate = gateRead.gate;
  const verdict = gatePasses(gate, fingerprint);
  if (!verdict.ok) return { status: 'gate_failed', reasons: verdict.reasons };

  const service = new IntentRevisionService(db, { sessions, now });
  const all = service.list();
  const everActivated = all.some(
    (revision) =>
      revision.targetFingerprint === fingerprint &&
      revision.decidedAt !== null &&
      (revision.status === 'active' || revision.status === 'superseded'),
  );
  if (everActivated) return { status: 'previously_decided', fingerprint };

  const draft = all
    .filter(
      (revision) =>
        revision.kind === 'source_baseline' &&
        revision.status === 'validated' &&
        revision.targetFingerprint === fingerprint &&
        revision.baseRevisionId === integrity.active.id,
    )
    .at(-1);
  if (!draft) return { status: 'no_draft' };

  const backup = join(
    dataDir,
    BACKUP_DIRECTORY,
    `calendar-before-seed-${fingerprint.slice(0, 8)}-${utcStamp(now())}.sqlite`,
  );
  try {
    snapshotDatabase(db, backup);
  } catch (err) {
    return { status: 'backup_failed', reason: err instanceof Error ? err.message : String(err) };
  }

  const approval = service.approve(adminFromDeployGate(gate), {
    id: draft.id,
    bodyHash: draft.bodyHash,
    baseRevisionId: integrity.active.id,
  });
  if (approval.status === 'active') {
    const { revisionId, targetFingerprint, removed, inserted } = approval;
    return { status: 'activated', revisionId, fingerprint: targetFingerprint, backup, removed, inserted };
  }
  // Nothing was written, so the backup would only pile up on every deferred boot.
  rmSync(backup, { force: true });
  if (approval.code === 'session_active' || approval.code === 'session_unreadable')
    return { status: 'deferred', code: approval.code };
  return { status: 'refused', code: approval.code };
}

/** Never throws for a refusal; callers still wrap it, because a database error must not stop the bot. */
export function activateGatedSeed(input: ActivationInput): ActivationResult {
  const fingerprint = seedFingerprint(input.seed);
  const result = decide(input, fingerprint);
  const fields = { ...result, outcome: result.status, fingerprint: fingerprint.slice(0, 8) };
  // A database that was never managed from the seed (a dev copy) is not an incident.
  const routine =
    result.status === 'activated' ||
    result.status === 'already_active' ||
    result.status === 'no_gate' ||
    (result.status === 'registry_refused' && result.state === 'unmanaged');
  input.log[routine ? 'info' : 'warn'](fields, 'intent seed activation');
  return result;
}
