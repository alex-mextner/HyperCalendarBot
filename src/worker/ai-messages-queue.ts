import type { ConnectionOptions } from 'bullmq';
import { Queue, Worker } from 'bullmq';
import type { AgentContextBuilder } from '../bot/agent-context-factory.ts';
import { t } from '../config/constants.ts';
import type { User } from '../database/types.ts';
import type { AgentContext } from '../services/ai/types.ts';
import type { AiMessageJobData, RetryJobStore } from '../services/scheduled/types.ts';
import { logger } from '../utils/logger.ts';

const queueLogger = logger.child({ module: 'ai-messages' });

/** Backoff delays for successive retry attempts (index = currentAttempt, 0-based). */
const BACKOFF_DELAYS_MS = [30_000, 60_000, 120_000] as const;
const MAX_RETRY_ATTEMPTS = BACKOFF_DELAYS_MS.length;

export interface SyntheticPipelineRunnerDeps {
  contextBuilder: AgentContextBuilder;
  intentRun: (agentCtx: AgentContext, message: string) => Promise<{ handled: boolean; response?: string }>;
  agentRun: (agentCtx: AgentContext) => Promise<void>;
  retryQueue?: {
    addDelayed(data: AiMessageJobData, delayMs: number): Promise<string>;
  };
  retryJobStore?: RetryJobStore;
}

export class SyntheticPipelineRunner {
  constructor(private deps: SyntheticPipelineRunnerDeps) {}

  async run(user: User, jobData: AiMessageJobData): Promise<void> {
    try {
      const agentCtx = this.deps.contextBuilder(user, user.telegram_id, jobData.message);
      const currentAttempt = jobData.retryAttempt ?? 0;
      agentCtx.retryAttempt = currentAttempt;

      if (this.deps.retryQueue) {
        const queue = this.deps.retryQueue;
        const jobStore = this.deps.retryJobStore;
        const lang = user.language as 'en' | 'ru';

        agentCtx.retryEnqueue = async (msg: string) => {
          if (currentAttempt >= MAX_RETRY_ATTEMPTS) {
            await agentCtx.sender?.sendMessage(user.telegram_id, t(lang).agent_give_up());
            if (jobStore) await jobStore.del(user.telegram_id);
            return;
          }
          const delay = BACKOFF_DELAYS_MS[currentAttempt]!;
          const jobId = await queue.addDelayed(
            { userId: user.telegram_id, message: msg, source: 'trigger', retryAttempt: currentAttempt + 1 },
            delay,
          );
          if (jobStore) await jobStore.set(user.telegram_id, jobId);
        };
      }

      const intentResult = await this.deps.intentRun(agentCtx, jobData.message);
      if (!intentResult.handled) {
        await this.deps.agentRun(agentCtx);
      }
    } catch (err: unknown) {
      queueLogger.error({ err, userId: user.telegram_id, message: jobData.message }, 'SyntheticPipelineRunner error');
    }
  }
}

export function createAiMessagesQueue(connection: ConnectionOptions) {
  const queue = new Queue<AiMessageJobData>('ai-messages', {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 10_000 },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500 },
    },
  });

  return {
    queue,
    async addDelayed(data: AiMessageJobData, delayMs: number): Promise<string> {
      const job = await queue.add('ai-schedule', data, { delay: delayMs });
      return job.id ?? '';
    },
    async addRepeat(data: AiMessageJobData, cron: string): Promise<void> {
      await queue.add('ai-schedule', data, { repeat: { pattern: cron } });
    },
    async removeDelayed(scheduleId: string): Promise<void> {
      const delayed = await queue.getDelayed();
      for (const job of delayed) {
        if (job.data.scheduleId === scheduleId) {
          await job.remove();
          return;
        }
      }
    },
    async removeJobById(jobId: string): Promise<void> {
      if (!jobId) return;
      const job = await queue.getJob(jobId);
      if (job) await job.remove();
    },
    async removeRepeat(cron: string): Promise<void> {
      await queue.removeRepeatable('ai-schedule', { pattern: cron });
    },
    async pushTrigger(data: AiMessageJobData): Promise<void> {
      await queue.add('ai-trigger', data);
    },
  };
}

export function createAiMessagesWorker(
  connection: ConnectionOptions,
  runner: SyntheticPipelineRunner,
  getUserById: (id: number) => User | null,
  onRunComplete?: (scheduleId: string) => void,
) {
  const worker = new Worker<AiMessageJobData>(
    'ai-messages',
    async (job) => {
      const { userId, scheduleId } = job.data;
      queueLogger.info(
        {
          userId,
          source: job.data.source,
          scheduleId,
          triggerId: job.data.triggerId,
          retryAttempt: job.data.retryAttempt,
        },
        'Processing ai-message job',
      );

      const user = getUserById(userId);
      if (!user) {
        queueLogger.warn({ userId }, 'User not found for ai-message job, skipping');
        return;
      }

      await runner.run(user, job.data);

      if (scheduleId && onRunComplete) {
        onRunComplete(scheduleId);
      }
    },
    { connection, concurrency: 5 },
  );

  worker.on('failed', (job, err) => {
    queueLogger.error({ jobId: job?.id, err }, 'ai-messages job failed');
  });

  return worker;
}
