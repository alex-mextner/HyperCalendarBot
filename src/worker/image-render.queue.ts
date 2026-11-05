import { Queue, QueueEvents, Worker } from 'bullmq';
import { planAgendaRaster } from '../utils/agenda-image.ts';
import { imageLogger } from '../utils/logger.ts';
import { parseRedisUrl } from '../utils/redis.ts';
import { UnrecoverableError } from '../utils/unrecoverable-error.ts';
import { playwrightPool } from './playwright-pool.ts';
import type { ConflictScheduleData } from './templates/conflict-schedule.ts';
import { getTemplate } from './templates/index.ts';
import type {
  DailyAgendaData,
  EventCardData,
  MdTableData,
  MonthlyCalendarData,
  WeeklyOverviewData,
} from './templates/types.ts';

// --- Job types ---

type ImageRenderPayload =
  | { type: 'daily-agenda'; data: DailyAgendaData; userId: number }
  | { type: 'weekly-overview'; data: WeeklyOverviewData; userId: number }
  | { type: 'event-card'; data: EventCardData; userId: number }
  | { type: 'monthly-calendar'; data: MonthlyCalendarData; userId: number }
  | { type: 'conflict-schedule'; data: ConflictScheduleData; userId: number }
  | { type: 'md-table'; data: MdTableData; userId: number };

/**
 * `expiresAt` (epoch ms) is the moment nobody waits for the picture any more (the delivery bound of
 * ImageDelivery). A job that only reaches the worker after it — a stalled job re-queued by a restart,
 * or a retry — is dropped unrendered: on the shared host a render for nobody costs a real user's picture.
 */
export type ImageRenderJob = ImageRenderPayload & { expiresAt?: number };

export interface ImageRenderResult {
  bufferBase64: string; // PNG as base64 (Buffer doesn't survive Redis JSON roundtrip)
  width: number;
  height: number;
  renderTimeMs: number;
}

// --- Queue name ---

const QUEUE_NAME = 'image-render';

// --- Process function (exported for testing) ---

export async function processRenderJob(job: ImageRenderJob): Promise<ImageRenderResult> {
  if (job.expiresAt !== undefined && Date.now() > job.expiresAt) {
    throw new UnrecoverableError('Image render job expired before it started');
  }
  const start = performance.now();

  const template = getTemplate(job.type);
  const html = template.render(job.data);

  const page = await playwrightPool.acquire();
  try {
    await page.setContent(html, { waitUntil: 'load' });

    // @ts-expect-error — page.evaluate callback runs in browser scope; document is unavailable in Node types
    const height = await page.evaluate(() => document.getElementById('__root')?.scrollHeight ?? 800);

    const density = (await page.evaluate('window.devicePixelRatio')) as number;
    const raster = planAgendaRaster(height, density);
    await page.setViewportSize({ width: 1080, height });

    const buffer = await page.screenshot({
      type: 'png',
      scale: raster.scale,
      clip: { x: 0, y: 0, width: 1080, height },
    });

    const renderTimeMs = Math.round(performance.now() - start);
    imageLogger.info({ type: job.type, userId: job.userId, renderTimeMs, height }, 'Image rendered');

    return {
      bufferBase64: Buffer.from(buffer).toString('base64'),
      width: raster.width,
      height: raster.height,
      renderTimeMs,
    };
  } finally {
    await playwrightPool.release(page);
  }
}

// --- Queue + Worker factory ---

export function createImageRenderQueue(redisUrl: string) {
  const connection = parseRedisUrl(redisUrl);

  const queue = new Queue<ImageRenderJob>(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: 'fixed', delay: 1000 },
      // A finished render stays a little over the 150 s delivery bound, so a bot restarted inside the bound can
      // still collect a picture finished while it was down; after that its row is expired and nobody wants it.
      removeOnComplete: { age: 180, count: 100 },
      removeOnFail: { age: 3600 },
    },
  });

  const queueEvents = new QueueEvents(QUEUE_NAME, { connection });

  const worker = new Worker<ImageRenderJob, ImageRenderResult>(
    QUEUE_NAME,
    async (bullJob) => processRenderJob(bullJob.data),
    {
      connection,
      concurrency: 4,
    },
  );

  worker.on('failed', (bullJob, err) => {
    imageLogger.error({ jobId: bullJob?.id, err: err }, 'Image render failed');
  });

  return { queue, worker, queueEvents };
}
