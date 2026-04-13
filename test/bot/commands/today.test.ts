import { describe, expect, mock, test } from 'bun:test';
import { handleToday } from '../../../src/bot/commands/today.ts';

const user = { telegram_id: 100, language: 'en' as const, timezone: 'UTC' };
const userRu = { telegram_id: 100, language: 'ru' as const, timezone: 'UTC' };

function makeCtx(overrides = {}) {
  return {
    dbUser: user,
    send: mock(() => Promise.resolve()),
    sendPhoto: mock(() => Promise.resolve()),
    ...overrides,
  };
}

function makeEventService(occurrences = []) {
  return {
    getEventsForDay: mock(() => occurrences),
  };
}

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

  test('does not call sendPhoto when no renderService', async () => {
    const { handleToday } = await import('../../../src/bot/commands/today.ts');
    const ctx = makeCtx();
    const svc = makeEventService();

    await handleToday(ctx as never, svc as never);

    expect(ctx.sendPhoto).not.toHaveBeenCalled();
  });

  test('does not call sendPhoto when renderService render fails', async () => {
    const { handleToday } = await import('../../../src/bot/commands/today.ts');
    const ctx = makeCtx();
    const svc = makeEventService();
    const renderService = { renderDirect: mock(() => Promise.reject(new Error('render failed'))) };

    await handleToday(ctx as never, svc as never, undefined, renderService as never);

    expect(ctx.send).toHaveBeenCalledTimes(1);
    expect(ctx.sendPhoto).not.toHaveBeenCalled();
  });

  test('pins image after successful render', async () => {
    const { handleToday } = await import('../../../src/bot/commands/today.ts');
    const pinChatMessage = mock(() => Promise.resolve());
    const ctx = {
      dbUser: user,
      send: mock(() => Promise.resolve()),
      sendPhoto: mock(() => Promise.resolve({ id: 42 })),
      bot: { api: { pinChatMessage, sendMessage: mock(() => Promise.resolve()) } },
    };
    const svc = makeEventService();
    const renderService = { renderDirect: mock(() => Promise.resolve(Buffer.from(''))) };

    await handleToday(ctx as never, svc as never, undefined, renderService as never);
    await Promise.resolve(); // flush fire-and-forget autoPin

    expect(ctx.sendPhoto).toHaveBeenCalled();
    expect(pinChatMessage).toHaveBeenCalledWith({
      chat_id: user.telegram_id,
      message_id: 42,
      disable_notification: true,
    });
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
