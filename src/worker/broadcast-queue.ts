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

import { type ConnectionOptions, Queue, Worker } from 'bullmq';
import { logger } from '../utils/logger.ts';
import type { ParseMode } from '../utils/telegram.ts';
import { UnrecoverableError } from '../utils/unrecoverable-error.ts';

const broadcastLogger = logger.child({ module: 'broadcast' });

const PERMANENT_TG_CODES = new Set([403, 404]);
const PERMANENT_TG_PATTERNS = [
  "bot can't initiate",
  'bot was blocked',
  'user is deactivated',
  'chat not found',
  'PEER_ID_INVALID',
];

function hasNumericCode(err: Error): err is Error & { code: number } {
  return 'code' in err && typeof err.code === 'number';
}

export function isTelegramPermanentError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (hasNumericCode(err) && PERMANENT_TG_CODES.has(err.code)) return true;
  const msg = err.message.toLowerCase();
  return PERMANENT_TG_PATTERNS.some((p) => msg.includes(p.toLowerCase()));
}

export interface BroadcastJobData {
  /** Target chat (user DM or group chat). */
  recipientId: number;
  /** Already-formatted message text (per-recipient formatting happens at enqueue time). */
  text: string;
  parseMode?: ParseMode;
  /** Free-form origin tag for audit/debugging, e.g. "group_event_created:42". */
  origin: string;
}

export interface BroadcastSender {
  sendMessage(chatId: number, text: string, parseMode?: ParseMode): Promise<{ message_id: number }>;
}

export interface BroadcastEnqueuer {
  /**
   * Enqueue a single per-recipient broadcast job. The caller is responsible
   * for per-recipient formatting (language, timezone, etc.) — the worker
   * dispatches the already-rendered text as-is.
   */
  enqueue(data: BroadcastJobData): Promise<void>;
  /** Enqueue a batch in a single Redis round-trip. Use when fanning out ≥3 jobs. */
  enqueueBatch(data: BroadcastJobData[]): Promise<void>;
}

export function createBroadcastQueue(connection: ConnectionOptions): {
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
  };

  return { queue, enqueuer };
}

export function createBroadcastWorker(
  connection: ConnectionOptions,
  sender: BroadcastSender,
): Worker<BroadcastJobData> {
  const worker = new Worker<BroadcastJobData>(
    'broadcast-notification',
    async (job) => {
      const { recipientId, text, parseMode, origin } = job.data;
      broadcastLogger.debug({ jobId: job.id, recipientId, origin }, 'Dispatching broadcast');
      try {
        await sender.sendMessage(recipientId, text, parseMode);
      } catch (err) {
        if (isTelegramPermanentError(err)) {
          broadcastLogger.warn({ jobId: job.id, recipientId, origin, err }, 'Recipient unreachable — skipping retries');
          throw new UnrecoverableError(err instanceof Error ? err.message : String(err));
        }
        throw err;
      }
    },
    {
      connection,
      concurrency: 5,
      // Telegram global limit is ~30 msg/sec for bots; stay at 20/sec so
      // other outgoing traffic (replies to other users) has headroom.
      limiter: { max: 20, duration: 1_000 },
    },
  );

  worker.on('failed', (job, err) => {
    if (!job) return;
    broadcastLogger.error(
      { jobId: job.id, recipientId: job.data.recipientId, origin: job.data.origin, attempts: job.attemptsMade, err },
      'Broadcast job failed',
    );
  });

  worker.on('completed', (job) => {
    broadcastLogger.debug(
      { jobId: job.id, recipientId: job.data.recipientId, origin: job.data.origin },
      'Broadcast delivered',
    );
  });

  return worker;
}
