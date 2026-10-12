import type { Queue, QueueEvents } from 'bullmq';
import { imageLogger } from '../../utils/logger.ts';
import type { ImageRenderJob, ImageRenderResult } from '../../worker/image-render.queue.ts';

// Production (ODROID-N2+, since 2026-10-09) renders take 6–15 s because the idle Chromium and
// Bun heap sit in swap between renders; 15 s dropped a finished 15.2 s render on 2026-10-12.
// 45 s is about 3× the slowest measured render. Like every tool, a render is not cut by the AI
// turn's 90 s deadline (checked between rounds), so a late render can end a turn past 90 s —
// chosen over discarding an image the worker already finished.
const RENDER_TIMEOUT_MS = 45_000;

/** Structural interface for image rendering — use this in AgentContext and tests instead of RenderService class. */
export interface ImageRenderer {
  renderDirect(job: ImageRenderJob): Promise<Buffer>;
}

export class RenderService implements ImageRenderer {
  constructor(
    private queue: Queue<ImageRenderJob>,
    private queueEvents: QueueEvents,
  ) {}

  async renderDirect(job: ImageRenderJob): Promise<Buffer> {
    imageLogger.info({ type: job.type, userId: job.userId }, 'Enqueuing render job');

    const added = await this.queue.add('render', job, { priority: 1 });

    const result = (await added.waitUntilFinished(this.queueEvents, RENDER_TIMEOUT_MS)) as ImageRenderResult;

    imageLogger.info({ type: job.type, userId: job.userId, renderTimeMs: result.renderTimeMs }, 'Render complete');

    return Buffer.from(result.bufferBase64, 'base64');
  }
}
