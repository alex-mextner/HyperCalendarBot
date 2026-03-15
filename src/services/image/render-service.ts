import type { Queue, QueueEvents } from 'bullmq';
import { imageLogger } from '../../utils/logger.ts';
import type { ImageRenderJob, ImageRenderResult } from '../../worker/image-render.queue.ts';

const RENDER_TIMEOUT_MS = 15_000;

export class RenderService {
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
