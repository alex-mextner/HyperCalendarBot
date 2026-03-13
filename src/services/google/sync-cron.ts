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
