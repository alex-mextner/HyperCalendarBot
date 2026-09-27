import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrations } from '../../src/database/migrations.ts';
import { runMigrations } from '../../src/database/schema.ts';
import {
  applySeedReplacement,
  type CanonicalSeed,
  planSeedReplacement,
} from '../../src/services/intent/seed-replacement.ts';

export interface TempRegistry {
  db: Database;
  close(): void;
}

/** A migrated file database in a private temp directory (WAL needs a real file). */
export function openTempRegistry(migrationList = migrations): TempRegistry {
  const directory = mkdtempSync(join(tmpdir(), 'intent-ledger-'));
  const db = new Database(join(directory, 'calendar.db'));
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
  runMigrations(db, migrationList);
  return {
    db,
    close() {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/** Installs a managed basis through the operator replacement path, with its verified backup. */
export function installSeed(db: Database, seed: readonly CanonicalSeed[]): void {
  const plan = planSeedReplacement(db, seed);
  const directory = mkdtempSync(join(tmpdir(), 'intent-ledger-backup-'));
  try {
    const backup = join(directory, 'before.db');
    db.query('VACUUM INTO ?').run(backup);
    applySeedReplacement(db, seed, plan, backup);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Every row of the registry tables, for asserting that a refusal wrote nothing. */
export function registrySnapshot(db: Database): string {
  return JSON.stringify({
    intents: db.query('SELECT * FROM intents ORDER BY id').all(),
    manifest: db.query('SELECT * FROM intent_basis_manifest').all(),
    revisions: db.query('SELECT * FROM intent_revisions ORDER BY id').all(),
  });
}
