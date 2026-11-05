// queuePicture: the one door every command, button and invitation notice sends a picture through.
// A REAL ImageDelivery over a gated renderer; only the render queue and Telegram are fake.
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { t } from '../../../src/config/constants.ts';
import { MAX_PENDING_PER_CHAT } from '../../../src/services/image/image-delivery.ts';
import { type PictureRequest, queuePicture } from '../../../src/services/image/queue-picture.ts';
import { configureTimeoutReporter } from '../../../src/services/incident/timeout-reporter.ts';
import { imageLogger } from '../../../src/utils/logger.ts';
import type { ImageRenderJob } from '../../../src/worker/image-render.queue.ts';
import { gatedDelivery } from '../../fixtures/picture-contract.ts';

afterEach(() => configureTimeoutReporter(null));

/** The test-only cast to a job shape lives in this one factory (CLAUDE.md). */
function dayJob(date: string): ImageRenderJob {
  return { type: 'daily-agenda', data: { date }, userId: 1 } as unknown as ImageRenderJob;
}

function request(overrides: Partial<PictureRequest> = {}) {
  const notes: string[] = [];
  const sent: number[] = [];
  const picture: PictureRequest = {
    chatId: 1,
    language: 'en',
    kind: 'day',
    label: '2026-11-01',
    slot: 'day:user:1:2026-11-01',
    requestId: 10,
    filename: 'day.png',
    buildJob: () => dayJob('2026-11-01'),
    sendPhoto: async () => {
      sent.push(1);
      return 77;
    },
    notify: async (text) => {
      notes.push(text);
    },
    ...overrides,
  };
  return { picture, notes, sent };
}

describe('queuePicture', () => {
  test('queues and returns while the render is pending, then sends once and runs onSent', async () => {
    const g = gatedDelivery();
    const onSent = mock((_messageId: number) => {});
    const { picture, notes, sent } = request({ onSent });

    expect(await queuePicture(g.delivery, picture)).toEqual({ status: 'queued' });
    expect(sent).toHaveLength(0);

    g.release();
    await g.delivery.whenIdle();

    expect(sent).toHaveLength(1);
    expect(onSent).toHaveBeenCalledWith(77);
    expect(notes).toHaveLength(0);
  });

  test('the same picture asked for twice is silent the second time', async () => {
    const g = gatedDelivery();
    const first = request();
    const second = request({ requestId: 11 });

    await queuePicture(g.delivery, first.picture);
    expect(await queuePicture(g.delivery, second.picture)).toEqual({ status: 'duplicate' });
    g.releaseAll();
    await g.delivery.whenIdle();

    expect(first.sent).toHaveLength(1);
    expect(second.sent).toHaveLength(0);
    expect(second.notes).toHaveLength(0);
  });

  test('a chat that already has the maximum pending gets one honest note and nothing is queued', async () => {
    const g = gatedDelivery();
    for (let i = 0; i < MAX_PENDING_PER_CHAT; i++) {
      await queuePicture(
        g.delivery,
        request({ slot: `day:${i}`, buildJob: () => dayJob(`2026-12-0${i + 1}`) }).picture,
      );
    }
    const over = request({ slot: 'day:over', buildJob: () => dayJob('2027-01-01') });

    expect(await queuePicture(g.delivery, over.picture)).toEqual({ status: 'busy' });

    expect(over.notes).toEqual([t('en').aiTools.meta.imageBusy]);
    expect(g.renderer.renderDirect).toHaveBeenCalledTimes(MAX_PENDING_PER_CHAT);
    g.releaseAll();
    await g.delivery.whenIdle();
  });

  test('a job that cannot be built gives one note and never reaches the renderer', async () => {
    const g = gatedDelivery();
    const { picture, notes } = request({
      buildJob: () => {
        throw new Error('synthetic mapper bug');
      },
    });

    await queuePicture(g.delivery, picture);

    expect(notes).toEqual([t('en').callbackErrors.imageGenerationFailed]);
    expect(g.renderer.renderDirect).not.toHaveBeenCalled();
  });

  test('a picture with no text version names its own failure: the default points at a text above it', async () => {
    const g = gatedDelivery();
    const { picture, notes } = request({
      failureNote: 'The comparison could not be prepared.',
      buildJob: () => {
        throw new Error('synthetic mapper bug');
      },
    });

    await queuePicture(g.delivery, picture);

    expect(notes).toEqual(['The comparison could not be prepared.']);
  });

  test('a note that cannot be sent is logged once, not thrown, and the picture is still not queued', async () => {
    const g = gatedDelivery();
    const warn = spyOn(imageLogger, 'warn').mockImplementation((() => undefined) as never);
    const error = spyOn(imageLogger, 'error').mockImplementation((() => undefined) as never);
    try {
      const { picture } = request({
        buildJob: () => {
          throw new Error('synthetic mapper bug');
        },
        notify: () => Promise.reject(new Error('chat blocked the bot')),
      });

      await expect(queuePicture(g.delivery, picture)).resolves.toEqual({ status: 'closed' });

      expect(g.renderer.renderDirect).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledTimes(1); // the build failure
      expect(warn).toHaveBeenCalledTimes(1); // the note that could not be sent
      expect(warn.mock.calls[0]![1]).toBe('Picture note could not be sent');
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });
});
