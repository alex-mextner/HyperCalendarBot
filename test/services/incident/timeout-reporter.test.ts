import { beforeEach, describe, expect, test } from 'bun:test';
import {
  configureTimeoutReporter,
  MAX_PUSH_ATTEMPTS,
  reportTimeout,
  TIMEOUT_ALERT_RETRY_MS,
  TIMEOUT_ALERT_SOURCE,
  TIMEOUT_ALERT_WINDOW_MS,
  TimeoutReporter,
} from '../../../src/services/incident/timeout-reporter.ts';

describe('timeout reporter', () => {
  let alerts: { text: string; source: string }[];
  let clock: number;
  let reporter: TimeoutReporter;
  let flushes: { fn: () => void; delayMs: number }[];

  beforeEach(() => {
    alerts = [];
    clock = 1_000_000;
    flushes = [];
    reporter = new TimeoutReporter(
      (text, source) => alerts.push({ text, source }),
      () => clock,
      (fn, delayMs) => flushes.push({ fn, delayMs }),
    );
  });

  test('the first timeout of a kind is pushed at once on the timeout source, with only durations and ids', () => {
    reporter.report({ kind: 'validator', requestId: 'req-1', elapsedMs: 15_001.4, limitMs: 15_000, recovered: false });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.source).toBe(TIMEOUT_ALERT_SOURCE);
    expect(alerts[0]?.text).toContain('Timeout (validator)');
    expect(alerts[0]?.text).toContain('requestId: req-1');
    expect(alerts[0]?.text).toContain('elapsedMs: 15001');
    expect(alerts[0]?.text).toContain('unrecovered=1 recovered=0');
  });

  test('later ones of the kind inside the window are counted, not dropped, and ride the next alert', () => {
    reporter.report({ kind: 'provider', elapsedMs: 8_000, limitMs: 8_000, recovered: true });
    clock += 60_000;
    reporter.report({ kind: 'provider', elapsedMs: 8_000, limitMs: 8_000, recovered: true });
    reporter.report({ kind: 'provider', elapsedMs: 8_000, limitMs: 8_000, recovered: false });
    expect(alerts).toHaveLength(1);

    clock += TIMEOUT_ALERT_WINDOW_MS;
    reporter.report({ kind: 'provider', elapsedMs: 8_000, limitMs: 8_000, recovered: true });
    expect(alerts).toHaveLength(2);
    expect(alerts[1]?.text).toContain('unrecovered=1 recovered=2');
  });

  test('kinds have their own windows', () => {
    reporter.report({ kind: 'render', elapsedMs: 45_000, limitMs: 45_000, recovered: false });
    reporter.report({ kind: 'validator', elapsedMs: 16_000, limitMs: 16_000, recovered: false });
    expect(alerts).toHaveLength(2);
  });

  test('a failing alert queue never fails the caller', () => {
    const broken = new TimeoutReporter(() => {
      throw new Error('database is locked');
    });
    expect(() => broken.report({ kind: 'db', elapsedMs: 1, limitMs: 1, recovered: false })).not.toThrow();
  });

  test('a late flush timer cannot send inside a window a newer alert already opened', () => {
    reporter.report({ kind: 'provider', elapsedMs: 1, limitMs: 1, recovered: false });
    clock += 1;
    reporter.report({ kind: 'provider', elapsedMs: 1, limitMs: 1, recovered: false });
    clock += TIMEOUT_ALERT_WINDOW_MS;
    reporter.report({ kind: 'provider', elapsedMs: 1, limitMs: 1, recovered: false }); // sends, opens a new window
    clock += 1;
    reporter.report({ kind: 'provider', elapsedMs: 1, limitMs: 1, recovered: false }); // held
    expect(alerts).toHaveLength(2);

    flushes[0]?.fn(); // the original timer fires late
    expect(alerts).toHaveLength(2);
    expect(flushes.at(-1)?.delayMs).toBe(TIMEOUT_ALERT_WINDOW_MS - 1);
  });

  test('an alert the queue refused is retried without needing another timeout, then rides the next one', () => {
    let refusing = true;
    const flaky = new TimeoutReporter(
      (text, source) => {
        if (refusing) throw new Error('database is locked');
        alerts.push({ text, source });
      },
      () => clock,
      (fn, delayMs) => flushes.push({ fn, delayMs }),
    );
    flaky.report({ kind: 'db_busy', elapsedMs: 5_000, limitMs: 5_000, recovered: false });
    expect(alerts).toHaveLength(0);
    expect(flushes.at(-1)?.delayMs).toBe(TIMEOUT_ALERT_RETRY_MS);

    refusing = false;
    clock += TIMEOUT_ALERT_RETRY_MS;
    flushes.at(-1)?.fn();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.text).toContain('unrecovered=1 recovered=0');
  });

  test('a queue that keeps refusing is tried a minute apart a bounded number of times in a row, then once per window', () => {
    let attempts = 0;
    const dead = new TimeoutReporter(
      () => {
        attempts++;
        throw new Error('database is locked');
      },
      () => clock,
      (fn, delayMs) => flushes.push({ fn, delayMs }),
    );
    dead.report({ kind: 'db_busy', elapsedMs: 1, limitMs: 1, recovered: false });
    const delays: number[] = [];
    for (let round = 0; round < 12; round++) {
      const next = flushes.shift();
      delays.push(next?.delayMs ?? -1);
      clock += next?.delayMs ?? 0;
      next?.fn();
    }
    // Four short waits after the first four refusals; from the fifth refusal on, one try per window.
    expect(delays.slice(0, MAX_PUSH_ATTEMPTS - 1)).toEqual(Array(MAX_PUSH_ATTEMPTS - 1).fill(TIMEOUT_ALERT_RETRY_MS));
    expect(delays.slice(MAX_PUSH_ATTEMPTS - 1)).toEqual(
      Array(12 - (MAX_PUSH_ATTEMPTS - 1)).fill(TIMEOUT_ALERT_WINDOW_MS),
    );
    expect(attempts).toBe(13);
    expect(flushes).toHaveLength(1);
  });

  test('every kind shares the failure count: a kind that meets a dead queue after the others failed does not restart the retries', () => {
    let attempts = 0;
    const dead = new TimeoutReporter(
      () => {
        attempts++;
        throw new Error('database is locked');
      },
      () => clock,
      (fn, delayMs) => flushes.push({ fn, delayMs }),
    );
    dead.report({ kind: 'render', elapsedMs: 1, limitMs: 1, recovered: false });
    for (let round = 0; round < MAX_PUSH_ATTEMPTS - 1; round++) {
      clock += TIMEOUT_ALERT_RETRY_MS;
      flushes.shift()?.fn();
    }
    expect(attempts).toBe(MAX_PUSH_ATTEMPTS);
    const before = flushes.length;

    // A new kind inside the window-long backoff only waits; it does not touch the queue.
    dead.report({ kind: 'provider', elapsedMs: 1, limitMs: 1, recovered: false });
    expect(attempts).toBe(MAX_PUSH_ATTEMPTS);
    expect(flushes.slice(before).every((flush) => flush.delayMs > TIMEOUT_ALERT_RETRY_MS)).toBe(true);

    // When the backoff ends and the first try is refused again, the next wait is a window, not a minute.
    clock += TIMEOUT_ALERT_WINDOW_MS;
    flushes.shift()?.fn();
    expect(attempts).toBe(MAX_PUSH_ATTEMPTS + 1);
    expect(flushes.at(-1)?.delayMs).toBe(TIMEOUT_ALERT_WINDOW_MS);
  });

  test('reportTimeout is a no-op until bootstrap configures a reporter', () => {
    configureTimeoutReporter(null);
    expect(() => reportTimeout({ kind: 'http', elapsedMs: 1, limitMs: 1, recovered: false })).not.toThrow();
    configureTimeoutReporter(reporter);
    reportTimeout({ kind: 'http', elapsedMs: 1, limitMs: 1, recovered: false });
    configureTimeoutReporter(null);
    expect(alerts).toHaveLength(1);
  });

  test('a queue that times out on its own while pushing does not recurse and loses no count', () => {
    let nested: TimeoutReporter | null = null;
    let pushes = 0;
    nested = new TimeoutReporter(
      (text, source) => {
        pushes++;
        alerts.push({ text, source });
        // The queue itself timed out: that is reported through the same reporter, mid-push.
        nested?.report({ kind: 'db_busy', elapsedMs: 5_000, limitMs: 5_000, recovered: false });
      },
      () => clock,
      (fn, delayMs) => flushes.push({ fn, delayMs }),
    );
    nested.report({ kind: 'db_busy', elapsedMs: 5_000, limitMs: 5_000, recovered: false });
    expect(pushes).toBe(1);

    // The mid-push timeout was counted and goes out when the window ends.
    clock += TIMEOUT_ALERT_WINDOW_MS;
    flushes.at(-1)?.fn();
    expect(pushes).toBe(2);
    expect(alerts[1]?.text).toContain('unrecovered=1 recovered=0');
  });

  test('a recovered timeout after an unrecovered one does not hide it: the alert describes the unrecovered one', () => {
    reporter.report({ kind: 'provider', elapsedMs: 8_000, limitMs: 8_000, recovered: true });
    clock += 1_000;
    reporter.report({ kind: 'provider', requestId: 'req-bad', elapsedMs: 9_000, limitMs: 8_000, recovered: false });
    clock += 1_000;
    reporter.report({ kind: 'provider', requestId: 'req-ok', elapsedMs: 8_000, limitMs: 8_000, recovered: true });

    clock += TIMEOUT_ALERT_WINDOW_MS;
    flushes[0]?.fn();
    expect(alerts).toHaveLength(2);
    expect(alerts[1]?.text).toContain('requestId: req-bad');
    expect(alerts[1]?.text).toContain('unrecovered=1 recovered=1');
  });

  test('a refusing queue is not hit again by new timeouts before the retry delay, nor beyond the attempt bound', () => {
    let attempts = 0;
    const locked = new TimeoutReporter(
      () => {
        attempts++;
        throw new Error('database is locked');
      },
      () => clock,
      (fn, delayMs) => flushes.push({ fn, delayMs }),
    );
    for (let i = 0; i < 20; i++) {
      clock += 1;
      locked.report({ kind: 'db_busy', elapsedMs: 5_000, limitMs: 5_000, recovered: false });
    }
    expect(attempts).toBe(1);

    // Drive the retries: each is one attempt, spaced by the retry delay, and the bound holds.
    for (let round = 0; round < 8 && flushes.length > 0; round++) {
      clock += TIMEOUT_ALERT_RETRY_MS;
      flushes.shift()?.fn();
      for (let i = 0; i < 5; i++) {
        clock += 1;
        locked.report({ kind: 'db_busy', elapsedMs: 5_000, limitMs: 5_000, recovered: false });
      }
    }
    expect(attempts).toBe(MAX_PUSH_ATTEMPTS);
  });

  test('a timeout held back in the window is flushed when the window ends, even if nothing else follows', () => {
    reporter.report({ kind: 'provider', elapsedMs: 8_000, limitMs: 8_000, recovered: true });
    clock += 1_000;
    reporter.report({ kind: 'provider', requestId: 'req-9', elapsedMs: 9_000, limitMs: 8_000, recovered: false });
    expect(alerts).toHaveLength(1);
    expect(flushes).toHaveLength(1);
    expect(flushes[0]?.delayMs).toBe(TIMEOUT_ALERT_WINDOW_MS - 1_000);

    clock += TIMEOUT_ALERT_WINDOW_MS - 1_000;
    flushes[0]?.fn();
    expect(alerts).toHaveLength(2);
    expect(alerts[1]?.text).toContain('requestId: req-9');
    expect(alerts[1]?.text).toContain('unrecovered=1 recovered=0');

    // The flush emptied the window: another flush is not scheduled for nothing.
    flushes[0]?.fn();
    expect(alerts).toHaveLength(2);
  });

  test('a lone incident is not lost when the queue stays refusing: it is retried each window and sent on recovery', () => {
    let refusing = true;
    let attempts = 0;
    const queue = new TimeoutReporter(
      (text, source) => {
        attempts++;
        if (refusing) throw new Error('database is locked');
        alerts.push({ text, source });
      },
      () => clock,
      (fn, delayMs) => flushes.push({ fn, delayMs }),
    );
    queue.report({ kind: 'render', requestId: 'req-lone', elapsedMs: 45_000, limitMs: 45_000, recovered: false });
    for (let attempt = 1; attempt < MAX_PUSH_ATTEMPTS; attempt++) {
      expect(flushes.at(-1)?.delayMs).toBe(TIMEOUT_ALERT_RETRY_MS);
      clock += TIMEOUT_ALERT_RETRY_MS;
      flushes.shift()?.fn();
    }
    expect(attempts).toBe(MAX_PUSH_ATTEMPTS);
    // Given up for now, not for good: the next try is a window away and the incident is still held.
    expect(flushes).toHaveLength(1);
    expect(flushes[0]?.delayMs).toBe(TIMEOUT_ALERT_WINDOW_MS);

    refusing = false;
    clock += TIMEOUT_ALERT_WINDOW_MS;
    flushes.shift()?.fn();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.text).toContain('requestId: req-lone');
    expect(alerts[0]?.text).toContain('unrecovered=1 recovered=0');
  });

  test('a refusing queue delays every kind, not only the one that hit it', () => {
    let attempts = 0;
    const queue = new TimeoutReporter(
      () => {
        attempts++;
        throw new Error('database is locked');
      },
      () => clock,
      (fn, delayMs) => flushes.push({ fn, delayMs }),
    );
    for (const kind of ['render', 'provider', 'validator', 'http']) {
      queue.report({ kind, elapsedMs: 1, limitMs: 1, recovered: false });
    }
    // The first refusal set the shared backoff: the other kinds wait instead of each hitting the queue.
    expect(attempts).toBe(1);
    expect(flushes.every((flush) => flush.delayMs <= TIMEOUT_ALERT_RETRY_MS)).toBe(true);
  });

  test('a recovered timeout that arrives while an unrecovered one is being pushed still gets its own alert', () => {
    let queue: TimeoutReporter | null = null;
    let pushes = 0;
    queue = new TimeoutReporter(
      (text, source) => {
        pushes++;
        alerts.push({ text, source });
        if (pushes === 1) {
          queue?.report({ kind: 'provider', requestId: 'req-ok', elapsedMs: 8_000, limitMs: 8_000, recovered: true });
        }
      },
      () => clock,
      (fn, delayMs) => flushes.push({ fn, delayMs }),
    );
    queue.report({ kind: 'provider', requestId: 'req-bad', elapsedMs: 9_000, limitMs: 8_000, recovered: false });
    expect(pushes).toBe(1);
    expect(flushes).toHaveLength(1);

    clock += TIMEOUT_ALERT_WINDOW_MS;
    flushes[0]?.fn();
    expect(pushes).toBe(2);
    expect(alerts[1]?.text).toContain('requestId: req-ok');
    expect(alerts[1]?.text).toContain('unrecovered=0 recovered=1');
  });

  test('flush sends what the window still holds, once, and nothing when nothing is held', () => {
    reporter.flush();
    expect(alerts).toHaveLength(0);

    reporter.report({ kind: 'provider', elapsedMs: 8_000, limitMs: 8_000, recovered: true });
    clock += 1_000;
    reporter.report({ kind: 'provider', requestId: 'req-9', elapsedMs: 9_000, limitMs: 8_000, recovered: false });
    reporter.report({ kind: 'render', requestId: 'req-r', elapsedMs: 45_000, limitMs: 45_000, recovered: false });
    expect(alerts).toHaveLength(2);

    expect(reporter.flush()).toEqual([]);
    expect(alerts).toHaveLength(3);
    expect(alerts[2]?.text).toContain('requestId: req-9');
    expect(alerts[2]?.text).toContain('unrecovered=1 recovered=0');

    expect(reporter.flush()).toEqual([]);
    expect(alerts).toHaveLength(3);
  });

  test('flush stops at the first refusal instead of hitting a locked queue once per kind', () => {
    let attempts = 0;
    let refusing = false;
    const queue = new TimeoutReporter(
      () => {
        attempts++;
        if (refusing) throw new Error('database is locked');
      },
      () => clock,
      (fn, delayMs) => flushes.push({ fn, delayMs }),
    );
    for (const kind of ['render', 'provider', 'validator']) {
      queue.report({ kind, elapsedMs: 1, limitMs: 1, recovered: true });
      queue.report({ kind, elapsedMs: 1, limitMs: 1, recovered: false });
    }
    expect(attempts).toBe(3);

    refusing = true;
    const unsent = queue.flush();
    expect(attempts).toBe(4);
    // Every kind still holds its incident, and shutdown is told which, with the counts.
    expect(unsent).toEqual([
      'render unrecovered=1 recovered=0',
      'provider unrecovered=1 recovered=0',
      'validator unrecovered=1 recovered=0',
    ]);
  });
});
