import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runSqliteBackup } from '../../src/database/backup.ts';
import { migrations } from '../../src/database/migrations.ts';
import { runMigrations } from '../../src/database/schema.ts';

let TMP_BASE: string;
let DATA_DIR: string;
let DB_PATH: string;
let BACKUP_DIR: string;

describe('runSqliteBackup', () => {
  let db: Database;

  beforeEach(async () => {
    // A private, unpredictable directory per test; a fixed name in the shared temp dir could be pre-created.
    TMP_BASE = await mkdtemp(path.join(os.tmpdir(), 'bak-test-'));
    DATA_DIR = path.join(TMP_BASE, 'data');
    DB_PATH = path.join(DATA_DIR, 'calendar.db');
    BACKUP_DIR = path.join(DATA_DIR, 'backups');
    await mkdir(DATA_DIR, { recursive: true });
    db = new Database(DB_PATH);
    runMigrations(db, migrations);
  });

  afterEach(async () => {
    db.close();
    await rm(TMP_BASE, { recursive: true, force: true });
  });

  test('creates backup file in data/backups/', async () => {
    await runSqliteBackup(db, DB_PATH);
    const files = await readdir(BACKUP_DIR);
    expect(files.some((f) => f.startsWith('calendar-') && f.endsWith('.db'))).toBe(true);
  });

  test('backup file is a valid SQLite database', async () => {
    await runSqliteBackup(db, DB_PATH);
    const files = (await readdir(BACKUP_DIR)).filter((f) => f.endsWith('.db'));
    const backupDb = new Database(path.join(BACKUP_DIR, files[0]!));
    const row = backupDb.prepare("SELECT name FROM sqlite_master WHERE type='table' LIMIT 1").get();
    backupDb.close();
    expect(row).not.toBeNull();
  });

  test('prunes oldest backups beyond 7-file retention', async () => {
    await mkdir(BACKUP_DIR, { recursive: true });
    // Create 8 pre-existing fake backup files with ascending dates
    for (let i = 1; i <= 8; i++) {
      await writeFile(path.join(BACKUP_DIR, `calendar-2026-01-0${i}.db`), 'fake');
    }
    await runSqliteBackup(db, DB_PATH);
    const files = (await readdir(BACKUP_DIR)).filter((f) => f.endsWith('.db'));
    expect(files.length).toBe(7);
  });

  test('idempotent: running twice on the same day does not accumulate', async () => {
    await runSqliteBackup(db, DB_PATH);
    await runSqliteBackup(db, DB_PATH);
    const files = (await readdir(BACKUP_DIR)).filter((f) => f.endsWith('.db'));
    // Same-day backup overwrites itself (same filename) — at most 1 file for today
    expect(files.length).toBe(1);
  });

  test('backup is 0600 in a 0700 directory under the default 022 umask (GH-613)', async () => {
    const previousUmask = process.umask(0o022);
    try {
      await mkdir(BACKUP_DIR, { mode: 0o755 });
      await chmod(BACKUP_DIR, 0o755);
      await runSqliteBackup(db, DB_PATH);
    } finally {
      process.umask(previousUmask);
    }
    const files = (await readdir(BACKUP_DIR)).filter((f) => f.endsWith('.db'));
    expect(files).toHaveLength(1);
    expect((await stat(path.join(BACKUP_DIR, files[0]!))).mode & 0o777).toBe(0o600);
    expect((await stat(BACKUP_DIR)).mode & 0o777).toBe(0o700);
  });
});
