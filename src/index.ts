import { createNotificationSender } from './services/notification/worker.ts';
import { formatSessionLoss } from './services/telegram-session/session-loss.ts';
// src/index.ts

import type { InlineKeyboard, TelegramInlineKeyboardMarkup, TelegramReplyKeyboardMarkup } from 'gramio';
import { z } from 'zod';
import { buildCalendarPickerKeyboard } from './bot/commands/calendars.ts';
import type { DisconnectDeps } from './bot/commands/disconnect-google.ts';
import { createBot, type GoogleBotDeps } from './bot/index.ts';
import type { Lang } from './config/constants.ts';
import { t } from './config/constants.ts';
import { loadConfig } from './config/env.ts';
import { createDatabase } from './database/index.ts';
import { AgendaRepository } from './database/repositories/agenda.repository.ts';
import type { CalendarEvent } from './database/types.ts';
import { AGENT_DRAIN_SETTLE_MS } from './services/ai/agent.ts';
import { AiDebugLogger } from './services/ai/debug-logger.ts';
import { HistorySummarizer } from './services/ai/history-summarizer.ts';
import { configureProviderCircuit } from './services/ai/provider-circuit.ts';
import { aiStreamRound } from './services/ai/streaming.ts';
import { runSyntheticIntent } from './services/intent/synthetic-intent-run.ts';
import { DomainEventBus } from './services/scheduled/domain-event-bus.ts';
import { InvitationCardRefresher } from './services/sharing/invitation-cards.ts';
import { hasChainAnswered, initProviderAlerts, isAiChainDown } from './utils/ai-provider-alert.ts';
import { botLogger } from './utils/logger.ts';
import { makeWorkerFailureHandler } from './utils/worker-alert.ts';
import { startWebServer, type WebServerDeps } from './web/server.ts';

// Filled in after db + config are initialized — best-effort, push() is synchronous
let pushCrashAlert: ((msg: string) => void) | undefined;

process.on('uncaughtException', (error: Error) => {
  botLogger.fatal({ err: error }, 'Uncaught exception');
  pushCrashAlert?.(`Bot crashed: ${error.stack ?? error.message}`);
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  // AbortError ("The connection was closed") is a transient network issue — log and continue.
  // Bun's DOMException has no stack trace; crashing gives zero diagnostic value.
  const isAbort = err.name === 'AbortError' || err.message?.includes('The connection was closed');
  if (isAbort) {
    botLogger.warn({ err, name: err.name, message: err.message }, 'Transient AbortError (not crashing)');
    return;
  }
  botLogger.fatal({ err }, 'Unhandled promise rejection');
  pushCrashAlert?.(`Bot unhandled rejection: ${err.stack ?? err.message}`);
  process.exit(1);
});

const config = loadConfig();
const db = createDatabase(config.DATABASE_PATH);

if (config.ADMIN_ALERT_TOKEN) {
  pushCrashAlert = (msg) => db.alerts.push(msg, 'bot-crash');
}

// Verify master key matches existing sessions before starting the bot
if (config.TELEGRAM_SESSION_MASTER_KEY) {
  const { verifyMasterKey } = await import('./services/crypto/master-key-check.ts');
  const key = Buffer.from(config.TELEGRAM_SESSION_MASTER_KEY, 'hex');
  const result = verifyMasterKey(db.telegramSessions, key);
  if (!result.ok) {
    botLogger.fatal(
      { err: result.err },
      'TELEGRAM_SESSION_MASTER_KEY does not match existing sessions — refusing to start',
    );
    process.exit(1);
  }
}

// Unconditional: /ready reads the outage record this keeps, and whether an admin
// chat is configured has nothing to do with whether the bot can answer people.
// Without an admin the alerts are logged instead of sent.
initProviderAlerts({ botToken: config.BOT_TOKEN, adminId: config.BOT_ADMIN_ID });

// Durable per-account provider circuits live in a sidecar next to the calendar
// database, so a deploy does not forget which accounts are out.
configureProviderCircuit(`${config.DATABASE_PATH}.provider-state.sqlite`);

// Returns a BullMQ 'failed' handler: logs via pino, Telegrams the admin, pushes to alert queue.
// When BOT_ADMIN_ID is absent (dev/test), still logs — just skips Telegram + alert queue.
function onWorkerFailed(name: string): (job: { id?: string } | undefined, err: Error) => void {
  const alertHandler = config.BOT_ADMIN_ID
    ? makeWorkerFailureHandler(name, {
        botToken: config.BOT_TOKEN,
        adminId: config.BOT_ADMIN_ID,
        pushAlert: config.ADMIN_ALERT_TOKEN ? (msg, src) => db.alerts.push(msg, src) : undefined,
      })
    : null;
  return (job, err) => {
    // UnrecoverableError = intentional permanent failure (e.g. Telegram 403).
    // Already logged at warn by the throwing site — don't spam error logs.
    if (err.name === 'UnrecoverableError') {
      botLogger.warn({ jobId: job?.id, worker: name, err }, 'Worker job permanently failed (no retry)');
    } else {
      botLogger.error({ jobId: job?.id, worker: name, err }, 'Worker job failed');
    }
    alertHandler?.(job, err);
  };
}

const aiDebugLogger = new AiDebugLogger(!!config.AI_DEBUG_LOGS, 'logs');

const summarizerRedis = new Bun.RedisClient(config.REDIS_URL);
const historySummarizer = new HistorySummarizer(
  {
    get: (key) => summarizerRedis.get(key),
    set: (key, value, exMode, ttl) =>
      exMode && ttl ? summarizerRedis.set(key, value, exMode, ttl) : summarizerRedis.set(key, value),
  },
  aiStreamRound,
);

type ParseMode = 'HTML' | 'MarkdownV2' | 'Markdown';
type ReplyMarkup = TelegramInlineKeyboardMarkup | TelegramReplyKeyboardMarkup;

// Mutable ref — patched after bot creation
const botRef: {
  sendMessage: (
    telegramId: number,
    text: string,
    parseMode?: ParseMode,
    replyMarkup?: ReplyMarkup,
  ) => Promise<{ message_id: number }>;
  sendVoice: (telegramId: number, audio: Buffer) => Promise<void>;
  editMessage: (
    chatId: number,
    messageId: number,
    text: string,
    parseMode?: ParseMode,
    replyMarkup?: InlineKeyboard,
  ) => Promise<void>;
} = {
  sendMessage: async () => ({ message_id: 0 }),
  sendVoice: async () => {},
  editMessage: async () => {},
};

let googleDeps: GoogleBotDeps | undefined;

// Mutable deps — Google fields are filled in once GOOGLE_CLIENT_ID is confirmed
const webServerDeps: WebServerDeps = {
  config,
  userRepo: db.users,
  botStarted: false,
  alertRepo: db.alerts,
  adminAlertToken: config.ADMIN_ALERT_TOKEN,
  // The cron watchdog polls /ready every two minutes, and this is what lets it
  // see a total provider outage. Process liveness alone never showed one.
  aiChainDown: isAiChainDown,
  aiChainVerified: hasChainAnswered,
};
const webServerHandle: { stop: () => void } | undefined = startWebServer(webServerDeps);
let syncQueueCleanup: { close: () => Promise<void> } | undefined;
let googleSyncQueueRef: import('bullmq').Queue | undefined;
let syncChangeNotifierRef: import('./services/event/event-change-notifier.ts').EventChangeNotifier | undefined;
let imageQueueCleanup: { close: () => Promise<void> } | undefined;
let renderService: import('./services/image/render-service.ts').RenderService | undefined;
let notificationQueueCleanup: { close: () => Promise<void> } | undefined;
let botTasksQueueCleanup: { close: () => Promise<void> } | undefined;
let googleRedisClient: Bun.RedisClient | undefined;
let participantPushSchedulerRef:
  | ((participantUserId: number, eventId: number, action: 'create' | 'update' | 'delete') => Promise<void>)
  | undefined;
/** Re-pushes all Google Calendar copies of an event after its place is confirmed or dropped */
let pushEventCopiesRef: ((event: CalendarEvent) => Promise<void>) | undefined;
if (config.GOOGLE_CLIENT_ID && config.REDIS_URL) {
  const { GoogleOAuthService } = await import('./services/google/oauth.ts');
  const { createGoogleSyncQueue } = await import('./services/google/sync-queue.ts');
  const { createPushScheduler, createParticipantPushScheduler, createEventCopiesPushScheduler } = await import(
    './services/google/push-scheduler.ts'
  );
  const { executeSyncCronTick, setupSyncCron } = await import('./services/google/sync-cron.ts');
  const { renewExpiringChannels, setupWatchRenewalCron } = await import('./services/google/watch-renewal-cron.ts');
  const { executeCleanup, setupCleanupCron } = await import('./services/google/cleanup-cron.ts');
  const redis = new Bun.RedisClient(config.REDIS_URL);
  googleRedisClient = redis;
  // Provide a lock client to GoogleOAuthService to prevent concurrent token refreshes
  const oauthRedisLock = {
    set: (key: string, value: string, mode: 'NX', expMode: 'EX', seconds: number) =>
      redis.set(key, value, expMode, String(seconds), mode),
    get: (key: string) => redis.get(key),
    del: (key: string) => redis.del(key),
  };
  const oauthService = new GoogleOAuthService(config, db.users, db.googleSync, oauthRedisLock);

  const stateStore = {
    set: async (key: string, value: string, ttl: number) => {
      await redis.set(key, value, 'EX', ttl);
    },
    get: async (key: string) => redis.get(key),
    del: async (key: string) => {
      await redis.del(key);
    },
  };

  const { ReminderMaterializer } = await import('./services/notification/materializer.ts');
  const syncMaterializer = new ReminderMaterializer(db.eventReminders, db.notificationPreferences);

  const sendSyncNotification = (telegramId: number, text: string) =>
    botRef
      .sendMessage(telegramId, text)
      .then(() => {})
      .catch((err) => botLogger.error({ err, telegramId }, 'Failed to send sync notification'));

  const editSyncMessage = (chatId: number, messageId: number, text: string) =>
    botRef.editMessage(chatId, messageId, text);

  const getSyncUserLang = (userId: number) => (db.users.findByTelegramId(userId)?.language ?? 'en') as Lang;

  const {
    queue,
    worker,
    changeNotifier: syncChangeNotifier,
  } = createGoogleSyncQueue({
    db: db.db,
    config,
    redisUrl: config.REDIS_URL,
    oauthService,
    eventRepo: db.events,
    syncRepo: db.googleSync,
    calendarRepo: db.googleCalendars,
    participantSyncRepo: db.participantGoogleSync,
    getUserLang: getSyncUserLang,
    onCronSyncTick: (q) => executeSyncCronTick(q, db.googleSync, db.googleCalendars),
    onWatchRenewalTick: () => renewExpiringChannels(config, oauthService, db.googleCalendars),
    onCleanupTick: () => executeCleanup(db.googleSync, db.googleCalendars),
    onCalendarsRefreshed: async (userId) => {
      const user = db.users.findByTelegramId(userId);
      const lang = (user?.language ?? 'en') as Lang;
      const calendars = db.googleCalendars.getCalendars(userId);
      const keyboard = buildCalendarPickerKeyboard(calendars, lang);
      await bot.api
        .sendMessage({
          chat_id: userId,
          text: t(lang).gcal_calendar_picker,
          reply_markup: keyboard,
        } as Parameters<typeof bot.api.sendMessage>[0])
        .catch((err) => botLogger.error({ err, userId }, 'Failed to show calendar picker'));
    },
    sendMessage: sendSyncNotification,
    changeNotifierDeps: {
      participantRepo: db.participants,
      editProposalRepo: db.editProposals,
      participantSyncRepo: db.participantGoogleSync,
      invitationRepo: db.invitations,
      materializer: syncMaterializer,
      notifyUser: sendSyncNotification,
      editMessage: editSyncMessage,
      sendMessageWithButtons: async (userId, text, buttons) => {
        const { InlineKeyboard } = await import('gramio');
        const kb = new InlineKeyboard();
        for (const row of buttons) {
          for (const btn of row) {
            kb.text(btn.text, btn.callbackData);
          }
          kb.row();
        }
        const msg = await botRef.sendMessage(userId, text, undefined, kb as never).catch((err) => {
          botLogger.error({ err, userId }, 'Failed to send proposal with buttons');
          return null;
        });
        if (!msg) return null;
        return { messageId: msg.message_id, chatId: userId };
      },
      getUserLang: getSyncUserLang,
      getUserName: (userId) => {
        const user = db.users.findByTelegramId(userId);
        return user?.first_name ?? user?.username ?? `User ${userId}`;
      },
    },
  });

  googleSyncQueueRef = queue;
  syncChangeNotifierRef = syncChangeNotifier;
  syncQueueCleanup = {
    close: async () => {
      await worker.close();
      await queue.close();
    },
  };

  const pushScheduler = createPushScheduler(db.googleSync, db.events, queue);
  const participantPushScheduler = createParticipantPushScheduler(db.googleSync, db.participantGoogleSync, queue);
  participantPushSchedulerRef = participantPushScheduler;
  pushEventCopiesRef = createEventCopiesPushScheduler(
    pushScheduler,
    participantPushScheduler,
    db.participantGoogleSync,
    db.participants,
  );

  const disconnectDeps: DisconnectDeps = {
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

  googleDeps = {
    oauthService,
    stateStore,
    disconnectDeps,
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

  await setupSyncCron(queue);
  await setupWatchRenewalCron(queue);
  await setupCleanupCron(queue);

  botLogger.info('Google Calendar sync initialized');
}

if (config.REDIS_URL) {
  const { createImageRenderQueue } = await import('./worker/image-render.queue.ts');
  const { RenderService } = await import('./services/image/render-service.ts');
  const { playwrightPool } = await import('./worker/playwright-pool.ts');

  try {
    await playwrightPool.initialize();

    const { queue: imageQueue, worker, queueEvents } = createImageRenderQueue(config.REDIS_URL);
    worker.on('failed', onWorkerFailed('image-render'));
    renderService = new RenderService(
      imageQueue as import('bullmq').Queue<import('./worker/image-render.queue.ts').ImageRenderJob>,
      queueEvents,
    );

    imageQueueCleanup = {
      close: async () => {
        await worker.close();
        await imageQueue.close();
        await queueEvents.close();
        await playwrightPool.shutdown();
      },
    };

    botLogger.info('Image render queue initialized');
  } catch (err) {
    botLogger.error({ err }, 'Playwright initialization failed — image rendering disabled');
  }
}

// Broadcast queue — enqueuer created early so createBot() can wire it into tool handlers.
// Worker is created later, after botRef is patched (see below "Broadcast worker").
const { createBroadcastQueue, createBroadcastWorker } = await import('./worker/broadcast-queue.ts');
const { parseRedisUrl } = await import('./utils/redis.ts');
const broadcastConnection = parseRedisUrl(config.REDIS_URL);
const broadcastRedisClient = new Bun.RedisClient(config.REDIS_URL);
const broadcastRedis = {
  set: async (key: string, value: string, ex: number) => {
    await broadcastRedisClient.set(key, value, 'EX', ex);
  },
  get: (key: string) => broadcastRedisClient.get(key),
  sadd: async (key: string, member: string) => {
    await broadcastRedisClient.send('SADD', [key, member]);
  },
  smembers: async (key: string): Promise<string[]> => {
    const result = await broadcastRedisClient.send('SMEMBERS', [key]);
    return z.array(z.string()).parse(result ?? []);
  },
  incr: async (key: string): Promise<number> => {
    const result = await broadcastRedisClient.send('INCR', [key]);
    return z.number().parse(result);
  },
  del: async (...keys: string[]) => {
    await broadcastRedisClient.send('DEL', keys);
  },
  expire: async (key: string, seconds: number) => {
    await broadcastRedisClient.send('EXPIRE', [key, String(seconds)]);
  },
};
const { queue: broadcastQueue, enqueuer: broadcastEnqueuer } = createBroadcastQueue(
  broadcastConnection,
  broadcastRedis,
);
let broadcastQueueCleanup: { close: () => Promise<void> } | undefined;

// Weather service — optional, requires OPENWEATHER_API_KEY
let weatherService: import('./services/weather/weather-service.ts').WeatherService | undefined;
if (config.OPENWEATHER_API_KEY) {
  const { WeatherService } = await import('./services/weather/weather-service.ts');
  weatherService = new WeatherService({ apiKey: config.OPENWEATHER_API_KEY });
  botLogger.info('Weather service initialized');
}

// Notification scheduler — requires Redis for BullMQ queue
if (config.REDIS_URL) {
  const { createNotificationQueue, createNotificationWorker, setupNotificationTick } = await import(
    './services/notification/queue.ts'
  );
  const { NotificationScheduler } = await import('./services/notification/scheduler.ts');
  const { EventService } = await import('./services/event/event-service.ts');

  const notifQueue = createNotificationQueue(config.REDIS_URL);

  const notifEventService = new EventService({
    eventRepo: db.events,
  });

  const scheduler = new NotificationScheduler({
    prefsRepo: db.notificationPreferences,
    reminderRepo: db.eventReminders,
    logRepo: db.notificationLog,
    userRepo: db.users,
    getEventsInRange: (userId, startUtc, endUtc) => notifEventService.getEventsInRange(userId, startUtc, endUtc),
    enqueue: (type, userId, logId, payload) => {
      notifQueue.add(type, { logId, telegramId: userId, type, payload });
    },
    weatherService,
    featureUsageRepo: db.featureUsage,
  });

  const notifWorker = createNotificationWorker(
    config.REDIS_URL,
    db.notificationLog,
    createNotificationSender(botRef),
    scheduler,
  );

  await setupNotificationTick(notifQueue);

  notificationQueueCleanup = {
    close: async () => {
      await notifWorker.close();
      await notifQueue.close();
    },
  };

  botLogger.info('Notification scheduler initialized');
}

if (config.REDIS_URL) {
  const {
    createBotTasksQueue,
    setupSecretaryExpiryCron,
    setupSharingCleanupCron,
    setupProposalExpiryCron,
    setupEditProposalExpiryCron,
    setupSessionCleanupCron,
    unscheduleRetiredCrons,
    setupChatHistoryCleanupCron,
    setupSqliteBackupCron,
    setupRecurringRemindersCron,
    setupActionLogCleanupCron,
    setupSessionKeepaliveCron,
  } = await import('./worker/bot-tasks-queue.ts');
  const { runSqliteBackup } = await import('./database/backup.ts');
  const { runSecretaryExpiry } = await import('./worker/secretary-expiry.ts');
  const { runSharingCleanup } = await import('./services/sharing/sharing-cleanup.ts');
  const { runProposalExpiry } = await import('./worker/proposal-expiry.ts');
  const { processExpiredEditProposals } = await import('./services/google/edit-proposal-expiry.ts');
  const { ReminderMaterializer } = await import('./services/notification/materializer.ts');
  const { processSessionKeepalive } = await import('./worker/session-keepalive.ts');

  const cronMaterializer = new ReminderMaterializer(db.eventReminders, db.notificationPreferences);
  const { queue: botTasksQueue, worker: botTasksWorker } = createBotTasksQueue({
    redisUrl: config.REDIS_URL,
    onSecretaryExpiry: () =>
      runSecretaryExpiry({
        secretaryRepo: db.secretaries,
        userRepo: db.users,
        notify: (userId, text) =>
          botRef
            .sendMessage(userId, text)
            .then(() => {})
            .catch((err) => botLogger.error({ err, userId }, 'Failed to send secretary expiry notification')),
      }),
    onSharingCleanup: () => runSharingCleanup({ invitationRepo: db.invitations, deepLinkRepo: db.deepLinks }),
    onProposalExpiry: () =>
      runProposalExpiry({
        proposalRepo: db.calendarProposals,
        editMessage: (chatId, messageId, text) => botRef.editMessage(chatId, messageId, text),
      }),
    onEditProposalExpiry: () => {
      if (!googleSyncQueueRef) return Promise.resolve();
      return processExpiredEditProposals({
        editProposalRepo: db.editProposals,
        eventRepo: db.events,
        syncQueue: googleSyncQueueRef,
        notifyUser: (userId, text) =>
          botRef
            .sendMessage(userId, text)
            .then(() => {})
            .catch((err) => botLogger.error({ err, userId }, 'Failed to notify about edit proposal expiry')),
        editMessage: (chatId, messageId, text) => botRef.editMessage(chatId, messageId, text),
        getUserLang: (userId) => (db.users.findByTelegramId(userId)?.language ?? 'en') as Lang,
      });
    },
    onSessionCleanup: () => {
      db.workflowSessions.cleanup();
      db.groupSessions.deleteExpired();
    },
    onActionLogCleanup: () => {
      const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60_000).toISOString().slice(0, 19).replace('T', ' ');
      const deleted = db.actionLog.deleteOlderThan(cutoff);
      if (deleted > 0) botLogger.info({ deleted }, 'Action log cleanup: removed old entries');
    },
    onChatHistoryCleanup: () => {
      const deleted = db.chatHistory.deleteOlderThan(90);
      botLogger.info({ deleted }, 'Cleaned up old chat history');
    },
    onSqliteBackup: () => runSqliteBackup(db.db, config.DATABASE_PATH),
    onRecurringReminders: () => {
      cronMaterializer.materializeUpcomingRecurringReminders(db.events);
    },
    onSessionKeepalive: config.TELEGRAM_SESSION_MASTER_KEY
      ? async () => {
          const masterKey = Buffer.from(config.TELEGRAM_SESSION_MASTER_KEY as string, 'hex');
          await processSessionKeepalive({
            sessionRepo: db.telegramSessions,
            masterKey,
            onSessionExpired: (userId, reason) => {
              const lang = db.users.findByTelegramId(userId)?.language ?? 'en';
              botRef
                .sendMessage(userId, formatSessionLoss(lang, reason))
                .then(() => {})
                .catch((err: unknown) => botLogger.warn({ err, userId }, 'Failed to notify user of expired session'));
            },
          });
        }
      : undefined,
  });

  await setupSecretaryExpiryCron(botTasksQueue);
  await setupSharingCleanupCron(botTasksQueue);
  await setupProposalExpiryCron(botTasksQueue);
  await setupEditProposalExpiryCron(botTasksQueue);
  await setupSessionCleanupCron(botTasksQueue);
  await unscheduleRetiredCrons(botTasksQueue);
  await setupChatHistoryCleanupCron(botTasksQueue);
  await setupSqliteBackupCron(botTasksQueue);
  await setupRecurringRemindersCron(botTasksQueue);
  await setupActionLogCleanupCron(botTasksQueue);
  if (config.TELEGRAM_SESSION_MASTER_KEY) {
    await setupSessionKeepaliveCron(botTasksQueue);
  }

  botTasksWorker.on('failed', onWorkerFailed('bot-tasks'));

  botTasksQueueCleanup = {
    close: async () => {
      await botTasksWorker.close();
      await botTasksQueue.close();
    },
  };

  botLogger.info('Bot tasks queue initialized');
}

let transcriptionService: import('./services/voice/transcription-service.ts').TranscriptionService | undefined;
if (config.GROQ_API_KEY) {
  const { TranscriptionService } = await import('./services/voice/transcription-service.ts');
  transcriptionService = new TranscriptionService(config.GROQ_API_KEY);
  botLogger.info('Voice transcription initialized (Whisper via Groq)');
}

let stressDictionary: import('./services/voice/stress-dictionary.ts').StressDictionary | undefined;
try {
  const { StressDictionary } = await import('./services/voice/stress-dictionary.ts');
  stressDictionary = await StressDictionary.loadFromFile('data/dictionaries/stress-dict.json');
} catch (error) {
  botLogger.warn({ err: error }, 'Stress dictionary not loaded');
}

const { TtsService: FallbackTtsService } = await import('./services/voice/tts-service.ts');
const fallbackTts = new FallbackTtsService();

let kokoroTts: import('./services/voice/kokoro-tts-service.ts').KokoroTtsService | undefined;
if (config.HF_TOKEN) {
  const { KokoroTtsService } = await import('./services/voice/kokoro-tts-service.ts');
  kokoroTts = new KokoroTtsService(config.HF_TOKEN);
  botLogger.info('Kokoro TTS initialized');
}

let nliClassifier: import('./services/nli/nli-classifier.ts').NliClassifier | undefined;
if (config.HF_TOKEN) {
  const { NliClassifier } = await import('./services/nli/nli-classifier.ts');
  nliClassifier = new NliClassifier(config.HF_TOKEN);
  botLogger.info('NLI classifier initialized (group message semantic filter)');
}

let sileroTts: import('./services/voice/silero-tts-service.ts').SileroTtsService | undefined;
if (config.SILERO_PYTHON_PATH && stressDictionary) {
  const { SileroTtsService } = await import('./services/voice/silero-tts-service.ts');
  sileroTts = new SileroTtsService(config.SILERO_PYTHON_PATH);
  botLogger.info('Silero TTS initialized');
}

let aiMessagesQueueCleanup: { close: () => Promise<void> } | undefined;
let eventCheckerQueueCleanup: { close: () => Promise<void> } | undefined;

let eventMentionStore: import('./services/intent/event-mention-store.ts').EventMentionStore | undefined;
if (config.REDIS_URL) {
  const { RedisEventMentionStore } = await import('./services/intent/event-mention-store.ts');
  const bunRedis = new Bun.RedisClient(config.REDIS_URL);
  const redisClient = {
    set: (key: string, value: string, opts?: { ex?: number }) =>
      opts?.ex ? bunRedis.set(key, value, 'EX', opts.ex) : bunRedis.set(key, value),
    get: (key: string) => bunRedis.get(key),
  };
  eventMentionStore = new RedisEventMentionStore(redisClient);
  // City resolver cache — persistent timezone lookups
  const { initCityResolverCache } = await import('./services/timezone/city-resolver.ts');
  initCityResolverCache({ get: (k) => bunRedis.get(k), set: (k, v) => bunRedis.set(k, v) });
  botLogger.info('City resolver cache: Redis');
  webServerDeps.healthCheck = () => bunRedis.ping().then(() => {});
  botLogger.info('Event mention store: Redis (7-day TTL)');
} else {
  const { InMemoryEventMentionStore } = await import('./services/intent/event-mention-store.ts');
  eventMentionStore = new InMemoryEventMentionStore();
  botLogger.info('Event mention store: in-memory (no REDIS_URL)');
}

const domainEventBus = new DomainEventBus();

// Participant Google Sync — push accepted invitation events to invitee's Google Calendar
if (participantPushSchedulerRef) {
  const schedParticipant = participantPushSchedulerRef;
  domainEventBus.on('myInvitations.accepted', ({ inviteeId, event }) => {
    schedParticipant(inviteeId, event.id, 'create').catch((err) =>
      botLogger.error({ err, inviteeId, eventId: event.id }, 'Failed to schedule participant Google push'),
    );
  });
  domainEventBus.on('myInvitations.rejected', ({ inviteeId, event }) => {
    schedParticipant(inviteeId, event.id, 'delete').catch((err) =>
      botLogger.error({ err, inviteeId, eventId: event.id }, 'Failed to schedule participant Google delete'),
    );
  });
  domainEventBus.on('myGroup.newEvent', ({ groupChatId, newEvent }) => {
    const members = db.groupMembers.getActiveMembers(groupChatId);
    for (const member of members) {
      schedParticipant(member.user_id, newEvent.id, 'create').catch((err) =>
        botLogger.error(
          { err, userId: member.user_id, eventId: newEvent.id },
          'Failed to schedule group event Google push',
        ),
      );
    }
  });
  domainEventBus.on('myGroup.rsvp', ({ userId, eventId, status }) => {
    schedParticipant(userId, eventId, status === 'accepted' ? 'create' : 'delete').catch((err) =>
      botLogger.error({ err, userId, eventId, status }, 'Failed to schedule group RSVP Google sync'),
    );
  });
}

// Delivered invitation cards list who is invited and each answer; re-render them when that changes.
// The edit resolves botRef at call time (patched after createBot).
const invitationCards = new InvitationCardRefresher({
  eventRepo: db.events,
  invitationRepo: db.invitations,
  userRepo: db.users,
  agendaRepository: new AgendaRepository(db.db),
  weatherService,
  editMessage: (chatId, messageId, text, options) =>
    botRef.editMessage(chatId, messageId, text, options.parse_mode, options.reply_markup),
});
domainEventBus.on('invitationRoster.changed', (change) => {
  invitationCards.refresh(change).catch((err: unknown) => {
    botLogger.error({ err, eventId: change.eventId }, 'Failed to refresh delivered invitation cards');
  });
});

// Location verification — requires GOOGLE_API_KEY + Redis for address cache
let locationVerification:
  | import('./services/location/location-verification-service.ts').LocationVerificationService
  | undefined;
let addressCache: import('./services/location/address-cache.ts').AddressCache | undefined;
let pendingGeoStore: import('./services/location/pending-geo-store.ts').PendingGeoStore | undefined;

if (config.GOOGLE_API_KEY && config.REDIS_URL) {
  const { createGeocodingService } = await import('./services/location/geocoding-service.ts');
  const { withCachedAreas } = await import('./services/location/area-cache.ts');
  const { AddressCache, redisCompareAndSet } = await import('./services/location/address-cache.ts');
  const { LocationVerificationService } = await import('./services/location/location-verification-service.ts');
  const { RedisLocationCandidateStore } = await import('./services/location/location-candidate-store.ts');
  const { RedisPendingGeoStore } = await import('./services/location/pending-geo-store.ts');

  const locationRedis = new Bun.RedisClient(config.REDIS_URL);
  const geocodingService = withCachedAreas(createGeocodingService(config.GOOGLE_API_KEY), {
    get: (key: string) => locationRedis.get(key),
    set: (key: string, value: string, opts: { ex: number }) => locationRedis.set(key, value, 'EX', opts.ex),
  });
  addressCache = new AddressCache({
    get: (key: string) => locationRedis.get(key),
    compareAndSet: redisCompareAndSet({
      eval: (script: string, numkeys: number, ...keysAndArgs: string[]) =>
        locationRedis.eval(script, numkeys, ...keysAndArgs),
    }),
  });
  const candidateStore = new RedisLocationCandidateStore({
    set: (key: string, value: string, opts?: { ex?: number }) =>
      opts?.ex ? locationRedis.set(key, value, 'EX', opts.ex) : locationRedis.set(key, value),
    del: (key: string) => locationRedis.del(key),
    eval: (script: string, numkeys: number, ...keysAndArgs: string[]) =>
      locationRedis.eval(script, numkeys, ...keysAndArgs),
  });

  // sendMessage / editMessage closures resolve botRef at call time (patched after createBot)
  locationVerification = new LocationVerificationService({
    geocodingService,
    addressCache,
    eventRepo: db.events,
    userRepo: db.users,
    invitationRepo: db.invitations,
    agendaRepository: new AgendaRepository(db.db),
    weatherService,
    candidateStore,
    sendMessage: async (userId, text, options) => {
      await botRef.sendMessage(userId, text, options?.parse_mode, options?.reply_markup).catch((err: unknown) => {
        botLogger.error({ err, userId }, 'Location verification: failed to send message');
      });
    },
    editMessage: async (chatId, messageId, text, options) => {
      await botRef
        .editMessage(chatId, messageId, text, options.parse_mode, options.reply_markup)
        .catch((err: unknown) => {
          // A keep tap re-renders every card; an unchanged card is already what the user sees
          if (String(err).includes('message is not modified')) return;
          botLogger.error({ err, chatId, messageId }, 'Location verification: failed to edit message');
        });
    },
    pushGoogleCopies: pushEventCopiesRef,
  });

  pendingGeoStore = new RedisPendingGeoStore({
    set: (key: string, value: string, opts?: { ex?: number }) =>
      opts?.ex ? locationRedis.set(key, value, 'EX', opts.ex) : locationRedis.set(key, value),
    get: (key: string) => locationRedis.get(key),
    del: (key: string) => locationRedis.del(key),
  });

  botLogger.info('Location verification initialized (Google Maps + Redis)');
} else if (config.GOOGLE_API_KEY) {
  botLogger.info('Location verification disabled: REDIS_URL not set (address cache requires Redis)');
}

const { bot, agentContextBuilder, agent, intentMatcher, intentExecutor, scheduleRepo, triggerRepo, msgDeps } =
  createBot(
    config.BOT_TOKEN,
    db,
    {
      debugLogger: aiDebugLogger,
      summarizer: historySummarizer,
      toolSchemaMode: config.AI_TOOL_SCHEMA_MODE,
      toolSchemaUserIds: config.AI_TOOL_SCHEMA_USER_IDS,
    },
    {
      googleDeps,
      renderService,
      transcriptionService,
      stressDictionary,
      sileroTts,
      kokoroTts,
      fallbackTts,
      eventMentionStore,
      domainEventBus,
      nliClassifier,
      locationVerification,
      addressCache,
      pendingGeoStore,
      envConfig: {
        BOT_ADMIN_ID: config.BOT_ADMIN_ID,
        INTENT_LEARNER_DAILY_LIMIT: config.INTENT_LEARNER_DAILY_LIMIT,
        BOT_USERNAME: config.BOT_USERNAME,
        INLINE_BOT_TOKEN: config.INLINE_BOT_TOKEN,
        TELEGRAM_SESSION_MASTER_KEY: config.TELEGRAM_SESSION_MASTER_KEY,
      },
      weatherService,
      broadcastEnqueuer,
      changeNotifier: syncChangeNotifierRef,
    },
  );

// Patch bot ref to use real bot API
botRef.sendMessage = async (telegramId, text, parseMode, replyMarkup) => {
  const msg = await bot.api.sendMessage({
    chat_id: telegramId,
    text,
    ...(parseMode ? { parse_mode: parseMode } : {}),
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
  if (!('message_id' in msg)) {
    throw new Error(`sendMessage returned no message_id for chat ${telegramId}`);
  }
  return { message_id: msg.message_id };
};
botRef.editMessage = async (chatId, messageId, text, parseMode, replyMarkup) => {
  await bot.api.editMessageText({
    chat_id: chatId,
    message_id: messageId,
    text,
    ...(parseMode ? { parse_mode: parseMode } : {}),
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
};
botRef.sendVoice = async (telegramId, audio) => {
  const file = new File([audio], 'message.mp3', { type: 'audio/mpeg' });
  await bot.api.sendVoice({ chat_id: telegramId, voice: file });
};
// Broadcast worker — created after botRef is patched so sendMessage is the real implementation.
// No botInitialized guard needed: the worker starts AFTER the flag is set.
const broadcastWorker = createBroadcastWorker(
  broadcastConnection,
  {
    sendMessage: async (chatId, text, parseMode, threadId) => {
      const msg = await bot.api.sendMessage({
        chat_id: chatId,
        text,
        ...(parseMode ? { parse_mode: parseMode } : {}),
        ...(threadId ? { message_thread_id: threadId } : {}),
      });
      if (!('message_id' in msg)) {
        throw new Error(`sendMessage returned no message_id for chat ${chatId}`);
      }
      return { message_id: msg.message_id };
    },
  },
  broadcastRedis,
);
broadcastWorker.on('failed', onWorkerFailed('broadcast-notification'));

broadcastQueueCleanup = {
  close: async () => {
    await broadcastWorker.close();
    await broadcastQueue.close();
    await broadcastRedisClient.close();
  },
};

botLogger.info('Broadcast notification queue initialized');

// Scheduled AI calls + trigger system — requires Redis for BullMQ
if (config.REDIS_URL) {
  const { TriggerService } = await import('./services/scheduled/trigger.service.ts');
  const { ScheduledAiCallService } = await import('./services/scheduled/scheduled-ai-call.service.ts');
  const { createAiMessagesQueue, createAiMessagesWorker, SyntheticPipelineRunner } = await import(
    './worker/ai-messages-queue.ts'
  );
  const { EventStartingChecker } = await import('./worker/event-starting-checker.ts');
  const { executeTool } = await import('./services/ai/tool-executor.ts');
  const { Queue, Worker } = await import('bullmq');

  const redisConnection = { url: config.REDIS_URL };
  const aiMsgQueue = createAiMessagesQueue(redisConnection);

  // TriggerService — subscribes to all domain events
  const triggerService = new TriggerService(domainEventBus, triggerRepo, (data) => aiMsgQueue.pushTrigger(data));
  triggerService.subscribe();

  // ScheduledAiCallService — manages BullMQ delayed/repeat jobs
  const scheduledCallService = new ScheduledAiCallService(scheduleRepo, aiMsgQueue);

  // Patch msgDeps so agentContextBuilder picks up the services. msgDeps is frozen
  // below (outside the REDIS_URL guard) so the lock applies in dev-without-Redis too.
  msgDeps.scheduledCallService = scheduledCallService;
  msgDeps.triggerService = { repo: triggerRepo };
  msgDeps.aiRetryQueue = aiMsgQueue;

  // Redis store for pending retry job IDs — enables cancellation when user sends new message
  const RETRY_JOB_TTL_S = 300; // 5 min covers max backoff (30s + 60s + 120s) + buffer
  const retryRedis = new Bun.RedisClient(config.REDIS_URL);
  const retryJobStore = {
    async set(userId: number, jobId: string): Promise<void> {
      await retryRedis.set(`retry:${userId}`, jobId, 'EX', RETRY_JOB_TTL_S);
    },
    async get(userId: number): Promise<string | null> {
      return retryRedis.get(`retry:${userId}`);
    },
    async del(userId: number): Promise<void> {
      await retryRedis.del(`retry:${userId}`);
    },
  };
  msgDeps.aiRetryJobStore = retryJobStore;

  // SyntheticPipelineRunner — runs IntentMatcher → AiAgent without GramIO context
  const syntheticRunner = new SyntheticPipelineRunner({
    contextBuilder: (user, chatId, message) => {
      const ctx = agentContextBuilder(user, chatId, message);
      if (ctx.scheduled) {
        ctx.scheduled.domainEvents = domainEventBus;
      }
      return ctx;
    },
    intentRun: (agentCtx, message) =>
      runSyntheticIntent(
        { matcher: intentMatcher, intentRepo: msgDeps.intentRepo, executor: intentExecutor, executeTool },
        agentCtx,
        message,
      ),
    agentRun: async (agentCtx) => {
      await agent.run(agentCtx);
    },
    retryQueue: aiMsgQueue,
    retryJobStore,
  });

  const aiWorker = createAiMessagesWorker(
    redisConnection,
    syntheticRunner,
    (userId) => db.users.findByTelegramId(userId),
    (scheduleId) => scheduleRepo.recordRun(scheduleId),
  );
  aiWorker.on('failed', onWorkerFailed('ai-messages'));

  // EventStartingChecker — runs on 1-minute BullMQ cron
  const eventStartingChecker = new EventStartingChecker(db.db, domainEventBus, (withinMs) =>
    db.events.findStartingWithin(withinMs),
  );

  const checkerQueue = new Queue('event-starting-checker', { connection: redisConnection });
  await checkerQueue.add(
    'tick',
    {},
    {
      repeat: { every: 60_000 },
      jobId: 'event-starting-checker-tick',
      removeOnComplete: { count: 100 },
    },
  );
  const checkerWorker = new Worker(
    'event-starting-checker',
    async () => {
      await eventStartingChecker.check();
    },
    { connection: redisConnection },
  );

  checkerWorker.on('failed', onWorkerFailed('event-starting-checker'));

  aiMessagesQueueCleanup = {
    close: async () => {
      await aiWorker.close();
      await aiMsgQueue.queue.close();
    },
  };

  eventCheckerQueueCleanup = {
    close: async () => {
      await checkerWorker.close();
      await checkerQueue.close();
    },
  };

  botLogger.info('Scheduled AI calls + trigger system initialized');
}

// Freeze msgDeps after all potential mutation sites (onboardingScene in createBot,
// scheduledCallService/triggerService in the REDIS_URL block above). All downstream
// consumers — AI agent context builder, pipeline layers, callback agent continuations —
// capture msgDeps by reference, so locking it here prevents accidental late writes
// from silently reshaping what those closures see.
Object.freeze(msgDeps);

// Register bot commands in Telegram menu — both languages
const COMMANDS_EN = [
  { command: 'today', description: "Today's events" },
  { command: 'tomorrow', description: "Tomorrow's events" },
  { command: 'week', description: '7-day overview' },
  { command: 'month', description: 'Monthly calendar' },
  { command: 'add', description: 'Create event' },
  { command: 'edit', description: 'Edit event' },
  { command: 'delete', description: 'Delete event' },
  { command: 'search', description: 'Search events' },
  { command: 'free', description: 'Find free slots' },
  { command: 'settings', description: 'Settings' },
  { command: 'import', description: 'Import .ics' },
  { command: 'holidays', description: 'Holidays calendar' },
  { command: 'share', description: 'Share agenda or event' },
  { command: 'invite', description: 'Invite user to event' },
  { command: 'invitations', description: 'View invitations' },
  { command: 'help', description: 'Help' },
];

const COMMANDS_RU = [
  { command: 'today', description: 'События сегодня' },
  { command: 'tomorrow', description: 'События завтра' },
  { command: 'week', description: 'Обзор на 7 дней' },
  { command: 'month', description: 'Месячный календарь' },
  { command: 'add', description: 'Создать событие' },
  { command: 'edit', description: 'Редактировать событие' },
  { command: 'delete', description: 'Удалить событие' },
  { command: 'search', description: 'Поиск событий' },
  { command: 'free', description: 'Свободные слоты' },
  { command: 'settings', description: 'Настройки' },
  { command: 'import', description: 'Импорт .ics' },
  { command: 'holidays', description: 'Календарь праздников' },
  { command: 'share', description: 'Поделиться повесткой/событием' },
  { command: 'invite', description: 'Пригласить на событие' },
  { command: 'invitations', description: 'Просмотр приглашений' },
  { command: 'help', description: 'Справка' },
];

if (config.GOOGLE_CLIENT_ID) {
  COMMANDS_EN.push(
    { command: 'connect_google', description: 'Connect Google Calendar' },
    { command: 'disconnect_google', description: 'Disconnect Google Calendar' },
    { command: 'google_status', description: 'Google Calendar sync status' },
  );
  COMMANDS_RU.push(
    { command: 'connect_google', description: 'Подключить Google Calendar' },
    { command: 'disconnect_google', description: 'Отключить Google Calendar' },
    { command: 'google_status', description: 'Статус синхронизации Google Calendar' },
  );
}

if (config.TELEGRAM_SESSION_MASTER_KEY) {
  COMMANDS_EN.push(
    { command: 'connect_telegram', description: 'Connect Telegram account for first-person invitations' },
    { command: 'disconnect_telegram', description: 'Disconnect Telegram account' },
  );
  COMMANDS_RU.push(
    { command: 'connect_telegram', description: 'Подключить Telegram-аккаунт для приглашений от твоего имени' },
    { command: 'disconnect_telegram', description: 'Отключить подключенный Telegram-аккаунт' },
  );
}

bot.onStart(async ({ info }) => {
  webServerDeps.botStarted = true;
  await bot.api.setMyCommands({ commands: COMMANDS_EN });
  await bot.api.setMyCommands({
    commands: COMMANDS_RU,
    language_code: 'ru',
  });
  botLogger.info({ username: info.username }, 'Bot started');
});

// bot.stop() (in-flight handlers get up to 3 s) + the AGENT_DRAIN_SETTLE_MS drain + the closes below
// must fit the 8 s shutdown timeout and Docker's 10 s stop grace.
/** Second, shorter drain: turns started by handlers that outlived bot.stop() while the queues closed. */
const LATE_AGENT_DRAIN_SETTLE_MS = 1_000;

async function drainAgents(settleMs: number): Promise<void> {
  await agent.drain(settleMs);
}

// Graceful shutdown. Stop taking updates first, then abort the AI turns still
// running so each one tells its user, queues its retry and writes its debug log
// while the queues, Redis and the database are still open.
async function shutdown(): Promise<void> {
  await bot.stop();
  await drainAgents(AGENT_DRAIN_SETTLE_MS);
  if (aiMessagesQueueCleanup) await aiMessagesQueueCleanup.close();
  if (eventCheckerQueueCleanup) await eventCheckerQueueCleanup.close();
  if (notificationQueueCleanup) await notificationQueueCleanup.close();
  if (botTasksQueueCleanup) await botTasksQueueCleanup.close();
  if (syncQueueCleanup) await syncQueueCleanup.close();
  if (imageQueueCleanup) await imageQueueCleanup.close();
  if (broadcastQueueCleanup) await broadcastQueueCleanup.close();
  // Nothing may still be writing when Redis and SQLite close.
  await drainAgents(LATE_AGENT_DRAIN_SETTLE_MS);
  if (googleRedisClient) googleRedisClient.close();
  summarizerRedis.close();
  if (webServerHandle) webServerHandle.stop();
  db.close();
}

async function shutdownWithTimeout(): Promise<void> {
  // Refuse webhook updates from here on: Telegram keeps a refused update and
  // redelivers it to the next process instead of it dying in the stopped queue.
  // Updates acknowledged just before this line still depend on the shutdown grace.
  webServerDeps.telegramUpdatesClosed = true;
  await Promise.race([
    shutdown(),
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error('Shutdown timeout after 8s')), 8000)),
  ]).catch((err: unknown) => {
    botLogger.fatal({ err }, 'Shutdown timed out, forcing exit');
    process.exit(1);
  });
}

process.on('SIGINT', async () => {
  botLogger.info('Shutting down...');
  await shutdownWithTimeout();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  botLogger.info('Shutting down (SIGTERM)...');
  await shutdownWithTimeout();
  process.exit(0);
});

if (config.PUBLIC_DOMAIN) {
  const { webhookHandler } = await import('gramio');
  const webhookSecret = crypto.randomUUID();
  const webhookUrl = `https://${config.PUBLIC_DOMAIN}/webhook/telegram`;

  webServerDeps.telegramWebhookHandler = webhookHandler(bot, 'Bun.serve', {
    secretToken: webhookSecret,
  }) as (req: Request) => Response;

  // Pending updates are kept, not dropped: a message sent while the bot restarted
  // is answered now, and createStaleUpdateGuard skips ones that waited too long.
  bot.start({
    webhook: {
      url: webhookUrl,
      secret_token: webhookSecret,
    },
  });
  botLogger.info({ webhookUrl }, 'Bot started (webhook mode)');
} else {
  bot.start();
}
