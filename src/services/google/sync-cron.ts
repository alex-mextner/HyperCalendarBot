// src/services/google/sync-cron.ts
import type { Queue } from 'bullmq';
import type { GoogleCalendarRepository } from '../../database/repositories/google-calendar.repository.ts';
import type { GoogleSyncRepository } from '../../database/repositories/google-sync.repository.ts';
import { syncLogger } from '../../utils/logger.ts';
import type { GoogleSyncJobData } from './sync-queue.ts';

export async function setupSyncCron(queue: Queue<GoogleSyncJobData>): Promise<void> {
  await queue.add(
    'sync-cron-tick',
    {
      type: 'cron-sync-tick',
      userId: 0,
    },
    {
      repeat: { every: 15 * 60_000 },
      removeOnComplete: true,
      jobId: 'sync-cron-tick',
    },
  );

  syncLogger.info('Sync cron scheduled (every 15min)');
}

export async function executeSyncCronTick(
  queue: Queue<GoogleSyncJobData>,
  syncRepo: GoogleSyncRepository,
  calendarRepo: GoogleCalendarRepository,
): Promise<void> {
  const activeUsers = syncRepo.getActiveUsers();

  for (const userId of activeUsers) {
    const calendars = calendarRepo.getEnabledCalendars(userId);
    for (const cal of calendars) {
      await queue.add(
        'pull-sync',
        {
          type: 'pull-sync',
          userId,
          calendarId: cal.google_calendar_id,
          trigger: 'cron',
        },
        {
          jobId: `pull-${userId}-${cal.google_calendar_id}-${Date.now()}`,
        },
      );
    }
  }
}

/**
 * Once per start: one reconcile job per connected user, which removes the events whose Google copy is
 * gone. It repairs the deletions the pulls missed before deletions were applied (#844): the delta that
 * carried them is no longer available, so no later pull brings them back.
 */
export async function enqueueStartupReconcile(
  queue: Queue<GoogleSyncJobData>,
  syncRepo: GoogleSyncRepository,
): Promise<number> {
  const activeUsers = syncRepo.getActiveUsers();
  for (const userId of activeUsers) {
    await queue.add(
      'reconcile-sync',
      { type: 'reconcile-sync', userId, trigger: 'startup' },
      // One per user: a restart while the job is still queued does not queue a second full listing.
      { jobId: `reconcile-${userId}`, removeOnComplete: true, removeOnFail: true },
    );
  }
  syncLogger.info({ users: activeUsers.length }, 'Startup reconcile of Google deletions enqueued');
  return activeUsers.length;
}
