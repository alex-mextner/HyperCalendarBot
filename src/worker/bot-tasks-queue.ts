import { Queue, Worker } from 'bullmq';
import { logger } from '../utils/logger.ts';
import { parseRedisUrl } from '../utils/redis.ts';

const botTasksLogger = logger.child({ module: 'bot-tasks' });

export type BotTaskJobType =
  | 'cron-secretary-expiry'
  | 'cron-sharing-cleanup'
  | 'cron-proposal-expiry'
  | 'cron-session-cleanup'
  | 'cron-birthday-sync'
  | 'cron-chat-history-cleanup'
  | 'cron-sqlite-backup'
  | 'cron-recurring-reminders'
  | 'cron-action-log-cleanup'
  | 'cron-session-keepalive';

export interface BotTaskJobData {
  type: BotTaskJobType;
}

interface BotTasksQueueDeps {
  redisUrl: string;
  onSecretaryExpiry?: () => Promise<void>;
  onSharingCleanup?: () => void;
  onProposalExpiry?: () => Promise<void>;
  onSessionCleanup?: () => void;
  onBirthdaySync?: () => Promise<void>;
  onChatHistoryCleanup?: () => void;
  onSqliteBackup?: () => Promise<void>;
  onRecurringReminders?: () => void;
  onActionLogCleanup?: () => void;
  onSessionKeepalive?: () => Promise<void>;
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
      if (job.data.type === 'cron-sharing-cleanup') {
        deps.onSharingCleanup?.();
        return;
      }
      if (job.data.type === 'cron-proposal-expiry') {
        if (deps.onProposalExpiry) await deps.onProposalExpiry();
        return;
      }
      if (job.data.type === 'cron-session-cleanup') {
        deps.onSessionCleanup?.();
        return;
      }
      if (job.data.type === 'cron-birthday-sync') {
        if (deps.onBirthdaySync) await deps.onBirthdaySync();
        return;
      }
      if (job.data.type === 'cron-chat-history-cleanup') {
        deps.onChatHistoryCleanup?.();
        return;
      }
      if (job.data.type === 'cron-sqlite-backup') {
        if (deps.onSqliteBackup) await deps.onSqliteBackup();
        return;
      }
      if (job.data.type === 'cron-recurring-reminders') {
        deps.onRecurringReminders?.();
        return;
      }
      if (job.data.type === 'cron-action-log-cleanup') {
        deps.onActionLogCleanup?.();
        return;
      }
      if (job.data.type === 'cron-session-keepalive') {
        if (deps.onSessionKeepalive) await deps.onSessionKeepalive();
        return;
      }
    },
    { connection, concurrency: 1 },
  );

  worker.on('failed', (job, err) => {
    if (!job) return;
    botTasksLogger.error({ jobId: job.id, type: job.data.type, err: err }, 'Bot task job failed');
  });

  return { queue, worker };
}

export async function setupSharingCleanupCron(queue: Queue<BotTaskJobData>): Promise<void> {
  await queue.add(
    'sharing-cleanup-tick',
    { type: 'cron-sharing-cleanup' },
    { repeat: { every: 10 * 60_000 }, removeOnComplete: true, jobId: 'sharing-cleanup-tick' },
  );
  botTasksLogger.info('Sharing cleanup cron scheduled (every 10min)');
}

export async function setupSecretaryExpiryCron(queue: Queue<BotTaskJobData>): Promise<void> {
  await queue.add(
    'secretary-expiry-tick',
    { type: 'cron-secretary-expiry' },
    { repeat: { every: 24 * 60 * 60_000 }, removeOnComplete: true, jobId: 'secretary-expiry-tick' },
  );
  botTasksLogger.info('Secretary expiry cron scheduled (daily)');
}

export async function setupProposalExpiryCron(queue: Queue<BotTaskJobData>): Promise<void> {
  await queue.add(
    'proposal-expiry-tick',
    { type: 'cron-proposal-expiry' },
    { repeat: { every: 60 * 60_000 }, removeOnComplete: true, jobId: 'proposal-expiry-tick' },
  );
  botTasksLogger.info('Proposal expiry cron scheduled (hourly)');
}

export async function setupSessionCleanupCron(queue: Queue<BotTaskJobData>): Promise<void> {
  const MONTHLY_MS = 30 * 24 * 60 * 60_000;
  await queue.add(
    'session-cleanup-tick',
    { type: 'cron-session-cleanup' },
    { repeat: { every: MONTHLY_MS }, removeOnComplete: true, jobId: 'session-cleanup-tick' },
  );
  botTasksLogger.info('Session cleanup cron scheduled (monthly)');
}

export async function setupBirthdaySyncCron(queue: Queue<BotTaskJobData>): Promise<void> {
  await queue.add(
    'birthday-sync-tick',
    { type: 'cron-birthday-sync' },
    { repeat: { every: 24 * 60 * 60_000 }, removeOnComplete: true, jobId: 'birthday-sync-tick' },
  );
  botTasksLogger.info('Birthday sync cron scheduled (daily)');
}

export async function setupChatHistoryCleanupCron(queue: Queue<BotTaskJobData>): Promise<void> {
  await queue.add(
    'chat-history-cleanup-tick',
    { type: 'cron-chat-history-cleanup' },
    { repeat: { every: 24 * 60 * 60_000 }, removeOnComplete: true, jobId: 'chat-history-cleanup-tick' },
  );
  botTasksLogger.info('Chat history cleanup cron scheduled (daily)');
}

export async function setupSqliteBackupCron(queue: Queue<BotTaskJobData>): Promise<void> {
  await queue.add(
    'sqlite-backup-tick',
    { type: 'cron-sqlite-backup' },
    { repeat: { every: 24 * 60 * 60_000 }, removeOnComplete: true, jobId: 'sqlite-backup-tick' },
  );
  botTasksLogger.info('SQLite backup cron scheduled (daily)');
}

export async function setupRecurringRemindersCron(queue: Queue<BotTaskJobData>): Promise<void> {
  await queue.add(
    'recurring-reminders-tick',
    { type: 'cron-recurring-reminders' },
    { repeat: { every: 6 * 60 * 60_000 }, removeOnComplete: true, jobId: 'recurring-reminders-tick' },
  );
  botTasksLogger.info('Recurring reminders cron scheduled (every 6h)');
}

export async function setupActionLogCleanupCron(queue: Queue<BotTaskJobData>): Promise<void> {
  const WEEKLY_MS = 7 * 24 * 60 * 60_000;
  await queue.add(
    'action-log-cleanup-tick',
    { type: 'cron-action-log-cleanup' },
    { repeat: { every: WEEKLY_MS }, removeOnComplete: true, jobId: 'action-log-cleanup-tick' },
  );
  botTasksLogger.info('Action log cleanup cron scheduled (weekly, retains 90 days)');
}

export async function setupSessionKeepaliveCron(queue: Queue<BotTaskJobData>): Promise<void> {
  const BIWEEKLY_MS = 14 * 24 * 60 * 60_000;
  await queue.add(
    'session-keepalive-tick',
    { type: 'cron-session-keepalive' },
    { repeat: { every: BIWEEKLY_MS }, removeOnComplete: true, jobId: 'session-keepalive-tick' },
  );
  botTasksLogger.info('Session keepalive cron scheduled (every 14 days)');
}
