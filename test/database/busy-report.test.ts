import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reportIfDatabaseBusy } from '../../src/services/incident/database-busy.ts';
import { configureTimeoutReporter, TimeoutReporter } from '../../src/services/incident/timeout-reporter.ts';

/** The error a statement really throws when another connection holds the write lock past busy_timeout. */
function realBusyError(dir: string): unknown {
  const path = join(dir, 'busy.db');
  const holder = new Database(path);
  holder.exec('CREATE TABLE t (x INTEGER)');
  holder.exec('BEGIN IMMEDIATE');
  const waiter = new Database(path);
  waiter.exec('PRAGMA busy_timeout = 1');
  try {
    waiter.exec('INSERT INTO t VALUES (1)');
  } catch (err) {
    return err;
  } finally {
    holder.close();
    waiter.close();
  }
  throw new Error('the write lock did not block the second connection');
}

describe('a database lock timeout reports to the timeout alerts', () => {
  let alerts: Array<{ text: string; source: string }>;
  let dir: string;

  beforeEach(() => {
    alerts = [];
    dir = mkdtempSync(join(tmpdir(), 'busy-report-'));
    configureTimeoutReporter(
      new TimeoutReporter(
        (text, source) => alerts.push({ text, source }),
        () => 1_000,
      ),
    );
  });
  afterEach(() => {
    configureTimeoutReporter(null);
    rmSync(dir, { recursive: true, force: true });
  });

  test('a real SQLITE_BUSY error raises one aggregated db_busy alert', () => {
    const err = realBusyError(dir);

    reportIfDatabaseBusy(err);

    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.source).toBe('timeout');
    expect(alerts[0]?.text).toContain('Timeout (db_busy)');
    expect(alerts[0]?.text).toContain('limitMs: 5000');
    expect(alerts[0]?.text).toContain('unrecovered=1 recovered=0');
  });

  test('repeated lock timeouts inside the window stay one alert', () => {
    const err = realBusyError(dir);

    reportIfDatabaseBusy(err);
    reportIfDatabaseBusy(err);

    expect(alerts).toHaveLength(1);
  });

  test('the caught error is only read: it stays the same error', () => {
    const err = realBusyError(dir) as Error;
    const message = err.message;

    reportIfDatabaseBusy(err);

    expect(err.message).toBe(message);
    expect(() => reportIfDatabaseBusy(err)).not.toThrow();
  });

  test('other errors and non-errors raise nothing', () => {
    reportIfDatabaseBusy(new Error('UNIQUE constraint failed: users.id'));
    reportIfDatabaseBusy('database is locked');
    reportIfDatabaseBusy(undefined);

    expect(alerts).toEqual([]);
  });
});
