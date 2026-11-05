import type { Queue, QueueEvents } from 'bullmq';
import { imageLogger } from '../../utils/logger.ts';
import type { ImageRenderJob, ImageRenderResult } from '../../worker/image-render.queue.ts';

// Production (ODROID-N2+, since 2026-10-09) renders take 6–15 s because the idle Chromium and
// Bun heap sit in swap between renders; 15 s dropped a finished 15.2 s render on 2026-10-12.
// 45 s is about 3× the slowest measured render. It is only the default for a caller that passes no
// timeout of its own: every picture the bot sends (the AI tools, the slash commands, the buttons)
// goes through ImageDelivery, which never blocks its caller and passes its own, longer bound
// (image-delivery.ts).
const RENDER_TIMEOUT_MS = 45_000;

export interface RenderOptions {
  /** How long to wait for the worker before giving up; default RENDER_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Stop waiting (and withdraw a job the worker has not started) when this aborts. */
  signal?: AbortSignal;
  /** BullMQ job id: a deterministic id makes a repeated add a no-op and lets a restarted bot find the job again. */
  jobId?: string;
}

/** The worker did not finish within the wait. The job is withdrawn when it has not started. */
export class RenderTimeoutError extends Error {
  constructor(
    readonly waitedMs: number,
    readonly limitMs: number,
  ) {
    super(`Image render timed out after ${waitedMs} ms (limit ${limitMs} ms)`);
    this.name = 'RenderTimeoutError';
  }
}

/** The caller stopped waiting (shutdown, a newer picture replaced this one). */
export class RenderAbortedError extends Error {
  constructor() {
    super('Image render wait was aborted');
    this.name = 'RenderAbortedError';
  }
}

/** Structural interface for image rendering — use this in AgentContext and tests instead of RenderService class. */
export interface ImageRenderer {
  renderDirect(job: ImageRenderJob, options?: RenderOptions): Promise<Buffer>;
}

/** BullMQ's `Job.waitUntilFinished` has no typed timeout error; its message is the only signal. */
function isWaitTimeout(err: unknown): boolean {
  return err instanceof Error && /timed out before finishing/.test(err.message);
}

function abortion(signal: AbortSignal | undefined): { promise: Promise<never>; stop(): void } | null {
  if (!signal) return null;
  const { promise, reject } = Promise.withResolvers<never>();
  const onAbort = () => reject(new RenderAbortedError());
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  promise.catch(() => {});
  return { promise, stop: () => signal.removeEventListener('abort', onAbort) };
}

export class RenderService implements ImageRenderer {
  constructor(
    private queue: Queue<ImageRenderJob>,
    private queueEvents: QueueEvents,
  ) {}

  async renderDirect(job: ImageRenderJob, options: RenderOptions = {}): Promise<Buffer> {
    const limitMs = options.timeoutMs ?? RENDER_TIMEOUT_MS;
    const startedAt = Date.now();
    imageLogger.info({ type: job.type, userId: job.userId }, 'Enqueuing render job');

    const added = await this.queue.add('render', job, {
      priority: 1,
      ...(options.jobId ? { jobId: options.jobId } : {}),
    });
    const finished = added.waitUntilFinished(this.queueEvents, limitMs) as Promise<ImageRenderResult>;
    finished.catch(() => {}); // the losing side of an abort race must not become an unhandled rejection
    const abort = abortion(options.signal);

    try {
      const result = await (abort ? Promise.race([finished, abort.promise]) : finished);
      imageLogger.info({ type: job.type, userId: job.userId, renderTimeMs: result.renderTimeMs }, 'Render complete');
      return Buffer.from(result.bufferBase64, 'base64');
    } catch (err) {
      const timedOut = isWaitTimeout(err);
      if (timedOut || err instanceof RenderAbortedError) {
        // Nobody waits for this picture any more: take it off the queue so the shared host does not
        // render it for nobody. A job the worker already runs cannot be removed; its expiry stops a retry.
        // Not on shutdown: the durable delivery resumes this very job at the next start.
        if (options.signal?.reason !== 'shutdown') await added.remove().catch(() => {});
      }
      if (timedOut) throw new RenderTimeoutError(Date.now() - startedAt, limitMs);
      throw err;
    } finally {
      abort?.stop();
    }
  }
}
