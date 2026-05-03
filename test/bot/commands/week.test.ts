import { describe, expect, mock, test } from 'bun:test';
import { TZDate } from '@date-fns/tz';
import { handleWeek } from '../../../src/bot/commands/week.ts';

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
    getEventsInRange: mock(() => occurrences),
  };
}

describe('handleWeek', () => {
  test('sends week agenda with no events', async () => {
    const { handleWeek } = await import('../../../src/bot/commands/week.ts');
    const ctx = makeCtx();
    const svc = makeEventService();

    await handleWeek(ctx as never, svc as never);

    expect(ctx.send).toHaveBeenCalledTimes(1);
    const args = ctx.send.mock.calls[0] as unknown[];
    const text = args[0] as string;
    expect(text).toContain('no events');
    expect(args[1]).toHaveProperty('parse_mode', 'HTML');
  });

  test('sends russian text when language is ru', async () => {
    const { handleWeek } = await import('../../../src/bot/commands/week.ts');
    const ctx = makeCtx({ dbUser: userRu });
    const svc = makeEventService();

    await handleWeek(ctx as never, svc as never);

    const text = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(text).toContain('нет событий');
  });

  test('does not call sendPhoto when no renderService', async () => {
    const { handleWeek } = await import('../../../src/bot/commands/week.ts');
    const ctx = makeCtx();
    const svc = makeEventService();

    await handleWeek(ctx as never, svc as never);

    expect(ctx.sendPhoto).not.toHaveBeenCalled();
  });

  test('calls renderService when provided and catches errors', async () => {
    const { handleWeek } = await import('../../../src/bot/commands/week.ts');
    const ctx = makeCtx();
    const svc = makeEventService();
    const renderService = { renderDirect: mock(() => Promise.reject(new Error('render failed'))) };

    await handleWeek(ctx as never, svc as never, undefined, renderService as never);

    expect(ctx.send).toHaveBeenCalledTimes(1);
  });

  test('queries holidayService for each of 7 days', async () => {
    const { handleWeek } = await import('../../../src/bot/commands/week.ts');
    const ctx = makeCtx();
    const svc = makeEventService();
    const holidayService = {
      getHolidaysForDate: mock(() => []),
    };

    await handleWeek(ctx as never, svc as never, holidayService as never);

    expect((holidayService.getHolidaysForDate.mock.calls as unknown[]).length).toBe(7);
  });

  test('shows holiday name in output when holiday returned', async () => {
    const { handleWeek } = await import('../../../src/bot/commands/week.ts');
    const ctx = makeCtx();
    const svc = makeEventService();
    const holidayService = {
      getHolidaysForDate: mock(() => [{ name: 'Labour Day', date: '2026-03-18' }]),
    };

    await handleWeek(ctx as never, svc as never, holidayService as never);

    const text = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(text).toContain('Labour Day');
  });

  test('includes weather in text when weatherService provided', async () => {
    const { handleWeek } = await import('../../../src/bot/commands/week.ts');
    const ctx = makeCtx();
    const svc = makeEventService();
    const weatherService = {
      getWeekWeather: mock(() =>
        Promise.resolve({
          days: [
            {
              date: new Date().toISOString().slice(0, 10),
              tempMin: 3,
              tempMax: 10,
              conditionCode: 800,
              description: 'clear',
              windSpeed: 2,
            },
          ],
          hours: [],
        }),
      ),
    };

    await handleWeek(ctx as never, svc as never, undefined, undefined, undefined, weatherService as never);

    const text = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(text).toContain('☀️');
    expect(text).toContain('3..10°');
  });

  test('works without weather when weatherService returns null', async () => {
    const { handleWeek } = await import('../../../src/bot/commands/week.ts');
    const ctx = makeCtx();
    const svc = makeEventService();
    const weatherService = {
      getWeekWeather: mock(() => Promise.resolve(null)),
    };

    await handleWeek(ctx as never, svc as never, undefined, undefined, undefined, weatherService as never);

    expect(ctx.send).toHaveBeenCalledTimes(1);
    const text = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(text).not.toContain('°');
  });
});

describe('handleWeek group context', () => {
  test('in group uses getEventsInRangeForGroup, not personal', async () => {
    const eventService = {
      getEventsInRange: mock(() => []),
      getEventsInRangeForGroup: mock(() => []),
    };
    const groupRepo = { getTimezone: mock(() => 'Europe/Moscow') };
    const ctx = {
      chat: { type: 'group', id: -100 },
      dbUser: { telegram_id: 1, language: 'ru', timezone: 'UTC' },
      send: mock(() => Promise.resolve()),
      sendPhoto: mock(() => Promise.resolve()),
    };
    await handleWeek(ctx as never, eventService as never, undefined, undefined, groupRepo as never);
    expect(eventService.getEventsInRangeForGroup).toHaveBeenCalled();
    expect(eventService.getEventsInRange).not.toHaveBeenCalled();
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
    await handleWeek(ctx as never, {} as never, undefined, undefined, groupRepo as never);
    expect(sentText).toContain('таймзону');
  });

  test('group mode holiday keys use local calendar dates, not UTC dates (UTC+2)', async () => {
    const queriedDates: string[] = [];
    const holidayService = {
      getHolidaysForDate: (_userId: number, date: string) => {
        queriedDates.push(date);
        return [];
      },
    };
    const groupRepo = { getTimezone: () => 'Europe/Kyiv' };
    const eventService = { getEventsInRangeForGroup: () => [] };
    const ctx = {
      chat: { type: 'group', id: -100 },
      dbUser: { telegram_id: 1, language: 'en', timezone: 'UTC' },
      send: mock(() => Promise.resolve()),
      sendPhoto: mock(() => Promise.resolve()),
    };

    await handleWeek(ctx as never, eventService as never, holidayService as never, undefined, groupRepo as never);

    expect(queriedDates).toHaveLength(7);
    // For Europe/Kyiv (UTC+2), local week starts on Monday.
    // With local calendar dates, the first key is a Monday; with UTC dates it would be Sunday.
    const firstDate = new Date(`${queriedDates[0]}T12:00:00Z`);
    expect(firstDate.getUTCDay()).toBe(1); // Monday = 1, not Sunday = 0
  });

  test('in private chat uses personal calendar', async () => {
    const eventService = {
      getEventsInRange: mock(() => []),
      getEventsInRangeForGroup: mock(() => []),
    };
    const ctx = {
      chat: { type: 'private', id: 1 },
      dbUser: { telegram_id: 1, language: 'ru', timezone: 'UTC' },
      send: mock(() => Promise.resolve()),
      sendPhoto: mock(() => Promise.resolve()),
    };
    await handleWeek(ctx as never, eventService as never);
    expect(eventService.getEventsInRange).toHaveBeenCalled();
    expect(eventService.getEventsInRangeForGroup).not.toHaveBeenCalled();
  });

  test('in group includes weather when weatherService provided', async () => {
    const eventService = {
      getEventsInRangeForGroup: mock(() => []),
    };
    const GROUP_TZ = 'Europe/Moscow';
    const groupRepo = { getTimezone: mock(() => GROUP_TZ) };
    const weatherService = {
      getWeekWeather: mock(() =>
        Promise.resolve({
          days: [
            {
              date: new TZDate(new Date(), GROUP_TZ).toISOString().slice(0, 10),
              tempMin: -5,
              tempMax: 1,
              conditionCode: 600,
              description: 'snow',
              windSpeed: 4,
            },
          ],
          hours: [],
        }),
      ),
    };
    const ctx = {
      chat: { type: 'group', id: -100 },
      dbUser: { telegram_id: 1, language: 'ru', timezone: 'UTC' },
      send: mock(() => Promise.resolve()),
      sendPhoto: mock(() => Promise.resolve()),
    };
    await handleWeek(
      ctx as never,
      eventService as never,
      undefined,
      undefined,
      groupRepo as never,
      weatherService as never,
    );
    const text = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(text).toContain('🌨');
    expect(text).toContain('-5..1°');
  });
});
