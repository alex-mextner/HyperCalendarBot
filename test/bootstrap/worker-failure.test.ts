import { describe, expect, test } from 'bun:test';
import { createWorkerFailedFactory, type WorkerFailureCollaborators } from '../../src/bootstrap/worker-failure.ts';

interface LogCall {
  level: 'warn' | 'error';
  message: string;
  worker: string;
}

function harness(config: { BOT_ADMIN_ID?: number; ADMIN_ALERT_TOKEN?: string }) {
  const logs: LogCall[] = [];
  const alertHandlerCalls: Array<{ name: string; pushAlert: unknown }> = [];
  const handled: Array<{ jobId: string | undefined; err: Error }> = [];

  const collaborators: WorkerFailureCollaborators = {
    logger: {
      warn: (obj: { worker: string }, message: string) => logs.push({ level: 'warn', message, worker: obj.worker }),
      error: (obj: { worker: string }, message: string) => logs.push({ level: 'error', message, worker: obj.worker }),
    },
    makeAlertHandler: (name, opts) => {
      alertHandlerCalls.push({ name, pushAlert: opts.pushAlert });
      return (job, err) => {
        handled.push({ jobId: job?.id, err });
      };
    },
  };
  const factory = createWorkerFailedFactory(
    {
      config: { BOT_TOKEN: 'tok', BOT_ADMIN_ID: config.BOT_ADMIN_ID, ADMIN_ALERT_TOKEN: config.ADMIN_ALERT_TOKEN },
      pushAlert: () => {},
    },
    collaborators,
  );
  return { factory, logs, alertHandlerCalls, handled };
}

describe('createWorkerFailedFactory', () => {
  test('without BOT_ADMIN_ID it logs only and never builds an alert handler', () => {
    const { factory, logs, alertHandlerCalls, handled } = harness({});
    factory('image-render')({ id: '1' }, new Error('boom'));

    expect(logs).toEqual([{ level: 'error', message: 'Worker job failed', worker: 'image-render' }]);
    expect(alertHandlerCalls).toEqual([]);
    expect(handled).toEqual([]);
  });

  test('an UnrecoverableError is logged at warn, not error', () => {
    const { factory, logs } = harness({});
    const err = new Error('forbidden');
    err.name = 'UnrecoverableError';
    factory('broadcast-notification')({ id: '2' }, err);

    expect(logs).toEqual([
      { level: 'warn', message: 'Worker job permanently failed (no retry)', worker: 'broadcast-notification' },
    ]);
  });

  test('with an admin it forwards the failure to the alert handler', () => {
    const { factory, alertHandlerCalls, handled } = harness({ BOT_ADMIN_ID: 7, ADMIN_ALERT_TOKEN: 'tok' });
    const err = new Error('boom');
    factory('ai-messages')({ id: '9' }, err);

    expect(alertHandlerCalls.map((c) => c.name)).toEqual(['ai-messages']);
    expect(handled).toEqual([{ jobId: '9', err }]);
  });

  test('the alert queue is wired only when ADMIN_ALERT_TOKEN is set', () => {
    const withToken = harness({ BOT_ADMIN_ID: 7, ADMIN_ALERT_TOKEN: 'tok' });
    withToken.factory('bot-tasks');
    expect(typeof withToken.alertHandlerCalls[0]?.pushAlert).toBe('function');

    const withoutToken = harness({ BOT_ADMIN_ID: 7 });
    withoutToken.factory('bot-tasks');
    expect(withoutToken.alertHandlerCalls[0]?.pushAlert).toBeUndefined();
  });

  test('a job-less failure is still reported', () => {
    const { factory, handled } = harness({ BOT_ADMIN_ID: 7 });
    const err = new Error('no job');
    factory('call-reminders')(undefined, err);
    expect(handled).toEqual([{ jobId: undefined, err }]);
  });
});
