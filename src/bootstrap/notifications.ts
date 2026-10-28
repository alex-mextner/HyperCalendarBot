// src/bootstrap/notifications.ts
//
// Startup phase: the reminder notification scheduler (BullMQ queue + worker + one-minute tick).
// Runs only with REDIS_URL.
//
// Ordering invariants:
//  - It runs AFTER the voice-call and weather phases: scheduled voice calls are enqueued through the
//    call queue (absent when voice is disabled) and the scheduler reads weather at tick time.
//  - It runs BEFORE createBot(); the worker sends through `ctx.botRef`, which is patched after
//    createBot(), so no job can send until the bot exists (the first tick fires after the await).
//  - The tick is registered after the worker exists, so a tick is never queued without a consumer.

import { createNotificationSender } from '../services/notification/worker.ts';
import type { WeatherService } from '../services/weather/weather-service.ts';
import { botLogger } from '../utils/logger.ts';
import type { StartupContext } from './runtime.ts';
import type { CallQueueHandle } from './voice-calls.ts';

export interface NotificationInputs {
  callQueue: CallQueueHandle | undefined;
  weatherService: WeatherService | undefined;
}

export async function initNotificationScheduler(ctx: StartupContext, inputs: NotificationInputs): Promise<void> {
  const { config, db, botRef } = ctx;
  if (!config.REDIS_URL) return;

  const { createNotificationQueue, createNotificationWorker, setupNotificationTick } = await import(
    '../services/notification/queue.ts'
  );
  const { NotificationScheduler } = await import('../services/notification/scheduler.ts');
  const { EventService } = await import('../services/event/event-service.ts');

  const notifQueue = createNotificationQueue(config.REDIS_URL);

  const notifEventService = new EventService({
    eventRepo: db.events,
  });

  const { callQueue } = inputs;
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
          callQueue
            .enqueue(data)
            .catch((err) => botLogger.error({ err, userId: data.userId }, 'Failed to queue scheduled voice call'));
        }
      : undefined,
    weatherService: inputs.weatherService,
    featureUsageRepo: db.featureUsage,
  });

  const notifWorker = createNotificationWorker(
    config.REDIS_URL,
    db.notificationLog,
    createNotificationSender(botRef),
    scheduler,
  );

  await setupNotificationTick(notifQueue);

  ctx.resources.notificationQueue = {
    close: async () => {
      await notifWorker.close();
      await notifQueue.close();
    },
  };

  botLogger.info('Notification scheduler initialized');
}
