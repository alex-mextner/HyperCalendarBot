import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runSqliteBackup } from '../../src/database/backup.ts';
import { migrations } from '../../src/database/migrations.ts';
import { runMigrations } from '../../src/database/schema.ts';

const TMP_BASE = path.join(os.tmpdir(), `bak-test-${Date.now()}`);
const DATA_DIR = path.join(TMP_BASE, 'data');
const DB_PATH = path.join(DATA_DIR, 'calendar.db');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

describe('runSqliteBackup', () => {
  let db: Database;

  beforeEach(async () => {
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
});
