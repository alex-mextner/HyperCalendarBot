// A service-tier script that outlives its timeoutMs is killed by spawnServiceScript. That kill is a
// deadline the owner must hear about (alerts queue, kind mtproto_script), aggregated per window, and
// reporting it must not change what the runner returns. Synthetic process; the kill timer is
// captured and fired by the test.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { configureTimeoutReporter, TimeoutReporter } from '../../src/services/incident/timeout-reporter.ts';
import { SERVICE_SCRIPTS, spawnServiceScript } from '../../src/services/telegram-session/service-tier.ts';
import {
  captureDeadlines,
  type DeadlineCapture,
  hangingProcess,
  KILLED_EXIT_CODE,
  type SpawnStub,
  stubSpawn,
} from '../helpers/hanging-process.ts';

const LIMIT_MS = 12_345;
let alerts: string[];
let spawn: SpawnStub | undefined;
let deadlines: DeadlineCapture;

beforeEach(() => {
  alerts = [];
  configureTimeoutReporter(
    new TimeoutReporter(
      (text) => alerts.push(text),
      () => 1_000,
    ),
  );
  deadlines = captureDeadlines(LIMIT_MS);
});

afterEach(() => {
  deadlines.restore();
  spawn?.restore();
  spawn = undefined;
  configureTimeoutReporter(null);
});

test('a script killed at its limit reports one aggregated mtproto_script alert and returns the killed result', async () => {
  const hung = [hangingProcess(), hangingProcess(), hangingProcess()];
  spawn = stubSpawn(...hung.map((entry) => entry.process));

  for (const entry of hung) {
    const pending = spawnServiceScript(SERVICE_SCRIPTS.probe, [], { timeoutMs: LIMIT_MS });
    deadlines.fire(LIMIT_MS);
    expect(await pending).toEqual({ stdout: '', stderr: '', exitCode: KILLED_EXIT_CODE });
    expect(entry.kill).toHaveBeenCalledTimes(1);
  }

  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toContain('Timeout (mtproto_script)');
  expect(alerts[0]).toContain(`limitMs: ${LIMIT_MS}`);
  expect(alerts[0]).toMatch(/elapsedMs: \d+/);
});
