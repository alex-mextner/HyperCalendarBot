import { logger } from '../../utils/logger.ts';
import type { ScheduledAiCall, ScheduledAiCallRepository } from './scheduled-ai-call.repository.ts';

const scheduleLogger = logger.child({ module: 'scheduled-ai-call' });

const USER_LIMIT = 50;

export interface CreateScheduleInput {
  userId: number;
  message: string;
  runAt: string | null;
  cron: string | null;
  label: string | null;
}

export interface AiJobData {
  userId: number;
  message: string;
  source: 'scheduled' | 'trigger';
  scheduleId?: string;
  triggerId?: string;
}

export interface QueueAdapter {
  addDelayed(data: AiJobData, delayMs: number): Promise<string>;
  addRepeat(data: AiJobData, cron: string): Promise<void>;
  removeDelayed(scheduleId: string): Promise<void>;
  removeRepeat(cron: string): Promise<void>;
}

export class ScheduledAiCallService {
  constructor(
    private repo: ScheduledAiCallRepository,
    private queue: QueueAdapter,
  ) {}

  async create(input: CreateScheduleInput): Promise<string> {
    if (!input.runAt && !input.cron) throw new Error('Either runAt or cron must be provided');
    if (input.runAt && input.cron) throw new Error('Only one of runAt or cron may be provided');

    if (input.runAt) {
      const delayMs = new Date(input.runAt).getTime() - Date.now();
      if (delayMs < 0) throw new Error('run_at must be in the future');
    }

    const count = this.repo.countEnabled(input.userId);
    if (count >= USER_LIMIT) throw new Error(`Scheduled calls limit (${USER_LIMIT}) reached for this user`);

    const schedule = this.repo.create({
      userId: input.userId,
      message: input.message,
      label: input.label,
      runAt: input.runAt,
      cron: input.cron,
    });

    if (input.runAt) {
      const delayMs = new Date(input.runAt).getTime() - Date.now();
      await this.queue.addDelayed(
        { userId: input.userId, message: input.message, source: 'scheduled', scheduleId: schedule.id },
        delayMs,
      );
    } else {
      await this.queue.addRepeat(
        { userId: input.userId, message: input.message, source: 'scheduled', scheduleId: schedule.id },
        input.cron!,
      );
    }

    scheduleLogger.info({ scheduleId: schedule.id, userId: input.userId }, 'Scheduled AI call created');
    return schedule.id;
  }

  list(userId: number): ScheduledAiCall[] {
    return this.repo.listEnabled(userId);
  }

  async cancel(id: string, userId: number): Promise<void> {
    const schedule = this.repo.findById(id);
    if (!schedule || schedule.user_id !== userId) return;

    if (schedule.cron) {
      await this.queue.removeRepeat(schedule.cron);
    } else {
      await this.queue.removeDelayed(id);
    }

    this.repo.disable(id);
    scheduleLogger.info({ scheduleId: id, userId }, 'Scheduled AI call cancelled');
  }
}
