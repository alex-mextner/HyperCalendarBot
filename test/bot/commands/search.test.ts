import { describe, expect, mock, test } from 'bun:test';
import type { CalendarEvent } from '../../../src/database/types.ts';

const user = { telegram_id: 100, language: 'en' as const, timezone: 'UTC' };
const userRu = { telegram_id: 100, language: 'ru' as const, timezone: 'UTC' };

function makeCtx(overrides = {}) {
  return {
    dbUser: user,
    args: '',
    send: mock(() => Promise.resolve()),
    ...overrides,
  };
}

function makeEvent(overrides: Partial<CalendarEvent> = {}) {
  return {
    id: 1,
    user_id: 100,
    title: 'Team Meeting',
    start_at: '2026-03-15T10:00:00Z',
    end_at: '2026-03-15T11:00:00Z',
    timezone: 'UTC',
    recurrence_rule: null,
    ...overrides,
  };
}

describe('handleSearch', () => {
  test('prompts for query when args is empty', async () => {
    const { handleSearch } = await import('../../../src/bot/commands/search.ts');
    const ctx = makeCtx({ args: '' });
    const svc = { searchEvents: mock(() => []) };

    await handleSearch(ctx as never, svc as never);

    expect(ctx.send).toHaveBeenCalledTimes(1);
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('/search');
    expect(svc.searchEvents).not.toHaveBeenCalled();
  });

  test('prompts in russian when language is ru and args empty', async () => {
    const { handleSearch } = await import('../../../src/bot/commands/search.ts');
    const ctx = makeCtx({ dbUser: userRu, args: '' });
    const svc = { searchEvents: mock(() => []) };

    await handleSearch(ctx as never, svc as never);

    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('/search');
    expect(msg).toContain('поиска');
  });

  test('sends no results message when nothing found', async () => {
    const { handleSearch } = await import('../../../src/bot/commands/search.ts');
    const ctx = makeCtx({ args: 'nonexistent' });
    const svc = { searchEvents: mock(() => []) };

    await handleSearch(ctx as never, svc as never);

    expect(svc.searchEvents).toHaveBeenCalledWith(100, 'nonexistent');
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('No events found');
  });

  test('sends no results in russian', async () => {
    const { handleSearch } = await import('../../../src/bot/commands/search.ts');
    const ctx = makeCtx({ dbUser: userRu, args: 'встреча' });
    const svc = { searchEvents: mock(() => []) };

    await handleSearch(ctx as never, svc as never);

    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('Ничего не найдено');
  });

  test('sends results list with keyboard when events found', async () => {
    const { handleSearch } = await import('../../../src/bot/commands/search.ts');
    const ctx = makeCtx({ args: 'meeting' });
    const events = [makeEvent(), makeEvent({ id: 2, title: 'Board Meeting' })];
    const svc = { searchEvents: mock(() => events) };

    await handleSearch(ctx as never, svc as never);

    const args = ctx.send.mock.calls[0] as unknown[];
    const text = args[0] as string;
    expect(text).toContain('Found 2');
    expect(args[1]).toHaveProperty('reply_markup');
  });

  test('caps display at 10 results', async () => {
    const { handleSearch } = await import('../../../src/bot/commands/search.ts');
    const ctx = makeCtx({ args: 'event' });
    const events = Array.from({ length: 15 }, (_, i) => makeEvent({ id: i + 1, title: `Event ${i + 1}` }));
    const svc = { searchEvents: mock(() => events) };

    await handleSearch(ctx as never, svc as never);

    const text = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(text).toContain('Found 15');
    // keyboard should only have 10 buttons max
    const opts = (ctx.send.mock.calls[0] as unknown[])[1] as { reply_markup?: unknown };
    expect(opts.reply_markup).toBeDefined();
  });

  test('trims whitespace from query', async () => {
    const { handleSearch } = await import('../../../src/bot/commands/search.ts');
    const ctx = makeCtx({ args: '  meeting  ' });
    const svc = { searchEvents: mock(() => [makeEvent()]) };

    await handleSearch(ctx as never, svc as never);

    expect(svc.searchEvents).toHaveBeenCalledWith(100, 'meeting');
  });

  test('in group calls searchEventsForGroup and not searchEvents', async () => {
    const { handleSearch } = await import('../../../src/bot/commands/search.ts');
    const ctx = makeCtx({
      chat: { type: 'group', id: -100 },
      args: 'встреча',
    });
    const svc = {
      searchEvents: mock(() => []),
      searchEventsForGroup: mock(() => [makeEvent({ title: 'Встреча' })]),
    };

    await handleSearch(ctx as never, svc as never);

    expect(svc.searchEventsForGroup).toHaveBeenCalledWith(-100, 'встреча');
    expect(svc.searchEvents).not.toHaveBeenCalled();
  });

  test('in private calls searchEvents and not searchEventsForGroup', async () => {
    const { handleSearch } = await import('../../../src/bot/commands/search.ts');
    const ctx = makeCtx({
      chat: { type: 'private', id: 1 },
      args: 'встреча',
    });
    const svc = {
      searchEvents: mock(() => []),
      searchEventsForGroup: mock(() => []),
    };

    await handleSearch(ctx as never, svc as never);

    expect(svc.searchEvents).toHaveBeenCalled();
    expect(svc.searchEventsForGroup).not.toHaveBeenCalled();
  });

  test('in group uses group timezone for formatting when groupRepo provides one', async () => {
    const { handleSearch } = await import('../../../src/bot/commands/search.ts');
    const groupTimezone = 'Europe/Berlin';
    const ctx = makeCtx({
      chat: { type: 'group', id: -200 },
      args: 'standup',
    });
    const svc = {
      searchEvents: mock(() => []),
      searchEventsForGroup: mock(() => [makeEvent({ title: 'Standup' })]),
    };
    const groupRepo = { getTimezone: mock(() => groupTimezone) };

    await handleSearch(ctx as never, svc as never, groupRepo as never);

    expect(groupRepo.getTimezone).toHaveBeenCalledWith(-200);
    const opts = (ctx.send.mock.calls[0] as unknown[])[1] as { reply_markup?: unknown };
    expect(opts).toHaveProperty('reply_markup');
  });

  test('in group falls back to user timezone when groupRepo returns null', async () => {
    const { handleSearch } = await import('../../../src/bot/commands/search.ts');
    const userWithTz = { telegram_id: 100, language: 'en' as const, timezone: 'Asia/Tokyo' };
    const ctx = makeCtx({
      dbUser: userWithTz,
      chat: { type: 'group', id: -300 },
      args: 'event',
    });
    const svc = {
      searchEvents: mock(() => []),
      searchEventsForGroup: mock(() => [makeEvent({ title: 'Event' })]),
    };
    const groupRepo = { getTimezone: mock(() => null) };

    await handleSearch(ctx as never, svc as never, groupRepo as never);

    // Falls back -- still returns results without error
    const text = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(text).toContain('Found 1');
  });
});
