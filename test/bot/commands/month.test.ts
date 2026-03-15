import { describe, expect, mock, test } from 'bun:test';

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
    const opts = callArgs[1] as Record<string, unknown>;
    expect(opts.reply_markup).toBeDefined();
  });
});
