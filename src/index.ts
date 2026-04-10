// src/index.ts

import type { TelegramInlineKeyboardMarkup, TelegramReplyKeyboardMarkup } from 'gramio';
import { z } from 'zod';
import { agentDispatcher } from './agent/dispatcher.ts';
import { initPairingSecret } from './agent/pairing.ts';
import { agentRegistry } from './agent/registry.ts';
import { buildCalendarPickerKeyboard } from './bot/commands/calendars.ts';
import type { DisconnectDeps } from './bot/commands/disconnect-google.ts';
import { createBot, type GoogleBotDeps } from './bot/index.ts';
import type { Lang } from './config/constants.ts';
import { t } from './config/constants.ts';
import { loadConfig } from './config/env.ts';
import { createDatabase } from './database/index.ts';
import { AiDebugLogger } from './services/ai/debug-logger.ts';
import { type Workflow, WorkflowSchema } from './services/intent/workflow-schema.ts';
import { DomainEventBus } from './services/scheduled/domain-event-bus.ts';
import { jsonCodec } from './utils/json-codec.ts';
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
    botLogger.error({ jobId: job?.id, worker: name, err }, 'Worker job failed');
    alertHandler?.(job, err);
  };
}

const aiDebugLogger = new AiDebugLogger(!!config.AI_DEBUG_LOGS, 'logs');

if (config.AGENT_JWT_SECRET) {
  initPairingSecret(config.AGENT_JWT_SECRET);
}

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
  editMessage: (chatId: number, messageId: number, text: string, parseMode?: ParseMode) => Promise<void>;
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
  agentRegistry,
  agentDispatcher,
  botStarted: false,
  alertRepo: db.alerts,
  adminAlertToken: config.ADMIN_ALERT_TOKEN,
};
const webServerHandle: { stop: () => void } | undefined = startWebServer(webServerDeps);
let syncQueueCleanup: { close: () => Promise<void> } | undefined;
let imageQueueCleanup: { close: () => Promise<void> } | undefined;
let renderService: import('./services/image/render-service.ts').RenderService | undefined;
let callQueue:
  | { enqueue(data: Omit<import('./services/voice/types.ts').CallReminderJobData, 'sessionId'>): Promise<void> }
  | undefined;
let callQueueCleanup: { close: () => Promise<void> } | undefined;
let notificationQueueCleanup: { close: () => Promise<void> } | undefined;
let botTasksQueueCleanup: { close: () => Promise<void> } | undefined;
let googleRedisClient: Bun.RedisClient | undefined;
let participantPushSchedulerRef:
  | ((participantUserId: number, eventId: number, action: 'create' | 'update' | 'delete') => Promise<void>)
  | undefined;
let mtprotoSendAsUser: ((userId: number, text: string, username?: string) => Promise<boolean>) | undefined;
let mtprotoResolveUsername:
  | ((username: string) => Promise<{ id: number; firstName?: string; username?: string } | null>)
  | undefined;

if (config.GOOGLE_CLIENT_ID && config.REDIS_URL) {
  const { GoogleOAuthService } = await import('./services/google/oauth.ts');
  const { createGoogleSyncQueue } = await import('./services/google/sync-queue.ts');
  const { createPushScheduler, createParticipantPushScheduler } = await import('./services/google/push-scheduler.ts');
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

  const { queue, worker } = createGoogleSyncQueue({
    db: db.db,
    config,
    redisUrl: config.REDIS_URL,
    oauthService,
    eventRepo: db.events,
    syncRepo: db.googleSync,
    calendarRepo: db.googleCalendars,
    participantSyncRepo: db.participantGoogleSync,
    getUserLang: (userId) => (db.users.findByTelegramId(userId)?.language ?? 'en') as Lang,
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
    sendMessage: (telegramId, text) =>
      botRef
        .sendMessage(telegramId, text)
        .then(() => {})
        .catch((err) => botLogger.error({ err, telegramId }, 'Failed to send sync notification')),
  });

  syncQueueCleanup = {
    close: async () => {
      await worker.close();
      await queue.close();
    },
  };

  const pushScheduler = createPushScheduler(db.googleSync, db.events, queue);
  const participantPushScheduler = createParticipantPushScheduler(db.googleSync, db.participantGoogleSync, queue);
  participantPushSchedulerRef = participantPushScheduler;

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

if (config.REDIS_URL && config.MTPROTO_API_ID && config.MTPROTO_API_HASH && !config.DISABLE_VOICE) {
  try {
    const { createCallQueue, createCallWorker } = await import('./worker/call-queue.ts');
    const { TtsService } = await import('./services/voice/tts-service.ts');
    const { CallManager } = await import('./services/voice/call-manager.ts');
    const { CallSessionManager } = await import('./services/voice/call-session-manager.ts');
    const { CallSession } = await import('./services/voice/call-session.ts');
    const { NovaStreamingSTT } = await import('./services/voice/nova-streaming-stt.ts');
    const { FluxStreamingSTT } = await import('./services/voice/flux-streaming-stt.ts');
    const { ThinkingPhrasePlayer } = await import('./services/voice/thinking-phrase-player.ts');
    const { CalendarBotAgent } = await import('./services/ai/agent.ts');
    const { EventService } = await import('./services/event/event-service.ts');
    const { ReminderMaterializer } = await import('./services/notification/materializer.ts');
    const { HolidayService } = await import('./services/holiday/holiday-service.ts');
    const { existsSync } = await import('node:fs');

    const cq = createCallQueue({ url: config.REDIS_URL });
    callQueue = cq;

    const pyBridgePath = 'scripts/voice-call-bridge.py';
    const pySessionExists = existsSync('data/voice_caller.session');

    if (!pySessionExists) {
      botLogger.warn(
        'Pyrogram session not found (data/voice_caller.session). Run: venv/bin/python scripts/pyrogram-auth.py',
      );
    }

    const { TtsTranslationService } = await import('./services/voice/tts-translation.ts');
    const ttsTranslationService = new TtsTranslationService({
      apiKey: config.ANTHROPIC_API_KEY,
      baseUrl: config.AI_BASE_URL,
      model: config.AI_FAST_MODEL,
    });
    const ttsService = new TtsService();

    const DEEPGRAM_API_KEY = config.DEEPGRAM_API_KEY ?? '';
    if (!DEEPGRAM_API_KEY) {
      botLogger.warn('DEEPGRAM_API_KEY is not set — STT will not work');
    }

    // TelegramSender for voice calls — forwards to botRef which wraps bot.api.
    // Used for: call protocol messages (listening indicator, blockquote), ask_user, etc.
    const voiceSender: import('./services/ai/types.ts').TelegramSender = {
      sendMessage: (chatId, text, parseMode) => botRef.sendMessage(chatId, text, parseMode),
      editMessageText: (chatId, messageId, text, parseMode) => botRef.editMessage(chatId, messageId, text, parseMode),
    };
    const voiceAgent = new CalendarBotAgent(
      {
        apiKey: config.ANTHROPIC_API_KEY,
        baseUrl: config.AI_BASE_URL,
        model: config.AI_MODEL,
        debugLogger: aiDebugLogger,
      },
      voiceSender,
    );

    const voiceMaterializer = new ReminderMaterializer(db.eventReminders, db.notificationPreferences);
    const voiceEventService = new EventService({
      eventRepo: db.events,
      materializer: voiceMaterializer,
    });
    const voiceHolidayService = new HolidayService(db.holidays);

    const { markStress, numbersToWords } = await import('./services/voice/stress-marker.ts');

    // Language-aware TTS adapter: Silero (RU) → Kokoro (EN) → Google fallback.
    // All four outer variables (sileroTts, kokoroTts, stressDictionary, fallbackTts) are
    // module-level lets/consts initialized later; closures resolve them at call time.
    const voiceCallTts = {
      synthesize: async (text: string, lang: string): Promise<Buffer> => {
        const clean = text.replace(/\n/g, ' ');
        if (lang === 'ru' && sileroTts && stressDictionary) {
          try {
            const stressedText = markStress(numbersToWords(clean), stressDictionary);
            botLogger.info({ engine: 'silero', lang }, 'Voice call TTS');
            return await sileroTts.synthesize(stressedText);
          } catch (err) {
            botLogger.warn({ err }, 'Silero TTS failed, falling back to Google');
          }
        } else if (lang === 'en' && kokoroTts) {
          try {
            botLogger.info({ engine: 'kokoro', lang }, 'Voice call TTS');
            return await kokoroTts.synthesize(clean);
          } catch (err) {
            botLogger.warn({ err }, 'Kokoro TTS failed, falling back to Google');
          }
        } else {
          botLogger.info({ engine: 'google', lang }, 'Voice call TTS');
        }
        return fallbackTts.synthesize(clean, lang);
      },
    };

    const callSessionManager = new CallSessionManager({
      createSession: (sessionId, userId, language, ws) =>
        CallSession.create({
          sessionId,
          userId,
          language,
          ws,
          createNovaStt: () => new NovaStreamingSTT(DEEPGRAM_API_KEY),
          createFluxStt: () => new FluxStreamingSTT(DEEPGRAM_API_KEY),
          createThinkingPlayer: () => new ThinkingPhrasePlayer(language),
          agent: voiceAgent,
          tts: voiceCallTts,
          openerText: language === 'ru' ? 'Привет! Чем могу помочь?' : 'Hello! How can I help you?',
          agentContextBase: {
            sender: voiceSender,
            eventService: voiceEventService,
            chatHistory: db.chatHistory,
            userRepo: db.users,
            eventReminderRepo: db.eventReminders,
            holidayService: voiceHolidayService,
          },
        }),
    });

    callSessionManager.startServer();

    const callManager = new CallManager({
      fallbackTts: ttsService,
      callLogRepo: db.callLog,
      translateText: (text, lang) => ttsTranslationService.translate(text, lang),
      pyBridgePath,
      registerSession: (sessionId, userId, language) => callSessionManager.registerSession(sessionId, userId, language),
      notifyUser: (userId, msg) => {
        botRef
          .sendMessage(userId, msg)
          .catch((err) => botLogger.error({ err, userId }, 'Failed to send call failure notification'));
      },
    });

    const worker = createCallWorker({ url: config.REDIS_URL }, callManager);
    worker.on('failed', onWorkerFailed('call-reminders'));
    callQueueCleanup = {
      close: async () => {
        await worker.close();
        await cq.queue.close();
      },
    };

    botLogger.info('Voice call pipeline initialized (Python bridge + BullMQ)');
  } catch (error) {
    botLogger.warn({ err: error }, 'Voice call init failed, queue-only mode');
    const { createCallQueue } = await import('./worker/call-queue.ts');
    const cq = createCallQueue({ url: config.REDIS_URL });
    callQueue = cq;
    callQueueCleanup = {
      close: async () => {
        await cq.queue.close();
      },
    };
  }
}

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
    callSettingsRepo: db.callSettings,
    callLogRepo: db.callLog,
    enqueueCall: callQueue
      ? (data) => {
          const log = db.callLog.create({ user_id: data.userId, tts_text: data.ttsText });
          callQueue!.enqueue({ ...data, callLogId: log.id });
        }
      : undefined,
    weatherService,
    featureUsageRepo: db.featureUsage,
  });

  const notifWorker = createNotificationWorker(
    config.REDIS_URL,
    db.notificationLog,
    (telegramId, text) =>
      botRef
        .sendMessage(telegramId, text, 'HTML')
        .then(() => {})
        .catch((err) => botLogger.error({ err, telegramId }, 'Failed to send notification')),
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
    setupSessionCleanupCron,
    setupBirthdaySyncCron,
    setupChatHistoryCleanupCron,
    setupSqliteBackupCron,
    setupRecurringRemindersCron,
    setupActionLogCleanupCron,
  } = await import('./worker/bot-tasks-queue.ts');
  const { runSqliteBackup } = await import('./database/backup.ts');
  const { runSecretaryExpiry } = await import('./worker/secretary-expiry.ts');
  const { runSharingCleanup } = await import('./services/sharing/sharing-cleanup.ts');
  const { runProposalExpiry } = await import('./worker/proposal-expiry.ts');
  const { BirthdayService, BIRTHDAY_SYNC_THROTTLE_MS } = await import('./services/birthday/birthday-service.ts');
  const { ReminderMaterializer } = await import('./services/notification/materializer.ts');

  const cronMaterializer = new ReminderMaterializer(db.eventReminders, db.notificationPreferences);
  const cronBirthdayService = new BirthdayService(
    db.events,
    db.birthdayMeta,
    db.eventReminders,
    db.notificationPreferences,
  );

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
    onSessionCleanup: () => {
      db.workflowSessions.cleanup();
      db.groupSessions.deleteExpired();
    },
    onActionLogCleanup: () => {
      const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60_000).toISOString().slice(0, 19).replace('T', ' ');
      const deleted = db.actionLog.deleteOlderThan(cutoff);
      if (deleted > 0) botLogger.info({ deleted }, 'Action log cleanup: removed old entries');
    },
    onBirthdaySync: async () => {
      const BATCH = 100;
      const users = db.birthdayMeta.getUsersNeedingSync(BIRTHDAY_SYNC_THROTTLE_MS);
      for (let i = 0; i < users.length; i += BATCH) {
        await cronBirthdayService.runBatchSync(users.slice(i, i + BATCH));
      }
    },
    onChatHistoryCleanup: () => {
      const deleted = db.chatHistory.deleteOlderThan(90);
      botLogger.info({ deleted }, 'Cleaned up old chat history');
    },
    onSqliteBackup: () => runSqliteBackup(db.db, config.DATABASE_PATH),
    onRecurringReminders: () => {
      cronMaterializer.materializeUpcomingRecurringReminders(db.events);
    },
  });

  await setupSecretaryExpiryCron(botTasksQueue);
  await setupSharingCleanupCron(botTasksQueue);
  await setupProposalExpiryCron(botTasksQueue);
  await setupSessionCleanupCron(botTasksQueue);
  await setupBirthdaySyncCron(botTasksQueue);
  await setupChatHistoryCleanupCron(botTasksQueue);
  await setupSqliteBackupCron(botTasksQueue);
  await setupRecurringRemindersCron(botTasksQueue);
  await setupActionLogCleanupCron(botTasksQueue);

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

// MTProto userbot for delivering messages to users who haven't started the bot
// Uses the same pyrogram session as voice-call-bridge.py (data/voice_caller.session)
if (config.MTPROTO_API_ID && config.MTPROTO_API_HASH) {
  const { existsSync } = await import('node:fs');
  if (existsSync('data/voice_caller.session')) {
    mtprotoSendAsUser = async (userId: number, text: string, username?: string): Promise<boolean> => {
      const args = ['venv/bin/python', 'scripts/send-message.py', String(userId), text];
      if (username) args.push(username);
      const proc = Bun.spawn(args, { env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (stderr) botLogger.warn({ userId, stderr: stderr.slice(0, 200) }, 'send-message.py stderr');
      const ok = exitCode === 0 && stdout.includes('OK');
      botLogger.info({ userId, ok }, 'MTProto message delivery');
      return ok;
    };
    mtprotoResolveUsername = async (username: string) => {
      const proc = Bun.spawn(['venv/bin/python', 'scripts/resolve-username.py', username], {
        env: { ...process.env },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (exitCode !== 0) {
        botLogger.warn({ username, stderr: stderr.slice(0, 200) }, 'resolve-username.py failed');
        return null;
      }
      const parseResult = jsonCodec(
        z.object({ id: z.number(), firstName: z.string().optional(), username: z.string().optional() }),
      ).safeParse(stdout.trim());
      if (!parseResult.success) {
        botLogger.warn({ username, stdout: stdout.slice(0, 500) }, 'resolve-username.py bad JSON');
        return null;
      }
      return parseResult.data;
    };
    botLogger.info('MTProto messenger initialized (pyrogram)');
  } else {
    botLogger.info('Pyrogram session not found, invitation delivery via userbot disabled');
  }
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
}

// Location verification — requires GOOGLE_API_KEY + Redis for address cache
let locationVerification:
  | import('./services/location/location-verification-service.ts').LocationVerificationService
  | undefined;
let addressCache: import('./services/location/address-cache.ts').AddressCache | undefined;
let pendingGeoStore: import('./services/location/pending-geo-store.ts').PendingGeoStore | undefined;

if (config.GOOGLE_API_KEY && config.REDIS_URL) {
  const { createGeocodingService } = await import('./services/location/geocoding-service.ts');
  const { AddressCache } = await import('./services/location/address-cache.ts');
  const { LocationVerificationService } = await import('./services/location/location-verification-service.ts');
  const { RedisLocationCandidateStore } = await import('./services/location/location-candidate-store.ts');
  const { RedisPendingGeoStore } = await import('./services/location/pending-geo-store.ts');

  const locationRedis = new Bun.RedisClient(config.REDIS_URL);
  const geocodingService = createGeocodingService(config.GOOGLE_API_KEY);
  addressCache = new AddressCache({
    get: (key: string) => locationRedis.get(key),
    set: (key: string, value: string) => locationRedis.set(key, value),
  });
  const candidateStore = new RedisLocationCandidateStore({
    set: (key: string, value: string, opts?: { ex?: number }) =>
      opts?.ex ? locationRedis.set(key, value, 'EX', opts.ex) : locationRedis.set(key, value),
    get: (key: string) => locationRedis.get(key),
    del: (key: string) => locationRedis.del(key),
  });

  // sendMessage / editMessage closures resolve botRef at call time (patched after createBot)
  locationVerification = new LocationVerificationService({
    geocodingService,
    addressCache,
    eventRepo: db.events,
    userRepo: db.users,
    invitationRepo: db.invitations,
    candidateStore,
    sendMessage: async (userId, text, options) => {
      await botRef.sendMessage(userId, text, options?.parse_mode, options?.reply_markup).catch((err: unknown) => {
        botLogger.error({ err, userId }, 'Location verification: failed to send message');
      });
    },
    editMessage: async (chatId, messageId, text, parseMode) => {
      await botRef.editMessage(chatId, messageId, text, parseMode).catch((err: unknown) => {
        botLogger.error({ err, chatId, messageId }, 'Location verification: failed to edit message');
      });
    },
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
      apiKey: config.ANTHROPIC_API_KEY,
      baseUrl: config.AI_BASE_URL,
      model: config.AI_MODEL,
      validationModel: config.AI_FAST_MODEL,
      debugLogger: aiDebugLogger,
      ...(config.AI_MODEL_FALLBACK && {
        fallback: {
          model: config.AI_MODEL_FALLBACK,
          baseUrl: config.AI_BASE_URL_FALLBACK,
          apiKey: config.AI_API_KEY_FALLBACK,
        },
      }),
    },
    {
      googleDeps,
      renderService,
      callQueue,
      transcriptionService,
      mtprotoSendAsUser,
      stressDictionary,
      sileroTts,
      kokoroTts,
      fallbackTts,
      mtprotoResolveUsername,
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
        AGENT_DOWNLOAD_URL: config.AGENT_DOWNLOAD_URL,
        INLINE_BOT_TOKEN: config.INLINE_BOT_TOKEN,
        AI_FAST_MODEL: config.AI_FAST_MODEL,
      },
      weatherService,
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
  return { message_id: 'message_id' in msg ? msg.message_id : 0 };
};
botRef.editMessage = async (chatId, messageId, text, parseMode) => {
  await bot.api.editMessageText({
    chat_id: chatId,
    message_id: messageId,
    text,
    ...(parseMode ? { parse_mode: parseMode } : {}),
  });
};
botRef.sendVoice = async (telegramId, audio) => {
  const file = new File([audio], 'message.mp3', { type: 'audio/mpeg' });
  await bot.api.sendVoice({ chat_id: telegramId, voice: file });
};

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

  // Patch msgDeps so agentContextBuilder picks up the services
  msgDeps.scheduledCallService = scheduledCallService;
  msgDeps.triggerService = { repo: triggerRepo };

  // SyntheticPipelineRunner — runs IntentMatcher → AiAgent without GramIO context
  const syntheticRunner = new SyntheticPipelineRunner({
    contextBuilder: (user, chatId, message) => {
      const ctx = agentContextBuilder(user, chatId, message);
      if (ctx.scheduled) {
        ctx.scheduled.domainEvents = domainEventBus;
      }
      return ctx;
    },
    intentRun: async (agentCtx, message) => {
      const match = intentMatcher.match(message);
      if (!match) return { handled: false };
      const intent = msgDeps.intentRepo.getById(match.intentId);
      if (!intent) return { handled: false };
      const workflowResult = jsonCodec(WorkflowSchema).safeParse(intent.workflow);
      if (!workflowResult.success) return { handled: false };
      const workflow: Workflow = workflowResult.data;
      const userCtx = {
        userId: agentCtx.user.telegram_id,
        language: agentCtx.user.language,
        timezone: agentCtx.user.timezone,
        username: agentCtx.user.username ?? undefined,
        firstName: agentCtx.user.first_name ?? undefined,
      };
      const result = await intentExecutor.run(workflow, match.captures, userCtx, (toolName: string, input: unknown) =>
        executeTool(agentCtx, toolName, input),
      );
      if (result.response && agentCtx.sender) {
        await agentCtx.sender.sendMessage(agentCtx.user.telegram_id, result.response);
      }
      return { handled: true, response: result.response };
    },
    agentRun: async (agentCtx) => {
      await agent.run(agentCtx);
    },
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

bot.onStart(async ({ info }) => {
  webServerDeps.botStarted = true;
  await bot.api.setMyCommands({ commands: COMMANDS_EN });
  await bot.api.setMyCommands({
    commands: COMMANDS_RU,
    language_code: 'ru',
  });
  botLogger.info({ username: info.username }, 'Bot started');
});

// Graceful shutdown
async function shutdown(): Promise<void> {
  await bot.stop();
  if (aiMessagesQueueCleanup) await aiMessagesQueueCleanup.close();
  if (eventCheckerQueueCleanup) await eventCheckerQueueCleanup.close();
  if (notificationQueueCleanup) await notificationQueueCleanup.close();
  if (botTasksQueueCleanup) await botTasksQueueCleanup.close();
  if (syncQueueCleanup) await syncQueueCleanup.close();
  if (imageQueueCleanup) await imageQueueCleanup.close();
  if (callQueueCleanup) await callQueueCleanup.close();
  if (googleRedisClient) googleRedisClient.close();
  if (webServerHandle) webServerHandle.stop();
  db.close();
}

async function shutdownWithTimeout(): Promise<void> {
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

  bot.start({
    webhook: {
      url: webhookUrl,
      secret_token: webhookSecret,
    },
    dropPendingUpdates: true,
  });
  botLogger.info({ webhookUrl }, 'Bot started (webhook mode)');
} else {
  bot.start({ dropPendingUpdates: true });
}
