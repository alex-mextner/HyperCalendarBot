// src/index.ts

import type { DisconnectDeps } from './bot/commands/disconnect-google.ts';
import { createBot, type GoogleBotDeps } from './bot/index.ts';
import { loadConfig } from './config/env.ts';
import { createDatabase } from './database/index.ts';
import { setupSharingCleanup } from './services/sharing/sharing-cleanup.ts';
import { botLogger } from './utils/logger.ts';

const config = loadConfig();
const db = createDatabase(config.DATABASE_PATH);

// Mutable ref — patched after bot creation
const botRef: { sendMessage: (telegramId: number, text: string) => Promise<void> } = {
  sendMessage: async () => {},
};

const sharingCleanup = setupSharingCleanup(db.invitations, db.deepLinks);

let googleDeps: GoogleBotDeps | undefined;
let webServerHandle: { stop: () => void } | undefined;
let syncQueueCleanup: { close: () => Promise<void> } | undefined;
let imageQueueCleanup: { close: () => Promise<void> } | undefined;
let renderService: import('./services/image/render-service.ts').RenderService | undefined;
let callQueue: { enqueue(data: import('./services/voice/types.ts').CallReminderJobData): Promise<void> } | undefined;
let callQueueCleanup: { close: () => Promise<void> } | undefined;

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

if (config.REDIS_URL && config.MTPROTO_API_ID && config.MTPROTO_API_HASH) {
  try {
    const { createCallQueue, createCallWorker } = await import('./worker/call-queue.ts');
    const { createMtprotoClient } = await import('./services/voice/mtproto-client.ts');
    const { CallSignaling } = await import('./services/voice/call-signaling.ts');
    const { TtsService } = await import('./services/voice/tts-service.ts');
    const { CallManager } = await import('./services/voice/call-manager.ts');

    const cq = createCallQueue({ url: config.REDIS_URL });
    callQueue = cq;

    // Initialize MTProto client + call pipeline (with timeout — connect can hang)
    const connectTimeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('MTProto connect timeout (10s)')), 10_000),
    );
    const mtClient = await Promise.race([
      createMtprotoClient({
        apiId: config.MTPROTO_API_ID,
        apiHash: config.MTPROTO_API_HASH,
        sessionString: '',
      }),
      connectTimeout,
    ]);

    const callSignaling = new CallSignaling({
      callRaw: (method) => mtClient.call(method as never) as Promise<unknown>,
      resolvePeer: async (userId) => {
        const peer = await mtClient.resolvePeer(userId);
        return { userId, accessHash: (peer as { accessHash?: unknown }).accessHash ?? 0 };
      },
    });

    const ttsService = new TtsService();
    const callManager = new CallManager({
      ttsService,
      callSignaling,
      callLogRepo: db.callLog,
      sendPostCallButtons: async (userId, eventId) => {
        botLogger.info({ userId, eventId }, 'Post-call buttons (not yet wired to bot)');
      },
    });

    const worker = createCallWorker({ url: config.REDIS_URL }, callManager);
    callQueueCleanup = {
      close: async () => {
        await worker.close();
        await cq.queue.close();
      },
    };

    botLogger.info('Voice call pipeline initialized (queue + MTProto + worker)');
  } catch (error) {
    // Call queue only (no worker) — calls will queue but not execute
    botLogger.warn({ error: String(error) }, 'Voice call worker failed to init, queue-only mode');
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
);

// Patch sendMessage to use real bot API
botRef.sendMessage = async (telegramId, text) => {
  await bot.api.sendMessage({ chat_id: telegramId, text });
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
  { command: 'notify', description: 'Notification settings' },
  { command: 'share', description: 'Share agenda or event' },
  { command: 'invite', description: 'Invite user to event' },
  { command: 'invitations', description: 'View invitations' },
  { command: 'privacy', description: 'Privacy & visibility' },
  { command: 'callsettings', description: 'Voice call settings' },
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
  { command: 'notify', description: 'Настройки уведомлений' },
  { command: 'share', description: 'Поделиться повесткой/событием' },
  { command: 'invite', description: 'Пригласить на событие' },
  { command: 'invitations', description: 'Просмотр приглашений' },
  { command: 'privacy', description: 'Приватность и видимость' },
  { command: 'callsettings', description: 'Голосовые звонки' },
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
  sharingCleanup.stop();
  if (syncQueueCleanup) await syncQueueCleanup.close();
  if (imageQueueCleanup) await imageQueueCleanup.close();
  if (callQueueCleanup) await callQueueCleanup.close();
  if (webServerHandle) webServerHandle.stop();
  db.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await bot.stop();
  sharingCleanup.stop();
  if (syncQueueCleanup) await syncQueueCleanup.close();
  if (imageQueueCleanup) await imageQueueCleanup.close();
  if (callQueueCleanup) await callQueueCleanup.close();
  if (webServerHandle) webServerHandle.stop();
  db.close();
  process.exit(0);
});

bot.start({ dropPendingUpdates: true });
