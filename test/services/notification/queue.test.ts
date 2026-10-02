// Queue factories inject offline BullMQ boundaries while running the real notification processor.
import { Database } from 'bun:sqlite';
import { expect, mock, test } from 'bun:test';
import type { QueueOptions, WorkerOptions } from 'bullmq';
import { Job, Queue, Worker } from 'bullmq';
import { NotificationLogRepository } from '../../../src/database/repositories/notification-log.repository.ts';
import {
  createNotificationQueue,
  createNotificationWorker,
  setupNotificationTick,
} from '../../../src/services/notification/queue.ts';
import type { NotificationJobData } from '../../../src/services/notification/worker.ts';

function fixture() {
  const db = new Database(':memory:');
  db.run(
    `CREATE TABLE notification_log (id INTEGER PRIMARY KEY, user_id INTEGER, type TEXT, reference_key TEXT, status TEXT, channel TEXT, payload TEXT, error TEXT, attempts INTEGER DEFAULT 0, created_at TEXT, sent_at TEXT)`,
  );
  db.run("INSERT INTO notification_log (id,user_id,type,status,payload) VALUES (1,42,'test','queued','Hello')");
  const repo = new NotificationLogRepository(db);
  const send = mock(async (_id: number, _text: string) => {});
  let processJob: (job: Job<NotificationJobData>, token?: string) => Promise<void> = async () => {
    throw new Error('worker not created');
  };
  let failed: (job: Job<NotificationJobData> | undefined, error: Error) => void = () => {
    throw new Error('listener not installed');
  };
  const worker = Object.create(Worker.prototype) as Worker<NotificationJobData>;
  worker.on = ((event: string, callback: typeof failed) => {
    expect(event).toBe('failed');
    failed = callback;
    return worker;
  }) as typeof worker.on;
  const createWorker = mock((name: string, processor: typeof processJob, options: WorkerOptions) => {
    expect(name).toBe('notifications');
    expect(options).toMatchObject({
      connection: { host: 'offline.invalid', port: 6379 },
      concurrency: 5,
      limiter: { max: 20, duration: 1000 },
    });
    processJob = processor;
    return worker;
  });
  createNotificationWorker('redis://offline.invalid:6379', repo, send, undefined, createWorker);
  const data = { logId: 1, telegramId: 42, type: 'test', payload: '{}' };
  const job = Object.assign(Object.create(Job.prototype) as Job<NotificationJobData>, {
    name: 'notification',
    data,
    attemptsMade: 1,
    opts: { attempts: 3 },
    moveToDelayed: mock(async (_timestamp: number, _token?: string) => {}),
  });
  return {
    db,
    repo,
    send,
    job,
    run: (token?: string) => processJob(job, token),
    fail: (error: Error) => failed(job, error),
  };
}

test('queue creation configures retries and minute tick without opening Redis', async () => {
  const queue = Object.create(Queue.prototype) as Queue;
  const add = mock(async () => Object.create(Job.prototype) as Job);
  queue.add = add;
  const createQueue = mock((_name: string, _options: QueueOptions) => queue);
  expect(createNotificationQueue('redis://offline.invalid:6380', createQueue)).toBe(queue);
  expect(createQueue).toHaveBeenCalledWith(
    'notifications',
    expect.objectContaining({
      connection: { host: 'offline.invalid', port: 6380 },
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 30000 },
        removeOnComplete: { age: 86400 },
        removeOnFail: { age: 604800 },
      },
    }),
  );
  await setupNotificationTick(queue);
  expect(add).toHaveBeenCalledWith('tick', {}, { repeat: { every: 60000 }, removeOnComplete: true });
});

test('worker sends real repository payload once and records success', async () => {
  const f = fixture();
  try {
    await f.run();
    expect(f.send).toHaveBeenCalledWith(42, 'Hello');
    expect(f.repo.getById(1)?.status).toBe('sent');
    await f.run();
    expect(f.send).toHaveBeenCalledTimes(1);
  } finally {
    f.db.close();
  }
});

test('rate limit delays with lock token; blocked user is terminal; other failures retry', async () => {
  for (const code of [429, 403, 500]) {
    const f = fixture();
    try {
      f.send.mockImplementation(async () => {
        throw Object.assign(new Error('delivery failed'), { code, payload: { retry_after: 7 } });
      });
      if (code === 403) {
        await f.run('lock');
        expect(f.repo.getById(1)?.status).toBe('failed');
        expect(f.repo.getById(1)?.error).toBe('Bot blocked by user');
      } else {
        const before = Date.now();
        await expect(f.run('lock')).rejects.toThrow(code === 429 ? 'bullmq:movedToDelayed' : 'delivery failed');
        if (code === 429) {
          const [timestamp, token] = f.job.moveToDelayed.mock.calls[0]!;
          expect(timestamp).toBeGreaterThanOrEqual(before + 7000);
          expect(timestamp).toBeLessThanOrEqual(Date.now() + 7000);
          expect(token).toBe('lock');
        } else expect(f.job.moveToDelayed).not.toHaveBeenCalled();
        expect(f.repo.getById(1)?.status).toBe('queued');
      }
    } finally {
      f.db.close();
    }
  }
});

test('failure listener records attempts and final failure at configured retry limit', () => {
  const f = fixture();
  try {
    f.fail(new Error('first failure'));
    expect(f.repo.getById(1)).toMatchObject({ status: 'queued', attempts: 1, error: 'first failure' });
    f.job.attemptsMade = 3;
    f.fail(new Error('last failure'));
    expect(f.repo.getById(1)).toMatchObject({ status: 'failed', attempts: 3, error: 'last failure' });
  } finally {
    f.db.close();
  }
});
