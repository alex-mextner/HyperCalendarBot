// Shared doubles for the "every picture is asynchronous" contract of the commands, buttons and
// invitation notices: a REAL ImageDelivery over a renderer whose every render stays pending until the
// test releases or fails it, so a test can prove the handler returned before the render ended and then
// finish the render later. Only the render queue and Telegram are fake.
import { afterEach, describe, expect, type Mock, test } from 'bun:test';
import type { ImageDelivery, ImageDeliveryDeps, RenderFailureReport } from '../../src/services/image/image-delivery.ts';
import { RenderAbortedError, type RenderOptions } from '../../src/services/image/render-service.ts';
import { configureTimeoutReporter, TimeoutReporter } from '../../src/services/incident/timeout-reporter.ts';
import type { ImageRenderJob } from '../../src/worker/image-render.queue.ts';
import { makeImageDelivery } from './image-delivery.ts';
import { png } from './png.ts';

type RenderDirect = (job: ImageRenderJob, options?: RenderOptions) => Promise<Buffer>;

export interface GatedDelivery {
  delivery: ImageDelivery;
  /** Every render the delivery started is a call here, in order. */
  renderer: { renderDirect: Mock<RenderDirect> };
  /** Reports the delivery raised for failures that are not timeouts (each is one owner alert). */
  failures: RenderFailureReport[];
  /** Finishes the n-th render (default the first) with a PNG. */
  release(index?: number): void;
  /** Finishes every render started so far with a PNG. */
  releaseAll(): void;
  /** Fails the n-th render (default the first) with `err`. */
  fail(err: unknown, index?: number): void;
}

export function gatedDelivery(deps: Partial<ImageDeliveryDeps> = {}): GatedDelivery {
  const gates: PromiseWithResolvers<Buffer>[] = [];
  const failures: RenderFailureReport[] = [];
  const { delivery, renderer } = makeImageDelivery(
    (_job, options) => {
      const gate = Promise.withResolvers<Buffer>();
      gate.promise.catch(() => {});
      options?.signal?.addEventListener('abort', () => gate.reject(new RenderAbortedError()), { once: true });
      gates.push(gate);
      return gate.promise;
    },
    { reportFailure: (report) => failures.push(report), ...deps },
  );
  return {
    delivery,
    renderer,
    failures,
    fail: (err, index = 0) => gates[index]!.reject(err),
    release: (index = 0) => gates[index]!.resolve(png()),
    releaseAll: () => {
      for (const gate of gates) gate.resolve(png());
    },
  };
}

/** Routes reportTimeout to a list for the test; call `configureTimeoutReporter(null)` in afterEach. */
export function captureTimeoutAlerts(): { text: string; source: string }[] {
  const alerts: { text: string; source: string }[] = [];
  configureTimeoutReporter(new TimeoutReporter((text, source) => alerts.push({ text, source })));
  return alerts;
}

/** What a handler under the picture contract looks like to the shared tests. */
export interface PictureHarness {
  /** Runs the handler once; `requestId` is the Telegram message (or callback) id of this call. */
  run(delivery: ImageDelivery, requestId: number): Promise<void>;
  /** Pictures (photos or documents) the chat received. */
  photos(): number;
  /** Every text the chat received, in order: the handler's own answer first, then any note. */
  texts(): string[];
}

/**
 * The behaviour every picture path owes the user (owner instruction 2026-11-01: every picture is
 * asynchronous, every timeout reaches the repair flow). `makeHarness` builds fresh doubles per test.
 */
export function describePictureContract(name: string, makeHarness: () => PictureHarness): void {
  describe(`${name}: picture contract`, () => {
    afterEach(() => configureTimeoutReporter(null));

    test('returns before a slow render ends and delivers the late picture exactly once', async () => {
      const h = makeHarness();
      const g = gatedDelivery();

      await h.run(g.delivery, 1);

      expect(g.renderer.renderDirect).toHaveBeenCalledTimes(1);
      expect(h.photos()).toBe(0);
      const answered = h.texts();

      g.release();
      await g.delivery.whenIdle();

      expect(h.photos()).toBe(1);
      expect(h.texts()).toEqual(answered); // the picture arrived: no note
    });

    test('a double tap or repeated command delivers one picture', async () => {
      const h = makeHarness();
      const g = gatedDelivery();

      await h.run(g.delivery, 1);
      await h.run(g.delivery, 2);
      g.releaseAll();
      await g.delivery.whenIdle();

      expect(h.photos()).toBe(1);
    });

    test('a failed render gives one note and one owner alert, and no picture', async () => {
      const h = makeHarness();
      const g = gatedDelivery();

      await h.run(g.delivery, 1);
      const answered = h.texts();
      g.fail(new Error('chromium crashed'));
      await g.delivery.whenIdle();

      expect(h.photos()).toBe(0);
      expect(h.texts()).toHaveLength(answered.length + 1);
      expect(g.failures).toHaveLength(1);
    });

    test('a render that outlives its bound gives one note and one timeout alert for the repair flow', async () => {
      const alerts = captureTimeoutAlerts();
      const h = makeHarness();
      const g = gatedDelivery({ boundMs: 20 });

      await h.run(g.delivery, 1);
      const answered = h.texts();
      await g.delivery.whenIdle();

      expect(h.photos()).toBe(0);
      expect(h.texts()).toHaveLength(answered.length + 1);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.text).toContain('Timeout (render)');
      expect(g.failures).toHaveLength(0);
    });
  });
}
