// src/bootstrap/google-sync.ts
//
// Startup phase: Google Calendar two-way sync (OAuth service, BullMQ sync queue + worker, push
// schedulers, cron jobs). Runs only when both GOOGLE_CLIENT_ID and REDIS_URL are set.
//
// Ordering invariants:
//  - It runs AFTER the web server is already listening: the Google fields of webServerDeps
//    (oauthService, stateLookup, onConnected, onWebhook) are filled into the live object here.
//  - It runs BEFORE createBot(): the returned googleDeps / changeNotifier / push schedulers are
//    inputs to the bot. Closures that need the bot (calendar picker) read it through `bot.get()` at
//    call time, never at wiring time.
//  - The Google modules are imported lazily, in this order, only when the feature is enabled.
//  - The cron/startup-reconcile jobs are scheduled last, after every wiring step has succeeded.

import type { Queue } from 'bullmq';
import { InlineKeyboard } from 'gramio';
import { buildCalendarPickerKeyboard } from '../bot/commands/calendars.ts';
import type { DisconnectDeps } from '../bot/commands/disconnect-google.ts';
import type { GoogleBotDeps } from '../bot/index.ts';
import { type Lang, t } from '../config/constants.ts';
import type { CalendarEvent } from '../database/types.ts';
import type { EventChangeNotifier } from '../services/event/event-change-notifier.ts';
import type { ChangeNotifierSyncDeps, GoogleSyncJobData } from '../services/google/sync-queue.ts';
import { ReminderMaterializer } from '../services/notification/materializer.ts';
import { botLogger } from '../utils/logger.ts';
import type { BotHandle, TelegramSendApi } from './bot-ref.ts';
import { createOAuthRedisLock, createOAuthStateStore, type OAuthStateStore } from './redis-adapters.ts';
import type { StartupContext } from './runtime.ts';

export type ParticipantPushScheduler = (
  participantUserId: number,
  eventId: number,
  action: 'create' | 'update' | 'delete',
) => Promise<void>;

/** What the rest of startup needs from the Google sync phase. Absent when Google sync is not configured. */
export interface GoogleSyncWiring {
  googleDeps: GoogleBotDeps;
  syncQueue: Queue<GoogleSyncJobData>;
  changeNotifier: EventChangeNotifier | undefined;
  participantPushScheduler: ParticipantPushScheduler;
  /** Re-pushes all Google Calendar copies of an event after its place is confirmed or dropped */
  pushEventCopies: (event: CalendarEvent) => Promise<void>;
}

async function loadGoogleSyncModules() {
  const { GoogleOAuthService } = await import('../services/google/oauth.ts');
  const { createGoogleSyncQueue } = await import('../services/google/sync-queue.ts');
  const { createPushScheduler, createParticipantPushScheduler, createEventCopiesPushScheduler } = await import(
    '../services/google/push-scheduler.ts'
  );
  const { enqueueStartupReconcile, executeSyncCronTick, setupSyncCron } = await import(
    '../services/google/sync-cron.ts'
  );
  const { renewExpiringChannels, setupWatchRenewalCron } = await import('../services/google/watch-renewal-cron.ts');
  const { executeCleanup, setupCleanupCron } = await import('../services/google/cleanup-cron.ts');
  return {
    GoogleOAuthService,
    createGoogleSyncQueue,
    createPushScheduler,
    createParticipantPushScheduler,
    createEventCopiesPushScheduler,
    enqueueStartupReconcile,
    executeSyncCronTick,
    setupSyncCron,
    renewExpiringChannels,
    setupWatchRenewalCron,
    executeCleanup,
    setupCleanupCron,
  };
}

interface SyncMessaging {
  sendSyncNotification: (telegramId: number, text: string) => Promise<void>;
  editSyncMessage: (chatId: number, messageId: number, text: string) => Promise<void>;
  getSyncUserLang: (userId: number) => Lang;
}

function createSyncMessaging(ctx: StartupContext): SyncMessaging {
  const { db, botRef } = ctx;
  const sendSyncNotification = (telegramId: number, text: string) =>
    botRef
      .sendMessage(telegramId, text)
      .then(() => {})
      .catch((err) => botLogger.error({ err, telegramId }, 'Failed to send sync notification'));

  const editSyncMessage = (chatId: number, messageId: number, text: string) =>
    botRef.editMessage(chatId, messageId, text);

  const getSyncUserLang = (userId: number) => (db.users.findByTelegramId(userId)?.language ?? 'en') as Lang;

  return { sendSyncNotification, editSyncMessage, getSyncUserLang };
}

/** After a calendar refresh the user picks which calendars to sync; the picker is sent through the bot API. */
function createCalendarPickerSender(ctx: StartupContext, bot: BotHandle<{ api: TelegramSendApi }>) {
  const { db } = ctx;
  return async (userId: number) => {
    const user = db.users.findByTelegramId(userId);
    const lang = (user?.language ?? 'en') as Lang;
    const calendars = db.googleCalendars.getCalendars(userId);
    const keyboard = buildCalendarPickerKeyboard(calendars, lang);
    await bot
      .get()
      .api.sendMessage({
        chat_id: userId,
        text: t(lang).gcal_calendar_picker,
        reply_markup: keyboard,
      })
      .catch((err) => botLogger.error({ err, userId }, 'Failed to show calendar picker'));
  };
}

function createProposalButtonsSender(ctx: StartupContext) {
  const { botRef } = ctx;
  return async (userId: number, text: string, buttons: { text: string; callbackData: string }[][]) => {
    const kb = new InlineKeyboard();
    for (const row of buttons) {
      for (const btn of row) {
        kb.text(btn.text, btn.callbackData);
      }
      kb.row();
    }
    const msg = await botRef.sendMessage(userId, text, undefined, kb.toJSON()).catch((err) => {
      botLogger.error({ err, userId }, 'Failed to send proposal with buttons');
      return null;
    });
    if (!msg) return null;
    return { messageId: msg.message_id, chatId: userId };
  };
}

function buildChangeNotifierDeps(ctx: StartupContext, messaging: SyncMessaging): ChangeNotifierSyncDeps {
  const { db } = ctx;
  return {
    participantRepo: db.participants,
    editProposalRepo: db.editProposals,
    participantSyncRepo: db.participantGoogleSync,
    invitationRepo: db.invitations,
    materializer: new ReminderMaterializer(db.eventReminders, db.notificationPreferences),
    notifyUser: messaging.sendSyncNotification,
    editMessage: messaging.editSyncMessage,
    sendMessageWithButtons: createProposalButtonsSender(ctx),
    getUserLang: messaging.getSyncUserLang,
    getUserName: (userId) => {
      const user = db.users.findByTelegramId(userId);
      return user?.first_name ?? user?.username ?? `User ${userId}`;
    },
  };
}

function buildDisconnectDeps(
  ctx: StartupContext,
  oauthService: DisconnectDeps['oauthService'],
  queue: Queue<GoogleSyncJobData>,
): DisconnectDeps {
  const { config, db } = ctx;
  return {
    config,
    oauthService,
    userRepo: db.users,
    eventRepo: db.events,
    syncRepo: db.googleSync,
    calendarRepo: db.googleCalendars,
    participantSyncRepo: db.participantGoogleSync,
    stopWatchChannels: async (userId) => {
      await queue.add('stop-watch', { type: 'stop-watch', userId });
    },
  };
}

function wireWebServer(
  ctx: StartupContext,
  oauthService: GoogleBotDeps['oauthService'],
  stateStore: OAuthStateStore,
  queue: Queue<GoogleSyncJobData>,
): void {
  const { db, webServerDeps } = ctx;
  webServerDeps.oauthService = oauthService;
  webServerDeps.syncRepo = db.googleSync;
  webServerDeps.calendarRepo = db.googleCalendars;
  webServerDeps.stateLookup = stateStore;
  webServerDeps.onConnected = async (userId) => {
    await queue.add('refresh-calendars', { type: 'refresh-calendars', userId });
  };
  webServerDeps.onWebhook = async (channelId, resourceId) => {
    const channel = db.googleCalendars.findChannelByIds(channelId, resourceId);
    if (!channel) return;
    const cal = db.googleCalendars.getCalendarById(channel.google_calendar_row_id);
    if (!cal) return;
    await queue.add('pull-sync', {
      type: 'pull-sync',
      userId: cal.user_id,
      calendarId: cal.google_calendar_id,
      trigger: 'webhook',
    });
  };
}

export async function initGoogleSync(
  ctx: StartupContext,
  bot: BotHandle<{ api: TelegramSendApi }>,
): Promise<GoogleSyncWiring | undefined> {
  const { config, db } = ctx;
  if (!(config.GOOGLE_CLIENT_ID && config.REDIS_URL)) return undefined;

  const mods = await loadGoogleSyncModules();
  const redis = new Bun.RedisClient(config.REDIS_URL);
  ctx.resources.googleRedisClient = redis;
  // Provide a lock client to GoogleOAuthService to prevent concurrent token refreshes
  const oauthService = new mods.GoogleOAuthService(config, db.users, db.googleSync, createOAuthRedisLock(redis));
  const stateStore = createOAuthStateStore(redis);
  const messaging = createSyncMessaging(ctx);

  const {
    queue,
    worker,
    changeNotifier: syncChangeNotifier,
  } = mods.createGoogleSyncQueue({
    db: db.db,
    config,
    redisUrl: config.REDIS_URL,
    oauthService,
    eventRepo: db.events,
    syncRepo: db.googleSync,
    calendarRepo: db.googleCalendars,
    participantSyncRepo: db.participantGoogleSync,
    getUserLang: messaging.getSyncUserLang,
    onCronSyncTick: (q) => mods.executeSyncCronTick(q, db.googleSync, db.googleCalendars),
    onWatchRenewalTick: () => mods.renewExpiringChannels(config, oauthService, db.googleCalendars),
    onCleanupTick: () => mods.executeCleanup(db.googleSync, db.googleCalendars),
    onCalendarsRefreshed: createCalendarPickerSender(ctx, bot),
    sendMessage: messaging.sendSyncNotification,
    changeNotifierDeps: buildChangeNotifierDeps(ctx, messaging),
  });

  ctx.resources.syncQueue = {
    close: async () => {
      await worker.close();
      await queue.close();
    },
  };

  const pushScheduler = mods.createPushScheduler(db.googleSync, db.events, queue);
  const participantPushScheduler = mods.createParticipantPushScheduler(db.googleSync, db.participantGoogleSync, queue);
  const pushEventCopies = mods.createEventCopiesPushScheduler(
    pushScheduler,
    participantPushScheduler,
    db.participantGoogleSync,
    db.participants,
  );

  const googleDeps: GoogleBotDeps = {
    oauthService,
    stateStore,
    disconnectDeps: buildDisconnectDeps(ctx, oauthService, queue),
    calendarRepo: db.googleCalendars,
    syncRepo: db.googleSync,
    schedulePush: pushScheduler,
    scheduleParticipantPush: participantPushScheduler,
    triggerSync: async (userId: number) => {
      await queue.add('pull-sync', { type: 'pull-sync', userId, trigger: 'manual' });
    },
    onCalendarsDone: async (userId) => {
      const calendars = db.googleCalendars.getEnabledCalendars(userId);
      for (const cal of calendars) {
        await queue.add('initial-sync', {
          type: 'initial-sync',
          userId,
          calendarId: cal.google_calendar_id,
        });
      }
    },
  };

  // Wire Google deps into the already-running web server
  wireWebServer(ctx, oauthService, stateStore, queue);

  await mods.setupSyncCron(queue);
  await mods.enqueueStartupReconcile(queue, db.googleSync);
  await mods.setupWatchRenewalCron(queue);
  await mods.setupCleanupCron(queue);

  botLogger.info('Google Calendar sync initialized');

  return {
    googleDeps,
    syncQueue: queue,
    changeNotifier: syncChangeNotifier,
    participantPushScheduler,
    pushEventCopies,
  };
}
