import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { RenderAbortedError, RenderService, RenderTimeoutError } from '../../../src/services/image/render-service.ts';
import { configureTimeoutReporter, TimeoutReporter } from '../../../src/services/incident/timeout-reporter.ts';
import type { ImageRenderJob } from '../../../src/worker/image-render.queue.ts';
import { THEME_LIGHT } from '../../../src/worker/templates/themes.ts';

describe('RenderService', () => {
  test('renderDirect enqueues job and decodes base64 result', async () => {
    const pngBase64 = Buffer.from('fake-png-data').toString('base64');
    const mockJob = {
      id: 'j1',
      waitUntilFinished: mock(() =>
        Promise.resolve({
          bufferBase64: pngBase64,
          width: 1080,
          height: 800,
          renderTimeMs: 500,
        }),
      ),
    };
    const mockAdd = mock(() => Promise.resolve(mockJob));
    const mockQueueEvents = {};

    const service = new RenderService(
      { add: mockAdd } as unknown as ConstructorParameters<typeof RenderService>[0],
      mockQueueEvents as unknown as ConstructorParameters<typeof RenderService>[1],
    );

    const job: ImageRenderJob = {
      type: 'daily-agenda',
      data: {
        date: '2026-03-11',
        dayOfWeek: 'Wed',
        dateFormatted: 'March 11',
        eventCount: 0,
        allDayEvents: [],
        timedEvents: [],
        theme: THEME_LIGHT,
        locale: 'en',
      },
      userId: 123,
    };

    const result = await service.renderDirect(job);
    expect(result).toBeInstanceOf(Buffer);
    expect(result.toString()).toBe('fake-png-data');
    expect(mockAdd).toHaveBeenCalledTimes(1);
  });

  test('delivers a render that finishes after 15 s instead of abandoning it (prod 2026-10-12)', async () => {
    // On 2026-10-12 18:00:31 UTC the production worker finished a daily agenda in 15 183 ms,
    // two seconds after renderDirect had stopped waiting at 15 000 ms. The caller
    // threw BullMQ's wait-timeout error and the finished image was discarded.
    const workerFinishedAfterMs = 15_183;
    const result = {
      bufferBase64: Buffer.from('late-png').toString('base64'),
      width: 1080,
      height: 1015,
      renderTimeMs: 15_183,
    };
    // Same contract as BullMQ's Job.waitUntilFinished: reject once the ttl passes first.
    const waitUntilFinished = mock((_events: unknown, ttl?: number) =>
      ttl !== undefined && ttl <= workerFinishedAfterMs
        ? Promise.reject(
            new Error(
              `Job wait render timed out before finishing, no finish notification arrived after ${ttl}ms (id=539)`,
            ),
          )
        : Promise.resolve(result),
    );
    const service = new RenderService(
      { add: mock(() => Promise.resolve({ id: '539', waitUntilFinished })) } as unknown as ConstructorParameters<
        typeof RenderService
      >[0],
      {} as unknown as ConstructorParameters<typeof RenderService>[1],
    );

    const buffer = await service.renderDirect({
      type: 'daily-agenda',
      data: {
        date: '2026-10-12',
        dayOfWeek: 'Mon',
        dateFormatted: 'October 12',
        eventCount: 0,
        allDayEvents: [],
        timedEvents: [],
        theme: THEME_LIGHT,
        locale: 'en',
      },
      userId: 123,
    });

    expect(buffer.toString()).toBe('late-png');
    // About 3× the slowest measured production render (15.2 s), yet bounded so a stuck worker
    // cannot hold a command for long.
    expect(waitUntilFinished.mock.calls[0]?.[1]).toBe(45_000);
  });
});

describe('RenderService with a caller-chosen bound (picture delivery)', () => {
  const dailyJob: ImageRenderJob = {
    type: 'daily-agenda',
    data: {
      date: '2026-11-01',
      dayOfWeek: 'Sun',
      dateFormatted: 'November 1',
      eventCount: 0,
      allDayEvents: [],
      timedEvents: [],
      theme: THEME_LIGHT,
      locale: 'en',
    },
    userId: 123,
  };

  function serviceWith(waitUntilFinished: (events: unknown, ttl?: number) => Promise<unknown>) {
    const remove = mock(() => Promise.resolve());
    const service = new RenderService(
      {
        add: mock(() => Promise.resolve({ id: '9', waitUntilFinished: mock(waitUntilFinished), remove })),
      } as unknown as ConstructorParameters<typeof RenderService>[0],
      {} as unknown as ConstructorParameters<typeof RenderService>[1],
    );
    return { service, remove };
  }

  test('waits for the given timeout instead of the default 45 s', async () => {
    const waitUntilFinished = mock((_events: unknown, _ttl?: number) =>
      Promise.resolve({ bufferBase64: Buffer.from('x').toString('base64'), width: 1, height: 1, renderTimeMs: 1 }),
    );
    const { service } = serviceWith(waitUntilFinished);
    await service.renderDirect(dailyJob, { timeoutMs: 150_000 });
    expect(waitUntilFinished.mock.calls[0]?.[1]).toBe(150_000);
  });

  test("the worker's wait timeout (prod 2026-11-01: 'Job wait render timed out ... 45000ms') becomes a typed RenderTimeoutError and withdraws the job", async () => {
    const { service, remove } = serviceWith((_events, ttl) =>
      Promise.reject(
        new Error(`Job wait render timed out before finishing, no finish notification arrived after ${ttl}ms (id=9)`),
      ),
    );
    const failure = await service.renderDirect(dailyJob, { timeoutMs: 1_000 }).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(RenderTimeoutError);
    expect(failure).toMatchObject({ limitMs: 1_000 });
    expect(remove).toHaveBeenCalledTimes(1);
  });

  describe('reporting', () => {
    const alerts: string[] = [];
    beforeEach(() => {
      alerts.length = 0;
      configureTimeoutReporter(new TimeoutReporter((text) => alerts.push(text)));
    });
    afterEach(() => configureTimeoutReporter(null));

    // ImageDelivery reports a picture's timeout once, for its own deadline and for this one alike; a
    // second report here would count one slow render twice.
    test('a wait timeout is thrown to the caller and not reported by the render call itself', async () => {
      const { service } = serviceWith((_events, ttl) =>
        Promise.reject(
          new Error(`Job wait render timed out before finishing, no finish notification arrived after ${ttl}ms (id=9)`),
        ),
      );
      await expect(service.renderDirect(dailyJob, { timeoutMs: 1_000 })).rejects.toBeInstanceOf(RenderTimeoutError);
      expect(alerts).toEqual([]);
    });
  });

  test('an aborted wait stops at once and withdraws the job nobody waits for', async () => {
    const { service, remove } = serviceWith(() => new Promise(() => {}));
    const controller = new AbortController();
    const rendering = service.renderDirect(dailyJob, { signal: controller.signal });
    controller.abort();
    expect(await rendering.catch((err: unknown) => err)).toBeInstanceOf(RenderAbortedError);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  test('a render that fails in the worker is rethrown as it is and the job is left for BullMQ', async () => {
    const { service, remove } = serviceWith(() => Promise.reject(new Error('page crashed')));
    await expect(service.renderDirect(dailyJob)).rejects.toThrow('page crashed');
    expect(remove).not.toHaveBeenCalled();
  });

  test('a deterministic job id reaches BullMQ so a repeated add is a no-op', async () => {
    const add = mock((_name: string, _job: unknown, _options: unknown) =>
      Promise.resolve({
        id: 'img-1',
        remove: mock(() => Promise.resolve()),
        waitUntilFinished: () =>
          Promise.resolve({ bufferBase64: Buffer.from('x').toString('base64'), width: 1, height: 1, renderTimeMs: 1 }),
      }),
    );
    const service = new RenderService(
      { add } as unknown as ConstructorParameters<typeof RenderService>[0],
      {} as unknown as ConstructorParameters<typeof RenderService>[1],
    );
    await service.renderDirect(dailyJob, { jobId: 'img-1' });
    expect(add.mock.calls[0]?.[2]).toEqual({ priority: 1, jobId: 'img-1' });
  });

  test('an abort for shutdown keeps the queued job: the next start resumes it', async () => {
    const { service, remove } = serviceWith(() => new Promise(() => {}));
    const controller = new AbortController();
    const rendering = service.renderDirect(dailyJob, { signal: controller.signal });
    controller.abort('shutdown');
    expect(await rendering.catch((err: unknown) => err)).toBeInstanceOf(RenderAbortedError);
    expect(remove).not.toHaveBeenCalled();
  });
});
