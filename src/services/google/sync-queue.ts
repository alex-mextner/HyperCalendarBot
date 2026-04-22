// src/services/google/sync-queue.ts

import type { Database } from 'bun:sqlite';
import { Queue, Worker } from 'bullmq';
import type { OAuth2Client } from 'google-auth-library';
import { type Lang, t } from '../../config/constants.ts';
import type { EnvConfig } from '../../config/env.ts';
import type { EditProposalRepository } from '../../database/repositories/edit-proposal.repository.ts';
import type { EventRepository } from '../../database/repositories/event.repository.ts';
import type { GoogleCalendarRepository } from '../../database/repositories/google-calendar.repository.ts';
import type { GoogleSyncRepository } from '../../database/repositories/google-sync.repository.ts';
import type { InvitationRepository } from '../../database/repositories/invitation.repository.ts';
import type { ParticipantRepository } from '../../database/repositories/participant.repository.ts';
import type { ParticipantGoogleSyncRepository } from '../../database/repositories/participant-google-sync.repository.ts';
import { syncLogger } from '../../utils/logger.ts';
import { parseRedisUrl } from '../../utils/redis.ts';
import { EventChangeNotifier } from '../event/event-change-notifier.ts';
import type { ReminderMaterializer } from '../notification/materializer.ts';
import { GoogleCalendarApi } from './calendar-api.ts';
import type { GoogleOAuthService } from './oauth.ts';
import { SyncService } from './sync-service.ts';

export type GoogleSyncJobType =
  | 'initial-sync'
  | 'pull-sync'
  | 'push-event'
  | 'push-participant-event'
  | 'refresh-calendars'
  | 'setup-watch'
  | 'stop-watch'
  | 'cron-sync-tick'
  | 'cron-watch-renewal-tick'
  | 'cron-cleanup-tick';

export interface GoogleSyncJobData {
  type: GoogleSyncJobType;
  userId: number;
  calendarId?: string;
  eventId?: number;
  action?: 'create' | 'update' | 'delete';
  trigger?: 'cron' | 'webhook' | 'manual';
  googleEventId?: string;
}

export interface ChangeNotifierSyncDeps {
  participantRepo: ParticipantRepository;
  editProposalRepo: EditProposalRepository;
  participantSyncRepo: ParticipantGoogleSyncRepository;
  invitationRepo: InvitationRepository;
  materializer: ReminderMaterializer;
  notifyUser: (userId: number, text: string) => Promise<void>;
  editMessage: (chatId: number, messageId: number, text: string) => Promise<void>;
  sendMessageWithButtons?: (
    userId: number,
    text: string,
    buttons: { text: string; callbackData: string }[][],
  ) => Promise<{ messageId: number; chatId: number } | null>;
  getUserLang: (userId: number) => Lang;
  getUserName: (userId: number) => string;
}

interface GoogleSyncQueueDeps {
  db: Database;
  config: EnvConfig;
  redisUrl: string;
  oauthService: GoogleOAuthService;
  eventRepo: EventRepository;
  syncRepo: GoogleSyncRepository;
  calendarRepo: GoogleCalendarRepository;
  participantSyncRepo?: ParticipantGoogleSyncRepository;
  onSyncComplete?: (userId: number, calendarId: string) => Promise<void>;
  onCalendarsRefreshed?: (userId: number) => Promise<void>;
  onCronSyncTick?: (queue: Queue<GoogleSyncJobData>) => Promise<void>;
  onWatchRenewalTick?: () => Promise<void>;
  onCleanupTick?: () => void;
  sendMessage: (telegramId: number, text: string) => Promise<void>;
  getUserLang?: (userId: number) => Lang;
  syncService?: SyncService;
  createCalendarApi?: (authClient: OAuth2Client) => GoogleCalendarApi;
  changeNotifierDeps?: ChangeNotifierSyncDeps;
}

export function createGoogleSyncQueue(deps: GoogleSyncQueueDeps) {
  const connection = parseRedisUrl(deps.redisUrl);

  const queue = new Queue<GoogleSyncJobData>('google-sync', {
    connection,
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 5000 },
    },
  });

  let changeNotifier: EventChangeNotifier | undefined;
  if (deps.changeNotifierDeps) {
    const cnd = deps.changeNotifierDeps;
    changeNotifier = new EventChangeNotifier({
      participantRepo: cnd.participantRepo,
      editProposalRepo: cnd.editProposalRepo,
      participantSyncRepo: cnd.participantSyncRepo,
      materializer: cnd.materializer,
      syncQueue: queue,
      notifyUser: cnd.notifyUser,
      editMessage: cnd.editMessage,
      getUserLang: cnd.getUserLang,
    });
  }

  const participantHandlerDeps = deps.changeNotifierDeps
    ? {
        eventRepo: deps.eventRepo,
        participantRepo: deps.changeNotifierDeps.participantRepo,
        participantSyncRepo: deps.changeNotifierDeps.participantSyncRepo,
        editProposalRepo: deps.changeNotifierDeps.editProposalRepo,
        invitationRepo: deps.changeNotifierDeps.invitationRepo,
        notifyUser: deps.changeNotifierDeps.notifyUser,
        sendMessageWithButtons: deps.changeNotifierDeps.sendMessageWithButtons,
        getUserLang: deps.changeNotifierDeps.getUserLang,
        getUserName: deps.changeNotifierDeps.getUserName,
      }
    : undefined;

  const syncService =
    deps.syncService ??
    new SyncService(
      deps.db,
      deps.eventRepo,
      deps.syncRepo,
      deps.calendarRepo,
      deps.sendMessage,
      deps.getUserLang,
      deps.participantSyncRepo,
      changeNotifier,
      participantHandlerDeps,
    );

  const worker = new Worker<GoogleSyncJobData>(
    'google-sync',
    async (job) => {
      const { type, userId, calendarId, eventId, action } = job.data;

      if (type === 'cron-sync-tick') {
        if (deps.onCronSyncTick) await deps.onCronSyncTick(queue);
        return;
      }
      if (type === 'cron-watch-renewal-tick') {
        if (deps.onWatchRenewalTick) await deps.onWatchRenewalTick();
        return;
      }
      if (type === 'cron-cleanup-tick') {
        if (deps.onCleanupTick) deps.onCleanupTick();
        return;
      }

      syncLogger.info({ type, userId, calendarId, jobId: job.id }, 'Processing sync job');

      let authClient: OAuth2Client;
      try {
        authClient = await deps.oauthService.getAuthClient(userId);
      } catch (err) {
        if (
          (err as { name?: string }).name === 'GoogleNotConnectedError' ||
          (err as { name?: string }).name === 'GoogleTokenRevokedError'
        ) {
          syncLogger.warn({ userId, type }, 'Skipping sync — user not connected or token revoked');
          return;
        }
        throw err;
      }

      const api = deps.createCalendarApi ? deps.createCalendarApi(authClient) : new GoogleCalendarApi(authClient);

      switch (type) {
        case 'initial-sync': {
          if (!calendarId) throw new Error('calendarId required for initial-sync');
          await syncService.initialSync(api, userId, calendarId);
          if (deps.onSyncComplete) {
            await deps.onSyncComplete(userId, calendarId);
          }
          break;
        }
        case 'pull-sync': {
          if (calendarId) {
            await syncService.incrementalPull(api, userId, calendarId);
          } else {
            const calendars = deps.calendarRepo.getEnabledCalendars(userId);
            for (const cal of calendars) {
              await syncService.incrementalPull(api, userId, cal.google_calendar_id);
            }
          }
          break;
        }
        case 'push-event': {
          if (!eventId || !action) throw new Error('eventId and action required for push-event');
          if (action === 'delete' && job.data.googleEventId) {
            const calId = job.data.calendarId ?? 'primary';
            await api.deleteEvent(calId, job.data.googleEventId);
            break;
          }
          await syncService.pushEvent(api, userId, eventId, action);
          break;
        }
        case 'push-participant-event': {
          if (!eventId || !action) throw new Error('eventId and action required for push-participant-event');
          await syncService.pushParticipantEvent(api, userId, eventId, action);
          break;
        }
        case 'refresh-calendars': {
          const calendars = await api.listCalendars();
          for (const cal of calendars) {
            deps.calendarRepo.upsertCalendar(userId, {
              google_calendar_id: cal.google_calendar_id,
              calendar_name: cal.calendar_name,
              color: cal.color ?? undefined,
              is_primary: cal.is_primary,
              access_role: cal.access_role,
            });
          }
          await deps.onCalendarsRefreshed?.(userId);
          break;
        }
        case 'setup-watch': {
          if (!calendarId || !deps.config.PUBLIC_DOMAIN) return;
          const cal = deps.calendarRepo.getCalendarByGoogleId(userId, calendarId);
          if (!cal) return;
          await syncService.setupWatchChannel(api, cal.id, calendarId, deps.config.PUBLIC_DOMAIN);
          break;
        }
        case 'stop-watch': {
          const calendars = deps.calendarRepo.getCalendars(userId);
          for (const cal of calendars) {
            const channels = deps.calendarRepo.getWatchChannels(cal.id);
            for (const ch of channels) {
              await api.stopChannel(ch.channel_id, ch.resource_id);
              deps.calendarRepo.deleteWatchChannel(ch.id);
            }
          }
          break;
        }
      }
    },
    { connection, concurrency: 1 },
  );

  worker.on('failed', (job, err) => {
    if (!job) return;
    syncLogger.error(
      {
        jobId: job.id,
        type: job.data.type,
        userId: job.data.userId,
        err: err,
        attempts: job.attemptsMade,
      },
      'Google sync job failed',
    );

    const errorStr = String(err);
    if (errorStr.includes('invalid_grant') || errorStr.includes('Token has been expired or revoked')) {
      deps.syncRepo.markRevoked(job.data.userId);
      const revokedLang = deps.getUserLang?.(job.data.userId) ?? 'en';
      deps.sendMessage(job.data.userId, t(revokedLang).gcal_revoked).catch(() => {});
    }

    if (errorStr.includes('Rate Limit Exceeded') || (err as { code?: number }).code === 429) {
      const retryAfterMs = parseRetryAfter(err) ?? 60_000;
      queue.add(job.name, job.data, { delay: retryAfterMs }).catch(() => {});
      syncLogger.warn({ userId: job.data.userId, retryAfterMs }, 'Rate limited by Google, re-queued with delay');
    }
  });

  return { queue, worker, syncService, changeNotifier };
}

function parseRetryAfter(err: unknown): number | undefined {
  const headers = (err as { response?: { headers?: Record<string, string> } }).response?.headers;
  const retryAfter = headers?.['retry-after'];
  if (retryAfter) return Number(retryAfter) * 1000;
  return undefined;
}
