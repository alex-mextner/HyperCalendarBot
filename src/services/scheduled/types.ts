/** DB row from scheduled_ai_calls table. */
export type ScheduledAiCall = {
  id: string;
  user_id: number;
  message: string;
  label: string | null;
  run_at: string | null;
  cron: string | null;
  enabled: number;
  run_count: number;
  last_run_at: string | null;
  created_at: string;
};

/** INSERT input for scheduled_ai_calls table. */
export interface CreateScheduleData {
  userId: number;
  message: string;
  label: string | null;
  runAt: string | null;
  cron: string | null;
}

/** Service-level input for creating a schedule. */
export interface CreateScheduleInput {
  userId: number;
  message: string;
  runAt: string | null;
  cron: string | null;
  label: string | null;
}

/** BullMQ job data for AI message queue. */
export interface AiMessageJobData {
  userId: number;
  message: string;
  source: 'scheduled' | 'trigger';
  scheduleId?: string;
  triggerId?: string;
  /** Backoff retry attempt index (1 = first retry, 2 = second, 3 = third/last). Absent on original messages. */
  retryAttempt?: number;
}

/** Stores pending BullMQ retry job IDs per user for cancellation when a new message arrives. */
export interface RetryJobStore {
  set(userId: number, jobId: string): Promise<void>;
  get(userId: number): Promise<string | null>;
  del(userId: number): Promise<void>;
}

/** Dependency injection interface for the job queue. */
export interface QueueAdapter {
  addDelayed(data: AiMessageJobData, delayMs: number): Promise<string>;
  addRepeat(data: AiMessageJobData, cron: string): Promise<void>;
  removeDelayed(scheduleId: string): Promise<void>;
  removeRepeat(cron: string): Promise<void>;
  removeJobById(jobId: string): Promise<void>;
}

/** DB row from ai_triggers table. */
export type Trigger = {
  id: string;
  user_id: number;
  topic: string;
  condition: string | null;
  action: string;
  label: string | null;
  once: number;
  enabled: number;
  fire_count: number;
  last_fired_at: string | null;
  created_at: string;
};

/** INSERT input for ai_triggers table. */
export interface CreateTriggerData {
  userId: number;
  topic: string;
  action: string;
  condition: string | null;
  label: string | null;
  once: boolean;
}
