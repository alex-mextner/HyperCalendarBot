// test/bot/commands/share.test.ts
import { describe, expect, mock, test } from 'bun:test';

describe('handleShare', () => {
  test('shows interactive navigator when no args', async () => {
    const { handleShare } = await import('../../../src/bot/commands/share.ts');
    const eventService = {
      getUpcoming: mock(() => [{ id: 1, title: 'Meeting', start_at: '2026-03-16T10:00:00Z' }]),
    };
    const ctx = {
      args: null,
      dbUser: { telegram_id: 100, language: 'en', timezone: 'UTC' },
      send: mock(() => Promise.resolve()),
    };
    await handleShare(ctx as never, eventService as never, {} as never, {} as never);
    expect(ctx.send).toHaveBeenCalled();
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('Share');
    expect(msg).toContain('Pick');
  });

  test('shows navigator in Russian for ru language', async () => {
    const { handleShare } = await import('../../../src/bot/commands/share.ts');
    const eventService = {
      getUpcoming: mock(() => []),
    };
    const ctx = {
      args: null,
      dbUser: { telegram_id: 100, language: 'ru', timezone: 'UTC' },
      send: mock(() => Promise.resolve()),
    };
    await handleShare(ctx as never, eventService as never, {} as never, {} as never);
    expect(ctx.send).toHaveBeenCalled();
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('Поделиться');
  });

  test('shows no events message when day is empty', async () => {
    const { handleShare } = await import('../../../src/bot/commands/share.ts');
    const ctx = {
      args: 'today',
      dbUser: { telegram_id: 100, language: 'en', timezone: 'UTC' },
      send: mock(() => Promise.resolve()),
    };
    const eventService = {
      getEventsForDay: mock(() => []),
    };
    await handleShare(ctx as never, eventService as never, {} as never, {} as never);
    expect(ctx.send).toHaveBeenCalled();
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('No events to share');
  });

  test('shows shareable events for today with full visibility', async () => {
    const { handleShare } = await import('../../../src/bot/commands/share.ts');
    const ctx = {
      args: 'today',
      dbUser: { telegram_id: 100, language: 'en', timezone: 'UTC' },
      send: mock(() => Promise.resolve()),
    };
    const eventService = {
      getEventsForDay: mock(() => [
        {
          event: { id: 1, title: 'Meeting', recurrence_rule: null },
          occurrence_start: '2026-03-15T10:00:00Z',
          occurrence_end: '2026-03-15T11:00:00Z',
          is_exception: false,
        },
      ]),
    };
    const privacyService = {
      resolveVisibility: mock(() => 'full'),
    };
    await handleShare(ctx as never, eventService as never, privacyService as never, {} as never);
    expect(ctx.send).toHaveBeenCalled();
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('Meeting');
    expect(msg).toContain('Preview');
  });

  test('shows busy placeholder for free_busy events', async () => {
    const { handleShare } = await import('../../../src/bot/commands/share.ts');
    const ctx = {
      args: 'today',
      dbUser: { telegram_id: 100, language: 'en', timezone: 'UTC' },
      send: mock(() => Promise.resolve()),
    };
    const eventService = {
      getEventsForDay: mock(() => [
        {
          event: { id: 1, title: 'Secret Meeting', recurrence_rule: null },
          occurrence_start: '2026-03-15T10:00:00Z',
          occurrence_end: '2026-03-15T11:00:00Z',
          is_exception: false,
        },
      ]),
    };
    const privacyService = {
      resolveVisibility: mock(() => 'free_busy'),
    };
    await handleShare(ctx as never, eventService as never, privacyService as never, {} as never);
    expect(ctx.send).toHaveBeenCalled();
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).not.toContain('Secret Meeting');
    expect(msg).toContain('Busy');
  });

  test('excludes private events entirely', async () => {
    const { handleShare } = await import('../../../src/bot/commands/share.ts');
    const ctx = {
      args: 'today',
      dbUser: { telegram_id: 100, language: 'en', timezone: 'UTC' },
      send: mock(() => Promise.resolve()),
    };
    const eventService = {
      getEventsForDay: mock(() => [
        {
          event: { id: 1, title: 'Private Event', recurrence_rule: null },
          occurrence_start: '2026-03-15T10:00:00Z',
          occurrence_end: '2026-03-15T11:00:00Z',
          is_exception: false,
        },
      ]),
    };
    const privacyService = {
      resolveVisibility: mock(() => 'private'),
    };
    await handleShare(ctx as never, eventService as never, privacyService as never, {} as never);
    expect(ctx.send).toHaveBeenCalled();
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('No events to share');
  });

  test('handles tomorrow period', async () => {
    const { handleShare } = await import('../../../src/bot/commands/share.ts');
    const ctx = {
      args: 'tomorrow',
      dbUser: { telegram_id: 100, language: 'en', timezone: 'UTC' },
      send: mock(() => Promise.resolve()),
    };
    const eventService = {
      getEventsForDay: mock(() => [
        {
          event: { id: 2, title: 'Lunch', recurrence_rule: null },
          occurrence_start: '2026-03-16T12:00:00Z',
          occurrence_end: '2026-03-16T13:00:00Z',
          is_exception: false,
        },
      ]),
    };
    const privacyService = {
      resolveVisibility: mock(() => 'full'),
    };
    await handleShare(ctx as never, eventService as never, privacyService as never, {} as never);
    expect(eventService.getEventsForDay).toHaveBeenCalled();
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('Lunch');
  });

  test('handles week period', async () => {
    const { handleShare } = await import('../../../src/bot/commands/share.ts');
    const ctx = {
      args: 'week',
      dbUser: { telegram_id: 100, language: 'en', timezone: 'UTC' },
      send: mock(() => Promise.resolve()),
    };
    const eventService = {
      getEventsForWeek: mock(() => [
        {
          event: { id: 3, title: 'Sprint Review', recurrence_rule: null },
          occurrence_start: '2026-03-16T15:00:00Z',
          occurrence_end: '2026-03-16T16:00:00Z',
          is_exception: false,
        },
      ]),
    };
    const privacyService = {
      resolveVisibility: mock(() => 'full'),
    };
    await handleShare(ctx as never, eventService as never, privacyService as never, {} as never);
    expect(eventService.getEventsForWeek).toHaveBeenCalled();
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('Sprint Review');
  });

  test('shows error for unknown period', async () => {
    const { handleShare } = await import('../../../src/bot/commands/share.ts');
    const ctx = {
      args: 'nextyear',
      dbUser: { telegram_id: 100, language: 'en', timezone: 'UTC' },
      send: mock(() => Promise.resolve()),
    };
    await handleShare(ctx as never, {} as never, {} as never, {} as never);
    expect(ctx.send).toHaveBeenCalled();
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('today');
    expect(msg).toContain('tomorrow');
    expect(msg).toContain('week');
  });

  test('handles event <id> sharing', async () => {
    const { handleShare } = await import('../../../src/bot/commands/share.ts');
    const ctx = {
      args: 'event 5',
      dbUser: { telegram_id: 100, language: 'en', timezone: 'UTC' },
      send: mock(() => Promise.resolve()),
    };
    const eventService = {
      getEvent: mock(() => ({
        id: 5,
        title: 'Birthday Party',
        start_at: '2026-03-20T18:00:00Z',
        end_at: '2026-03-20T22:00:00Z',
        recurrence_rule: null,
      })),
    };
    const privacyService = {
      resolveVisibility: mock(() => 'full'),
    };
    const deepLinkService = {
      createShareLink: mock(() => ({ code: 's_abc123' })),
      generateUrl: mock(() => 'https://t.me/Bot?start=s_abc123'),
    };
    await handleShare(ctx as never, eventService as never, privacyService as never, deepLinkService as never);
    expect(eventService.getEvent).toHaveBeenCalledWith(5, 100);
    expect(ctx.send).toHaveBeenCalled();
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('Birthday Party');
  });

  test('shows error for private event sharing', async () => {
    const { handleShare } = await import('../../../src/bot/commands/share.ts');
    const ctx = {
      args: 'event 5',
      dbUser: { telegram_id: 100, language: 'en', timezone: 'UTC' },
      send: mock(() => Promise.resolve()),
    };
    const eventService = {
      getEvent: mock(() => ({
        id: 5,
        title: 'Secret',
        start_at: '2026-03-20T18:00:00Z',
        end_at: null,
        recurrence_rule: null,
      })),
    };
    const privacyService = {
      resolveVisibility: mock(() => 'private'),
    };
    await handleShare(ctx as never, eventService as never, privacyService as never, {} as never);
    expect(ctx.send).toHaveBeenCalled();
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('private');
  });

  test('shows error when event not found', async () => {
    const { handleShare } = await import('../../../src/bot/commands/share.ts');
    const ctx = {
      args: 'event 999',
      dbUser: { telegram_id: 100, language: 'en', timezone: 'UTC' },
      send: mock(() => Promise.resolve()),
    };
    const eventService = {
      getEvent: mock(() => null),
    };
    await handleShare(ctx as never, eventService as never, {} as never, {} as never);
    expect(ctx.send).toHaveBeenCalled();
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('not found');
  });

  test('shows error for non-numeric event id', async () => {
    const { handleShare } = await import('../../../src/bot/commands/share.ts');
    const ctx = {
      args: 'event abc',
      dbUser: { telegram_id: 100, language: 'en', timezone: 'UTC' },
      send: mock(() => Promise.resolve()),
    };
    await handleShare(ctx as never, {} as never, {} as never, {} as never);
    expect(ctx.send).toHaveBeenCalled();
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('today');
  });

  test('in group shows group events picker', async () => {
    const { handleShare } = await import('../../../src/bot/commands/share.ts');
    const occ = {
      event: { id: 3, title: 'Demo Day', start_at: '2026-03-20T10:00:00Z' },
      occurrence_start: '2026-03-20T10:00:00Z',
      occurrence_end: null,
      is_exception: false,
    };
    const eventService = {
      getUpcomingForGroup: mock(() => [occ]),
      getUpcoming: mock(() => []),
    };
    const groupRepo = { getTimezone: mock(() => 'Europe/Moscow') };
    const ctx = {
      chat: { type: 'group', id: -100 },
      args: null,
      dbUser: { telegram_id: 1, language: 'ru', timezone: 'UTC' },
      send: mock(() => Promise.resolve()),
    };
    await handleShare(ctx as never, eventService as never, {} as never, {} as never, groupRepo as never);
    expect(eventService.getUpcomingForGroup).toHaveBeenCalledWith(-100, 10);
    expect(eventService.getUpcoming).not.toHaveBeenCalled();
    const [msg, opts] = ctx.send.mock.calls[0] as [string, { reply_markup: unknown }];
    expect(msg).toContain('Поделиться');
    expect(opts?.reply_markup).toBeDefined();
  });

  test('in group with no events shows empty message', async () => {
    const { handleShare } = await import('../../../src/bot/commands/share.ts');
    const eventService = { getUpcomingForGroup: mock(() => []), getUpcoming: mock(() => []) };
    const groupRepo = { getTimezone: mock(() => 'UTC') };
    const ctx = {
      chat: { type: 'group', id: -100 },
      args: null,
      dbUser: { telegram_id: 1, language: 'en', timezone: 'UTC' },
      send: mock(() => Promise.resolve()),
    };
    await handleShare(ctx as never, eventService as never, {} as never, {} as never, groupRepo as never);
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('No group events');
  });

  test('creates deep link for event sharing with full visibility', async () => {
    const { handleShare } = await import('../../../src/bot/commands/share.ts');
    const ctx = {
      args: 'event 5',
      dbUser: { telegram_id: 100, language: 'en', timezone: 'UTC' },
      send: mock(() => Promise.resolve()),
    };
    const eventService = {
      getEvent: mock(() => ({
        id: 5,
        title: 'Party',
        start_at: '2026-03-20T18:00:00Z',
        end_at: null,
        recurrence_rule: null,
      })),
    };
    const privacyService = {
      resolveVisibility: mock(() => 'full'),
    };
    const deepLinkService = {
      createShareLink: mock(() => ({ code: 's_xyz' })),
      generateUrl: mock(() => 'https://t.me/Bot?start=s_xyz'),
    };
    await handleShare(ctx as never, eventService as never, privacyService as never, deepLinkService as never);
    expect(deepLinkService.createShareLink).toHaveBeenCalledWith(5, 100);
    expect(deepLinkService.generateUrl).toHaveBeenCalled();
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('https://t.me/Bot?start=s_xyz');
  });
});
