// The operator tool for the intent revision ledger: read-only by default, backed up and exact when it
// writes, rollback as a new approved revision that restores an earlier activation's stored rules.
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { EXIT_CODES, runIntentRevisionCli } from '../../scripts/intent-revision.ts';
import { IntentRepository } from '../../src/database/repositories/intent.repository.ts';
import { WorkflowSessionRepository } from '../../src/database/repositories/workflow-session.repository.ts';
import type { RevisionBodyInput } from '../../src/services/intent/revision-body.ts';
import { adminFromOperatorCli, IntentRevisionService } from '../../src/services/intent/revision-service.ts';
import { seedFingerprint } from '../../src/services/intent/rule-fingerprint.ts';
import { seedIntents } from '../../src/services/intent/seed-catalog.ts';
import type { CanonicalSeed } from '../../src/services/intent/seed-replacement.ts';
import { WorkflowSchema } from '../../src/services/intent/workflow-schema.ts';
import { installSeed, openTempRegistry, registrySnapshot, type TempRegistry } from '../helpers/intent-registry.ts';

const HELP_WORKFLOW = { version: 2, steps: [{ call: 'get_bot_info', input: {} }] };
const help: CanonicalSeed = {
  canonical_name: 'basis.help',
  pattern: '^(?:помощь|help)$',
  phrases: ['помощь', 'help'],
  trigger_words: ['помощь', 'help'],
  source_message: 'помощь',
  workflow: HELP_WORKFLOW,
};
const helpWithSpravka: CanonicalSeed = {
  ...help,
  pattern: '^(?:помощь|help|справка)$',
  phrases: ['помощь', 'help', 'справка'],
  trigger_words: ['помощь', 'help', 'справка'],
};
const timeNow = seedIntents.find((rule) => rule.canonical_name === 'basis.time.now')!;
const botInfo = seedIntents.find((rule) => rule.canonical_name === 'basis.bot.info')!;
const oldSeed = [help, timeNow];
const newSeed = [helpWithSpravka, timeNow, botInfo];
const NOW = 1_900_000_000_000;
const createPing: RevisionBodyInput = {
  type: 'operations',
  summary: 'Answer a ping',
  operations: [
    {
      kind: 'create',
      sourceNames: [],
      reason: 'frequent request',
      intents: [
        {
          canonical_name: 'learned.ping',
          pattern: '^(?:пинг бота)$',
          workflow: HELP_WORKFLOW,
          phrases: ['пинг бота'],
          trigger_words: ['пинг'],
          source_message: 'пинг бота',
        },
      ],
    },
  ],
};

let registry: TempRegistry;
let db: Database;
let service: IntentRevisionService;
let sessions: WorkflowSessionRepository;
let oldRevisionId: number;
let newRevisionId: number;
const operator = adminFromOperatorCli();

beforeEach(() => {
  registry = openTempRegistry();
  db = registry.db;
  installSeed(db, oldSeed);
  sessions = new WorkflowSessionRepository(db);
  service = new IntentRevisionService(db, { sessions, now: () => NOW });
  oldRevisionId = service.activeRevisionId()!;
  const draft = service.ensureSourceBaselineDraft(newSeed)!;
  const approved = service.approve(operator, { id: draft.id, bodyHash: draft.bodyHash, baseRevisionId: oldRevisionId });
  if (approved.status !== 'active') throw new Error(approved.code);
  newRevisionId = draft.id;
});
afterEach(() => registry.close());

interface CliRun {
  code: number;
  json: Record<string, unknown>;
  stderr: string;
}
function run(...args: string[]): CliRun {
  const out: string[] = [];
  const err: string[] = [];
  const code = runIntentRevisionCli(['--db', db.filename, ...args], {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    now: () => NOW,
  });
  const text = out.join('\n');
  return { code, json: text ? JSON.parse(text) : {}, stderr: err.join('\n') };
}
const names = () =>
  new IntentRepository(db)
    .getApproved()
    .map((row) => row.canonical_name)
    .sort();
const manifest = () =>
  db.query<{ fingerprint: string }, []>('SELECT fingerprint FROM intent_basis_manifest').get()?.fingerprint;
const ledgerRows = () => db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM intent_revisions').get()!.n;
const backupDirectory = () => join(dirname(db.filename), 'intent-basis-backups');
const backupFiles = () => (existsSync(backupDirectory()) ? readdirSync(backupDirectory()) : []);

describe('usage', () => {
  test('exit codes are distinct and stable', () => {
    expect(EXIT_CODES).toEqual({
      ok: 0,
      refused: 1,
      usage: 2,
      registry: 3,
      notRestorable: 4,
      backup: 5,
      failure: 6,
    });
  });

  test('a missing subcommand, an unknown one, a missing --db and malformed numbers are usage errors', () => {
    expect(run().code).toBe(EXIT_CODES.usage);
    expect(run('explode').code).toBe(EXIT_CODES.usage);
    expect(runIntentRevisionCli(['status'], { out: () => {}, err: () => {}, now: () => NOW })).toBe(EXIT_CODES.usage);
    expect(run('approve', '--id', 'x', '--hash', 'ab', '--base', '1').code).toBe(EXIT_CODES.usage);
    expect(run('approve', '--id', '5').code).toBe(EXIT_CODES.usage);
    expect(run('rollback', '--to', 'abc').code).toBe(EXIT_CODES.usage);
    expect(run('rollback', '--bogus').code).toBe(EXIT_CODES.usage);
  });

  test('a usage error says what was wrong and how to fix it', () => {
    expect(run('approve', '--id', '5').stderr).toMatch(/error:[\s\S]*why:[\s\S]*fix:/);
  });

  test('--help lists every exit code', () => {
    const out: string[] = [];
    expect(runIntentRevisionCli(['--help'], { out: (line) => out.push(line), err: () => {}, now: () => NOW })).toBe(0);
    for (const code of Object.values(EXIT_CODES)) expect(out.join('\n')).toContain(`${code}  `);
  });
});

describe('status and list', () => {
  test('status reports the active revision, its fingerprint, the rule count and recent activations', () => {
    const result = run('status');
    expect(result.code).toBe(EXIT_CODES.ok);
    expect(result.json).toMatchObject({
      integrity: 'intact',
      activeRevisionId: newRevisionId,
      fingerprint: seedFingerprint(newSeed),
      ruleCount: 3,
    });
    const recent = result.json.recentActivations as { id: number }[];
    expect(recent.map((row) => row.id)).toEqual([newRevisionId, oldRevisionId]);
  });

  test('status lists open drafts with the hash and base an approval must name', () => {
    const draft = service.propose(createPing, { kind: 'manual', principal: operator });
    if (draft.status !== 'created') throw new Error(draft.code);
    const drafts = run('status').json.openDrafts as { id: number; bodyHash: string; baseRevisionId: number }[];
    expect(drafts).toEqual([
      expect.objectContaining({
        id: draft.revision.id,
        bodyHash: draft.revision.bodyHash,
        baseRevisionId: newRevisionId,
      }),
    ]);
  });

  test('list shows every revision', () => {
    const rows = run('list').json.revisions as { id: number; status: string }[];
    expect(rows.map((row) => [row.id, row.status])).toEqual([
      [oldRevisionId, 'superseded'],
      [newRevisionId, 'active'],
    ]);
  });

  test('status of a tampered registry says so and exits with the registry code', () => {
    db.run("UPDATE intents SET phrases='[\"tampered\"]' WHERE canonical_name='basis.time.now'");
    const result = run('status');
    expect(result.code).toBe(EXIT_CODES.registry);
    expect(result.json).toMatchObject({ integrity: 'tampered' });
  });
});

describe('rollback', () => {
  test('is a dry run by default: it names the plan and writes nothing, not even a backup', () => {
    const before = registrySnapshot(db);
    const result = run('rollback');
    expect(result.code).toBe(EXIT_CODES.ok);
    expect(result.json).toMatchObject({
      mode: 'dry-run',
      status: 'would_restore',
      targetRevisionId: oldRevisionId,
      removed: ['basis.bot.info', 'basis.help'],
      inserted: ['basis.help'],
      restartRequired: false,
    });
    expect(registrySnapshot(db)).toBe(before);
    expect(backupFiles()).toEqual([]);
  });

  test('--apply restores the earlier revision as a new approved revision, after a backup', () => {
    const rowsBefore = ledgerRows();
    const result = run('rollback', '--apply');
    expect(result.code).toBe(EXIT_CODES.ok);
    expect(result.json).toMatchObject({
      mode: 'apply',
      status: 'restored',
      targetRevisionId: oldRevisionId,
      restartRequired: true,
    });
    expect(names()).toEqual(['basis.help', 'basis.time.now']);
    expect(manifest()).toBe(seedFingerprint(oldSeed));
    expect(ledgerRows()).toBe(rowsBefore + 1);
    expect(service.get(newRevisionId)?.status).toBe('superseded');
    const restored = service.get(result.json.revisionId as number)!;
    expect(restored).toMatchObject({ status: 'active', parentId: oldRevisionId, decidedBy: 'operator_cli' });
    expect(backupFiles()).toHaveLength(1);
  });

  test('the backup holds the rules from before the rollback', () => {
    const result = run('rollback', '--apply');
    const saved = new Database(result.json.backup as string, { readonly: true });
    try {
      expect(saved.query<{ quick_check: string }, []>('PRAGMA quick_check').all()).toEqual([{ quick_check: 'ok' }]);
      const rows = saved
        .query<{ canonical_name: string }, []>('SELECT canonical_name FROM intents ORDER BY canonical_name')
        .all();
      expect(rows.map((row) => row.canonical_name)).toEqual(['basis.bot.info', 'basis.help', 'basis.time.now']);
    } finally {
      saved.close();
    }
  });

  test('rolling back again is a no-op: no new revision, no new backup, no restart', () => {
    expect(run('rollback', '--apply').code).toBe(EXIT_CODES.ok);
    const rows = ledgerRows();
    const before = registrySnapshot(db);
    const again = run('rollback', '--apply');
    expect(again.code).toBe(EXIT_CODES.ok);
    expect(again.json).toMatchObject({ status: 'noop', restartRequired: false });
    expect(ledgerRows()).toBe(rows);
    expect(registrySnapshot(db)).toBe(before);
    expect(backupFiles()).toHaveLength(1);
  });

  test('an explicit --to names the revision to restore', () => {
    const result = run('rollback', '--to', String(oldRevisionId), '--apply');
    expect(result.json).toMatchObject({ status: 'restored', targetRevisionId: oldRevisionId });
    expect(run('rollback', '--to', String(oldRevisionId), '--apply').json).toMatchObject({ status: 'noop' });
  });

  test('with no earlier activation there is nothing to roll back', () => {
    const result = run('rollback', '--to', String(newRevisionId), '--apply');
    expect(result.code).toBe(EXIT_CODES.ok);
    expect(result.json).toMatchObject({ status: 'noop' });
    const fresh = openTempRegistry();
    try {
      installSeed(fresh.db, oldSeed);
      const out: string[] = [];
      const code = runIntentRevisionCli(['--db', fresh.db.filename, 'rollback'], {
        out: (line) => out.push(line),
        err: () => {},
        now: () => NOW,
      });
      expect(code).toBe(EXIT_CODES.notRestorable);
      expect(out.join('')).toContain('no_earlier_revision');
    } finally {
      fresh.close();
    }
  });

  test('a revision that never ran, or does not exist, cannot be restored', () => {
    const draft = service.propose(createPing, { kind: 'manual', principal: operator });
    if (draft.status !== 'created') throw new Error(draft.code);
    expect(run('rollback', '--to', String(draft.revision.id), '--apply').code).toBe(EXIT_CODES.notRestorable);
    expect(run('rollback', '--to', '9999', '--apply').code).toBe(EXIT_CODES.notRestorable);
    expect(names()).toEqual(['basis.bot.info', 'basis.help', 'basis.time.now']);
  });

  test('a live workflow on a rule the rollback replaces blocks it and leaves the registry as it was', () => {
    const botInfoId = db
      .query<{ id: number }, []>("SELECT id FROM intents WHERE canonical_name='basis.bot.info'")
      .get()!.id;
    sessions.set(7, 7, {
      intentId: botInfoId,
      stepIndex: 0,
      stepResults: {},
      workflow: WorkflowSchema.parse(HELP_WORKFLOW),
      captures: {},
      createdAt: NOW,
    });
    const before = JSON.parse(registrySnapshot(db));
    const result = run('rollback', '--apply');
    expect(result.code).toBe(EXIT_CODES.refused);
    expect(result.json).toMatchObject({ status: 'refused', code: 'session_active', restartRequired: false });
    expect(JSON.parse(registrySnapshot(db)).intents).toEqual(before.intents);
    expect(JSON.parse(registrySnapshot(db)).manifest).toEqual(before.manifest);
    expect(service.activeRevisionId()).toBe(newRevisionId);
  });

  test('a tampered registry is refused with the registry code', () => {
    db.run("UPDATE intents SET phrases='[\"tampered\"]' WHERE canonical_name='basis.time.now'");
    expect(run('rollback', '--apply').code).toBe(EXIT_CODES.registry);
  });

  test('a backup that cannot be taken stops the rollback before any write', () => {
    const before = registrySnapshot(db);
    const result = run('rollback', '--apply', '--backup-dir', join(db.filename, 'cannot-be-a-directory'));
    expect(result.code).toBe(EXIT_CODES.backup);
    expect(registrySnapshot(db)).toBe(before);
  });
});

describe('approve', () => {
  function pingDraft() {
    const draft = service.propose(createPing, { kind: 'manual', principal: operator });
    if (draft.status !== 'created') throw new Error(draft.code);
    return draft.revision;
  }

  test('dry run reports whether the exact approval would pass and writes nothing', () => {
    const draft = pingDraft();
    const before = registrySnapshot(db);
    const result = run('approve', '--id', String(draft.id), '--hash', draft.bodyHash, '--base', String(newRevisionId));
    expect(result.code).toBe(EXIT_CODES.ok);
    expect(result.json).toMatchObject({ mode: 'dry-run', status: 'would_approve', inserted: ['learned.ping'] });
    expect(registrySnapshot(db)).toBe(before);
    expect(backupFiles()).toEqual([]);
  });

  test('--apply approves after a backup and asks for a restart', () => {
    const draft = pingDraft();
    const result = run(
      'approve',
      '--id',
      String(draft.id),
      '--hash',
      draft.bodyHash,
      '--base',
      String(newRevisionId),
      '--apply',
    );
    expect(result.code).toBe(EXIT_CODES.ok);
    expect(result.json).toMatchObject({ status: 'approved', restartRequired: true });
    expect(names()).toContain('learned.ping');
    expect(service.get(draft.id)?.decidedBy).toBe('operator_cli');
    expect(backupFiles()).toHaveLength(1);
  });

  test('a wrong hash is refused, in a dry run and when applied, and nothing changes', () => {
    const draft = pingDraft();
    const before = registrySnapshot(db);
    const args = ['approve', '--id', String(draft.id), '--hash', 'f'.repeat(64), '--base', String(newRevisionId)];
    expect(run(...args)).toMatchObject({
      code: EXIT_CODES.refused,
      json: { status: 'refused', code: 'hash_mismatch' },
    });
    expect(run(...args, '--apply')).toMatchObject({ code: EXIT_CODES.refused, json: { code: 'hash_mismatch' } });
    expect(registrySnapshot(db)).toBe(before);
  });

  test('a stale base is refused', () => {
    const draft = pingDraft();
    const result = run('approve', '--id', String(draft.id), '--hash', draft.bodyHash, '--base', String(oldRevisionId));
    expect(result).toMatchObject({ code: EXIT_CODES.refused, json: { code: 'conflict' } });
  });
});
