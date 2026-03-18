// src/index.ts

import type { DisconnectDeps } from './bot/commands/disconnect-google.ts';
import { createBot, type GoogleBotDeps } from './bot/index.ts';
import { loadConfig } from './config/env.ts';
import { createDatabase } from './database/index.ts';
import { botLogger } from './utils/logger.ts';

const config = loadConfig();
const db = createDatabase(config.DATABASE_PATH);

// Mutable ref — patched after bot creation
const botRef: {
  sendMessage: (telegramId: number, text: string) => Promise<void>;
  sendVoice: (telegramId: number, audio: Buffer) => Promise<void>;
  editMessage: (chatId: number, messageId: number, text: string) => Promise<void>;
} = {
  sendMessage: async () => {},
  sendVoice: async () => {},
  editMessage: async () => {},
};

let googleDeps: GoogleBotDeps | undefined;
let webServerHandle: { stop: () => void } | undefined;
let syncQueueCleanup: { close: () => Promise<void> } | undefined;
let imageQueueCleanup: { close: () => Promise<void> } | undefined;
let renderService: import('./services/image/render-service.ts').RenderService | undefined;
let callQueue: { enqueue(data: import('./services/voice/types.ts').CallReminderJobData): Promise<void> } | undefined;
let callQueueCleanup: { close: () => Promise<void> } | undefined;
let notificationQueueCleanup: { close: () => Promise<void> } | undefined;
let botTasksQueueCleanup: { close: () => Promise<void> } | undefined;
let mtprotoSendAsUser: ((userId: number, text: string, username?: string) => Promise<boolean>) | undefined;

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
    sendMessage: (telegramId, text) => botRef.sendMessage(telegramId, text),
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

  const { queue, worker, queueEvents } = createImageRenderQueue(config.REDIS_URL);
  renderService = new RenderService(queue, queueEvents);

  imageQueueCleanup = {
    close: async () => {
      await worker.close();
      await queue.close();
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
    const { existsSync } = await import('node:fs');

    const cq = createCallQueue({ url: config.REDIS_URL });
    callQueue = cq;

    const pyBridgePath = 'scripts/voice-call-bridge.py';
    const pySessionExists = existsSync('data/voice_caller.session');

    if (!pySessionExists) {
      botLogger.warn('Pyrogram session not found (data/voice_caller.session). Run: bun run auth:voice');
    }

    const ttsService = new TtsService();
    const callManager = new CallManager({
      ttsService,
      callLogRepo: db.callLog,
      sendPostCallButtons: async (userId, eventId) => {
        botLogger.info({ userId, eventId }, 'Post-call buttons (not yet wired to bot)');
      },
      sendVoiceMessage: async (userId, audio) => {
        await botRef.sendVoice(userId, audio);
      },
      pyBridgePath,
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
    botLogger.warn({ error: String(error) }, 'Voice call init failed, queue-only mode');
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
    (telegramId, text) => botRef.sendMessage(telegramId, text),
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
  const { createBotTasksQueue, setupSecretaryExpiryCron, setupSharingCleanupCron, setupProposalExpiryCron } =
    await import('./worker/bot-tasks-queue.ts');
  const { runSecretaryExpiry } = await import('./worker/secretary-expiry.ts');
  const { runSharingCleanup } = await import('./services/sharing/sharing-cleanup.ts');
  const { runProposalExpiry } = await import('./worker/proposal-expiry.ts');

  const { queue: botTasksQueue, worker: botTasksWorker } = createBotTasksQueue({
    redisUrl: config.REDIS_URL,
    onSecretaryExpiry: () =>
      runSecretaryExpiry({
        secretaryRepo: db.secretaries,
        userRepo: db.users,
        notify: (userId, text) => botRef.sendMessage(userId, text),
      }),
    onSharingCleanup: () => runSharingCleanup({ invitationRepo: db.invitations, deepLinkRepo: db.deepLinks }),
    onProposalExpiry: () =>
      runProposalExpiry({
        proposalRepo: db.calendarProposals,
        editMessage: (chatId, messageId, text) => botRef.editMessage(chatId, messageId, text),
      }),
  });

  await setupSecretaryExpiryCron(botTasksQueue);
  await setupSharingCleanupCron(botTasksQueue);
  await setupProposalExpiryCron(botTasksQueue);

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
  botLogger.warn({ error: String(error) }, 'Stress dictionary not loaded');
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
    botLogger.info('MTProto messenger initialized (pyrogram)');
  } else {
    botLogger.info('Pyrogram session not found, invitation delivery via userbot disabled');
  }
}

const { bot } = createBot(
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
);

// Patch bot ref to use real bot API
botRef.sendMessage = async (telegramId, text) => {
  await bot.api.sendMessage({ chat_id: telegramId, text });
};
botRef.editMessage = async (chatId, messageId, text) => {
  await bot.api.editMessageText({ chat_id: chatId, message_id: messageId, text });
};
botRef.sendVoice = async (telegramId, audio) => {
  const file = new File([audio], 'message.mp3', { type: 'audio/mpeg' });
  await bot.api.sendVoice({ chat_id: telegramId, voice: file });
};

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
  { command: 'export', description: 'Export .ics' },
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
  { command: 'export', description: 'Экспорт .ics' },
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
