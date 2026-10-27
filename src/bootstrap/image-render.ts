// src/bootstrap/image-render.ts
//
// Startup phase: the Playwright-backed calendar image renderer (BullMQ queue + worker).
//
// Ordering invariants:
//  - Only with REDIS_URL. The Playwright pool starts first; if it cannot initialise, image
//    rendering is disabled (renderService stays undefined) and startup continues.
//  - The queue/worker modules are imported lazily so a deployment without rendering never loads
//    Playwright.
//  - The pool is shut down last when the queue is closed (see shutdown.ts: imageQueue).

import type { Queue } from 'bullmq';
import type { RenderService } from '../services/image/render-service.ts';
import { botLogger } from '../utils/logger.ts';
import type { ImageRenderJob } from '../worker/image-render.queue.ts';
import type { StartupContext } from './runtime.ts';

export async function initImageRender(ctx: StartupContext): Promise<RenderService | undefined> {
  const { config } = ctx;
  if (!config.REDIS_URL) return undefined;

  const { createImageRenderQueue } = await import('../worker/image-render.queue.ts');
  const { RenderService: RenderServiceClass } = await import('../services/image/render-service.ts');
  const { playwrightPool } = await import('../worker/playwright-pool.ts');

  let renderService: RenderService | undefined;
  try {
    await playwrightPool.initialize();

    const { queue: imageQueue, worker, queueEvents } = createImageRenderQueue(config.REDIS_URL);
    worker.on('failed', ctx.onWorkerFailed('image-render'));
    renderService = new RenderServiceClass(imageQueue as Queue<ImageRenderJob>, queueEvents);

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
  return renderService;
}
