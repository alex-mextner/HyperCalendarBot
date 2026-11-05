// src/bootstrap/image-render.ts
//
// Startup phase: the Playwright-backed calendar image renderer (BullMQ queue + worker).
//
// Ordering invariants:
//  - Only with REDIS_URL. The Playwright pool starts first; if it cannot initialise, image
//    rendering is disabled (imageDelivery stays undefined: commands send text only) and startup continues.
//  - The queue/worker modules are imported lazily so a deployment without rendering never loads
//    Playwright.
//  - The pool is shut down last when the queue is closed (see shutdown.ts: imageQueue).
//  - ImageDelivery (the background delivery of EVERY picture: AI tools, commands, buttons, invitation
//    notices) sits on top of the render service and
//    is closed BEFORE the queue (shutdown.ts: imageDelivery): its pending renders are cancelled but their
//    BullMQ jobs and database rows are kept, so the next start delivers them (a delivery without a store
//    tells its user instead), and the held render-failure summary is sent. It learns of calendar writes from the domain event
//    bus (domain-events.ts), which is created later.
//  - Deliveries are durable (image_deliveries, migration 070). Once the bot exists, index.ts attaches
//    the Telegram transport and calls `reconcile()`: what the previous process left unfinished is
//    delivered, expired with one note, or marked unknown (never re-sent).

import type { Queue } from 'bullmq';
import type { TelegramSender } from '../services/ai/types.ts';
import { ImageDelivery } from '../services/image/image-delivery.ts';
import { RenderFailureReporter } from '../services/image/render-failure-reporter.ts';
import { sendAgendaImage } from '../utils/agenda-image.ts';
import { botLogger } from '../utils/logger.ts';
import type { ImageRenderJob } from '../worker/image-render.queue.ts';
import type { StartupContext } from './runtime.ts';

export interface ImageRender {
  /** Background delivery of every calendar picture; nothing in the bot awaits a render. */
  imageDelivery: ImageDelivery;
}

export async function initImageRender(ctx: StartupContext): Promise<ImageRender | undefined> {
  const { config } = ctx;
  if (!config.REDIS_URL) return undefined;

  const { createImageRenderQueue } = await import('../worker/image-render.queue.ts');
  const { RenderService: RenderServiceClass } = await import('../services/image/render-service.ts');
  const { playwrightPool } = await import('../worker/playwright-pool.ts');

  let imageRender: ImageRender | undefined;
  try {
    await playwrightPool.initialize();

    const { queue: imageQueue, worker, queueEvents } = createImageRenderQueue(config.REDIS_URL);
    worker.on('failed', ctx.onWorkerFailed('image-render'));
    const renderService = new RenderServiceClass(imageQueue as Queue<ImageRenderJob>, queueEvents);
    const failures = new RenderFailureReporter((text, source) => ctx.db.alerts.push(text, source));
    const imageDelivery = new ImageDelivery({
      renderer: renderService,
      store: ctx.db.imageDeliveries,
      reportFailure: (report) => failures.report(report),
    });
    imageRender = { imageDelivery };

    ctx.resources.imageDelivery = {
      close: async () => {
        try {
          await imageDelivery.close();
        } finally {
          failures.flush(); // the summary held for the alert window must not die with the process
        }
      },
    };

    ctx.resources.imageQueue = {
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
  return imageRender;
}

/**
 * Once the bot exists: gives deliveries the Telegram transport for recovery and reconciles what the
 * previous process left unfinished. Fire-and-forget: startup must not wait on Telegram, and a failure
 * here is logged, never fatal.
 */
export function recoverImageDeliveries(imageDelivery: ImageDelivery, sender: TelegramSender): void {
  imageDelivery.attachTransport({
    notify: (chatId, text) => sender.sendMessage(chatId, text),
    sendImage: async (chatId, png, language) => {
      const file = new File([png], 'picture.png', { type: 'image/png' });
      const sent = await sendAgendaImage(file, {
        language,
        sendPhoto: (photo) => sender.sendPhoto!(chatId, photo),
        sendDocument: sender.sendDocument
          ? (document, options) => sender.sendDocument!(chatId, document, options.caption)
          : undefined,
      });
      return sent.message_id;
    },
  });
  imageDelivery.reconcile().catch((err: unknown) => botLogger.error({ err }, 'Image delivery reconciliation failed'));
}
