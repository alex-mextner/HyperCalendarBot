import { describe, expect, test } from 'bun:test';
import { createCrashHandlers, isTransientAbort } from '../../src/bootstrap/crash-handlers.ts';

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
