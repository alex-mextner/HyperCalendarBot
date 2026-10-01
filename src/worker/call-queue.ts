// src/worker/call-queue.ts

import { randomUUID } from 'node:crypto';
import { type ConnectionOptions, Queue, Worker } from 'bullmq';
import type { CallLogRepository } from '../database/repositories/call-log.repository';
import type { CallManager } from '../services/voice/call-manager';
import type { CallReminderJobData } from '../services/voice/types';
import { voiceLogger } from '../services/voice/types';

/** A call to place; the queue logs it and assigns the log row and session. */
export type CallRequest = Omit<CallReminderJobData, 'sessionId' | 'callLogId'>;

export function createCallQueue(
  connection: ConnectionOptions,
  callLog: Pick<CallLogRepository, 'create' | 'complete'>,
) {
  const queue = new Queue<CallReminderJobData>('call-reminders', { connection });
  return {
    queue,
    /** Logs the call, then queues it. Rejects when the queue write fails, after marking the logged call
     *  failed — otherwise its row would stay 'queued' with no job to ever complete it. The reminder text
     *  (event titles, places) travels only in the job, which BullMQ drops on completion or failure. */
    async enqueue(data: CallRequest): Promise<void> {
      const log = callLog.create({ user_id: data.userId, event_id: data.eventId });
      try {
        await queue.add(
          'call-reminder',
          { ...data, callLogId: log.id, sessionId: randomUUID() },
          {
            attempts: 1,
            removeOnComplete: true,
            removeOnFail: true,
          },
        );
      } catch (error) {
        callLog.complete(log.id, 'failed', 0, error instanceof Error ? error.message : String(error));
        throw error;
      }
    },
  };
}

export function createCallWorker(connection: ConnectionOptions, callManager: Pick<CallManager, 'executeCall'>) {
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
    voiceLogger.error({ jobId: job?.id, err: err }, 'Call job failed');
  });

  return worker;
}
