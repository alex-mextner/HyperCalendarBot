// src/bootstrap/bot-tasks.ts
//
// Startup phase: the "bot-tasks" BullMQ queue — housekeeping crons (expiry, cleanup, backup,
// birthday sync, recurring reminders, session keepalive). Runs only with REDIS_URL.
//
// Ordering invariants:
//  - It runs AFTER the Google sync phase: the edit-proposal expiry job pushes to the Google sync
//    queue and is a no-op when that queue does not exist.
//  - It runs BEFORE createBot(); handlers reach Telegram through `ctx.botRef` at job time (patched
//    after createBot()), never through a captured method.
//  - Cron registration order is fixed (the table below) and happens after the queue and worker
//    exist; the session-keepalive cron is registered only with TELEGRAM_SESSION_MASTER_KEY.
//  - The failure handler is attached after the crons are registered, and the close handle is
//    recorded last.
//  - Handler modules are imported lazily, in this order, only when REDIS_URL is set.

import type { Queue } from 'bullmq';
import type { Lang } from '../config/constants.ts';
import type { runSqliteBackup } from '../database/backup.ts';
import type { BirthdayService } from '../services/birthday/birthday-service.ts';
import type { processExpiredEditProposals } from '../services/google/edit-proposal-expiry.ts';
import type { GoogleSyncJobData } from '../services/google/sync-queue.ts';
import type { runSharingCleanup } from '../services/sharing/sharing-cleanup.ts';
import type { ServiceTier } from '../services/telegram-session/service-tier.ts';
import { formatSessionLoss } from '../services/telegram-session/session-loss.ts';
import { botLogger } from '../utils/logger.ts';
import type { BotTaskJobData, BotTasksQueueDeps } from '../worker/bot-tasks-queue.ts';
import type { runProposalExpiry } from '../worker/proposal-expiry.ts';
import type { runSecretaryExpiry } from '../worker/secretary-expiry.ts';
import type { processSessionKeepalive } from '../worker/session-keepalive.ts';
import type { BotRef } from './bot-ref.ts';
import type { StartupContext } from './runtime.ts';

const ACTION_LOG_RETENTION_MS = 90 * 24 * 60 * 60_000;
const CHAT_HISTORY_RETENTION_DAYS = 90;
const BIRTHDAY_SYNC_BATCH = 100;

export interface BotTasksInputs {
  googleSyncQueue: Queue<GoogleSyncJobData> | undefined;
  serviceTier: ServiceTier;
}

/** Sends a plain message through the late-bound bot; the failure is reported by `onError`, never thrown. */
function sendThroughBot(botRef: BotRef, userId: number, text: string, onError: (err: unknown) => void): Promise<void> {
  return botRef
    .sendMessage(userId, text)
    .then(() => {})
    .catch(onError);
}

/** `YYYY-MM-DD HH:MM:SS` in UTC, the format the action log stores. */
export function actionLogCutoff(nowMs: number): string {
  return new Date(nowMs - ACTION_LOG_RETENTION_MS).toISOString().slice(0, 19).replace('T', ' ');
}

function buildExpiryHandlers(
  ctx: StartupContext,
  googleSyncQueue: BotTasksInputs['googleSyncQueue'],
  fns: {
    runSecretaryExpiry: typeof runSecretaryExpiry;
    runProposalExpiry: typeof runProposalExpiry;
    processExpiredEditProposals: typeof processExpiredEditProposals;
  },
): Omit<BotTasksQueueDeps, 'redisUrl'> {
  const { db, botRef } = ctx;
  const editMessage = (chatId: number, messageId: number, text: string) => botRef.editMessage(chatId, messageId, text);
  return {
    onSecretaryExpiry: () =>
      fns.runSecretaryExpiry({
        secretaryRepo: db.secretaries,
        userRepo: db.users,
        notify: (userId, text) =>
          sendThroughBot(botRef, userId, text, (err) =>
            botLogger.error({ err, userId }, 'Failed to send secretary expiry notification'),
          ),
      }),
    onProposalExpiry: () => fns.runProposalExpiry({ proposalRepo: db.calendarProposals, editMessage }),
    onEditProposalExpiry: () => {
      if (!googleSyncQueue) return Promise.resolve();
      return fns.processExpiredEditProposals({
        editProposalRepo: db.editProposals,
        eventRepo: db.events,
        syncQueue: googleSyncQueue,
        notifyUser: (userId, text) =>
          sendThroughBot(botRef, userId, text, (err) =>
            botLogger.error({ err, userId }, 'Failed to notify about edit proposal expiry'),
          ),
        editMessage,
        getUserLang: (userId) => (db.users.findByTelegramId(userId)?.language ?? 'en') as Lang,
      });
    },
  };
}

function buildCleanupHandlers(
  ctx: StartupContext,
  fns: { runSharingCleanup: typeof runSharingCleanup; runSqliteBackup: typeof runSqliteBackup },
): Omit<BotTasksQueueDeps, 'redisUrl'> {
  const { config, db } = ctx;
  return {
    onSharingCleanup: () => fns.runSharingCleanup({ invitationRepo: db.invitations, deepLinkRepo: db.deepLinks }),
    onSessionCleanup: () => {
      db.workflowSessions.cleanup();
      db.groupSessions.deleteExpired();
    },
    onActionLogCleanup: () => {
      const deleted = db.actionLog.deleteOlderThan(actionLogCutoff(Date.now()));
      if (deleted > 0) botLogger.info({ deleted }, 'Action log cleanup: removed old entries');
    },
    onAiUsageCleanup: () => {
      const deleted = db.aiUsage.pruneExpired(Date.now());
      if (deleted > 0) botLogger.info({ deleted }, 'AI usage cleanup: removed expired rows');
    },
    onChatHistoryCleanup: () => {
      const deleted = db.chatHistory.deleteOlderThan(CHAT_HISTORY_RETENTION_DAYS);
      botLogger.info({ deleted }, 'Cleaned up old chat history');
    },
    onSqliteBackup: () => fns.runSqliteBackup(db.db, config.DATABASE_PATH),
  };
}

/** Birthday auto-sync reads birthdays through the service account, so it exists only with it. */
function buildBirthdaySync(
  ctx: StartupContext,
  serviceTier: ServiceTier,
  birthdays: { BirthdayService: typeof BirthdayService; throttleMs: number },
): (() => Promise<void>) | undefined {
  const { db } = ctx;
  const service = new birthdays.BirthdayService(
    db.events,
    db.birthdayMeta,
    db.eventReminders,
    db.notificationPreferences,
    serviceTier,
  );
  if (!serviceTier.enabled) return undefined;
  return async () => {
    const users = db.birthdayMeta.getUsersNeedingSync(birthdays.throttleMs);
    for (let i = 0; i < users.length; i += BIRTHDAY_SYNC_BATCH) {
      await service.runBatchSync(users.slice(i, i + BIRTHDAY_SYNC_BATCH));
    }
  };
}

function buildSessionKeepalive(
  ctx: StartupContext,
  keepalive: typeof processSessionKeepalive,
): (() => Promise<void>) | undefined {
  const { config, db, botRef } = ctx;
  const masterKeyHex = config.TELEGRAM_SESSION_MASTER_KEY;
  if (!masterKeyHex) return undefined;
  return async () => {
    await keepalive({
      sessionRepo: db.telegramSessions,
      masterKey: Buffer.from(masterKeyHex, 'hex'),
      onSessionExpired: (userId, reason) => {
        const lang = db.users.findByTelegramId(userId)?.language ?? 'en';
        void sendThroughBot(botRef, userId, formatSessionLoss(lang, reason), (err) =>
          botLogger.warn({ err, userId }, 'Failed to notify user of expired session'),
        );
      },
    });
  };
}

async function registerCrons(
  queue: Queue<BotTaskJobData>,
  onBirthdaySync: (() => Promise<void>) | undefined,
  withSessionKeepalive: boolean,
): Promise<void> {
  const crons = await import('../worker/bot-tasks-queue.ts');
  const schedule: Array<(q: Queue<BotTaskJobData>) => Promise<void>> = [
    crons.setupSecretaryExpiryCron,
    crons.setupSharingCleanupCron,
    crons.setupProposalExpiryCron,
    crons.setupEditProposalExpiryCron,
    crons.setupSessionCleanupCron,
    (q) => crons.setupBirthdaySyncCron(q, { onBirthdaySync }),
    crons.setupChatHistoryCleanupCron,
    crons.setupSqliteBackupCron,
    crons.setupRecurringRemindersCron,
    crons.setupActionLogCleanupCron,
    crons.setupAiUsageCleanupCron,
  ];
  if (withSessionKeepalive) schedule.push(crons.setupSessionKeepaliveCron);
  for (const setup of schedule) {
    await setup(queue);
  }
}

export async function initBotTasks(ctx: StartupContext, inputs: BotTasksInputs): Promise<void> {
  const { config, db } = ctx;
  if (!config.REDIS_URL) return;

  const { createBotTasksQueue } = await import('../worker/bot-tasks-queue.ts');
  const { runSqliteBackup } = await import('../database/backup.ts');
  const { runSecretaryExpiry } = await import('../worker/secretary-expiry.ts');
  const { runSharingCleanup } = await import('../services/sharing/sharing-cleanup.ts');
  const { runProposalExpiry } = await import('../worker/proposal-expiry.ts');
  const { processExpiredEditProposals } = await import('../services/google/edit-proposal-expiry.ts');
  const { BirthdayService: BirthdayServiceClass, BIRTHDAY_SYNC_THROTTLE_MS } = await import(
    '../services/birthday/birthday-service.ts'
  );
  const { ReminderMaterializer } = await import('../services/notification/materializer.ts');
  const { processSessionKeepalive: keepalive } = await import('../worker/session-keepalive.ts');

  const cronMaterializer = new ReminderMaterializer(db.eventReminders, db.notificationPreferences);
  const onBirthdaySync = buildBirthdaySync(ctx, inputs.serviceTier, {
    BirthdayService: BirthdayServiceClass,
    throttleMs: BIRTHDAY_SYNC_THROTTLE_MS,
  });

  const { queue, worker } = createBotTasksQueue({
    redisUrl: config.REDIS_URL,
    ...buildExpiryHandlers(ctx, inputs.googleSyncQueue, {
      runSecretaryExpiry,
      runProposalExpiry,
      processExpiredEditProposals,
    }),
    ...buildCleanupHandlers(ctx, { runSharingCleanup, runSqliteBackup }),
    onBirthdaySync,
    onRecurringReminders: () => {
      cronMaterializer.materializeUpcomingRecurringReminders(db.events);
    },
    onSessionKeepalive: buildSessionKeepalive(ctx, keepalive),
  });

  await registerCrons(queue, onBirthdaySync, Boolean(config.TELEGRAM_SESSION_MASTER_KEY));

  worker.on('failed', ctx.onWorkerFailed('bot-tasks'));

  ctx.resources.botTasksQueue = {
    close: async () => {
      await worker.close();
      await queue.close();
    },
  };

  botLogger.info('Bot tasks queue initialized');
}
