// src/database/backup.ts

import type { Database } from 'bun:sqlite';
import { mkdir, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../utils/logger.ts';

const backupLogger = logger.child({ module: 'backup' });
const BACKUP_RETENTION = 7;

export async function runSqliteBackup(db: Database, dbPath: string): Promise<void> {
  const dataDir = path.dirname(path.resolve(dbPath));
  const backupDir = path.join(dataDir, 'backups');
  await mkdir(backupDir, { recursive: true });

  const dateStr = new Date().toISOString().slice(0, 10);
  const backupPath = path.join(backupDir, `calendar-${dateStr}.db`);

  // VACUUM INTO fails if the target file already exists — remove stale same-day backup first
  try {
    await unlink(backupPath);
  } catch {
    // file did not exist, nothing to remove
  }
  db.exec(`VACUUM INTO '${backupPath}'`);

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
