// src/worker/broadcast-queue.ts
//
// Broadcast notification queue — dedicated BullMQ queue for fan-out delivery
// to many recipients (group event notifications, notify_participants).
//
// Rationale: handlers like sendGroupNotifications / handleNotifyParticipants
// previously shipped messages fire-and-forget which silently hid per-recipient
// failures AND blocked the AI agent from returning a truthful tool result. A
// naive sync `for await` would block tool handlers for multiple seconds in
// groups >10 and eventually trip Telegram's 30 msg/sec global rate limit.
//
// The queue:
//   * one job per recipient (natural retry granularity, no partial-batch pain)
//   * worker uses BullMQ `limiter: { max: 20, duration: 1000 }` — hard-capped
//     to 20 msg/sec, well under Telegram's 30/sec global ceiling
//   * concurrency: 5 parallel workers so short bursts clear quickly
//   * attempts: 3 with exponential backoff — survives transient 429s
//   * failed jobs retained for 500 runs so admin can inspect via BullMQ UI
//
// Batch failure tracking:
//   When a batch of broadcasts is enqueued, a batch is registered in Redis with
//   the total job count and fallback metadata. On permanent delivery failures
//   (403/400), the worker records the failed recipient's mention in a Redis set.
//   After the last job finishes (success or fail), the worker sends ONE aggregated
//   fallback message to the source group listing all unreachable users.

import { type ConnectionOptions, Queue, Worker } from 'bullmq';
import { parseTelegramError } from '../services/notification/worker.ts';
import { logger } from '../utils/logger.ts';
import type { ParseMode } from '../utils/telegram.ts';

const broadcastLogger = logger.child({ module: 'broadcast' });

const BATCH_KEY_PREFIX = 'broadcast:batch:';
const BATCH_TTL_SECONDS = 3600; // 1 hour — generous ceiling for slow queues

/** Permanent Telegram errors that will never succeed on retry. */
export function isPermanentTelegramError(code: number): boolean {
  // 403 = bot blocked / user hasn't started bot / bot kicked from chat
  // 400 = chat not found / peer_id_invalid / user deactivated
  return code === 403 || code === 400;
}

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

export interface BroadcastJobData {
  /** Target chat (user DM or group chat). */
  recipientId: number;
  /** Already-formatted message text (per-recipient formatting happens at enqueue time). */
  text: string;
  parseMode?: ParseMode;
  /** Free-form origin tag for audit/debugging, e.g. "group_event_created:42". */
  origin: string;
  /** Links this job to a tracked batch for aggregated failure reporting. */
  batchId?: string;
  /** HTML mention of the recipient (e.g. @nick or <a href="tg://user?id=...">Name</a>). */
  recipientMention?: string;
}

export interface BroadcastBatchMeta {
  total: number;
  groupChatId: number;
  threadId?: number;
  /** Pre-formatted invite_deep_link text (without user list). */
  fallbackText: string;
}

export interface BroadcastSender {
  sendMessage(chatId: number, text: string, parseMode?: ParseMode, threadId?: number): Promise<{ message_id: number }>;
}

// ---------------------------------------------------------------------------
// Redis interface for batch tracking (thin wrapper, testable)
// ---------------------------------------------------------------------------

export interface BroadcastRedis {
  set(key: string, value: string, ex: number): Promise<void>;
  get(key: string): Promise<string | null>;
  sadd(key: string, member: string): Promise<void>;
  smembers(key: string): Promise<string[]>;
  incr(key: string): Promise<number>;
  del(...keys: string[]): Promise<void>;
  expire(key: string, seconds: number): Promise<void>;
}

// ---------------------------------------------------------------------------
// Enqueuer
// ---------------------------------------------------------------------------

export interface BroadcastEnqueuer {
  enqueue(data: BroadcastJobData): Promise<void>;
  enqueueBatch(data: BroadcastJobData[]): Promise<void>;
  /** Register a batch for aggregated failure tracking (requires Redis). */
  registerBatch?(batchId: string, meta: BroadcastBatchMeta): Promise<void>;
}

export function createBroadcastQueue(
  connection: ConnectionOptions,
  redis?: BroadcastRedis,
): {
  queue: Queue<BroadcastJobData>;
  enqueuer: BroadcastEnqueuer;
} {
  const queue = new Queue<BroadcastJobData>('broadcast-notification', {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2_000 },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 500 },
    },
  });

  const enqueuer: BroadcastEnqueuer = {
    enqueue: async (data) => {
      await queue.add('broadcast', data);
    },
    enqueueBatch: async (items) => {
      if (items.length === 0) return;
      await queue.addBulk(items.map((data) => ({ name: 'broadcast', data })));
    },
    registerBatch: redis
      ? async (batchId, meta) => {
          const metaKey = `${BATCH_KEY_PREFIX}${batchId}:meta`;
          const doneKey = `${BATCH_KEY_PREFIX}${batchId}:done`;
          await redis.set(metaKey, JSON.stringify(meta), BATCH_TTL_SECONDS);
          await redis.set(doneKey, '0', BATCH_TTL_SECONDS);
        }
      : undefined,
  };

  return { queue, enqueuer };
}

// ---------------------------------------------------------------------------
// Job processor (exported for testability)
// ---------------------------------------------------------------------------

/**
 * Process a single broadcast job: deliver the message, track permanent
 * failures in Redis for batch aggregation, re-throw transient errors.
 */
export async function processBroadcastJob(
  data: BroadcastJobData,
  sender: BroadcastSender,
  redis?: BroadcastRedis,
): Promise<void> {
  const { recipientId, text, parseMode } = data;
  try {
    await sender.sendMessage(recipientId, text, parseMode);
  } catch (err) {
    const tgErr = parseTelegramError(err);
    if (tgErr && isPermanentTelegramError(tgErr.code)) {
      broadcastLogger.warn(
        { recipientId, origin: data.origin, code: tgErr.code },
        'Recipient unreachable (permanent), skipping retries',
      );
      // Track failure for batch aggregation
      if (redis && data.batchId && data.recipientMention) {
        const failKey = `${BATCH_KEY_PREFIX}${data.batchId}:failed`;
        await redis.sadd(failKey, data.recipientMention);
        await redis.expire(failKey, BATCH_TTL_SECONDS);
      }
      return;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Batch completion handler
// ---------------------------------------------------------------------------

/**
 * Increment the done counter for a batch. When all jobs are done, send ONE
 * aggregated fallback to the group listing unreachable users, then cleanup.
 */
export async function completeBatchJob(batchId: string, redis: BroadcastRedis, sender: BroadcastSender): Promise<void> {
  const doneKey = `${BATCH_KEY_PREFIX}${batchId}:done`;
  const metaKey = `${BATCH_KEY_PREFIX}${batchId}:meta`;
  const failKey = `${BATCH_KEY_PREFIX}${batchId}:failed`;

  const done = await redis.incr(doneKey);
  const metaStr = await redis.get(metaKey);
  if (!metaStr) return;

  const meta: BroadcastBatchMeta = JSON.parse(metaStr);
  if (done < meta.total) return;

  // All jobs finished — check for failures
  try {
    const failedMentions = await redis.smembers(failKey);
    if (failedMentions.length > 0) {
      const userList = failedMentions.join(', ');
      const fullMessage = `${userList}\n${meta.fallbackText}`;
      await sender.sendMessage(meta.groupChatId, fullMessage, 'HTML', meta.threadId);
      broadcastLogger.info(
        { batchId, failedCount: failedMentions.length, groupChatId: meta.groupChatId },
        'Batch fallback sent to group',
      );
    }
  } catch (err) {
    broadcastLogger.warn({ err, batchId }, 'Failed to send batch fallback');
  }

  // Cleanup Redis keys
  await redis.del(metaKey, doneKey, failKey).catch(() => {
    // Non-critical — keys expire via TTL anyway
  });
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export function createBroadcastWorker(
  connection: ConnectionOptions,
  sender: BroadcastSender,
  redis?: BroadcastRedis,
): Worker<BroadcastJobData> {
  const worker = new Worker<BroadcastJobData>(
    'broadcast-notification',
    async (job) => {
      broadcastLogger.debug(
        { jobId: job.id, recipientId: job.data.recipientId, origin: job.data.origin },
        'Dispatching broadcast',
      );
      await processBroadcastJob(job.data, sender, redis);
    },
    {
      connection,
      concurrency: 5,
      limiter: { max: 20, duration: 1_000 },
    },
  );

  // Batch tracking: increment done counter after each completed job
  worker.on('completed', (job) => {
    broadcastLogger.debug(
      { jobId: job.id, recipientId: job.data.recipientId, origin: job.data.origin },
      'Broadcast delivered',
    );
    if (redis && job.data.batchId) {
      completeBatchJob(job.data.batchId, redis, sender).catch((err) => {
        broadcastLogger.warn({ err, batchId: job.data.batchId }, 'Batch completion tracking failed');
      });
    }
  });

  // Also track jobs that exhaust all retries (transient errors)
  worker.on('failed', (job, err) => {
    if (!job) return;
    const maxAttempts = job.opts.attempts ?? 3;
    const isExhausted = job.attemptsMade >= maxAttempts;

    if (isExhausted) {
      broadcastLogger.error(
        { jobId: job.id, recipientId: job.data.recipientId, origin: job.data.origin, attempts: job.attemptsMade, err },
        'Broadcast job exhausted retries',
      );
      if (redis && job.data.batchId) {
        // Track as failure (transient errors that never recovered)
        const trackAndComplete = async () => {
          if (job.data.recipientMention) {
            const failKey = `${BATCH_KEY_PREFIX}${job.data.batchId}:failed`;
            await redis.sadd(failKey, job.data.recipientMention);
            await redis.expire(failKey, BATCH_TTL_SECONDS);
          }
          await completeBatchJob(job.data.batchId!, redis, sender);
        };
        trackAndComplete().catch((trackErr) => {
          broadcastLogger.warn({ err: trackErr, batchId: job.data.batchId }, 'Batch failure tracking failed');
        });
      }
    } else {
      broadcastLogger.warn(
        { jobId: job.id, recipientId: job.data.recipientId, origin: job.data.origin, attempts: job.attemptsMade, err },
        'Broadcast job failed (will retry)',
      );
    }
  });

  return worker;
}
