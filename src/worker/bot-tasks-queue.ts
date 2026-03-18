import { Queue, Worker } from 'bullmq';
import { logger } from '../utils/logger.ts';
import { parseRedisUrl } from '../utils/redis.ts';

const botTasksLogger = logger.child({ module: 'bot-tasks' });

export type BotTaskJobType = 'cron-secretary-expiry';

export interface BotTaskJobData {
  type: BotTaskJobType;
}

interface BotTasksQueueDeps {
  redisUrl: string;
  onSecretaryExpiry?: () => Promise<void>;
}

export function createBotTasksQueue(deps: BotTasksQueueDeps) {
  const connection = parseRedisUrl(deps.redisUrl);

  const queue = new Queue<BotTaskJobData>('bot-tasks', {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 10_000 },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500 },
    },
  });

  const worker = new Worker<BotTaskJobData>(
    'bot-tasks',
    async (job) => {
      if (job.data.type === 'cron-secretary-expiry') {
        if (deps.onSecretaryExpiry) await deps.onSecretaryExpiry();
        return;
      }
    },
    { connection, concurrency: 1 },
  );

  worker.on('failed', (job, err) => {
    if (!job) return;
    botTasksLogger.error({ jobId: job.id, type: job.data.type, error: err.message }, 'Bot task job failed');
  });

  return { queue, worker };
}

export async function setupSecretaryExpiryCron(queue: Queue<BotTaskJobData>): Promise<void> {
  await queue.add(
    'secretary-expiry-tick',
    { type: 'cron-secretary-expiry' },
    { repeat: { every: 24 * 60 * 60_000 }, removeOnComplete: true, jobId: 'secretary-expiry-tick' },
  );
  botTasksLogger.info('Secretary expiry cron scheduled (daily)');
}
