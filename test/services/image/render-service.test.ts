import { describe, expect, mock, test } from 'bun:test';
import { RenderService } from '../../../src/services/image/render-service.ts';
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
