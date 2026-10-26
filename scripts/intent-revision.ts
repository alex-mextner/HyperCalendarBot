// Operator tool for the intent revision ledger: inspect it, approve one exact draft, or roll the
// catalogue back to an earlier activation. Every write is a dry run unless `--apply` is given, is
// preceded by a verified backup, and goes through the same approval path as the bot (exact id, hash
// and base, revalidation, live-session guard, one transaction). Ledger rows are never deleted: a
// rollback is a new approved revision that restores the stored rules of an earlier one.
//
//   bun --no-env-file scripts/intent-revision.ts --db data/calendar.db status
//   bun --no-env-file scripts/intent-revision.ts --db data/calendar.db rollback [--to ID] [--apply]
import { Database } from 'bun:sqlite';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { IntentRevisionRepository } from '../src/database/repositories/intent-revision.repository.ts';
import { WorkflowSessionRepository } from '../src/database/repositories/workflow-session.repository.ts';
import { snapshotDatabase } from '../src/services/intent/db-backup.ts';
import { registryIntegrity } from '../src/services/intent/revision-ledger.ts';
import {
  adminFromOperatorCli,
  type IntentRevision,
  IntentRevisionService,
} from '../src/services/intent/revision-service.ts';

export const EXIT_CODES = {
  ok: 0,
  refused: 1,
  usage: 2,
  registry: 3,
  notRestorable: 4,
  backup: 5,
  failure: 6,
} as const;
type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  now(): number;
}

const HELP = `Usage: bun --no-env-file scripts/intent-revision.ts --db <calendar.db> <command> [options]

Commands (a write is a DRY RUN unless --apply is given):
  status                        active revision, fingerprint, rule count, recent activations, open drafts
  list                          every revision in the ledger
  approve --id N --hash H --base B [--apply]
                                approve the exact draft N (body hash H, based on active revision B)
  rollback [--to ID] [--apply]  restore the rules of an earlier activation as a NEW approved revision;
                                default: the revision that was active before the latest activation

Options:
  --db PATH           the database file (required)
  --backup-dir DIR    where --apply writes its backup (default: <database directory>/intent-basis-backups)
  --help              this text

An applied change prints "restartRequired": true: restart the bot so it loads the new rules.

Exit codes:
  0  success (including a dry run and an idempotent no-op)
  1  refused: the change was checked and did not pass (hash/base mismatch, live workflow, invalid rules)
  2  usage error
  3  registry not manageable (unmanaged, tampered or unledgered); nothing was written
  4  nothing to restore (no earlier revision, unknown revision, or one that never ran)
  5  backup failed; nothing was written
  6  unexpected failure (database unreadable or locked)`;

class CliError extends Error {
  constructor(
    readonly exit: ExitCode,
    message: string,
    readonly why: string,
    readonly fix: string,
  ) {
    super(message);
  }
}
const usageError = (message: string, fix: string) =>
  new CliError(EXIT_CODES.usage, message, 'the command line could not be understood', fix);

interface Args {
  command: 'status' | 'list' | 'approve' | 'rollback';
  db: string;
  apply: boolean;
  id: number | null;
  hash: string | null;
  base: number | null;
  to: number | null;
  backupDir: string | null;
  help: boolean;
}

function positiveInt(name: string, raw: string | undefined): number | null {
  if (raw === undefined) return null;
  if (!/^[1-9]\d*$/.test(raw))
    throw usageError(`--${name} must be a positive integer, got "${raw}"`, `pass --${name} 12`);
  return Number(raw);
}

function parseOptions(argv: string[]) {
  try {
    return parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    throw usageError(err instanceof Error ? err.message : 'bad arguments', 'run with --help for the options');
  }
}

function parseCli(argv: string[]): Args | 'help' {
  const { values, positionals } = parseOptions(argv);
  if (values.help) return 'help';
  const [command, ...extra] = positionals;
  if (command !== 'status' && command !== 'list' && command !== 'approve' && command !== 'rollback')
    throw usageError(
      command ? `unknown command "${command}"` : 'no command given',
      'use one of: status, list, approve, rollback (see --help)',
    );
  if (extra.length) throw usageError(`unexpected argument "${extra[0]}"`, 'see --help');
  if (!values.db) throw usageError('--db is required', 'pass --db data/calendar.db (the bot database file)');
  const args: Args = {
    command,
    db: values.db,
    apply: values.apply,
    id: positiveInt('id', values.id),
    hash: values.hash ?? null,
    base: positiveInt('base', values.base),
    to: positiveInt('to', values.to),
    backupDir: values['backup-dir'] ?? null,
    help: false,
  };
  if (command === 'approve') {
    if (args.id === null || args.base === null || args.hash === null)
      throw usageError('approve needs --id, --hash and --base', 'copy all three from the draft listed by `status`');
    if (!/^[0-9a-f]{64}$/.test(args.hash))
      throw usageError('--hash must be the 64-hex body hash', 'copy bodyHash from `status` (openDrafts)');
  }
  return args;
}

const OPTIONS = {
  db: { type: 'string' },
  apply: { type: 'boolean', default: false },
  id: { type: 'string' },
  hash: { type: 'string' },
  base: { type: 'string' },
  to: { type: 'string' },
  'backup-dir': { type: 'string' },
  help: { type: 'boolean', default: false },
} as const;

const REFUSAL_TEXT: Record<string, { why: string; fix: string }> = {
  session_active: {
    why: 'a live suspended workflow still refers to a rule this change replaces',
    fix: 'retry once that workflow ends or its 5-minute session expires',
  },
  session_unreadable: {
    why: 'a stored workflow session could not be read, so the live-session guard cannot vouch for the change',
    fix: 'inspect the workflow_sessions table, then retry',
  },
  hash_mismatch: {
    why: 'the body hash does not match the stored draft',
    fix: 'copy bodyHash again from `status` (openDrafts); the draft may have been revised',
  },
  conflict: {
    why: 'the draft was made against a revision that is no longer active, or --base is not the active revision',
    fix: 'run `status`; take --base from activeRevisionId, or record the build seed again for a new draft',
  },
  not_validated: { why: 'the revision is not a validated, open draft', fix: 'run `list` and pick a validated draft' },
  not_found: { why: 'there is no such revision', fix: 'run `list` for valid ids' },
  invalid: {
    why: 'the revision no longer passes validation against the active catalogue',
    fix: 'run `status`/`list`; the rules need a new draft',
  },
};

function emit(io: CliIo, result: object): void {
  io.out(JSON.stringify(result, null, 2));
}

/** A checked change that did not pass: the structured result on stdout, what/why/fix on stderr. */
function refuse(io: CliIo, exit: ExitCode, result: { status: string; code: string }, message: string): ExitCode {
  emit(io, { ...result, restartRequired: false });
  const text = REFUSAL_TEXT[result.code] ?? {
    why: 'the registry integrity check failed',
    fix: 'inspect intent_basis_manifest and intent_revisions; restore the database backup if rows were edited by hand',
  };
  io.err(`error: ${message}`);
  io.err(`why: ${text.why}`);
  io.err(`fix: ${text.fix}`);
  return exit;
}

function refusalExit(code: string): ExitCode {
  return code === 'unmanaged' || code.startsWith('registry_') ? EXIT_CODES.registry : EXIT_CODES.refused;
}

/** The refusal code the service uses for a registry that is not intact. */
function registryCode(state: 'unmanaged' | 'tampered' | 'unledgered'): string {
  return state === 'unmanaged' ? 'unmanaged' : `registry_${state}`;
}

const stamp = (ms: number) =>
  new Date(ms)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');

function takeBackup(db: Database, args: Args, io: CliIo, label: string, fingerprint: string): string {
  const directory = args.backupDir ? resolve(args.backupDir) : join(dirname(resolve(args.db)), 'intent-basis-backups');
  const file = join(directory, `calendar-before-${label}-${fingerprint.slice(0, 8)}-${stamp(io.now())}.sqlite`);
  try {
    snapshotDatabase(db, file);
  } catch (err) {
    throw new CliError(
      EXIT_CODES.backup,
      `backup failed: ${err instanceof Error ? err.message : String(err)}`,
      'no change is made without a verified backup',
      'free disk space or pass --backup-dir with a writable directory; nothing was written',
    );
  }
  return file;
}

function summarize(revision: IntentRevision) {
  return {
    id: revision.id,
    kind: revision.kind,
    status: revision.status,
    fingerprint: revision.targetFingerprint,
    bodyHash: revision.bodyHash,
    baseRevisionId: revision.baseRevisionId,
    parentId: revision.parentId,
    author: revision.author,
    decidedBy: revision.decidedBy,
    decidedAt: revision.decidedAt === null ? null : new Date(revision.decidedAt).toISOString(),
  };
}

const wasActivated = (revision: IntentRevision) =>
  revision.decidedAt !== null && (revision.status === 'active' || revision.status === 'superseded');

function status(db: Database, service: IntentRevisionService, io: CliIo): ExitCode {
  const integrity = registryIntegrity(new IntentRevisionRepository(db));
  if (integrity.state !== 'intact') {
    emit(io, { integrity: integrity.state });
    io.err(`error: the intent registry is ${integrity.state}`);
    io.err('why: the installed rules, the manifest and the active revision do not agree (or were never ledgered)');
    io.err('fix: restore the latest backup in intent-basis-backups, or install a seed with replace-intent-basis.ts');
    return EXIT_CODES.registry;
  }
  const revisions = service.list();
  const recentActivations = revisions
    .filter(wasActivated)
    .sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0) || b.id - a.id)
    .slice(0, 5)
    .map(summarize);
  const openDrafts = revisions
    .filter((revision) => revision.status === 'draft' || revision.status === 'validated')
    .map(summarize);
  emit(io, {
    integrity: 'intact',
    activeRevisionId: integrity.active.id,
    fingerprint: integrity.fingerprint,
    ruleCount: integrity.rules.length,
    recentActivations,
    openDrafts,
  });
  return EXIT_CODES.ok;
}

function approve(db: Database, service: IntentRevisionService, args: Args, io: CliIo): ExitCode {
  const { id, hash, base } = args;
  if (id === null || hash === null || base === null)
    throw usageError('approve needs --id, --hash and --base', 'see --help');
  const request = { id, bodyHash: hash, baseRevisionId: base };
  const preview = service.previewApproval(request);
  if (preview.status === 'refused')
    return refuse(
      io,
      refusalExit(preview.code),
      { status: 'refused', code: preview.code },
      `cannot approve revision ${id}`,
    );
  const plan = {
    revisionId: id,
    targetFingerprint: preview.targetFingerprint,
    removed: preview.removed,
    inserted: preview.inserted,
  };
  if (!args.apply) {
    emit(io, { command: 'approve', mode: 'dry-run', status: 'would_approve', ...plan, restartRequired: false });
    return EXIT_CODES.ok;
  }
  const integrity = registryIntegrity(new IntentRevisionRepository(db));
  if (integrity.state !== 'intact')
    return refuse(
      io,
      EXIT_CODES.registry,
      { status: 'refused', code: registryCode(integrity.state) },
      'the intent registry changed',
    );
  const backup = takeBackup(db, args, io, 'approve', integrity.fingerprint);
  const result = service.approve(adminFromOperatorCli(), request);
  if (result.status === 'refused')
    return refuse(
      io,
      refusalExit(result.code),
      { status: 'refused', code: result.code },
      `cannot approve revision ${id}`,
    );
  emit(io, { command: 'approve', mode: 'apply', status: 'approved', ...plan, backup, restartRequired: true });
  return EXIT_CODES.ok;
}

/** A rollback is a restore revision whose parent is the activation it restored; undoing it is that same state. */
function defaultRollbackTarget(active: IntentRevision): number | null {
  const isRestore = active.kind === 'manual' && active.body?.type === 'replace_all' && active.parentId !== null;
  return isRestore ? active.parentId : active.baseRevisionId;
}

function rollback(db: Database, service: IntentRevisionService, args: Args, io: CliIo): ExitCode {
  const integrity = registryIntegrity(new IntentRevisionRepository(db));
  if (integrity.state !== 'intact')
    return refuse(
      io,
      EXIT_CODES.registry,
      { status: 'refused', code: registryCode(integrity.state) },
      `the intent registry is ${integrity.state}`,
    );
  const active = service.get(integrity.active.id);
  if (!active) throw new Error('the active revision vanished');
  const targetId = args.to ?? defaultRollbackTarget(active);
  if (targetId === null)
    return refuse(
      io,
      EXIT_CODES.notRestorable,
      { status: 'not_restorable', code: 'no_earlier_revision' },
      'nothing to roll back to',
    );
  const target = service.get(targetId);
  if (!target)
    return refuse(
      io,
      EXIT_CODES.notRestorable,
      { status: 'not_restorable', code: 'not_found' },
      `revision ${targetId} does not exist`,
    );
  const plan = {
    command: 'rollback',
    targetRevisionId: targetId,
    targetFingerprint: target.targetFingerprint,
    activeFingerprint: integrity.fingerprint,
  };
  if (target.targetFingerprint === integrity.fingerprint) {
    emit(io, { ...plan, mode: args.apply ? 'apply' : 'dry-run', status: 'noop', restartRequired: false });
    return EXIT_CODES.ok;
  }
  const preview = service.previewRestore(targetId);
  if ('status' in preview) {
    const exit =
      preview.code === 'invalid' || preview.code === 'not_found' ? EXIT_CODES.notRestorable : refusalExit(preview.code);
    return refuse(
      io,
      exit,
      { status: 'not_restorable', code: preview.code },
      `revision ${targetId} cannot be restored`,
    );
  }
  if (!preview.ok) {
    emit(io, { ...plan, status: 'refused', code: 'invalid', errors: preview.errors, restartRequired: false });
    io.err(`error: revision ${targetId} no longer passes validation against the active catalogue`);
    io.err(preview.errors.join('\n'));
    return EXIT_CODES.refused;
  }
  const changes = { removed: preview.removed, inserted: preview.inserted };
  if (!args.apply) {
    emit(io, { ...plan, mode: 'dry-run', status: 'would_restore', ...changes, restartRequired: false });
    return EXIT_CODES.ok;
  }
  const operator = adminFromOperatorCli();
  const backup = takeBackup(db, args, io, 'rollback', integrity.fingerprint);
  const proposed = service.proposeRestore(operator, targetId);
  if (proposed.status === 'refused')
    return refuse(
      io,
      refusalExit(proposed.code),
      { status: 'refused', code: proposed.code },
      `cannot draft the restore of revision ${targetId}`,
    );
  const { revision } = proposed;
  const approved = service.approve(operator, {
    id: revision.id,
    bodyHash: revision.bodyHash,
    baseRevisionId: integrity.active.id,
  });
  if (approved.status === 'refused')
    return refuse(
      io,
      refusalExit(approved.code),
      { status: 'refused', code: approved.code },
      `cannot approve the restore of revision ${targetId}`,
    );
  emit(io, {
    ...plan,
    mode: 'apply',
    status: 'restored',
    revisionId: revision.id,
    ...changes,
    backup,
    restartRequired: true,
  });
  return EXIT_CODES.ok;
}

function execute(args: Args, io: CliIo): ExitCode {
  const writes = args.apply && (args.command === 'approve' || args.command === 'rollback');
  const db = new Database(resolve(args.db), { readonly: !writes, readwrite: writes, create: false });
  try {
    db.exec(`PRAGMA busy_timeout=3000;${writes ? ' PRAGMA foreign_keys=ON;' : ''}`);
    const service = new IntentRevisionService(db, { sessions: new WorkflowSessionRepository(db), now: io.now });
    switch (args.command) {
      case 'status':
        return status(db, service, io);
      case 'list':
        emit(io, { revisions: service.list().map(summarize) });
        return EXIT_CODES.ok;
      case 'approve':
        return approve(db, service, args, io);
      case 'rollback':
        return rollback(db, service, args, io);
    }
  } finally {
    db.close();
  }
}

export function runIntentRevisionCli(argv: string[], io: CliIo): ExitCode {
  try {
    const args = parseCli(argv);
    if (args === 'help') {
      io.out(HELP);
      return EXIT_CODES.ok;
    }
    return execute(args, io);
  } catch (err) {
    if (err instanceof CliError) {
      io.err(`error: ${err.message}`);
      io.err(`why: ${err.why}`);
      io.err(`fix: ${err.fix}`);
      return err.exit;
    }
    io.err(`error: ${err instanceof Error ? err.message : 'unexpected failure'}`);
    io.err('why: the database could not be read or written');
    io.err('fix: check the --db path and that no other process holds a long write lock, then retry');
    return EXIT_CODES.failure;
  }
}

if (import.meta.main) {
  process.exitCode = runIntentRevisionCli(process.argv.slice(2), {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    now: Date.now,
  });
}
