import { describe, expect, mock, test } from 'bun:test';
import type { Queue } from 'bullmq';
import type { GoogleSyncRepository } from '../../../src/database/repositories/google-sync.repository.ts';
import { enqueueStartupReconcile } from '../../../src/services/google/sync-cron.ts';
import type { GoogleSyncJobData } from '../../../src/services/google/sync-queue.ts';

describe('enqueueStartupReconcile', () => {
  test('enqueues one reconcile job per connected user, each with its own job id', async () => {
    const add = mock(async () => ({}));
    const queue = { add } as unknown as Queue<GoogleSyncJobData>;
    const syncRepo = { getActiveUsers: () => [11, 22] } as unknown as GoogleSyncRepository;

    const enqueued = await enqueueStartupReconcile(queue, syncRepo);

    expect(enqueued).toBe(2);
    const calls = add.mock.calls as unknown as [string, GoogleSyncJobData, { jobId: string }][];
    expect(calls.map(([name, data]) => [name, data.type, data.userId])).toEqual([
      ['reconcile-sync', 'reconcile-sync', 11],
      ['reconcile-sync', 'reconcile-sync', 22],
    ]);
    // No calendar id: the worker reconciles every enabled calendar of the user.
    expect(calls.every(([, data]) => data.calendarId === undefined)).toBe(true);
    expect(new Set(calls.map(([, , opts]) => opts.jobId)).size).toBe(2);
  });

  test('enqueues nothing when nobody is connected', async () => {
    const add = mock(async () => ({}));
    const queue = { add } as unknown as Queue<GoogleSyncJobData>;
    const syncRepo = { getActiveUsers: () => [] } as unknown as GoogleSyncRepository;

    expect(await enqueueStartupReconcile(queue, syncRepo)).toBe(0);
    expect(add).not.toHaveBeenCalled();
  });
});
