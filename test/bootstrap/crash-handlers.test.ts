import { describe, expect, test } from 'bun:test';
import { createCrashHandlers, isTransientAbort } from '../../src/bootstrap/crash-handlers.ts';
import { FAKE_GETME_URL, FAKE_TELEGRAM_TOKEN, SECRET_FRAGMENTS } from '../helpers/fake-secrets.ts';

interface LogCall {
  level: 'fatal' | 'warn';
  message: string;
}

function harness() {
  const logs: LogCall[] = [];
  const exits: number[] = [];
  const alerts: string[] = [];
  const handlers = createCrashHandlers({
    logger: {
      fatal: (_obj: unknown, message: string) => logs.push({ level: 'fatal', message }),
      warn: (_obj: unknown, message: string) => logs.push({ level: 'warn', message }),
    },
    exit: (code) => exits.push(code),
  });
  return { logs, exits, alerts, handlers };
}

describe('isTransientAbort', () => {
  test('matches an AbortError by name', () => {
    const err = new Error('x');
    err.name = 'AbortError';
    expect(isTransientAbort(err)).toBe(true);
  });

  test('matches the Bun "connection was closed" message', () => {
    expect(isTransientAbort(new Error('The connection was closed unexpectedly'))).toBe(true);
  });

  test('does not match other errors', () => {
    expect(isTransientAbort(new Error('boom'))).toBe(false);
  });
});

describe('createCrashHandlers', () => {
  test('an uncaught exception logs fatal, pushes the stack to the alert sink and exits 1', () => {
    const { logs, exits, alerts, handlers } = harness();
    handlers.setAlertSink((msg) => alerts.push(msg));
    const error = new Error('kaput');

    handlers.onUncaughtException(error);

    expect(logs).toEqual([{ level: 'fatal', message: 'Uncaught exception' }]);
    expect(alerts).toEqual([`Bot crashed: ${error.stack}`]);
    expect(exits).toEqual([1]);
  });

  test('a crash before the alert sink exists still logs and exits 1', () => {
    const { logs, exits, handlers } = harness();
    handlers.onUncaughtException(new Error('early'));
    expect(logs).toHaveLength(1);
    expect(exits).toEqual([1]);
  });

  test('an unhandled rejection with a non-Error reason is wrapped, alerted and fatal', () => {
    const { logs, exits, alerts, handlers } = harness();
    handlers.setAlertSink((msg) => alerts.push(msg));

    handlers.onUnhandledRejection('plain string');

    expect(logs).toEqual([{ level: 'fatal', message: 'Unhandled promise rejection' }]);
    expect(alerts[0]).toStartWith('Bot unhandled rejection: Error: plain string');
    expect(exits).toEqual([1]);
  });

  test('a transient AbortError is logged at warn and the process survives', () => {
    const { logs, exits, alerts, handlers } = harness();
    handlers.setAlertSink((msg) => alerts.push(msg));

    handlers.onUnhandledRejection(new Error('The connection was closed'));

    expect(logs).toEqual([{ level: 'warn', message: 'Transient AbortError (not crashing)' }]);
    expect(alerts).toEqual([]);
    expect(exits).toEqual([]);
  });

  test('the alert sink can be disarmed', () => {
    const { alerts, handlers } = harness();
    handlers.setAlertSink((msg) => alerts.push(msg));
    handlers.setAlertSink(undefined);
    handlers.onUncaughtException(new Error('x'));
    expect(alerts).toEqual([]);
  });
});

describe('alertFatal (#972)', () => {
  test('raises a redacted alert without exiting, so the caller can run the graceful shutdown first', () => {
    const { logs, exits, alerts, handlers } = harness();
    handlers.setAlertSink((msg) => alerts.push(msg));
    const failure = new Error(`Telegram start failed after 8 attempts: TypeError ECONNRESET ${FAKE_GETME_URL}`);

    handlers.alertFatal(failure);

    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toStartWith('Bot failed to start: ');
    expect(alerts[0]).toContain('ECONNRESET');
    expect(alerts[0]).not.toContain(FAKE_TELEGRAM_TOKEN);
    expect(exits).toEqual([]);
    expect(logs).toEqual([]);
  });

  test('without an alert sink it does nothing', () => {
    const { exits, handlers } = harness();
    handlers.alertFatal(new Error('x'));
    expect(exits).toEqual([]);
  });
});

describe('crash alerts carry no secrets (#972)', () => {
  /** What Bun's fetch throws on a reset: the URL, bot token included, sits in `path` and often in the stack text. */
  function resetWithToken(): Error {
    const err = Object.assign(new TypeError(`ECONNRESET: request to ${FAKE_GETME_URL} was closed`), {
      code: 'ECONNRESET',
      path: FAKE_GETME_URL,
    });
    err.stack = `TypeError: ECONNRESET\n    at fetch (${FAKE_GETME_URL}:1:1)`;
    return err;
  }

  test('an unhandled rejection pushes an alert without the bot token in the message or the stack', () => {
    const { alerts, handlers } = harness();
    handlers.setAlertSink((msg) => alerts.push(msg));

    handlers.onUnhandledRejection(resetWithToken());

    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toStartWith('Bot unhandled rejection: ');
    expect(alerts[0]).not.toContain(FAKE_TELEGRAM_TOKEN);
    for (const fragment of SECRET_FRAGMENTS) expect(alerts[0]).not.toContain(fragment);
    expect(alerts[0]).toContain('ECONNRESET');
  });

  test('an uncaught exception pushes an alert without the bot token', () => {
    const { alerts, handlers } = harness();
    handlers.setAlertSink((msg) => alerts.push(msg));

    handlers.onUncaughtException(resetWithToken());

    expect(alerts[0]).toStartWith('Bot crashed: ');
    expect(alerts[0]).not.toContain(FAKE_TELEGRAM_TOKEN);
  });
});
