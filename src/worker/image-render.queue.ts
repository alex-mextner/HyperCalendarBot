import { Queue, QueueEvents, Worker } from 'bullmq';
import { imageLogger } from '../utils/logger.ts';
import { parseRedisUrl } from '../utils/redis.ts';
import { playwrightPool } from './playwright-pool.ts';
import type { ConflictScheduleData } from './templates/conflict-schedule.ts';
import { getTemplate } from './templates/index.ts';
import type { DailyAgendaData, EventCardData, WeeklyOverviewData } from './templates/types.ts';

// --- Job types ---

export type ImageRenderJob =
  | { type: 'daily-agenda'; data: DailyAgendaData; userId: number }
  | { type: 'weekly-overview'; data: WeeklyOverviewData; userId: number }
  | { type: 'event-card'; data: EventCardData; userId: number }
  | { type: 'conflict-schedule'; data: ConflictScheduleData; userId: number };

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
  const start = performance.now();

  const template = getTemplate(job.type);
  const html = template.render(job.data);

  const page = await playwrightPool.acquire();
  try {
    await page.setContent(html, { waitUntil: 'load' });

    const height = await page.evaluate(() => document.getElementById('__root')?.scrollHeight ?? 800);

    await page.setViewportSize({ width: 1080, height });

    const buffer = await page.screenshot({
      type: 'png',
      clip: { x: 0, y: 0, width: 1080, height },
    });

    const renderTimeMs = Math.round(performance.now() - start);
    imageLogger.info({ type: job.type, userId: job.userId, renderTimeMs, height }, 'Image rendered');

    return {
      bufferBase64: Buffer.from(buffer).toString('base64'),
      width: 1080,
      height,
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
      timeout: 15_000,
      removeOnComplete: { age: 60, count: 100 },
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
      limiter: { max: 20, duration: 60_000 },
    },
  );

  worker.on('failed', (bullJob, err) => {
    imageLogger.error({ jobId: bullJob?.id, err: err }, 'Image render failed');
  });

  return { queue, worker, queueEvents };
}
