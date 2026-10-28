// Verified, never-overwritten database snapshots taken before the intent registry is rewritten
// (operator seed replacement, deploy-time seed activation, rollback). A snapshot that fails its
// integrity check or would replace an existing file is an error, so a caller never writes after one.
import { Database } from 'bun:sqlite';
import { chmodSync, closeSync, fsyncSync, linkSync, mkdirSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * `VACUUM INTO` a private temporary file beside `destination`, `quick_check` it, fsync it, then
 * hard-link it into place: the link is atomic and refuses an existing file.
 */
export function snapshotDatabase(db: Database, destination: string): void {
  const target = resolve(destination);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
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

/** Directory of the open database file, or null for an in-memory or temporary database. */
export function databaseDirectory(db: Database): string | null {
  const main = db
    .query<{ name: string; file: string }, []>('PRAGMA database_list')
    .all()
    .find((entry) => entry.name === 'main');
  return main?.file ? dirname(main.file) : null;
}
