// Migration 065 brings the intent ledger under the migration path and backfills the active
// revision from the LIVE manifest, never from the build's source seed, and only when the raw
// approved rows still fingerprint to that manifest. A tampered registry is never blessed.
import type { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { migrations } from '../../src/database/migrations.ts';
import { IntentRepository } from '../../src/database/repositories/intent.repository.ts';
import { runMigrations } from '../../src/database/schema.ts';
import { seedFingerprint } from '../../src/services/intent/rule-fingerprint.ts';
import { seedIntents } from '../../src/services/intent/seed-catalog.ts';
import { applySeedReplacement, planSeedReplacement } from '../../src/services/intent/seed-replacement.ts';
import { openTempRegistry, type TempRegistry } from '../helpers/intent-registry.ts';

const MIGRATION = '065_intent_revisions';
const before = migrations.filter((migration) => migration.name !== MIGRATION);
let registry: TempRegistry | undefined;
afterEach(() => registry?.close());

/** The pre-065 production shape: rows plus the ad hoc manifest table and its fingerprint. */
function managedBeforeMigration(seed: typeof seedIntents): Database {
  registry = openTempRegistry(before);
  const { db } = registry;
  db.exec(
    'CREATE TABLE IF NOT EXISTS intent_basis_manifest (singleton INTEGER PRIMARY KEY CHECK(singleton=1), fingerprint TEXT NOT NULL, installed_at TEXT NOT NULL, rule_count INTEGER NOT NULL)',
  );
  const insert = db.prepare(
    'INSERT INTO intents(canonical_name,pattern,workflow,phrases,trigger_words,source_message,format,status) VALUES(?,?,?,?,?,?,?,?)',
  );
  for (const rule of seed)
    insert.run(
      rule.canonical_name,
      rule.pattern,
      JSON.stringify(rule.workflow),
      JSON.stringify(rule.phrases),
      JSON.stringify(rule.trigger_words),
      rule.source_message,
      'text',
      'approved',
    );
  db.run("INSERT INTO intent_basis_manifest VALUES(1,?,datetime('now'),?)", [seedFingerprint(seed), seed.length]);
  return db;
}

function revisions(db: Database) {
  return db
    .query<{ kind: string; status: string; author: string; target_fingerprint: string }, []>(
      'SELECT kind, status, author, target_fingerprint FROM intent_revisions',
    )
    .all();
}

test('backfills one active revision equal to the live manifest', () => {
  const db = managedBeforeMigration(seedIntents);
  runMigrations(db, migrations);
  expect(revisions(db)).toEqual([
    {
      kind: 'source_baseline',
      status: 'active',
      author: 'migration',
      target_fingerprint: seedFingerprint(seedIntents),
    },
  ]);
  expect(new IntentRepository(db).getApproved()).toHaveLength(seedIntents.length);
});

test('backfills from the manifest even when the build ships a different source seed', () => {
  const installed = seedIntents.slice(0, -1);
  const db = managedBeforeMigration(installed);
  runMigrations(db, migrations);
  expect(revisions(db)[0]?.target_fingerprint).toBe(seedFingerprint(installed));
  expect(new IntentRepository(db).getApproved()).toHaveLength(installed.length);
});

test('a row tampered before the migration is not blessed', () => {
  const db = managedBeforeMigration(seedIntents);
  db.run('UPDATE intents SET phrases=? WHERE canonical_name=?', ['["tampered"]', 'basis.time.now']);
  expect(() => runMigrations(db, migrations)).not.toThrow();
  expect(revisions(db)).toEqual([]);
  expect(new IntentRepository(db).getApproved()).toEqual([]);
});

test('unparseable row JSON before the migration is not blessed and does not throw', () => {
  const db = managedBeforeMigration(seedIntents);
  db.run('UPDATE intents SET workflow=? WHERE canonical_name=?', ['not JSON', 'basis.time.now']);
  expect(() => runMigrations(db, migrations)).not.toThrow();
  expect(revisions(db)).toEqual([]);
  expect(new IntentRepository(db).getApproved()).toEqual([]);
});

test('an unmanaged database gets the tables and no revision', () => {
  registry = openTempRegistry(before);
  const { db } = registry;
  db.run('INSERT INTO intents(canonical_name,workflow,status) VALUES(?,?,?)', ['legacy', '{}', 'approved']);
  runMigrations(db, migrations);
  expect(revisions(db)).toEqual([]);
  expect(db.query('SELECT * FROM intent_basis_manifest').all()).toEqual([]);
  expect(new IntentRepository(db).getApproved()).toHaveLength(1);
});

test('the migration ships its reviewed deploy document', () => {
  expect(existsSync(join(import.meta.dir, '../../docs/reference/migrations', `${MIGRATION}.md`))).toBe(true);
});

test('the schema admits at most one active revision', () => {
  const db = managedBeforeMigration(seedIntents);
  runMigrations(db, migrations);
  expect(() =>
    db.run(
      "INSERT INTO intent_revisions (kind, status, body_hash, body, validation, author, created_at) VALUES ('manual', 'active', 'h', '{}', '{}', 'admin', 0)",
    ),
  ).toThrow('UNIQUE');
});

test('the operator replacement refuses a database without the ledger migration', () => {
  const db = managedBeforeMigration(seedIntents.slice(0, -1));
  const rows = db.query('SELECT * FROM intents ORDER BY id').all();
  const plan = planSeedReplacement(db, seedIntents);
  expect(() => applySeedReplacement(db, seedIntents, plan, '/nonexistent')).toThrow('065_intent_revisions');
  expect(db.query('SELECT * FROM intents ORDER BY id').all()).toEqual(rows);
});

test('the operator replacement of the same seed refuses a database without the ledger migration', () => {
  const db = managedBeforeMigration(seedIntents);
  const plan = planSeedReplacement(db, seedIntents);
  expect(() => applySeedReplacement(db, seedIntents, plan, '/nonexistent')).toThrow('065_intent_revisions');
});

test('a manifest whose rule count disagrees with the rows is not blessed', () => {
  const db = managedBeforeMigration(seedIntents);
  db.run('UPDATE intent_basis_manifest SET rule_count = rule_count + 1');
  runMigrations(db, migrations);
  expect(revisions(db)).toEqual([]);
  expect(new IntentRepository(db).getApproved()).toEqual([]);
});
