// src/services/google/watch-renewal-cron.ts
import type { Queue } from 'bullmq';
import type { EnvConfig } from '../../config/env.ts';
import type { GoogleCalendarRepository } from '../../database/repositories/google-calendar.repository.ts';
import { syncLogger } from '../../utils/logger.ts';
import { GoogleCalendarApi } from './calendar-api.ts';
import type { GoogleOAuthService } from './oauth.ts';
import type { GoogleSyncJobData } from './sync-queue.ts';

export async function setupWatchRenewalCron(queue: Queue<GoogleSyncJobData>): Promise<void> {
  await queue.add(
    'watch-renewal-tick',
    {
      type: 'cron-watch-renewal-tick',
      userId: 0,
    },
    {
      repeat: { every: 6 * 60 * 60_000 },
      removeOnComplete: true,
      jobId: 'watch-renewal-tick',
    },
  );
  syncLogger.info('Watch renewal cron scheduled (every 6h)');
}

export async function renewExpiringChannels(
  config: EnvConfig,
  oauthService: GoogleOAuthService,
  calendarRepo: GoogleCalendarRepository,
): Promise<void> {
  if (!config.PUBLIC_DOMAIN) return;

  const threshold = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const expiring = calendarRepo.getExpiringChannels(threshold);

  for (const channel of expiring) {
    try {
      const authClient = await oauthService.getAuthClient(channel.user_id);
      const api = new GoogleCalendarApi(authClient);

      await api.stopChannel(channel.channel_id, channel.resource_id);
      calendarRepo.deleteWatchChannel(channel.id);

      const newChannelId = crypto.randomUUID();
      const channelToken = crypto.randomUUID();
      const webhookUrl = `https://${config.PUBLIC_DOMAIN}/webhooks/google-calendar`;
      const expMs = Date.now() + 7 * 24 * 60 * 60 * 1000;
      const result = await api.watchEvents(channel.google_calendar_id, newChannelId, webhookUrl, expMs, channelToken);

      calendarRepo.addWatchChannel(
        channel.google_calendar_row_id,
        newChannelId,
        result.resourceId,
        result.expiration,
        result.token,
      );

      syncLogger.info({ userId: channel.user_id, calendarId: channel.google_calendar_id }, 'Watch channel renewed');
    } catch (err) {
      syncLogger.error({ err: err, channelId: channel.channel_id }, 'Watch channel renewal failed');
    }
  }
}
