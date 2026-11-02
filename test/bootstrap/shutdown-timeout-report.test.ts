import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createShutdownWithTimeout, type ShutdownDeps } from '../../src/bootstrap/shutdown.ts';
import {
  configureTimeoutReporter,
  reportTimeout,
  TimeoutReporter,
} from '../../src/services/incident/timeout-reporter.ts';

function hungDeps(): { deps: ShutdownDeps; exits: number[]; fatals: string[] } {
  const exits: number[] = [];
  const fatals: string[] = [];
  const deps: ShutdownDeps = {
    bot: { stop: () => Promise.withResolvers<void>().promise },
    agent: { drain: async () => {} },
    resources: {},
    summarizerRedis: { close: () => {} },
    webServerHandle: undefined,
    webServerDeps: {},
    database: { close: () => {} },
    flushAiUsageRecording: () => {},
    timeoutMs: 20,
    logger: { fatal: (_obj: unknown, message: string) => fatals.push(message) },
    exit: (code) => exits.push(code),
  };
  return { deps, exits, fatals };
}

describe('shutdown deadline reports to the timeout alerts', () => {
  let alerts: Array<{ text: string; source: string }>;

  beforeEach(() => {
    alerts = [];
    configureTimeoutReporter(
      new TimeoutReporter(
        (text, source) => alerts.push({ text, source }),
        () => 1_000,
      ),
    );
  });
  afterEach(() => configureTimeoutReporter(null));

  test('a missed deadline raises one aggregated alert and still logs fatal and exits 1', async () => {
    const { deps, exits, fatals } = hungDeps();

    await createShutdownWithTimeout(deps)();

    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.source).toBe('timeout');
    expect(alerts[0]?.text).toContain('Timeout (shutdown)');
    expect(alerts[0]?.text).toContain('limitMs: 20');
    expect(alerts[0]?.text).toContain('unrecovered=1 recovered=0');
    expect(fatals).toEqual(['Shutdown timed out, forcing exit']);
    expect(exits).toEqual([1]);
  });

  test('a second missed deadline is sent at once by the flush on the deadline path: the process is exiting, so the window no longer applies', async () => {
    const first = hungDeps();
    const second = hungDeps();

    await createShutdownWithTimeout(first.deps)();
    await createShutdownWithTimeout(second.deps)();

    expect(alerts).toHaveLength(2);
    expect(alerts[1]?.text).toContain('unrecovered=1 recovered=0');
    expect(second.exits).toEqual([1]);
  });

  test('a close that throws is not a deadline and raises no timeout alert', async () => {
    const { deps, exits } = hungDeps();
    deps.bot = { stop: async () => {} };
    deps.database = {
      close: () => {
        throw new Error('locked');
      },
    };

    await createShutdownWithTimeout(deps)();

    expect(alerts).toEqual([]);
    expect(exits).toEqual([1]);
  });

  test('a clean shutdown raises no alert', async () => {
    const { deps, exits } = hungDeps();
    deps.bot = { stop: async () => {} };

    await createShutdownWithTimeout(deps)();

    expect(alerts).toEqual([]);
    expect(exits).toEqual([]);
  });

  test('timeouts still held back in their window are sent before the database closes', async () => {
    const order: string[] = [];
    configureTimeoutReporter(
      new TimeoutReporter(
        (text) => {
          order.push(`alert:${text.split('\n')[0]}`);
        },
        () => 1_000,
        () => {},
      ),
    );
    // The first provider timeout opens the window; the unrecovered one behind it is held back.
    reportTimeout({ kind: 'provider', elapsedMs: 8_000, limitMs: 8_000, recovered: true });
    reportTimeout({ kind: 'provider', requestId: 'req-held', elapsedMs: 9_000, limitMs: 8_000, recovered: false });
    expect(order).toEqual(['alert:Timeout (provider)']);

    const { deps } = hungDeps();
    deps.bot = { stop: async () => {} };
    deps.database = { close: () => order.push('database closed') };
    await createShutdownWithTimeout(deps)();

    expect(order).toEqual(['alert:Timeout (provider)', 'alert:Timeout (provider)', 'database closed']);
  });
});
