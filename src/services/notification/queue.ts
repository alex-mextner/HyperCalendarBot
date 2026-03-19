// src/services/notification/queue.ts
import { Queue, Worker } from 'bullmq';
import type { NotificationLogRepository } from '../../database/repositories/notification-log.repository.ts';
import { notifyLogger } from '../../utils/logger.ts';
import { parseRedisUrl } from '../../utils/redis.ts';
import type { NotificationScheduler } from './scheduler.ts';
import type { NotificationJobData } from './worker.ts';
import { processNotification } from './worker.ts';

export function createNotificationQueue(redisUrl: string) {
  const connection = parseRedisUrl(redisUrl);

  const queue = new Queue('notifications', {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: { age: 86400 },
      removeOnFail: { age: 86400 * 7 },
    },
  });

  return queue;
}

export function createNotificationWorker(
  redisUrl: string,
  logRepo: NotificationLogRepository,
  sendMessage: (telegramId: number, text: string) => Promise<void>,
  scheduler?: NotificationScheduler,
) {
  const connection = parseRedisUrl(redisUrl);

  const worker = new Worker<NotificationJobData>(
    'notifications',
    async (job) => {
      if (job.name === 'tick') {
        if (scheduler) await scheduler.tick(new Date());
        return;
      }
      await processNotification(job.data, logRepo, sendMessage);
    },
    { connection, concurrency: 5 },
  );

  worker.on('failed', (job, err) => {
    if (!job) return;
    notifyLogger.error(
      { jobId: job.id, type: job.data.type, err: err, attempts: job.attemptsMade },
      'Notification job failed',
    );
    if (job.attemptsMade >= (job.opts.attempts ?? 3)) {
      logRepo.markFailed(job.data.logId, err.message, job.attemptsMade);
    } else {
      logRepo.updateAttempts(job.data.logId, err.message, job.attemptsMade);
    }
  });

  return worker;
}

export async function setupNotificationTick(queue: Queue): Promise<void> {
  await queue.add('tick', {}, { repeat: { every: 60_000 }, removeOnComplete: true });
  notifyLogger.info('Notification tick scheduled (every 60s)');
}
