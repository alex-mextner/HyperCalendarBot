// A real ImageDelivery over a scripted renderer: the AI picture tools are tested through the
// production queue-and-deliver path, not a stub of it. `await delivery.whenIdle()` waits for the
// background delivery the tool call started.
import { mock } from 'bun:test';
import {
  ImageDelivery,
  type ImageDeliveryDeps,
  type ImageDeliveryOutcome,
  type ImageOutcomeDetails,
} from '../../src/services/image/image-delivery.ts';
import type { RenderOptions } from '../../src/services/image/render-service.ts';
import type { ImageRenderJob } from '../../src/worker/image-render.queue.ts';
import { png } from './png.ts';

type RenderDirect = (job: ImageRenderJob, options?: RenderOptions) => Promise<Buffer>;

export function makeImageDelivery(
  renderDirect: RenderDirect = () => Promise.resolve(png()),
  deps: Partial<ImageDeliveryDeps> = {},
) {
  const renderer = { renderDirect: mock(renderDirect) };
  const delivery = new ImageDelivery({ renderer, ...deps });
  return { delivery, renderer };
}

/** One 'Image delivery outcome' log line: the outcome, the delivery's identity and the details it carried. */
export interface LoggedOutcome extends ImageOutcomeDetails {
  outcome: ImageDeliveryOutcome;
  kind: string;
  jobType: string;
  chatId: number;
  elapsedMs: number;
}

/** The fields object of a logger call, narrowed to an outcome line (the service only logs this message with that shape). */
export function asLoggedOutcome(fields: unknown): LoggedOutcome {
  return fields as LoggedOutcome;
}
