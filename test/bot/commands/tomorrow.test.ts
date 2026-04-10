import { describe, expect, mock, test } from 'bun:test';
import { handleTomorrow } from '../../../src/bot/commands/tomorrow.ts';

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

describe('handleTomorrow', () => {
  test('sends day agenda with no events', async () => {
    const { handleTomorrow } = await import('../../../src/bot/commands/tomorrow.ts');
    const ctx = makeCtx();
    const svc = makeEventService();

    await handleTomorrow(ctx as never, svc as never);

    expect(ctx.send).toHaveBeenCalledTimes(1);
    const args = ctx.send.mock.calls[0] as unknown[];
    const text = args[0] as string;
    expect(text).toContain('No events');
    expect(args[1]).toHaveProperty('parse_mode', 'HTML');
  });

  test('sends russian text when language is ru', async () => {
    const { handleTomorrow } = await import('../../../src/bot/commands/tomorrow.ts');
    const ctx = makeCtx({ dbUser: userRu });
    const svc = makeEventService();

    await handleTomorrow(ctx as never, svc as never);

    const text = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(text).toContain('Нет событий');
  });

  test('does not call sendPhoto when no renderService', async () => {
    const { handleTomorrow } = await import('../../../src/bot/commands/tomorrow.ts');
    const ctx = makeCtx();
    const svc = makeEventService();

    await handleTomorrow(ctx as never, svc as never);

    expect(ctx.sendPhoto).not.toHaveBeenCalled();
  });

  test('calls renderService when provided and catches errors', async () => {
    const { handleTomorrow } = await import('../../../src/bot/commands/tomorrow.ts');
    const ctx = makeCtx();
    const svc = makeEventService();
    const renderService = { renderDirect: mock(() => Promise.reject(new Error('render failed'))) };

    await handleTomorrow(ctx as never, svc as never, undefined, renderService as never);
    expect(ctx.send).toHaveBeenCalledTimes(1);
  });

  test('shows holiday entries when holidayService returns them', async () => {
    const { handleTomorrow } = await import('../../../src/bot/commands/tomorrow.ts');
    const ctx = makeCtx();
    const svc = makeEventService();
    const holidayService = {
      getHolidaysForDate: mock(() => [{ name: 'Christmas', date: '2026-12-25' }]),
    };

    await handleTomorrow(ctx as never, svc as never, holidayService as never);

    const text = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(text).toContain('Christmas');
  });
});

describe('handleTomorrow group context', () => {
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
    await handleTomorrow(ctx as never, eventService as never, undefined, undefined, groupRepo as never);
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
    await handleTomorrow(ctx as never, {} as never, undefined, undefined, groupRepo as never);
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
    await handleTomorrow(ctx as never, eventService as never);
    expect(eventService.getEventsForDay).toHaveBeenCalled();
    expect(eventService.getEventsInRangeForGroup).not.toHaveBeenCalled();
  });
});
