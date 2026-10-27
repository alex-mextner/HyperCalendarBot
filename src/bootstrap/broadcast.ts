// src/bootstrap/broadcast.ts
//
// Startup phase: the admin/group broadcast queue, split in two on purpose.
//
// Ordering invariants:
//  - createBroadcastInfra() runs EARLY: the enqueuer is an input to createBot() (tool handlers use
//    it), so the queue and its Redis connection must exist first. It never sends anything.
//  - infra.startWorker() runs only AFTER createBot() and patchBotRef(): the worker sends through the
//    real bot API from its first job on, so no "bot not initialised yet" guard is needed.

import type { EnvConfig } from '../config/env.ts';
import { botLogger } from '../utils/logger.ts';
import type { BroadcastEnqueuer } from '../worker/broadcast-queue.ts';
import { createBroadcastSender, type TelegramSendApi } from './bot-ref.ts';
import { createBroadcastRedis } from './redis-adapters.ts';
import type { StartupContext } from './runtime.ts';

export interface BroadcastInfra {
  enqueuer: BroadcastEnqueuer;
  startWorker(ctx: StartupContext, api: TelegramSendApi): void;
}

export async function createBroadcastInfra(config: Pick<EnvConfig, 'REDIS_URL'>): Promise<BroadcastInfra> {
  const { createBroadcastQueue, createBroadcastWorker } = await import('../worker/broadcast-queue.ts');
  const { parseRedisUrl } = await import('../utils/redis.ts');
  const connection = parseRedisUrl(config.REDIS_URL);
  const redisClient = new Bun.RedisClient(config.REDIS_URL);
  const redis = createBroadcastRedis(redisClient);
  const { queue, enqueuer } = createBroadcastQueue(connection, redis);

  return {
    enqueuer,
    startWorker(ctx, api) {
      const worker = createBroadcastWorker(connection, createBroadcastSender(api), redis);
      worker.on('failed', ctx.onWorkerFailed('broadcast-notification'));

      ctx.resources.broadcastQueue = {
        close: async () => {
          await worker.close();
          await queue.close();
          await redisClient.close();
        },
      };

      botLogger.info('Broadcast notification queue initialized');
    },
  };
}
