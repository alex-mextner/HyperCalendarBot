// A managed intent catalogue must keep loading its approved rules when a new build ships a
// different source seed (#426 changes serialized workflows): the source is a candidate, never the
// runtime authority. Rows that drift from the manifest must still fail closed.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { IntentRepository } from '../../src/database/repositories/intent.repository.ts';
import { WorkflowSessionRepository } from '../../src/database/repositories/workflow-session.repository.ts';
import { IntentRevisionService } from '../../src/services/intent/revision-service.ts';
import { seedIntents } from '../../src/services/intent/seed-catalog.ts';
import { installSeed, openTempRegistry, type TempRegistry } from '../helpers/intent-registry.ts';

const ALL = seedIntents.length;
const withoutLast = seedIntents.slice(0, ALL - 1);
let registry: TempRegistry;
beforeEach(() => {
  registry = openTempRegistry();
});
afterEach(() => registry.close());

test('source-only deploy keeps the installed catalogue loading', () => {
  const installed = withoutLast;
  installSeed(registry.db, installed);
  // The running build compiles every source rule; the database holds all but the last one.
  const approved = new IntentRepository(registry.db).getApproved();
  expect(approved.map((row) => row.canonical_name).sort()).toEqual(installed.map((rule) => rule.canonical_name).sort());
});

test('the full source catalogue loads every approved rule', () => {
  installSeed(registry.db, seedIntents);
  expect(new IntentRepository(registry.db).getApproved()).toHaveLength(ALL);
});

test('a row edited outside the ledger disables the managed catalogue', () => {
  installSeed(registry.db, seedIntents);
  registry.db.run('UPDATE intents SET phrases=? WHERE canonical_name=?', ['["unreviewed"]', 'basis.time.now']);
  expect(new IntentRepository(registry.db).getApproved()).toEqual([]);
});

test('an active revision whose target differs from the manifest disables the catalogue', () => {
  installSeed(registry.db, seedIntents);
  registry.db.run("UPDATE intent_revisions SET target_fingerprint='0' WHERE status='active'");
  expect(new IntentRepository(registry.db).getApproved()).toEqual([]);
});

test('an active revision whose stored rule set differs from its target disables the catalogue', () => {
  installSeed(registry.db, seedIntents);
  registry.db.run("UPDATE intent_revisions SET target_rules='[]' WHERE status='active'");
  expect(new IntentRepository(registry.db).getApproved()).toEqual([]);
});

test('a managed catalogue without an active revision fails closed', () => {
  installSeed(registry.db, seedIntents);
  registry.db.run("DELETE FROM intent_revisions WHERE status='active'");
  expect(new IntentRepository(registry.db).getApproved()).toEqual([]);
});

test('the operator replacement records exactly one active source revision', () => {
  installSeed(registry.db, withoutLast);
  installSeed(registry.db, seedIntents);
  const revisions = registry.db
    .query<{ status: string; author: string; decided_by: string }, []>(
      'SELECT status, author, decided_by FROM intent_revisions ORDER BY id',
    )
    .all();
  expect(revisions).toEqual([
    { status: 'superseded', author: 'operator', decided_by: 'operator_cli' },
    { status: 'active', author: 'operator', decided_by: 'operator_cli' },
  ]);
  expect(new IntentRepository(registry.db).getApproved()).toHaveLength(ALL);
});

test('the operator replacement repairs a registry whose ledger entry was lost', () => {
  installSeed(registry.db, seedIntents);
  registry.db.run("DELETE FROM intent_revisions WHERE status='active'");
  expect(new IntentRepository(registry.db).getApproved()).toEqual([]);
  installSeed(registry.db, seedIntents);
  expect(new IntentRepository(registry.db).getApproved()).toHaveLength(ALL);
});

test('a manifest rule count that disagrees with the rows disables the catalogue', () => {
  installSeed(registry.db, seedIntents);
  registry.db.run('UPDATE intent_basis_manifest SET rule_count = 0');
  expect(new IntentRepository(registry.db).getApproved()).toEqual([]);
});

test('the full source catalogue forms a validated baseline draft at startup and stays inactive', () => {
  installSeed(registry.db, withoutLast);
  const service = new IntentRevisionService(registry.db, { sessions: new WorkflowSessionRepository(registry.db) });
  const active = service.activeRevisionId();
  const draft = service.ensureSourceBaselineDraft(seedIntents);
  expect(draft).toMatchObject({ kind: 'source_baseline', status: 'validated' });
  expect(draft?.validation).toMatchObject({ ok: true, inserted: [seedIntents[ALL - 1]!.canonical_name] });
  expect(service.activeRevisionId()).toBe(active);
  expect(new IntentRepository(registry.db).getApproved()).toHaveLength(ALL - 1);
});
