// A render job whose delivery bound has passed is dropped by the worker unrendered: on the shared host
// a render for nobody (a stalled job re-queued by a restart, a retry) costs a real user's picture.
import { describe, expect, spyOn, test } from 'bun:test';
import { UnrecoverableError } from '../../src/utils/unrecoverable-error.ts';
import { type ImageRenderJob, processRenderJob } from '../../src/worker/image-render.queue.ts';
import { playwrightPool } from '../../src/worker/playwright-pool.ts';
import { THEME_LIGHT } from '../../src/worker/templates/themes.ts';

const job = (expiresAt: number | undefined): ImageRenderJob => ({
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
  userId: 1,
  expiresAt,
});

describe('processRenderJob expiry', () => {
  test('an expired job fails permanently (no retry, no worker alert) without touching the browser', async () => {
    const acquire = spyOn(playwrightPool, 'acquire').mockRejectedValue(new Error('the browser must not be used'));
    try {
      const failure = await processRenderJob(job(Date.now() - 1)).catch((err: unknown) => err);
      expect(failure).toBeInstanceOf(UnrecoverableError); // the repo's own class: bullmq's cannot be imported under Bun on Linux CI
      expect(failure).toMatchObject({
        name: 'UnrecoverableError',
        message: 'Image render job expired before it started',
      });
      expect(acquire).not.toHaveBeenCalled();
    } finally {
      acquire.mockRestore();
    }
  });

  test('a job within its bound, or without one, starts rendering', async () => {
    const acquire = spyOn(playwrightPool, 'acquire').mockRejectedValue(new Error('browser reached'));
    try {
      for (const expiresAt of [Date.now() + 60_000, undefined]) {
        await expect(processRenderJob(job(expiresAt))).rejects.toThrow('browser reached');
      }
      expect(acquire).toHaveBeenCalledTimes(2);
    } finally {
      acquire.mockRestore();
    }
  });
});
