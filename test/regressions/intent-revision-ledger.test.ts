// A managed intent catalogue must keep loading its approved rules when a new build ships a
// different source seed (#426, #548 edit the seed): the source is a candidate, never the runtime
// authority. Rows that drift from the manifest must still fail closed.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { IntentRepository } from '../../src/database/repositories/intent.repository.ts';
import { seedIntents } from '../../src/services/intent/seed-catalog.ts';
import { installSeed, openTempRegistry, type TempRegistry } from '../helpers/intent-registry.ts';

let registry: TempRegistry;
beforeEach(() => {
  registry = openTempRegistry();
});
afterEach(() => registry.close());

test('source-only deploy keeps the installed catalogue loading', () => {
  const installed = seedIntents.slice(0, 51);
  installSeed(registry.db, installed);
  // The running build compiles all 52 source rules; the database holds the 51 approved ones.
  const approved = new IntentRepository(registry.db).getApproved();
  expect(approved.map((row) => row.canonical_name).sort()).toEqual(installed.map((rule) => rule.canonical_name).sort());
});

test('the full source catalogue loads all 52 approved rules', () => {
  installSeed(registry.db, seedIntents);
  expect(new IntentRepository(registry.db).getApproved()).toHaveLength(52);
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
  installSeed(registry.db, seedIntents.slice(0, 51));
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
  expect(new IntentRepository(registry.db).getApproved()).toHaveLength(52);
});
