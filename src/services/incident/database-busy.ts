// SQLite's busy timeout has no timer to hook: it surfaces only as a thrown SQLITE_BUSY ("database is
// locked") from whichever statement hit the lock. Code that catches a database error, the central
// error handlers and the places that swallow one on purpose, hands it here; a busy error is reported
// as a `db_busy` timeout, anything else is ignored.
import { reportTimeout } from './timeout-reporter.ts';

/** How long SQLite waits on a locked database before it fails the statement with SQLITE_BUSY. */
export const DB_BUSY_TIMEOUT_MS = 5000;

/** SQLite has already waited the full busy timeout (`limitMs`) when it throws. */
export function reportIfDatabaseBusy(err: unknown, limitMs: number = DB_BUSY_TIMEOUT_MS): void {
  if (!(err instanceof Error)) return;
  const code = (err as Error & { code?: unknown }).code;
  if (code !== 'SQLITE_BUSY' && !err.message.includes('database is locked')) return;
  reportTimeout({ kind: 'db_busy', elapsedMs: limitMs, limitMs, recovered: false });
}
