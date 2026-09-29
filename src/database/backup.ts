// src/database/backup.ts

import type { Database } from 'bun:sqlite';
import { chmod, mkdir, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../utils/logger.ts';

const backupLogger = logger.child({ module: 'backup' });
const BACKUP_RETENTION = 7;

export async function runSqliteBackup(db: Database, dbPath: string): Promise<void> {
  const dataDir = path.dirname(path.resolve(dbPath));
  const backupDir = path.join(dataDir, 'backups');
  // A backup copies every user's private data onto a host shared with other services (GH-613):
  // the directory is 0700 and each file 0600 regardless of the process umask.
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  await chmod(backupDir, 0o700);

  const dateStr = new Date().toISOString().slice(0, 10);
  const backupPath = path.join(backupDir, `calendar-${dateStr}.db`);

  // VACUUM INTO fails if the target file already exists — remove stale same-day backup first
  try {
    await unlink(backupPath);
  } catch {
    // file did not exist, nothing to remove
  }
  // The copy is created 0600 (SQLite creates 0644 minus the umask); the synchronous VACUUM
  // leaves no await in which other code could run under the narrowed umask.
  const previousUmask = process.umask(0o077);
  try {
    db.exec(`VACUUM INTO '${backupPath}'`);
  } finally {
    process.umask(previousUmask);
  }
  try {
    await chmod(backupPath, 0o600);
    const mode = (await stat(backupPath)).mode & 0o777;
    if (mode !== 0o600) throw new Error(`backup ${backupPath} is mode ${mode.toString(8)}, expected 600`);
  } catch (error) {
    // Fail closed: never keep a copy that others may be able to read.
    await unlink(backupPath).catch((unlinkError: unknown) =>
      backupLogger.error({ err: unlinkError, backupPath }, 'could not delete a backup with unrestricted mode'),
    );
    throw error;
  }

  const allBackups = (await readdir(backupDir)).filter((f) => f.startsWith('calendar-') && f.endsWith('.db')).sort();

  const toDelete = allBackups.slice(0, Math.max(0, allBackups.length - BACKUP_RETENTION));
  for (const f of toDelete) {
    await unlink(path.join(backupDir, f));
  }

  backupLogger.info(
    { backupPath, retained: allBackups.length - toDelete.length, deleted: toDelete.length },
    'SQLite backup completed',
  );
}
