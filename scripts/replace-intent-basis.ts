import { Database } from 'bun:sqlite';
import { chmodSync, closeSync, fsyncSync, linkSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { seedIntents } from '../src/services/intent/seed-catalog.ts';
import {
  applySeedReplacement,
  assertReplacementWindow,
  intentRows,
  planSeedReplacement,
} from '../src/services/intent/seed-replacement.ts';

function durableSnapshot(db: Database, destination: string): void {
  const target = resolve(destination);
  const temporary = mkdtempSync(join(dirname(target), '.intent-basis-backup-'));
  try {
    const file = join(temporary, 'before.sqlite');
    db.query('VACUUM INTO ?').run(file);
    chmodSync(file, 0o600);
    const saved = new Database(file, { readonly: true, create: false });
    try {
      const check = saved.query<{ quick_check: string }, []>('PRAGMA quick_check').all();
      if (check.length !== 1 || check[0]?.quick_check !== 'ok') throw new Error('Backup integrity failed');
    } finally {
      saved.close();
    }
    const fd = openSync(file, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    linkSync(file, target); // Atomic no-clobber; refuse an existing backup.
    const parent = openSync(dirname(target), 'r');
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
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
    durableSnapshot(db, values.backup!);
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
