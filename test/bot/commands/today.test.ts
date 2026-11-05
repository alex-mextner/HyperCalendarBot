import { afterEach, describe, expect, mock, test } from 'bun:test';
import { handleToday } from '../../../src/bot/commands/today.ts';
import { t } from '../../../src/config/constants.ts';
import { configureTimeoutReporter } from '../../../src/services/incident/timeout-reporter.ts';
import { AgendaImageError } from '../../../src/utils/agenda-image.ts';
import { captureTimeoutAlerts, gatedDelivery } from '../../fixtures/picture-contract.ts';

const user = { telegram_id: 100, language: 'en' as const, timezone: 'UTC' };
const userRu = { telegram_id: 100, language: 'ru' as const, timezone: 'UTC' };

function makeCtx(overrides = {}) {
  return {
    id: 7,
    dbUser: user,
    send: mock(() => Promise.resolve()),
    sendPhoto: mock(() => Promise.resolve({ id: 42 })),
    sendDocument: mock(() => Promise.resolve({ id: 43 })),
    bot: { api: { pinChatMessage: mock(() => Promise.resolve()), sendMessage: mock(() => Promise.resolve()) } },
    ...overrides,
  };
}

function makeEventService(occurrences = []) {
  return {
    getEventsForDay: mock(() => occurrences),
  };
}

/** Lets every already-settled promise continuation run (a macrotask turn, no wall-clock wait). */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

afterEach(() => configureTimeoutReporter(null));

describe('handleToday', () => {
  test('sends day agenda with no events', async () => {
    const { handleToday } = await import('../../../src/bot/commands/today.ts');
    const ctx = makeCtx();
    const svc = makeEventService();

    await handleToday(ctx as never, svc as never);

    expect(ctx.send).toHaveBeenCalledTimes(1);
    const args = ctx.send.mock.calls[0] as unknown[];
    const text = args[0] as string;
    expect(text).toContain('No events');
    expect(args[1]).toHaveProperty('parse_mode', 'HTML');
  });

  test('sends russian text when language is ru', async () => {
    const { handleToday } = await import('../../../src/bot/commands/today.ts');
    const ctx = makeCtx({ dbUser: userRu });
    const svc = makeEventService();

    await handleToday(ctx as never, svc as never);

    const text = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(text).toContain('Нет событий');
  });

  test('does not call sendPhoto when there is no image delivery (text-only)', async () => {
    const { handleToday } = await import('../../../src/bot/commands/today.ts');
    const ctx = makeCtx();
    const svc = makeEventService();

    await handleToday(ctx as never, svc as never);

    expect(ctx.sendPhoto).not.toHaveBeenCalled();
    expect(ctx.send).toHaveBeenCalledTimes(1);
  });

  test('returns with the text before a slow render ends; the late picture is delivered once and pinned', async () => {
    const { delivery, renderer, release } = gatedDelivery();
    const ctx = makeCtx();

    await handleToday(ctx as never, makeEventService() as never, undefined, delivery);

    // The handler is done while the render is still pending: only the text went out.
    expect(renderer.renderDirect).toHaveBeenCalledTimes(1);
    expect(ctx.send).toHaveBeenCalledTimes(1);
    expect(ctx.sendPhoto).not.toHaveBeenCalled();

    release();
    await delivery.whenIdle();
    await flush();

    expect(ctx.sendPhoto).toHaveBeenCalledTimes(1);
    expect(ctx.send).toHaveBeenCalledTimes(1); // no note: the picture arrived
    expect(ctx.bot.api.pinChatMessage).toHaveBeenCalledWith({
      chat_id: user.telegram_id,
      message_id: 42,
      disable_notification: true,
    });
  });

  test('a double command while the first picture renders delivers one picture', async () => {
    const { delivery, releaseAll } = gatedDelivery();
    const ctx = makeCtx();
    const again = makeCtx({ id: 8 });

    await handleToday(ctx as never, makeEventService() as never, undefined, delivery);
    await handleToday(again as never, makeEventService() as never, undefined, delivery);
    releaseAll();
    await delivery.whenIdle();

    expect(ctx.sendPhoto.mock.calls.length + again.sendPhoto.mock.calls.length).toBe(1);
  });

  test('a render failure gives one note and one owner alert, not the date-range wording', async () => {
    const { delivery, fail, failures } = gatedDelivery();
    const ctx = makeCtx();

    await handleToday(ctx as never, makeEventService() as never, undefined, delivery);
    fail(new Error('chromium crashed'));
    await delivery.whenIdle();

    expect(ctx.sendPhoto).not.toHaveBeenCalled();
    expect(ctx.send).toHaveBeenCalledTimes(2); // the text, then ONE note
    const note = (ctx.send.mock.calls[1] as unknown[])[0] as string;
    expect(note).toContain('could not prepare the picture');
    expect(note).not.toContain('date range');
    expect(failures).toHaveLength(1);
  });

  test('a render that outlives its bound gives one note and one timeout alert for the repair flow', async () => {
    const alerts = captureTimeoutAlerts();
    const { delivery, failures } = gatedDelivery({ boundMs: 20 });
    const ctx = makeCtx();

    await handleToday(ctx as never, makeEventService() as never, undefined, delivery);
    await delivery.whenIdle();

    expect(ctx.send).toHaveBeenCalledTimes(2);
    expect((ctx.send.mock.calls[1] as unknown[])[0]).toContain('did not get ready in time');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.text).toContain('Timeout (render)');
    expect(failures).toHaveLength(0);
  });

  test('a picture too large to send explains it once and raises no alert', async () => {
    const { delivery, fail, failures } = gatedDelivery();
    const ctx = makeCtx();

    await handleToday(ctx as never, makeEventService() as never, undefined, delivery);
    fail(new AgendaImageError('Agenda PNG exceeds the 50 MB document limit. Choose a shorter date range.', true));
    await delivery.whenIdle();

    expect(ctx.send).toHaveBeenCalledTimes(2);
    expect((ctx.send.mock.calls[1] as unknown[])[0]).toContain('too large to send');
    expect((ctx.send.mock.calls[1] as unknown[])[0]).not.toContain('Agenda PNG');
    expect(failures).toHaveLength(0);
  });

  test('the failure note follows the user language', async () => {
    const { delivery, fail } = gatedDelivery();
    const ctx = makeCtx({ dbUser: userRu });

    await handleToday(ctx as never, makeEventService() as never, undefined, delivery);
    fail(new Error('render failed'));
    await delivery.whenIdle();

    expect((ctx.send.mock.calls[1] as unknown[])[0]).toContain(
      t('ru').aiTools.meta.imageNoteFailed(new Date().toISOString().slice(0, 10)),
    );
  });

  test('shows holiday entries when holidayService returns them', async () => {
    const { handleToday } = await import('../../../src/bot/commands/today.ts');
    const ctx = makeCtx();
    const svc = makeEventService();
    const holidayService = {
      getHolidaysForDate: mock(() => [{ name: 'New Year', date: '2026-01-01' }]),
    };

    await handleToday(ctx as never, svc as never, holidayService as never);

    const text = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(text).toContain('New Year');
  });
  test('includes weather in text when weatherService provided', async () => {
    const { handleToday } = await import('../../../src/bot/commands/today.ts');
    const ctx = makeCtx();
    const svc = makeEventService();
    const weatherService = {
      getDayWeather: mock(() =>
        Promise.resolve({
          tempMin: 5,
          tempMax: 15,
          tempCurrent: 10,
          conditionCode: 800,
          description: 'clear sky',
          windSpeed: 3,
        }),
      ),
    };

    await handleToday(ctx as never, svc as never, undefined, undefined, undefined, undefined, weatherService as never);

    const text = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(text).toContain('☀️');
    expect(text).toContain('clear sky');
  });

  test('works without weather when weatherService returns null', async () => {
    const { handleToday } = await import('../../../src/bot/commands/today.ts');
    const ctx = makeCtx();
    const svc = makeEventService();
    const weatherService = {
      getDayWeather: mock(() => Promise.resolve(null)),
    };

    await handleToday(ctx as never, svc as never, undefined, undefined, undefined, undefined, weatherService as never);

    expect(ctx.send).toHaveBeenCalledTimes(1);
    const text = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(text).not.toContain('°C');
  });
});

describe('handleToday group context', () => {
  test('in group uses getEventsInRangeForGroup, not personal', async () => {
    const eventService = {
      getEventsForDay: mock(() => []),
      getEventsInRangeForGroup: mock(() => []),
    };
    const groupRepo = { getTimezone: mock(() => 'Europe/Moscow') };
    const ctx = {
      chat: { type: 'group', id: -100 },
      dbUser: { telegram_id: 1, language: 'ru', timezone: 'UTC' },
      send: mock(() => Promise.resolve()),
      sendPhoto: mock(() => Promise.resolve()),
    };
    await handleToday(ctx as never, eventService as never, undefined, undefined, groupRepo as never);
    expect(eventService.getEventsInRangeForGroup).toHaveBeenCalled();
    expect(eventService.getEventsForDay).not.toHaveBeenCalled();
  });

  test('in group with no timezone sends Russian prompt containing таймзону', async () => {
    const groupRepo = { getTimezone: mock(() => null) };
    let sentText = '';
    const ctx = {
      chat: { type: 'group', id: -100 },
      dbUser: { telegram_id: 1, language: 'ru', timezone: 'UTC' },
      send: mock((text: string) => {
        sentText = text;
        return Promise.resolve();
      }),
      sendPhoto: mock(() => Promise.resolve()),
    };
    await handleToday(ctx as never, {} as never, undefined, undefined, groupRepo as never);
    expect(sentText).toContain('таймзону');
  });

  test('in private chat uses personal calendar', async () => {
    const eventService = {
      getEventsForDay: mock(() => []),
      getEventsInRangeForGroup: mock(() => []),
    };
    const ctx = {
      chat: { type: 'private', id: 1 },
      dbUser: { telegram_id: 1, language: 'ru', timezone: 'UTC' },
      send: mock(() => Promise.resolve()),
      sendPhoto: mock(() => Promise.resolve()),
    };
    await handleToday(ctx as never, eventService as never);
    expect(eventService.getEventsForDay).toHaveBeenCalled();
    expect(eventService.getEventsInRangeForGroup).not.toHaveBeenCalled();
  });
});
