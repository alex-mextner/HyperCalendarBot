// Revision ledger lookup used by the intent repository before it loads a managed registry that
// has evolved past the shipped source baseline. Kept dependency-free so the repository can import it.
import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { cmdLogger } from '../../utils/logger.ts';
import { sidecarPathFor } from './constants.ts';

/**
 * Answers whether `fingerprint` is the target of an admin-approved revision. A revision is recorded
 * as `activating` before the main database commit, so a crash between the commit and the
 * acknowledgement still loads the approved registry. The lineage is not tied to the source
 * baseline of the running build: a later build with a different shipped seed keeps loading the
 * registry the admin approved.
 */
export type RevisionLedgerCheck = (fingerprint: string) => boolean;

export function ledgerAccepts(ledger: Database, fingerprint: string): boolean {
  return (
    ledger
      .query<{ one: number }, [string]>(
        "SELECT 1 AS one FROM revisions WHERE target_fingerprint = ? AND status IN ('activating', 'active') LIMIT 1",
      )
      .get(fingerprint) !== null
  );
}

/** Ledger check against the sidecar of `databasePath`; in-memory databases have no ledger. */
export function sidecarLedgerCheck(databasePath: string): RevisionLedgerCheck {
  return (fingerprint) => {
    if (!databasePath || databasePath === ':memory:') return false;
    const path = sidecarPathFor(databasePath);
    if (!existsSync(path)) return false;
    let ledger: Database | undefined;
    try {
      ledger = new Database(path, { readonly: true });
      ledger.exec('PRAGMA busy_timeout = 3000');
      return ledgerAccepts(ledger, fingerprint);
    } catch (err) {
      cmdLogger.warn({ err }, 'Intent revision ledger unreadable; evolved registry stays unloaded');
      return false;
    } finally {
      ledger?.close();
    }
  };
}
