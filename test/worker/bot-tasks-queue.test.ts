import { describe, expect, mock, test } from 'bun:test';

type JobProcessor = (job: { data: { type: string } }) => Promise<void>;
type FailedHandler = (job: { id: string; data: { type: string } } | undefined, err: Error) => void;

let capturedQueueName = '';
let capturedQueueOpts: Record<string, unknown> = {};
let capturedWorkerName = '';
let capturedProcessor: JobProcessor = async () => {};
let capturedWorkerOpts: Record<string, unknown> = {};
let capturedFailedHandler: FailedHandler = () => {};

const mockQueueAdd = mock(async () => {});
const mockWorkerOn = mock((_event: string, handler: FailedHandler) => {
  capturedFailedHandler = handler;
});

mock.module('bullmq', () => ({
  Queue: class MockQueue {
    name: string;
    constructor(name: string, opts: Record<string, unknown>) {
      capturedQueueName = name;
      capturedQueueOpts = opts;
      this.name = name;
    }
    add = mockQueueAdd;
  },
  Worker: class MockWorker {
    constructor(name: string, processor: JobProcessor, opts: Record<string, unknown>) {
      capturedWorkerName = name;
      capturedProcessor = processor;
      capturedWorkerOpts = opts;
    }
    on = mockWorkerOn;
  },
}));

const {
  createBotTasksQueue,
  setupSharingCleanupCron,
  setupSecretaryExpiryCron,
  setupProposalExpiryCron,
  setupSessionCleanupCron,
  setupBirthdaySyncCron,
  setupChatHistoryCleanupCron,
  setupSessionKeepaliveCron,
} = await import('../../src/worker/bot-tasks-queue.ts');

describe('createBotTasksQueue', () => {
  test('returns queue and worker', () => {
    const { queue, worker } = createBotTasksQueue({ redisUrl: 'redis://localhost:6379' });
    expect(queue).toBeDefined();
    expect(worker).toBeDefined();
  });

  test('queue is named bot-tasks', () => {
    createBotTasksQueue({ redisUrl: 'redis://localhost:6379' });
    expect(capturedQueueName).toBe('bot-tasks');
  });

  test('worker is named bot-tasks', () => {
    createBotTasksQueue({ redisUrl: 'redis://localhost:6379' });
    expect(capturedWorkerName).toBe('bot-tasks');
  });

  test('worker runs with concurrency 1', () => {
    createBotTasksQueue({ redisUrl: 'redis://localhost:6379' });
    expect((capturedWorkerOpts as { concurrency: number }).concurrency).toBe(1);
  });

  test('queue default job options have 3 attempts', () => {
    createBotTasksQueue({ redisUrl: 'redis://localhost:6379' });
    const opts = capturedQueueOpts as { defaultJobOptions: { attempts: number } };
    expect(opts.defaultJobOptions.attempts).toBe(3);
  });
});

describe('bot-tasks job processor', () => {
  test('calls onSecretaryExpiry for cron-secretary-expiry', async () => {
    const onSecretaryExpiry = mock(async () => {});
    createBotTasksQueue({ redisUrl: 'redis://localhost:6379', onSecretaryExpiry });
    await capturedProcessor({ data: { type: 'cron-secretary-expiry' } });
    expect(onSecretaryExpiry).toHaveBeenCalledTimes(1);
  });

  test('calls onSharingCleanup for cron-sharing-cleanup', async () => {
    const onSharingCleanup = mock(() => {});
    createBotTasksQueue({ redisUrl: 'redis://localhost:6379', onSharingCleanup });
    await capturedProcessor({ data: { type: 'cron-sharing-cleanup' } });
    expect(onSharingCleanup).toHaveBeenCalledTimes(1);
  });

  test('calls onProposalExpiry for cron-proposal-expiry', async () => {
    const onProposalExpiry = mock(async () => {});
    createBotTasksQueue({ redisUrl: 'redis://localhost:6379', onProposalExpiry });
    await capturedProcessor({ data: { type: 'cron-proposal-expiry' } });
    expect(onProposalExpiry).toHaveBeenCalledTimes(1);
  });

  test('calls onSessionCleanup for cron-session-cleanup', async () => {
    const onSessionCleanup = mock(() => {});
    createBotTasksQueue({ redisUrl: 'redis://localhost:6379', onSessionCleanup });
    await capturedProcessor({ data: { type: 'cron-session-cleanup' } });
    expect(onSessionCleanup).toHaveBeenCalledTimes(1);
  });

  test('calls onBirthdaySync for cron-birthday-sync', async () => {
    const onBirthdaySync = mock(async () => {});
    createBotTasksQueue({ redisUrl: 'redis://localhost:6379', onBirthdaySync });
    await capturedProcessor({ data: { type: 'cron-birthday-sync' } });
    expect(onBirthdaySync).toHaveBeenCalledTimes(1);
  });

  test('calls onChatHistoryCleanup for cron-chat-history-cleanup', async () => {
    const onChatHistoryCleanup = mock(() => {});
    createBotTasksQueue({ redisUrl: 'redis://localhost:6379', onChatHistoryCleanup });
    await capturedProcessor({ data: { type: 'cron-chat-history-cleanup' } });
    expect(onChatHistoryCleanup).toHaveBeenCalledTimes(1);
  });

  test('calls onSessionKeepalive for cron-session-keepalive', async () => {
    const onSessionKeepalive = mock(async () => {});
    createBotTasksQueue({ redisUrl: 'redis://localhost:6379', onSessionKeepalive });
    await capturedProcessor({ data: { type: 'cron-session-keepalive' } });
    expect(onSessionKeepalive).toHaveBeenCalledTimes(1);
  });

  test('does not throw when optional handlers are absent', async () => {
    createBotTasksQueue({ redisUrl: 'redis://localhost:6379' });
    await expect(capturedProcessor({ data: { type: 'cron-secretary-expiry' } })).resolves.toBeUndefined();
    await expect(capturedProcessor({ data: { type: 'cron-sharing-cleanup' } })).resolves.toBeUndefined();
    await expect(capturedProcessor({ data: { type: 'cron-birthday-sync' } })).resolves.toBeUndefined();
    await expect(capturedProcessor({ data: { type: 'cron-chat-history-cleanup' } })).resolves.toBeUndefined();
    await expect(capturedProcessor({ data: { type: 'cron-session-keepalive' } })).resolves.toBeUndefined();
  });

  test('failed handler logs without throwing when job is present', () => {
    createBotTasksQueue({ redisUrl: 'redis://localhost:6379' });
    expect(() =>
      capturedFailedHandler({ id: 'j1', data: { type: 'cron-secretary-expiry' } }, new Error('boom')),
    ).not.toThrow();
  });

  test('failed handler does not throw when job is undefined', () => {
    createBotTasksQueue({ redisUrl: 'redis://localhost:6379' });
    expect(() => capturedFailedHandler(undefined, new Error('no job'))).not.toThrow();
  });
});

describe('cron setup functions', () => {
  test('setupSharingCleanupCron adds job with correct repeat interval', async () => {
    mockQueueAdd.mockClear();
    const { queue } = createBotTasksQueue({ redisUrl: 'redis://localhost:6379' });
    await setupSharingCleanupCron(queue);
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    const [name, data, opts] = mockQueueAdd.mock.calls[0] as unknown as [
      string,
      { type: string },
      { repeat: { every: number }; jobId: string },
    ];
    expect(name).toBe('sharing-cleanup-tick');
    expect(data.type).toBe('cron-sharing-cleanup');
    expect(opts.repeat.every).toBe(10 * 60_000);
    expect(opts.jobId).toBe('sharing-cleanup-tick');
  });

  test('setupSecretaryExpiryCron adds job with daily interval', async () => {
    mockQueueAdd.mockClear();
    const { queue } = createBotTasksQueue({ redisUrl: 'redis://localhost:6379' });
    await setupSecretaryExpiryCron(queue);
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    const [name, data, opts] = mockQueueAdd.mock.calls[0] as unknown as [
      string,
      { type: string },
      { repeat: { every: number }; jobId: string },
    ];
    expect(name).toBe('secretary-expiry-tick');
    expect(data.type).toBe('cron-secretary-expiry');
    expect(opts.repeat.every).toBe(24 * 60 * 60_000);
    expect(opts.jobId).toBe('secretary-expiry-tick');
  });

  test('setupProposalExpiryCron adds job with hourly interval', async () => {
    mockQueueAdd.mockClear();
    const { queue } = createBotTasksQueue({ redisUrl: 'redis://localhost:6379' });
    await setupProposalExpiryCron(queue);
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    const [name, data, opts] = mockQueueAdd.mock.calls[0] as unknown as [
      string,
      { type: string },
      { repeat: { every: number }; jobId: string },
    ];
    expect(name).toBe('proposal-expiry-tick');
    expect(data.type).toBe('cron-proposal-expiry');
    expect(opts.repeat.every).toBe(60 * 60_000);
    expect(opts.jobId).toBe('proposal-expiry-tick');
  });

  test('setupSessionCleanupCron adds job with monthly interval', async () => {
    mockQueueAdd.mockClear();
    const { queue } = createBotTasksQueue({ redisUrl: 'redis://localhost:6379' });
    await setupSessionCleanupCron(queue);
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    const [name, data, opts] = mockQueueAdd.mock.calls[0] as unknown as [
      string,
      { type: string },
      { repeat: { every: number }; jobId: string },
    ];
    expect(name).toBe('session-cleanup-tick');
    expect(data.type).toBe('cron-session-cleanup');
    expect(opts.repeat.every).toBe(30 * 24 * 60 * 60_000);
    expect(opts.jobId).toBe('session-cleanup-tick');
  });

  test('setupBirthdaySyncCron adds job with daily interval', async () => {
    mockQueueAdd.mockClear();
    const { queue } = createBotTasksQueue({ redisUrl: 'redis://localhost:6379' });
    await setupBirthdaySyncCron(queue);
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    const [name, data, opts] = mockQueueAdd.mock.calls[0] as unknown as [
      string,
      { type: string },
      { repeat: { every: number }; jobId: string },
    ];
    expect(name).toBe('birthday-sync-tick');
    expect(data.type).toBe('cron-birthday-sync');
    expect(opts.repeat.every).toBe(24 * 60 * 60_000);
    expect(opts.jobId).toBe('birthday-sync-tick');
  });

  test('setupChatHistoryCleanupCron adds job with daily interval', async () => {
    mockQueueAdd.mockClear();
    const { queue } = createBotTasksQueue({ redisUrl: 'redis://localhost:6379' });
    await setupChatHistoryCleanupCron(queue);
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    const [name, data, opts] = mockQueueAdd.mock.calls[0] as unknown as [
      string,
      { type: string },
      { repeat: { every: number }; jobId: string },
    ];
    expect(name).toBe('chat-history-cleanup-tick');
    expect(data.type).toBe('cron-chat-history-cleanup');
    expect(opts.repeat.every).toBe(24 * 60 * 60_000);
    expect(opts.jobId).toBe('chat-history-cleanup-tick');
  });

  test('setupSessionKeepaliveCron adds job with 14-day interval', async () => {
    mockQueueAdd.mockClear();
    const { queue } = createBotTasksQueue({ redisUrl: 'redis://localhost:6379' });
    await setupSessionKeepaliveCron(queue);
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    const [name, data, opts] = mockQueueAdd.mock.calls[0] as unknown as [
      string,
      { type: string },
      { repeat: { every: number }; jobId: string },
    ];
    expect(name).toBe('session-keepalive-tick');
    expect(data.type).toBe('cron-session-keepalive');
    expect(opts.repeat.every).toBe(14 * 24 * 60 * 60_000);
    expect(opts.jobId).toBe('session-keepalive-tick');
  });
});
