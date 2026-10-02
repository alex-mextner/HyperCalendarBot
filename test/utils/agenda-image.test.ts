// Boundary and failure contracts for lossless delivery, without Telegram requests.
import { expect, test } from 'bun:test';
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
        expect(options.caption).toContain('lossless');
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
