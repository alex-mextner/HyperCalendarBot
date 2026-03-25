import { describe, expect, mock, test } from 'bun:test';

let capturedProcessor: ((job: { data: { type: string } }) => Promise<void>) | null = null;
let capturedAddCalls: Array<[string, { type: string }, { repeat?: { every: number }; jobId?: string }]> = [];

mock.module('bullmq', () => {
  return {
    Queue: class {
      add = mock((...args: unknown[]) => {
        capturedAddCalls.push(args as [string, { type: string }, { repeat?: { every: number }; jobId?: string }]);
        return Promise.resolve();
      });
    },
    Worker: class {
      on = mock(() => {});

      constructor(_name: string, processor: (job: { data: { type: string } }) => Promise<void>) {
        capturedProcessor = processor;
      }
    },
  };
});

const {
  createBotTasksQueue,
  setupSharingCleanupCron,
  setupSecretaryExpiryCron,
  setupProposalExpiryCron,
  setupSessionCleanupCron,
  setupBirthdaySyncCron,
} = await import('../../src/worker/bot-tasks-queue.ts');

import type { BotTaskJobType } from '../../src/worker/bot-tasks-queue.ts';

describe('BotTaskJobType', () => {
  test('all expected job types are valid BotTaskJobType values', () => {
    const types: BotTaskJobType[] = [
      'cron-secretary-expiry',
      'cron-sharing-cleanup',
      'cron-proposal-expiry',
      'cron-session-cleanup',
      'cron-birthday-sync',
    ];
    expect(types).toHaveLength(5);
    for (const t of types) {
      expect(typeof t).toBe('string');
    }
  });
});

describe('createBotTasksQueue', () => {
  test('returns queue and worker', () => {
    const result = createBotTasksQueue({ redisUrl: 'redis://localhost:6379' });
    expect(result).toHaveProperty('queue');
    expect(result).toHaveProperty('worker');
  });

  test('worker dispatches cron-secretary-expiry to onSecretaryExpiry callback', async () => {
    const onSecretaryExpiry = mock(() => Promise.resolve());
    createBotTasksQueue({ redisUrl: 'redis://localhost:6379', onSecretaryExpiry });

    expect(capturedProcessor).not.toBeNull();
    await capturedProcessor!({ data: { type: 'cron-secretary-expiry' } });
    expect(onSecretaryExpiry).toHaveBeenCalledTimes(1);
  });

  test('worker dispatches cron-sharing-cleanup to onSharingCleanup callback', async () => {
    const onSharingCleanup = mock(() => {});
    createBotTasksQueue({ redisUrl: 'redis://localhost:6379', onSharingCleanup });

    expect(capturedProcessor).not.toBeNull();
    await capturedProcessor!({ data: { type: 'cron-sharing-cleanup' } });
    expect(onSharingCleanup).toHaveBeenCalledTimes(1);
  });

  test('worker dispatches cron-proposal-expiry to onProposalExpiry callback', async () => {
    const onProposalExpiry = mock(() => Promise.resolve());
    createBotTasksQueue({ redisUrl: 'redis://localhost:6379', onProposalExpiry });

    expect(capturedProcessor).not.toBeNull();
    await capturedProcessor!({ data: { type: 'cron-proposal-expiry' } });
    expect(onProposalExpiry).toHaveBeenCalledTimes(1);
  });

  test('worker dispatches cron-session-cleanup to onSessionCleanup callback', async () => {
    const onSessionCleanup = mock(() => {});
    createBotTasksQueue({ redisUrl: 'redis://localhost:6379', onSessionCleanup });

    expect(capturedProcessor).not.toBeNull();
    await capturedProcessor!({ data: { type: 'cron-session-cleanup' } });
    expect(onSessionCleanup).toHaveBeenCalledTimes(1);
  });

  test('worker dispatches cron-birthday-sync to onBirthdaySync callback', async () => {
    const onBirthdaySync = mock(() => Promise.resolve());
    createBotTasksQueue({ redisUrl: 'redis://localhost:6379', onBirthdaySync });

    expect(capturedProcessor).not.toBeNull();
    await capturedProcessor!({ data: { type: 'cron-birthday-sync' } });
    expect(onBirthdaySync).toHaveBeenCalledTimes(1);
  });

  test('worker does nothing when callback is not provided', async () => {
    createBotTasksQueue({ redisUrl: 'redis://localhost:6379' });

    expect(capturedProcessor).not.toBeNull();
    // Should not throw when callback is undefined
    await capturedProcessor!({ data: { type: 'cron-secretary-expiry' } });
    await capturedProcessor!({ data: { type: 'cron-sharing-cleanup' } });
    await capturedProcessor!({ data: { type: 'cron-proposal-expiry' } });
  });
});

describe('setup cron functions', () => {
  test('setupSharingCleanupCron adds job with 10min repeat', async () => {
    capturedAddCalls = [];
    const { queue } = createBotTasksQueue({ redisUrl: 'redis://localhost:6379' });
    await setupSharingCleanupCron(queue);

    const lastCall = capturedAddCalls[capturedAddCalls.length - 1]!;
    expect(lastCall).toBeDefined();
    expect(lastCall[1].type).toBe('cron-sharing-cleanup');
    expect(lastCall[2].repeat?.every).toBe(10 * 60_000);
    expect(lastCall[2].jobId).toBe('sharing-cleanup-tick');
  });

  test('setupSecretaryExpiryCron adds job with daily repeat', async () => {
    capturedAddCalls = [];
    const { queue } = createBotTasksQueue({ redisUrl: 'redis://localhost:6379' });
    await setupSecretaryExpiryCron(queue);

    const lastCall = capturedAddCalls[capturedAddCalls.length - 1]!;
    expect(lastCall).toBeDefined();
    expect(lastCall[1].type).toBe('cron-secretary-expiry');
    expect(lastCall[2].repeat?.every).toBe(24 * 60 * 60_000);
    expect(lastCall[2].jobId).toBe('secretary-expiry-tick');
  });

  test('setupProposalExpiryCron adds job with hourly repeat', async () => {
    capturedAddCalls = [];
    const { queue } = createBotTasksQueue({ redisUrl: 'redis://localhost:6379' });
    await setupProposalExpiryCron(queue);

    const lastCall = capturedAddCalls[capturedAddCalls.length - 1]!;
    expect(lastCall).toBeDefined();
    expect(lastCall[1].type).toBe('cron-proposal-expiry');
    expect(lastCall[2].repeat?.every).toBe(60 * 60_000);
    expect(lastCall[2].jobId).toBe('proposal-expiry-tick');
  });

  test('setupSessionCleanupCron adds job with monthly repeat', async () => {
    capturedAddCalls = [];
    const { queue } = createBotTasksQueue({ redisUrl: 'redis://localhost:6379' });
    await setupSessionCleanupCron(queue);

    const lastCall = capturedAddCalls[capturedAddCalls.length - 1]!;
    expect(lastCall).toBeDefined();
    expect(lastCall[1].type).toBe('cron-session-cleanup');
    expect(lastCall[2].repeat?.every).toBe(30 * 24 * 60 * 60_000);
    expect(lastCall[2].jobId).toBe('session-cleanup-tick');
  });

  test('setupBirthdaySyncCron adds job with daily repeat', async () => {
    capturedAddCalls = [];
    const { queue } = createBotTasksQueue({ redisUrl: 'redis://localhost:6379' });
    await setupBirthdaySyncCron(queue);

    const lastCall = capturedAddCalls[capturedAddCalls.length - 1]!;
    expect(lastCall).toBeDefined();
    expect(lastCall[1].type).toBe('cron-birthday-sync');
    expect(lastCall[2].repeat?.every).toBe(24 * 60 * 60_000);
    expect(lastCall[2].jobId).toBe('birthday-sync-tick');
  });
});
