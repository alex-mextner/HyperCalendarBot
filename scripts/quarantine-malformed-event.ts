/** Explicit, fingerprint-guarded quarantine of an operator-reviewed malformed row.
 * Default is read-only inspection. No event titles/descriptions are printed.
 */
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, linkSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { EventRepository } from '../src/database/repositories/event.repository.ts';
import type { CalendarEvent } from '../src/database/types.ts';
import { eventTimestampError, eventTimestampSchema } from '../src/utils/event-timestamps.ts';

const MAX_REPAIR_WINDOW_MS = 5 * 60_000;

const idSchema = z.number().int().positive().safe();
const idsSchema = z.object({ ownerId: idSchema, candidateId: idSchema, replacementId: idSchema }).strict();
const planSchema = idsSchema.extend({
  candidateFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  replacementFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
type PairIds = z.infer<typeof idsSchema>;
export type QuarantinePlan = z.infer<typeof planSchema>;
export type QuarantineResult =
  | { status: 'already_quarantined'; changedIds: number[] }
  | { status: 'quarantined'; changedIds: number[]; replacementId: number; otherRowsUnchanged: true };

/** SQLite stores created_at as UTC text; normalize its known format explicitly. */
function createdAtMillis(value: string): number {
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  return z.iso.datetime({ offset: true }).safeParse(normalized).success ? Date.parse(normalized) : NaN;
}

/** Exclude only fields changed by a soft-delete, so reapplication is a no-op. */
export function eventFingerprint(event: CalendarEvent): string {
  const fields = Object.keys(event)
    .filter((key) => !['is_deleted', 'updated_at'].includes(key))
    .sort();
  return createHash('sha256').update(JSON.stringify(event, fields)).digest('hex');
}

function requireSafePair(db: Database, ids: PairIds) {
  idsSchema.parse(ids);
  if (ids.candidateId === ids.replacementId) throw new Error('Candidate and replacement must differ');
  const select = db.query<CalendarEvent, [number]>('SELECT * FROM events WHERE id = ?');
  const candidate = select.get(ids.candidateId);
  const replacement = select.get(ids.replacementId);
  if (!candidate || !replacement) throw new Error('Expected rows not found');
  for (const row of [candidate, replacement]) {
    if (row.user_id !== ids.ownerId || row.owner_type !== 'user' || row.group_id !== null) {
      throw new Error('Owner/scope mismatch; group or cross-owner quarantine is forbidden');
    }
    if (row.is_cancelled || row.recurrence_rule || row.parent_event_id) {
      throw new Error('Cancelled/recurring/exception rows require separate reconciliation');
    }
  }
  if (eventTimestampSchema.safeParse(candidate.start_at).success || Number.isFinite(Date.parse(candidate.start_at))) {
    throw new Error('Candidate timestamp is valid or parseable; legacy normalization requires separate review');
  }
  if (replacement.is_deleted || eventTimestampError(replacement))
    throw new Error('Replacement is not a valid active event');
  const age = createdAtMillis(replacement.created_at) - createdAtMillis(candidate.created_at);
  if (!Number.isFinite(age) || age < 0 || age > MAX_REPAIR_WINDOW_MS)
    throw new Error('Rows are not from one bounded repair window');
  if (candidate.google_event_id || candidate.google_calendar_id || candidate.last_synced_at) {
    throw new Error('Candidate has Google synchronization evidence; reconcile externally first');
  }
  return { candidate, replacement };
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function requireNoReferences(db: Database, candidateId: number): void {
  const tables = db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all();
  for (const table of tables) {
    const keys = db
      .query<{ table: string; from: string; to: string | null }, []>(
        `PRAGMA foreign_key_list(${quoteIdentifier(table.name)})`,
      )
      .all();
    for (const key of keys) {
      if (key.table !== 'events') continue;
      // REFERENCES events without a column names the primary key implicitly.
      if (key.to !== null && key.to !== 'id')
        throw new Error('Unsupported event-reference target; manual reconciliation required');
      const found = db
        .query<{ n: number }, [number]>(
          `SELECT COUNT(*) AS n FROM ${quoteIdentifier(table.name)} WHERE ${quoteIdentifier(key.from)} = ?`,
        )
        .get(candidateId);
      if (found?.n) throw new Error(`Candidate has dependent rows in ${table.name}; no automatic quarantine`);
    }
  }
}

export function inspectMalformedPair(db: Database, input: PairIds): QuarantinePlan {
  const ids = idsSchema.parse(input);
  const { candidate, replacement } = requireSafePair(db, ids);
  requireNoReferences(db, ids.candidateId);
  return {
    ...ids,
    candidateFingerprint: eventFingerprint(candidate),
    replacementFingerprint: eventFingerprint(replacement),
  };
}

/** Caller must secure a WAL-consistent backup before applying to a persistent DB. */
export function applyQuarantine(db: Database, input: QuarantinePlan): QuarantineResult {
  const plan = planSchema.parse(input);
  return db
    .transaction((): QuarantineResult => {
      const { candidate, replacement } = requireSafePair(db, {
        ownerId: plan.ownerId,
        candidateId: plan.candidateId,
        replacementId: plan.replacementId,
      });
      if (
        eventFingerprint(candidate) !== plan.candidateFingerprint ||
        eventFingerprint(replacement) !== plan.replacementFingerprint
      ) {
        throw new Error('Fingerprint mismatch; re-inspect instead of overwriting concurrent edits');
      }
      if (candidate.is_deleted) return { status: 'already_quarantined', changedIds: [] };
      requireNoReferences(db, candidate.id);
      const otherRows = () =>
        db.query<CalendarEvent, [number]>('SELECT * FROM events WHERE id != ? ORDER BY id').all(candidate.id);
      const before = JSON.stringify(otherRows());
      const removed = new EventRepository(db).remove(candidate.id, plan.ownerId);
      if (!removed || JSON.stringify(otherRows()) !== before) throw new Error('Unexpected write set; rolling back');
      return {
        status: 'quarantined',
        changedIds: [candidate.id],
        replacementId: replacement.id,
        otherRowsUnchanged: true,
      };
    })
    .immediate();
}

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      database: { type: 'string' },
      owner: { type: 'string' },
      candidate: { type: 'string' },
      replacement: { type: 'string' },
      manifest: { type: 'string' },
      backup: { type: 'string' },
      apply: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (values.help) {
    console.log(
      'Inspect: bun scripts/quarantine-malformed-event.ts --database PATH --owner ID --candidate ID --replacement ID',
    );
    console.log(
      'Apply:   bun scripts/quarantine-malformed-event.ts --database PATH --manifest PLAN.json --apply --backup NEW_PATH.db',
    );
    return;
  }
  if (!values.database) throw new Error('--database is required');
  if (values.apply && (!values.manifest || !values.backup))
    throw new Error('--apply requires both --manifest and a new --backup path');
  const db = new Database(values.database, { readonly: !values.apply, readwrite: values.apply, create: false });
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    if (!values.apply) {
      const ids = idsSchema.parse({
        ownerId: Number(values.owner),
        candidateId: Number(values.candidate),
        replacementId: Number(values.replacement),
      });
      console.log(JSON.stringify(inspectMalformedPair(db, ids), null, 2));
      return;
    }
    const plan = planSchema.parse(JSON.parse(readFileSync(values.manifest!, 'utf8')));
    // Native macOS SQLite rejects even an existing empty INTO target. Build in
    // a private staging directory, verify it, then publish by no-clobber hard link.
    const backupPath = resolve(values.backup!);
    const staging = mkdtempSync(join(dirname(backupPath), '.hcb-backup-'));
    try {
      const snapshot = join(staging, 'snapshot.db');
      db.query('VACUUM INTO ?').run(snapshot);
      chmodSync(snapshot, 0o600);
      const saved = new Database(snapshot, { readonly: true, create: false });
      try {
        const integrity = saved.query<{ quick_check: string }, []>('PRAGMA quick_check').all();
        if (integrity.length !== 1 || integrity[0]?.quick_check !== 'ok')
          throw new Error('Backup integrity check failed');
      } finally {
        saved.close();
      }
      const fd = openSync(snapshot, 'r+');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      linkSync(snapshot, backupPath); // Atomic EEXIST refusal, never replacement.
      const parentFd = openSync(dirname(backupPath), 'r');
      try {
        fsyncSync(parentFd);
      } finally {
        closeSync(parentFd);
      }
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
    console.log(JSON.stringify({ ...applyQuarantine(db, plan), backupCreated: true, backupIntegrity: 'ok' }, null, 2));
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Quarantine failed');
    process.exitCode = 1;
  }
}
