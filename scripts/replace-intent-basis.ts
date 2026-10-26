import { Database } from 'bun:sqlite';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { snapshotDatabase } from '../src/services/intent/db-backup.ts';
import { seedIntents } from '../src/services/intent/seed-catalog.ts';
import {
  applySeedReplacement,
  assertReplacementWindow,
  intentRows,
  planSeedReplacement,
} from '../src/services/intent/seed-replacement.ts';

export function runSeedReplacementCli(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      db: { type: 'string' },
      apply: { type: 'boolean', default: false },
      expect: { type: 'string' },
      backup: { type: 'string' },
    },
    strict: true,
  });
  if (!values.db) throw new Error('--db existing-database is required');
  if (values.apply && (!values.expect || !values.backup))
    throw new Error('--apply requires a reviewed --expect fingerprint and a NEW --backup path');
  const db = new Database(resolve(values.db), { readonly: !values.apply, readwrite: values.apply, create: false });
  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;');
    const plan = planSeedReplacement(db, seedIntents);
    if (!values.apply) {
      console.log(JSON.stringify({ mode: 'plan', ...plan }, null, 2));
      return;
    }
    if (values.expect !== plan.previousFingerprint) throw new Error('Intent definitions changed after operator review');
    assertReplacementWindow(db);
    snapshotDatabase(db, values.backup!);
    const archive = `${values.backup!}.intents.json`;
    writeFileSync(archive, JSON.stringify({ plan, rows: intentRows(db) }, null, 2), { flag: 'wx', mode: 0o600 });
    const result = applySeedReplacement(db, seedIntents, plan, values.backup!);
    console.log(
      JSON.stringify({ ...result, archive, backup: resolve(values.backup!), restartRequired: true }, null, 2),
    );
  } finally {
    db.close();
  }
}
if (import.meta.main) {
  try {
    runSeedReplacementCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Seed replacement failed');
    process.exitCode = 1;
  }
}
