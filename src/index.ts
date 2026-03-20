// src/index.ts

import type { DisconnectDeps } from './bot/commands/disconnect-google.ts';
import { createBot, type GoogleBotDeps } from './bot/index.ts';
import { loadConfig } from './config/env.ts';
import { createDatabase } from './database/index.ts';
import { DomainEventBus } from './services/scheduled/domain-event-bus.ts';
import { botLogger } from './utils/logger.ts';

const config = loadConfig();
const db = createDatabase(config.DATABASE_PATH);

// Mutable ref — patched after bot creation
const botRef: {
  sendMessage: (telegramId: number, text: string, parseMode?: string) => Promise<{ message_id: number }>;
  sendVoice: (telegramId: number, audio: Buffer) => Promise<void>;
  editMessage: (chatId: number, messageId: number, text: string, parseMode?: string) => Promise<void>;
} = {
  sendMessage: async () => ({ message_id: 0 }),
  sendVoice: async () => {},
  editMessage: async () => {},
};

let googleDeps: GoogleBotDeps | undefined;
let webServerHandle: { stop: () => void } | undefined;
let syncQueueCleanup: { close: () => Promise<void> } | undefined;
let imageQueueCleanup: { close: () => Promise<void> } | undefined;
let renderService: import('./services/image/render-service.ts').RenderService | undefined;
let callQueue:
  | { enqueue(data: Omit<import('./services/voice/types.ts').CallReminderJobData, 'sessionId'>): Promise<void> }
  | undefined;
let callQueueCleanup: { close: () => Promise<void> } | undefined;
let notificationQueueCleanup: { close: () => Promise<void> } | undefined;
let botTasksQueueCleanup: { close: () => Promise<void> } | undefined;
let mtprotoSendAsUser: ((userId: number, text: string, username?: string) => Promise<boolean>) | undefined;
let mtprotoResolveUsername:
  | ((username: string) => Promise<{ id: number; firstName?: string; username?: string } | null>)
  | undefined;

if (config.GOOGLE_CLIENT_ID && config.REDIS_URL) {
  const { GoogleOAuthService } = await import('./services/google/oauth.ts');
  const { startWebServer } = await import('./web/server.ts');
  const { createGoogleSyncQueue } = await import('./services/google/sync-queue.ts');
  const { executeSyncCronTick, setupSyncCron } = await import('./services/google/sync-cron.ts');
  const { renewExpiringChannels, setupWatchRenewalCron } = await import('./services/google/watch-renewal-cron.ts');
  const { executeCleanup, setupCleanupCron } = await import('./services/google/cleanup-cron.ts');
  const Redis = (await import('ioredis')).default;

  const oauthService = new GoogleOAuthService(config, db.users, db.googleSync);
  const redis = new Redis(config.REDIS_URL);

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
    config,
    redisUrl: config.REDIS_URL,
    oauthService,
    eventRepo: db.events,
    syncRepo: db.googleSync,
    calendarRepo: db.googleCalendars,
    onCronSyncTick: (q) => executeSyncCronTick(q, db.googleSync, db.googleCalendars),
    onWatchRenewalTick: () => renewExpiringChannels(config, oauthService, db.googleCalendars),
    onCleanupTick: () => executeCleanup(db.googleSync, db.googleCalendars),
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
      redis.disconnect();
    },
  };

  const disconnectDeps: DisconnectDeps = {
    config,
    oauthService,
    userRepo: db.users,
    eventRepo: db.events,
    syncRepo: db.googleSync,
    calendarRepo: db.googleCalendars,
    stopWatchChannels: async (userId) => {
      await queue.add('stop-watch', { type: 'stop-watch', userId });
    },
  };

  googleDeps = {
    oauthService,
    stateStore,
    disconnectDeps,
    calendarRepo: db.googleCalendars,
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

  webServerHandle = startWebServer({
    config,
    oauthService,
    userRepo: db.users,
    syncRepo: db.googleSync,
    calendarRepo: db.googleCalendars,
    stateLookup: stateStore,
    onConnected: async (userId) => {
      await queue.add('refresh-calendars', { type: 'refresh-calendars', userId });
    },
    onWebhook: async (channelId, resourceId) => {
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
    },
  });

  await setupSyncCron(queue);
  await setupWatchRenewalCron(queue);
  await setupCleanupCron(queue);

  botLogger.info('Google Calendar sync initialized');
}

if (config.REDIS_URL) {
  const { createImageRenderQueue } = await import('./worker/image-render.queue.ts');
  const { RenderService } = await import('./services/image/render-service.ts');
  const { playwrightPool } = await import('./worker/playwright-pool.ts');

  await playwrightPool.initialize();

  const { queue: imageQueue, worker, queueEvents } = createImageRenderQueue(config.REDIS_URL);
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
}

if (config.REDIS_URL && config.MTPROTO_API_ID && config.MTPROTO_API_HASH && !process.env.DISABLE_VOICE) {
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
    const { HolidayService } = await import('./services/holiday/holiday-service.ts');
    const { existsSync } = await import('node:fs');

    const cq = createCallQueue({ url: config.REDIS_URL });
    callQueue = cq;

    const pyBridgePath = 'scripts/voice-call-bridge.py';
    const pySessionExists = existsSync('data/voice_caller.session');

    if (!pySessionExists) {
      botLogger.warn('Pyrogram session not found (data/voice_caller.session). Run: bun run auth:voice');
    }

    const { TtsTranslationService } = await import('./services/voice/tts-translation.ts');
    const ttsTranslationService = new TtsTranslationService({
      apiKey: config.ANTHROPIC_API_KEY,
      baseUrl: config.AI_BASE_URL,
    });
    const ttsService = new TtsService();

    const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY ?? '';
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
      { apiKey: config.ANTHROPIC_API_KEY, baseUrl: config.AI_BASE_URL, model: config.AI_MODEL },
      voiceSender,
    );

    const voiceEventService = new EventService(db.events, db.reminders);
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
            reminderRepo: db.reminders,
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

// Notification scheduler — requires Redis for BullMQ queue
if (config.REDIS_URL) {
  const { createNotificationQueue, createNotificationWorker, setupNotificationTick } = await import(
    './services/notification/queue.ts'
  );
  const { NotificationScheduler } = await import('./services/notification/scheduler.ts');

  const notifQueue = createNotificationQueue(config.REDIS_URL);

  const scheduler = new NotificationScheduler({
    prefsRepo: db.notificationPreferences,
    reminderRepo: db.eventReminders,
    logRepo: db.notificationLog,
    userRepo: db.users,
    eventRepo: db.events,
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
  });

  const notifWorker = createNotificationWorker(
    config.REDIS_URL,
    db.notificationLog,
    (telegramId, text) =>
      botRef
        .sendMessage(telegramId, text)
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
  } = await import('./worker/bot-tasks-queue.ts');
  const { runSecretaryExpiry } = await import('./worker/secretary-expiry.ts');
  const { runSharingCleanup } = await import('./services/sharing/sharing-cleanup.ts');
  const { runProposalExpiry } = await import('./worker/proposal-expiry.ts');
  const { BirthdayService } = await import('./services/birthday/birthday-service.ts');

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
      db.eventMentions.deleteExpired();
    },
    onBirthdaySync: async () => {
      const BATCH = 100;
      const needingIds = new Set(db.birthdayMeta.getUsersNeedingSync(7 * 24 * 60 * 60 * 1000));
      const allUsers = db.users.findAll().filter((u) => needingIds.has(u.telegram_id));
      for (let i = 0; i < allUsers.length; i += BATCH) {
        await cronBirthdayService.runBatchSync(allUsers.slice(i, i + BATCH));
      }
    },
  });

  await setupSecretaryExpiryCron(botTasksQueue);
  await setupSharingCleanupCron(botTasksQueue);
  await setupProposalExpiryCron(botTasksQueue);
  await setupSessionCleanupCron(botTasksQueue);
  await setupBirthdaySyncCron(botTasksQueue);

  botTasksQueueCleanup = {
    close: async () => {
      await botTasksWorker.close();
      await botTasksQueue.close();
    },
  };

  botLogger.info('Bot tasks queue initialized');
}

let transcriptionService: import('./services/voice/transcription-service.ts').TranscriptionService | undefined;
if (config.HF_TOKEN) {
  const { TranscriptionService } = await import('./services/voice/transcription-service.ts');
  transcriptionService = new TranscriptionService(config.HF_TOKEN);
  botLogger.info('Voice transcription initialized (Whisper via HF)');
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

let sileroTts: import('./services/voice/silero-tts-service.ts').SileroTtsService | undefined;
{
  const pythonPath = '/tmp/tts-test/bin/python3';
  const { existsSync } = await import('node:fs');
  if (existsSync(pythonPath) && stressDictionary) {
    const { SileroTtsService } = await import('./services/voice/silero-tts-service.ts');
    sileroTts = new SileroTtsService(pythonPath);
    botLogger.info('Silero TTS initialized');
  }
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
      try {
        return JSON.parse(stdout.trim()) as { id: number; firstName?: string; username?: string };
      } catch {
        botLogger.warn({ username, stdout: stdout.slice(0, 500) }, 'resolve-username.py bad JSON');
        return null;
      }
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
  botLogger.info('Event mention store: Redis (7-day TTL)');
} else {
  const { InMemoryEventMentionStore } = await import('./services/intent/event-mention-store.ts');
  eventMentionStore = new InMemoryEventMentionStore();
  botLogger.info('Event mention store: in-memory (no REDIS_URL)');
}

const domainEventBus = new DomainEventBus();

const { bot, agentContextBuilder, agent, intentMatcher, intentExecutor, scheduleRepo, triggerRepo, msgDeps } =
  createBot(
    config.BOT_TOKEN,
    db,
    {
      apiKey: config.ANTHROPIC_API_KEY,
      baseUrl: config.AI_BASE_URL,
      model: config.AI_MODEL,
    },
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
  );

// Patch bot ref to use real bot API
botRef.sendMessage = async (telegramId, text, parseMode) => {
  const msg = await bot.api.sendMessage({
    chat_id: telegramId,
    text,
    ...(parseMode ? { parse_mode: parseMode as 'HTML' | 'MarkdownV2' | 'Markdown' } : {}),
  });
  return { message_id: msg.message_id };
};
botRef.editMessage = async (chatId, messageId, text, parseMode) => {
  await bot.api.editMessageText({
    chat_id: chatId,
    message_id: messageId,
    text,
    ...(parseMode ? { parse_mode: parseMode as 'HTML' | 'MarkdownV2' | 'Markdown' } : {}),
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
      ctx.scheduledCallService = scheduledCallService;
      ctx.triggerService = { repo: triggerRepo };
      ctx.domainEvents = domainEventBus;
      return ctx;
    },
    intentRun: async (agentCtx, message) => {
      const match = intentMatcher.match(message);
      if (!match) return { handled: false };
      const intent = msgDeps.intentRepo.getById(match.intentId);
      if (!intent) return { handled: false };
      let workflow: Record<string, unknown>;
      try {
        workflow = JSON.parse(intent.workflow) as Record<string, unknown>;
      } catch {
        return { handled: false };
      }
      const userCtx = {
        userId: agentCtx.user.telegram_id,
        language: agentCtx.user.language,
        timezone: agentCtx.user.timezone,
        username: agentCtx.user.username ?? undefined,
        firstName: agentCtx.user.first_name ?? undefined,
      };
      const result = await intentExecutor.run(
        workflow,
        match.captures,
        userCtx,
        (toolName: string, input: Record<string, unknown>) => executeTool(agentCtx, toolName, input),
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

  checkerWorker.on('failed', (job, err) => {
    botLogger.error({ jobId: job?.id, err }, 'EventStartingChecker job failed');
  });

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
  { command: 'timezone', description: 'Change timezone' },
  { command: 'settings', description: 'Settings' },
  { command: 'import', description: 'Import .ics' },
  { command: 'holidays', description: 'Holidays calendar' },
  { command: 'share', description: 'Share agenda or event' },
  { command: 'invite', description: 'Invite user to event' },
  { command: 'invitations', description: 'View invitations' },
  { command: 'unshare', description: 'Remove event from group chat' },
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
  { command: 'timezone', description: 'Часовой пояс' },
  { command: 'settings', description: 'Настройки' },
  { command: 'import', description: 'Импорт .ics' },
  { command: 'holidays', description: 'Календарь праздников' },
  { command: 'share', description: 'Поделиться повесткой/событием' },
  { command: 'invite', description: 'Пригласить на событие' },
  { command: 'invitations', description: 'Просмотр приглашений' },
  { command: 'unshare', description: 'Убрать событие из группового чата' },
  { command: 'help', description: 'Справка' },
];

if (config.GOOGLE_CLIENT_ID) {
  COMMANDS_EN.push(
    { command: 'connect_google', description: 'Connect Google Calendar' },
    { command: 'disconnect_google', description: 'Disconnect Google Calendar' },
  );
  COMMANDS_RU.push(
    { command: 'connect_google', description: 'Подключить Google Calendar' },
    { command: 'disconnect_google', description: 'Отключить Google Calendar' },
  );
}

bot.onStart(async ({ info }) => {
  await bot.api.setMyCommands({ commands: COMMANDS_EN });
  await bot.api.setMyCommands({
    commands: COMMANDS_RU,
    language_code: 'ru',
  });
  botLogger.info({ username: info.username }, 'Bot started');
});

// Graceful shutdown
process.on('SIGINT', async () => {
  botLogger.info('Shutting down...');
  await bot.stop();
  if (aiMessagesQueueCleanup) await aiMessagesQueueCleanup.close();
  if (eventCheckerQueueCleanup) await eventCheckerQueueCleanup.close();
  if (notificationQueueCleanup) await notificationQueueCleanup.close();
  if (botTasksQueueCleanup) await botTasksQueueCleanup.close();
  if (syncQueueCleanup) await syncQueueCleanup.close();
  if (imageQueueCleanup) await imageQueueCleanup.close();
  if (callQueueCleanup) await callQueueCleanup.close();
  if (webServerHandle) webServerHandle.stop();
  db.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await bot.stop();
  if (aiMessagesQueueCleanup) await aiMessagesQueueCleanup.close();
  if (eventCheckerQueueCleanup) await eventCheckerQueueCleanup.close();
  if (notificationQueueCleanup) await notificationQueueCleanup.close();
  if (botTasksQueueCleanup) await botTasksQueueCleanup.close();
  if (syncQueueCleanup) await syncQueueCleanup.close();
  if (imageQueueCleanup) await imageQueueCleanup.close();
  if (callQueueCleanup) await callQueueCleanup.close();
  if (webServerHandle) webServerHandle.stop();
  db.close();
  process.exit(0);
});

bot.start({ dropPendingUpdates: true });
