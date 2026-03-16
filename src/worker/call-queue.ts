// src/worker/call-queue.ts
import { type ConnectionOptions, Queue, Worker } from 'bullmq';
import type { CallManager } from '../services/voice/call-manager';
import type { CallReminderJobData } from '../services/voice/types';
import { voiceLogger } from '../services/voice/types';

export function createCallQueue(connection: ConnectionOptions) {
  const queue = new Queue<CallReminderJobData>('call-reminders', { connection });
  return {
    queue,
    async enqueue(data: CallReminderJobData): Promise<void> {
      await queue.add('call-reminder', data, {
        attempts: 2,
        backoff: { type: 'fixed', delay: 60_000 },
        removeOnComplete: true,
        removeOnFail: 100,
      });
    },
  };
}

export function createCallWorker(connection: ConnectionOptions, callManager: CallManager) {
  const worker = new Worker<CallReminderJobData>(
    'call-reminders',
    async (job) => {
      voiceLogger.info({ jobId: job.id, userId: job.data.userId }, 'Processing call job');
      await callManager.executeCall(job.data);
    },
    {
      connection,
      concurrency: 1, // One call at a time
      limiter: { max: 1, duration: 5000 }, // Max 1 call per 5 seconds
    },
  );

  worker.on('failed', (job, err) => {
    voiceLogger.error({ jobId: job?.id, error: String(err) }, 'Call job failed');
  });

  return worker;
}
