// recoverImageDeliveries: after a restart the bot hands ImageDelivery its Telegram sender and the previous
// process's unfinished pictures are delivered once, expired with one note, or marked unknown and never
// re-sent. A real ImageDelivery over a real SQLite store; only Telegram and the render queue are fakes.
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { recoverImageDeliveries } from '../../src/bootstrap/image-render.ts';
import { t } from '../../src/config/constants.ts';
import { migrations } from '../../src/database/migrations.ts';
import {
  ImageDeliveryRepository,
  type NewImageDelivery,
} from '../../src/database/repositories/image-delivery.repository.ts';
import { runMigrations } from '../../src/database/schema.ts';
import type { TelegramSender } from '../../src/services/ai/types.ts';
import { ImageDelivery } from '../../src/services/image/image-delivery.ts';
import { configureTimeoutReporter, TimeoutReporter } from '../../src/services/incident/timeout-reporter.ts';
import { botLogger } from '../../src/utils/logger.ts';
import type { ImageRenderJob } from '../../src/worker/image-render.queue.ts';
import { png } from '../fixtures/png.ts';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const job = { type: 'daily-agenda', data: { date: '2026-11-02', theme: {}, locale: 'en' }, userId: 1 };
const stored = (overrides: Partial<NewImageDelivery> = {}): NewImageDelivery => ({
  id: 'img-1',
  chatId: 7,
  language: 'en',
  kind: 'day',
  label: '2026-11-02',
  jobType: 'daily-agenda',
  slot: 'day:user:1:2026-11-02:en',
  payloadHash: 'h',
  jobJson: JSON.stringify(job),
  createdAt: Date.now(),
  expiresAt: Date.now() + 150_000,
  ...overrides,
});

let db: Database;
let store: ImageDeliveryRepository;
let alerts: string[];
let errorSpy: ReturnType<typeof spyOn>;

function sender() {
  const sendMessage = mock(async (_chatId: number, _text: string) => ({ message_id: 1 }));
  const sendPhoto = mock(async (_chatId: number, _photo: File) => ({ message_id: 77 }));
  return { sendMessage, sendPhoto, telegram: { sendMessage, sendPhoto } as unknown as TelegramSender };
}

/** A fresh process: a renderer that has the finished picture ready, over the shared SQLite. */
function process2() {
  const renderDirect = mock(async (_job: ImageRenderJob) => png());
  return { delivery: new ImageDelivery({ renderer: { renderDirect }, store }), renderDirect };
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db, migrations);
  store = new ImageDeliveryRepository(db);
  alerts = [];
  configureTimeoutReporter(new TimeoutReporter((text) => alerts.push(text)));
  errorSpy = spyOn(botLogger, 'error').mockImplementation(() => {});
});

afterEach(() => {
  configureTimeoutReporter(null);
  errorSpy.mockRestore();
  db.close();
});

describe('recoverImageDeliveries', () => {
  test('a picture the previous process left rendering is delivered as a photo to its own chat, once', async () => {
    store.insert(stored());
    const { delivery, renderDirect } = process2();
    const tg = sender();

    recoverImageDeliveries(delivery, tg.telegram);
    await delivery.whenIdle();
    await flush();

    expect(renderDirect).toHaveBeenCalledTimes(1);
    expect(tg.sendPhoto).toHaveBeenCalledTimes(1);
    const [chatId, file] = tg.sendPhoto.mock.calls[0]!;
    expect(chatId).toBe(7);
    expect(file.type).toBe('image/png');
    expect(tg.sendMessage).not.toHaveBeenCalled();
    expect(store.get('img-1')).toMatchObject({ state: 'delivered', message_id: 77 });

    // A second start finds nothing left to do.
    const again = process2();
    const tg2 = sender();
    recoverImageDeliveries(again.delivery, tg2.telegram);
    await again.delivery.whenIdle();
    await flush();
    expect(tg2.sendPhoto).not.toHaveBeenCalled();
  });

  test('a delivery past its bound earns one "the bot was restarting" note in its own chat, no timeout alert and no picture', async () => {
    store.insert(stored({ createdAt: Date.now() - 210_000, expiresAt: Date.now() - 60_000 })); // a deploy restart
    const { delivery, renderDirect } = process2();
    const tg = sender();

    recoverImageDeliveries(delivery, tg.telegram);
    await delivery.whenIdle();
    await flush();

    expect(renderDirect).not.toHaveBeenCalled();
    expect(tg.sendPhoto).not.toHaveBeenCalled();
    expect(tg.sendMessage.mock.calls).toEqual([[7, t('en').aiTools.meta.imageNoteInterrupted('2026-11-02')]]);
    expect(store.get('img-1')).toMatchObject({ state: 'expired', note_sent: 1 });
    expect(alerts).toEqual([]);
  });

  test('an upload that may have landed is marked unknown and never sent again, with no note', async () => {
    store.insert(stored());
    store.advance('img-1', 'sending', Date.now());
    const { delivery, renderDirect } = process2();
    const tg = sender();

    recoverImageDeliveries(delivery, tg.telegram);
    await delivery.whenIdle();
    await flush();

    expect(renderDirect).not.toHaveBeenCalled();
    expect(tg.sendPhoto).not.toHaveBeenCalled();
    expect(tg.sendMessage).not.toHaveBeenCalled();
    expect(store.get('img-1')?.state).toBe('unknown');
  });

  test('a reconciliation that fails is logged and never thrown out of start-up', async () => {
    const { delivery } = process2();
    store.unfinished = () => {
      throw new Error('database is locked');
    };

    expect(() => recoverImageDeliveries(delivery, sender().telegram)).not.toThrow();
    await flush();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[1]).toBe('Image delivery reconciliation failed');
  });
});
