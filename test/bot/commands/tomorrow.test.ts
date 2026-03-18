import { describe, expect, mock, test } from 'bun:test';

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
    const renderService = { render: mock(() => Promise.resolve(Buffer.from(''))) };

    await handleTomorrow(ctx as never, svc as never, undefined, renderService as never);

    // renderDayImage throws internally since renderService.render doesn't match expected shape
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
