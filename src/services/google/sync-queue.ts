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
  | 'reconcile-sync'
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
  trigger?: 'cron' | 'webhook' | 'manual' | 'startup';
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
      invitationRepo: cnd.invitationRepo,
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

  /** Cron ticks carry no user: they call the configured hook and need no Google client. */
  async function runCronTick(type: GoogleSyncJobType): Promise<boolean> {
    if (type === 'cron-sync-tick') {
      await deps.onCronSyncTick?.(queue);
      return true;
    }
    if (type === 'cron-watch-renewal-tick') {
      await deps.onWatchRenewalTick?.();
      return true;
    }
    if (type === 'cron-cleanup-tick') {
      deps.onCleanupTick?.();
      return true;
    }
    return false;
  }

  /** undefined when the user is not connected to Google or revoked the token: the job is skipped, not failed. */
  async function authClientOrSkip(userId: number, type: GoogleSyncJobType): Promise<OAuth2Client | undefined> {
    try {
      return await deps.oauthService.getAuthClient(userId);
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === 'GoogleNotConnectedError' || name === 'GoogleTokenRevokedError') {
        syncLogger.warn({ userId, type }, 'Skipping sync — user not connected or token revoked');
        return undefined;
      }
      throw err;
    }
  }

  async function pullSync(api: GoogleCalendarApi, userId: number, calendarId: string | undefined) {
    if (calendarId) {
      await syncService.incrementalPull(api, userId, calendarId);
      return;
    }
    for (const cal of deps.calendarRepo.getEnabledCalendars(userId)) {
      await syncService.incrementalPull(api, userId, cal.google_calendar_id);
    }
  }

  async function reconcileSync(api: GoogleCalendarApi, userId: number, calendarId: string | undefined) {
    const calendarIds = calendarId
      ? [calendarId]
      : deps.calendarRepo.getEnabledCalendars(userId).map((cal) => cal.google_calendar_id);
    for (const id of calendarIds) {
      await syncService.reconcileDeletions(api, userId, id);
    }
  }

  async function pushEvent(api: GoogleCalendarApi, data: GoogleSyncJobData) {
    const { userId, eventId, action } = data;
    if (!eventId || !action) throw new Error('eventId and action required for push-event');
    if (action === 'delete' && data.googleEventId) {
      await api.deleteEvent(data.calendarId ?? 'primary', data.googleEventId);
      return;
    }
    await syncService.pushEvent(api, userId, eventId, action);
  }

  async function refreshCalendars(api: GoogleCalendarApi, userId: number) {
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
  }

  async function setupWatch(api: GoogleCalendarApi, userId: number, calendarId: string | undefined) {
    if (!calendarId || !deps.config.PUBLIC_DOMAIN) return;
    const cal = deps.calendarRepo.getCalendarByGoogleId(userId, calendarId);
    if (!cal) return;
    await syncService.setupWatchChannel(api, cal.id, calendarId, deps.config.PUBLIC_DOMAIN);
  }

  async function stopWatch(api: GoogleCalendarApi, userId: number) {
    for (const cal of deps.calendarRepo.getCalendars(userId)) {
      for (const ch of deps.calendarRepo.getWatchChannels(cal.id)) {
        await api.stopChannel(ch.channel_id, ch.resource_id);
        deps.calendarRepo.deleteWatchChannel(ch.id);
      }
    }
  }

  async function runApiJob(api: GoogleCalendarApi, data: GoogleSyncJobData) {
    const { type, userId, calendarId, eventId, action } = data;
    switch (type) {
      case 'initial-sync':
        if (!calendarId) throw new Error('calendarId required for initial-sync');
        await syncService.initialSync(api, userId, calendarId);
        await deps.onSyncComplete?.(userId, calendarId);
        break;
      case 'pull-sync':
        await pullSync(api, userId, calendarId);
        break;
      case 'reconcile-sync':
        await reconcileSync(api, userId, calendarId);
        break;
      case 'push-event':
        await pushEvent(api, data);
        break;
      case 'push-participant-event':
        if (!eventId || !action) throw new Error('eventId and action required for push-participant-event');
        await syncService.pushParticipantEvent(api, userId, eventId, action, undefined, data);
        break;
      case 'refresh-calendars':
        await refreshCalendars(api, userId);
        break;
      case 'setup-watch':
        await setupWatch(api, userId, calendarId);
        break;
      case 'stop-watch':
        await stopWatch(api, userId);
        break;
    }
  }

  const worker = new Worker<GoogleSyncJobData>(
    'google-sync',
    async (job) => {
      const { type, userId, calendarId } = job.data;
      if (await runCronTick(type)) return;

      syncLogger.info({ type, userId, calendarId, jobId: job.id }, 'Processing sync job');

      const authClient = await authClientOrSkip(userId, type);
      if (!authClient) return;

      const api = deps.createCalendarApi ? deps.createCalendarApi(authClient) : new GoogleCalendarApi(authClient);
      await runApiJob(api, job.data);
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
