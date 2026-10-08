// src/services/google/cleanup-cron.ts

import type { GoogleCalendarRepository } from '../../database/repositories/google-calendar.repository.ts';
import type { GoogleSyncRepository } from '../../database/repositories/google-sync.repository.ts';
import { syncLogger } from '../../utils/logger.ts';
import type { GoogleCronQueue } from './sync-cron.ts';

const SYNC_LOG_RETENTION_DAYS = 30;

export async function setupCleanupCron(queue: GoogleCronQueue): Promise<void> {
  await queue.add(
    'cleanup-tick',
    {
      type: 'cron-cleanup-tick',
      userId: 0,
    },
    {
      repeat: { every: 24 * 60 * 60_000 },
      removeOnComplete: true,
      jobId: 'cleanup-tick',
    },
  );
  syncLogger.info('Cleanup cron scheduled (daily)');
}

export function executeCleanup(
  syncRepo: Pick<GoogleSyncRepository, 'pruneOldLogs'>,
  calendarRepo: Pick<GoogleCalendarRepository, 'getExpiringChannels' | 'deleteWatchChannel'>,
): void {
  syncRepo.pruneOldLogs(SYNC_LOG_RETENTION_DAYS);

  const nowIso = new Date().toISOString();
  const expired = calendarRepo.getExpiringChannels(nowIso);
  for (const ch of expired) {
    if (new Date(ch.expiration) < new Date()) {
      calendarRepo.deleteWatchChannel(ch.id);
    }
  }

  syncLogger.info('Cleanup completed');
}
