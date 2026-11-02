// The /connect_telegram bridge has two deadlines: a 60 s kill for one-shot subcommands and a 5 min
// kill for the whole send_and_sign flow. Each firing is reported once per window as mtproto_bridge,
// and reporting must not change what the caller gets. The two timers are captured and fired by the
// test instead of waited for; the processes are synthetic.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { configureTimeoutReporter, TimeoutReporter } from '../../../src/services/incident/timeout-reporter.ts';
import { SessionBridge } from '../../../src/services/telegram-session/session-bridge.ts';
import {
  captureDeadlines,
  type DeadlineCapture,
  hangingProcess,
  KILLED_EXIT_CODE,
  type SpawnStub,
  stubSpawn,
} from '../../helpers/hanging-process.ts';

const SPAWN_TIMEOUT_MS = 60_000;
const AUTH_FLOW_TIMEOUT_MS = 5 * 60 * 1000;
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
  deadlines = captureDeadlines(SPAWN_TIMEOUT_MS, AUTH_FLOW_TIMEOUT_MS);
});

afterEach(() => {
  deadlines.restore();
  spawn?.restore();
  spawn = undefined;
  configureTimeoutReporter(null);
});

function expectOneAggregatedAlert(limitMs: number): void {
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toContain('Timeout (mtproto_bridge)');
  expect(alerts[0]).toContain(`limitMs: ${limitMs}`);
  expect(alerts[0]).toMatch(/elapsedMs: \d+/);
}

test('a one-shot bridge command killed at the spawn limit reports one aggregated mtproto_bridge alert and returns the same result', async () => {
  const unchanged = SessionBridge.parseResult('', '', KILLED_EXIT_CODE);
  const hung = [hangingProcess(), hangingProcess(), hangingProcess()];
  spawn = stubSpawn(...hung.map((entry) => entry.process));

  for (const entry of hung) {
    const pending = SessionBridge.logOut('/synthetic/session');
    deadlines.fire(SPAWN_TIMEOUT_MS);
    expect(await pending).toEqual(unchanged);
    expect(entry.kill).toHaveBeenCalledTimes(1);
  }

  expectOneAggregatedAlert(SPAWN_TIMEOUT_MS);
});

test('an auth flow killed at its 5 min limit reports one aggregated mtproto_bridge alert and still drops the live handle', async () => {
  const userIds = [7_000_001, 7_000_002, 7_000_003];
  const hung = userIds.map(() => hangingProcess({ firstLine: JSON.stringify({ phone_code_hash: 'synthetic-hash' }) }));
  spawn = stubSpawn(...hung.map((entry) => entry.process));

  for (const [index, userId] of userIds.entries()) {
    const started = await SessionBridge.spawnSendAndSign('+10000000000', '/synthetic/session', userId);
    expect(started).toMatchObject({ success: true, data: { phone_code_hash: 'synthetic-hash' } });
    expect(SessionBridge.getLiveAuthHandle(userId)).toBe(started.handle);

    deadlines.fire(AUTH_FLOW_TIMEOUT_MS);

    expect(hung[index]?.kill).toHaveBeenCalledTimes(1);
    expect(SessionBridge.getLiveAuthHandle(userId)).toBeUndefined();
  }

  expectOneAggregatedAlert(AUTH_FLOW_TIMEOUT_MS);
});
