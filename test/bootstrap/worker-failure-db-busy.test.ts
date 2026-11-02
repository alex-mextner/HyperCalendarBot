import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkerFailedFactory, type WorkerFailureCollaborators } from '../../src/bootstrap/worker-failure.ts';
import { configureTimeoutReporter, TimeoutReporter } from '../../src/services/incident/timeout-reporter.ts';

/** The error a job really throws when another connection holds the write lock past busy_timeout. */
function realBusyError(dir: string): Error {
  const path = join(dir, 'busy.db');
  const holder = new Database(path);
  holder.exec('CREATE TABLE t (x INTEGER)');
  holder.exec('BEGIN IMMEDIATE');
  const waiter = new Database(path);
  waiter.exec('PRAGMA busy_timeout = 1');
  try {
    waiter.exec('INSERT INTO t VALUES (1)');
  } catch (err) {
    if (err instanceof Error) return err;
  } finally {
    holder.close();
    waiter.close();
  }
  throw new Error('the write lock did not block the second connection');
}

describe('a job that failed on a locked database is reported as a db_busy timeout', () => {
  let alerts: Array<{ text: string; source: string }>;
  let dir: string;
  let logged: string[];
  let handled: Error[];

  beforeEach(() => {
    alerts = [];
    logged = [];
    handled = [];
    dir = mkdtempSync(join(tmpdir(), 'worker-busy-'));
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

  function handler() {
    const collaborators: WorkerFailureCollaborators = {
      logger: { warn: (_obj, message) => logged.push(message), error: (_obj, message) => logged.push(message) },
      makeAlertHandler: () => (_job, err) => {
        handled.push(err);
      },
    };
    return createWorkerFailedFactory(
      { config: { BOT_TOKEN: 'tok', BOT_ADMIN_ID: 7, ADMIN_ALERT_TOKEN: 'tok' }, pushAlert: () => {} },
      collaborators,
    )('image-render');
  }

  test('one lock failure raises one db_busy alert and the log and admin alert are unchanged', () => {
    const err = realBusyError(dir);

    handler()({ id: '1' }, err);

    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.text).toContain('Timeout (db_busy)');
    expect(logged).toEqual(['Worker job failed']);
    expect(handled).toEqual([err]);
  });

  test('repeated lock failures inside the window stay one alert', () => {
    const err = realBusyError(dir);
    const onFailed = handler();

    onFailed({ id: '1' }, err);
    onFailed({ id: '2' }, err);

    expect(alerts).toHaveLength(1);
    expect(handled).toHaveLength(2);
  });

  test('a job that failed for another reason raises no timeout alert', () => {
    handler()({ id: '3' }, new Error('boom'));

    expect(alerts).toEqual([]);
  });
});
