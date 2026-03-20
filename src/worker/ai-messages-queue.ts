import type { ConnectionOptions } from 'bullmq';
import { Queue, Worker } from 'bullmq';
import type { AgentContextBuilder } from '../bot/agent-context-factory.ts';
import type { User } from '../database/types.ts';
import type { AgentContext } from '../services/ai/types.ts';
import { logger } from '../utils/logger.ts';

const queueLogger = logger.child({ module: 'ai-messages' });

export interface AiMessageJobData {
  userId: number;
  message: string;
  source: 'scheduled' | 'trigger';
  scheduleId?: string;
  triggerId?: string;
}

export interface SyntheticPipelineRunnerDeps {
  contextBuilder: AgentContextBuilder;
  intentRun: (agentCtx: AgentContext, message: string) => Promise<{ handled: boolean; response?: string }>;
  agentRun: (agentCtx: AgentContext) => Promise<void>;
}

export class SyntheticPipelineRunner {
  constructor(private deps: SyntheticPipelineRunnerDeps) {}

  async run(user: User, message: string): Promise<void> {
    try {
      const agentCtx = this.deps.contextBuilder(user, user.telegram_id, message);
      const intentResult = await this.deps.intentRun(agentCtx, message);
      if (!intentResult.handled) {
        await this.deps.agentRun(agentCtx);
      }
    } catch (err: unknown) {
      queueLogger.error({ err, userId: user.telegram_id, message }, 'SyntheticPipelineRunner error');
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
    async addDelayed(data: Record<string, unknown>, delayMs: number): Promise<string> {
      const job = await queue.add('ai-schedule', data as unknown as AiMessageJobData, { delay: delayMs });
      return job.id ?? '';
    },
    async addRepeat(data: Record<string, unknown>, cron: string): Promise<void> {
      await queue.add('ai-schedule', data as unknown as AiMessageJobData, { repeat: { pattern: cron } });
    },
    async removeDelayed(scheduleId: string): Promise<void> {
      const delayed = await queue.getDelayed();
      for (const job of delayed) {
        if ((job.data as AiMessageJobData).scheduleId === scheduleId) {
          await job.remove();
          return;
        }
      }
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
      const { userId, message, scheduleId } = job.data;
      queueLogger.info(
        { userId, source: job.data.source, scheduleId, triggerId: job.data.triggerId },
        'Processing ai-message job',
      );

      const user = getUserById(userId);
      if (!user) {
        queueLogger.warn({ userId }, 'User not found for ai-message job, skipping');
        return;
      }

      await runner.run(user, message);

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
