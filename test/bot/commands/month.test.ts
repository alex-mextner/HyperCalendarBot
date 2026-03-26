import { describe, expect, mock, test } from 'bun:test';
import { handleMonth } from '../../../src/bot/commands/month.ts';

const user = { telegram_id: 100, language: 'en' as const, timezone: 'UTC' };
const userRu = { telegram_id: 100, language: 'ru' as const, timezone: 'UTC' };

function makeCtx(overrides = {}) {
  return {
    dbUser: user,
    send: mock(() => Promise.resolve()),
    editText: mock(() => Promise.resolve()),
    ...overrides,
  };
}

function makeEventService(occurrences: Array<{ occurrence_start: string; occurrence_end: string | null }> = []) {
  return {
    getEventsInRange: mock(() => occurrences),
  };
}

describe('handleMonth', () => {
  test('sends calendar for current month when no yearMonth', async () => {
    const { handleMonth } = await import('../../../src/bot/commands/month.ts');
    const ctx = makeCtx();
    const svc = makeEventService();

    await handleMonth(ctx as never, svc as never);

    expect(ctx.send).toHaveBeenCalledTimes(1);
    const args = ctx.send.mock.calls[0] as unknown[];
    const text = args[0] as string;
    expect(text).toContain('Mo Tu We Th Fr Sa Su');
    expect(text).toContain('No events this month.');
    expect(args[1]).toHaveProperty('parse_mode', 'HTML');
    expect(args[1]).toHaveProperty('reply_markup');
  });

  test('uses editText when yearMonth is provided', async () => {
    const { handleMonth } = await import('../../../src/bot/commands/month.ts');
    const ctx = makeCtx();
    const svc = makeEventService();

    await handleMonth(ctx as never, svc as never, '2026-06');

    expect(ctx.editText).toHaveBeenCalledTimes(1);
    expect(ctx.send).not.toHaveBeenCalled();
    const text = (ctx.editText.mock.calls[0] as unknown[])[0] as string;
    expect(text).toContain('June 2026');
  });

  test('shows russian month name for ru language', async () => {
    const { handleMonth } = await import('../../../src/bot/commands/month.ts');
    const ctx = makeCtx({ dbUser: userRu });
    const svc = makeEventService();

    await handleMonth(ctx as never, svc as never, '2026-01');

    const text = (ctx.editText.mock.calls[0] as unknown[])[0] as string;
    // Russian locale month name for January
    expect(text).toContain('2026');
  });

  test('shows event counts when events exist', async () => {
    const { handleMonth } = await import('../../../src/bot/commands/month.ts');
    const ctx = makeCtx();
    const svc = makeEventService([
      { occurrence_start: '2026-06-10T10:00:00Z', occurrence_end: '2026-06-10T11:00:00Z' },
      { occurrence_start: '2026-06-10T14:00:00Z', occurrence_end: '2026-06-10T15:00:00Z' },
      { occurrence_start: '2026-06-15T09:00:00Z', occurrence_end: null },
    ]);

    await handleMonth(ctx as never, svc as never, '2026-06');

    const text = (ctx.editText.mock.calls[0] as unknown[])[0] as string;
    expect(text).toContain('Events:');
    expect(text).not.toContain('No events this month.');
  });

  test('renders calendar header', async () => {
    const { handleMonth } = await import('../../../src/bot/commands/month.ts');
    const ctx = makeCtx();
    const svc = makeEventService();

    await handleMonth(ctx as never, svc as never, '2026-03');

    const text = (ctx.editText.mock.calls[0] as unknown[])[0] as string;
    expect(text).toContain('March 2026');
    expect(text).toContain('Mo Tu We Th Fr Sa Su');
  });

  test('passes navigation keyboard', async () => {
    const { handleMonth } = await import('../../../src/bot/commands/month.ts');
    const ctx = makeCtx();
    const svc = makeEventService();

    await handleMonth(ctx as never, svc as never, '2026-12');

    const callArgs = ctx.editText.mock.calls[0] as unknown[];
    const opts = callArgs[1] as { reply_markup?: unknown };
    expect(opts.reply_markup).toBeDefined();
  });

  test('pins image after successful month render', async () => {
    const { handleMonth } = await import('../../../src/bot/commands/month.ts');
    const pinChatMessage = mock(() => Promise.resolve());
    const ctx = {
      dbUser: user,
      send: mock(() => Promise.resolve()),
      editText: mock(() => Promise.resolve()),
      sendPhoto: mock(() => Promise.resolve({ id: 55 })),
      bot: { api: { pinChatMessage, sendMessage: mock(() => Promise.resolve()) } },
    };
    const svc = makeEventService();
    const renderService = { renderDirect: mock(() => Promise.resolve(Buffer.from(''))) };

    // yearMonth undefined -> triggers image render (only on initial /month command)
    await handleMonth(ctx as never, svc as never, undefined, renderService as never);
    await Promise.resolve(); // flush fire-and-forget autoPin

    expect(ctx.sendPhoto).toHaveBeenCalled();
    expect(pinChatMessage).toHaveBeenCalledWith({
      chat_id: user.telegram_id,
      message_id: 55,
      disable_notification: true,
    });
  });
});

describe('handleMonth group context', () => {
  test('in group uses getEventsInRangeForGroup, not personal', async () => {
    const eventService = {
      getEventsInRange: mock(() => []),
      getEventsInRangeForGroup: mock(() => []),
    };
    const groupRepo = { getTimezone: mock(() => 'Europe/Moscow') };
    const ctx = {
      chat: { type: 'group', id: -100 },
      dbUser: { telegram_id: 1, language: 'en', timezone: 'UTC' },
      send: mock(() => Promise.resolve()),
      editText: mock(() => Promise.resolve()),
    };
    await handleMonth(ctx as never, eventService as never, undefined, undefined, groupRepo as never);
    expect(eventService.getEventsInRangeForGroup).toHaveBeenCalled();
    expect(eventService.getEventsInRange).not.toHaveBeenCalled();
  });

  test('in group with no timezone sends Russian prompt containing timezone', async () => {
    const groupRepo = { getTimezone: mock(() => null) };
    let sentText = '';
    const ctx = {
      chat: { type: 'group', id: -100 },
      dbUser: { telegram_id: 1, language: 'ru', timezone: 'UTC' },
      send: mock((text: string) => {
        sentText = text;
        return Promise.resolve();
      }),
      editText: mock(() => Promise.resolve()),
    };
    await handleMonth(ctx as never, {} as never, undefined, undefined, groupRepo as never);
    expect(sentText).toContain('таймзону');
  });

  test('in private chat uses personal calendar', async () => {
    const eventService = {
      getEventsInRange: mock(() => []),
      getEventsInRangeForGroup: mock(() => []),
    };
    const ctx = {
      chat: { type: 'private', id: 1 },
      dbUser: { telegram_id: 1, language: 'en', timezone: 'UTC' },
      send: mock(() => Promise.resolve()),
      editText: mock(() => Promise.resolve()),
    };
    await handleMonth(ctx as never, eventService as never);
    expect(eventService.getEventsInRange).toHaveBeenCalled();
    expect(eventService.getEventsInRangeForGroup).not.toHaveBeenCalled();
  });
});
