// src/services/notification/queue.ts
import { DelayedError, type Job, Queue, Worker } from 'bullmq';
import type { NotificationLogRepository } from '../../database/repositories/notification-log.repository.ts';
import { notifyLogger } from '../../utils/logger.ts';
import { parseRedisUrl } from '../../utils/redis.ts';
import type { NotificationScheduler } from './scheduler.ts';
import type { NotificationJobData } from './worker.ts';
import { parseTelegramError, processNotification } from './worker.ts';

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

type NotificationJob = Pick<Job<NotificationJobData>, 'name' | 'data' | 'attemptsMade' | 'moveToDelayed'>;

/** Exact processor used by BullMQ, exposed for transport-to-storage regressions. */
export async function processNotificationJob(
  job: NotificationJob,
  logRepo: NotificationLogRepository,
  sendMessage: (telegramId: number, text: string) => Promise<void>,
  token?: string,
  scheduler?: Pick<NotificationScheduler, 'tick'>,
): Promise<void> {
  if (job.name === 'tick') {
    if (scheduler) await scheduler.tick(new Date());
    return;
  }
  try {
    await processNotification(job.data, logRepo, sendMessage);
  } catch (err) {
    const tgErr = parseTelegramError(err);
    if (tgErr?.code === 429) {
      const delay = (tgErr.retryAfter ?? 30) * 1000;
      await job.moveToDelayed(Date.now() + delay, token);
      throw new DelayedError();
    }
    if (tgErr?.code === 403) {
      notifyLogger.warn(
        { logId: job.data.logId, telegramId: job.data.telegramId },
        'Bot blocked by user, dropping notification',
      );
      logRepo.markFailed(job.data.logId, 'Bot blocked by user', job.attemptsMade);
      return;
    }
    throw err;
  }
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
    (job, token) => processNotificationJob(job, logRepo, sendMessage, token, scheduler),
    { connection, concurrency: 5, limiter: { max: 20, duration: 1000 } },
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
