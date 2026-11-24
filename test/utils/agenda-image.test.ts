// Boundary and failure contracts for lossless delivery, without Telegram requests.
import { expect, test } from 'bun:test';
import { TelegramError } from 'gramio';
import { planAgendaRaster, sendAgendaImage } from '../../src/utils/agenda-image.ts';
import { png } from '../fixtures/png.ts';

for (const [width, height, bytes, mode] of [
  [2160, 7840, 33, 'photo'],
  [2160, 7841, 33, 'document'],
  [100, 2000, 33, 'photo'],
  [100, 2001, 33, 'document'],
  [2001, 100, 33, 'document'],
  [100, 100, 10 * 1024 * 1024, 'photo'],
  [100, 100, 10 * 1024 * 1024 + 1, 'document'],
  [100, 100, 50 * 1024 * 1024, 'document'],
] as const) {
  test(`${width}x${height} ${bytes} bytes uses ${mode} unchanged`, async () => {
    const file = new File([png(width, height, bytes)], 'agenda.png', { type: 'image/png' });
    const calls: string[] = [];
    const result = await sendAgendaImage(file, {
      sendPhoto: async (actual) => {
        expect(actual).toBe(file);
        calls.push('photo');
        return 42;
      },
      sendDocument: async (actual, options) => {
        expect(actual).toBe(file);
        expect(options.caption).toContain('exceeds Telegram photo limits');
        calls.push('document');
        return 42;
      },
    });
    expect(result).toBe(42);
    expect(calls).toEqual([mode]);
  });
}
test('over 50MB and malformed PNG fail without delivery', async () => {
  for (const buffer of [png(100, 100, 50 * 1024 * 1024 + 1), Buffer.from('bad'), png(0, 1)]) {
    let calls = 0;
    await expect(
      sendAgendaImage(new File([buffer], 'agenda.png'), {
        sendPhoto: async () => calls++,
        sendDocument: async () => calls++,
      }),
    ).rejects.toThrow();
    expect(calls).toBe(0);
  }
});
test('missing document capability and rejected document cannot report success', async () => {
  const file = new File([png(2160, 9000)], 'agenda.png');
  await expect(sendAgendaImage(file, { sendPhoto: async () => 1 })).rejects.toThrow('unavailable');
  await expect(
    sendAgendaImage(file, {
      sendDocument: async () => {
        throw new Error('API rejected');
      },
    }),
  ).rejects.toThrow('API rejected');
});

const telegram400 = (description: string) =>
  new TelegramError({ ok: false, error_code: 400, description }, 'sendPhoto', { chat_id: 1, photo: 'photo' });

for (const description of ['Bad Request: IMAGE_PROCESS_FAILED', 'Bad Request: PHOTO_INVALID_DIMENSIONS']) {
  for (const [language, caption] of [
    ['en', 'could not process this agenda as a photo'],
    ['ru', 'не смог обработать это расписание как фото'],
  ] as const) {
    test(`${language}: a photo Telegram refuses (${description}) goes out as the same PNG document`, async () => {
      const file = new File([png(1080, 1335)], 'agenda.png', { type: 'image/png' });
      const calls: string[] = [];
      const result = await sendAgendaImage(file, {
        language,
        sendPhoto: async () => {
          calls.push('photo');
          throw telegram400(description);
        },
        sendDocument: async (actual, options) => {
          expect(actual).toBe(file);
          expect(options.caption).toContain(caption);
          calls.push('document');
          return 7;
        },
      });
      expect(result).toBe(7);
      expect(calls).toEqual(['photo', 'document']);
    });
  }
}

test('a refused photo is not retried when the error is not Telegram 400 with a photo-processing reason', async () => {
  const file = new File([png(1080, 1335)], 'agenda.png', { type: 'image/png' });
  const errors = [
    new Error('sendPhoto: Bad Request: IMAGE_PROCESS_FAILED'), // text alone says nothing about the outcome
    new TelegramError({ ok: false, error_code: 429, description: 'Too Many Requests: retry after 5' }, 'sendPhoto', {
      chat_id: 1,
      photo: 'photo',
    }),
    telegram400('Bad Request: chat not found'),
  ];
  for (const error of errors) {
    const calls: string[] = [];
    await expect(
      sendAgendaImage(file, {
        sendPhoto: async () => {
          calls.push('photo');
          throw error;
        },
        sendDocument: async () => {
          calls.push('document');
          return 1;
        },
      }),
    ).rejects.toBe(error);
    expect(calls).toEqual(['photo']);
  }
});

test('a refused photo without a document sender propagates the 400', async () => {
  const file = new File([png(1080, 1335)], 'agenda.png', { type: 'image/png' });
  await expect(
    sendAgendaImage(file, {
      sendPhoto: async () => {
        throw telegram400('Bad Request: IMAGE_PROCESS_FAILED');
      },
    }),
  ).rejects.toThrow('IMAGE_PROCESS_FAILED');
});

test('a document that fails after a refused photo surfaces its own error', async () => {
  const file = new File([png(1080, 1335)], 'agenda.png', { type: 'image/png' });
  await expect(
    sendAgendaImage(file, {
      sendPhoto: async () => {
        throw telegram400('Bad Request: IMAGE_PROCESS_FAILED');
      },
      sendDocument: async () => {
        throw new Error('document rejected');
      },
    }),
  ).rejects.toThrow('document rejected');
});

test('large layouts keep every CSS pixel without a multi-hundred-megabyte raster', () => {
  expect(planAgendaRaster(16711, 2)).toEqual({ scale: 'css', width: 1080, height: 16711 });
  expect(() => planAgendaRaster(24000, 2)).toThrow('allocation limit');
  expect(planAgendaRaster(1000, 2)).toEqual({ scale: 'device', width: 2160, height: 2000 });
});
test('delivery checks only PNG header without copying the entire file', async () => {
  const file = new File([png(1080, 9500)], 'large.png');
  file.arrayBuffer = async () => {
    throw new Error('whole-file-copy');
  };
  expect(await sendAgendaImage(file, { sendDocument: async () => 42 })).toBe(42);
});
test('PNG document explanation uses Russian for a Russian calendar', async () => {
  let caption = '';
  await sendAgendaImage(new File([png(1080, 9500)], 'large.png'), {
    language: 'ru',
    sendDocument: async (_file, options) => {
      caption = options.caption;
      return 1;
    },
  });
  expect(caption).toContain('PNG');
  expect(caption).toContain('расписание');
});
