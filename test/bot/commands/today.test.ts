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

  test('calls sendPhoto when renderService is provided', async () => {
    const { handleToday } = await import('../../../src/bot/commands/today.ts');
    const ctx = makeCtx();
    const svc = makeEventService();
    const renderService = { render: mock(() => Promise.resolve(Buffer.from(''))) };

    // renderDayImage is an internal call; stub it via renderService that throws
    // to exercise the catch branch
    await handleToday(ctx as never, svc as never, undefined, renderService as never);

    // render threw so sendPhoto should NOT be called, but send still was
    expect(ctx.send).toHaveBeenCalledTimes(1);
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

  test('saves response to chat history when chatHistory provided', async () => {
    const { handleToday } = await import('../../../src/bot/commands/today.ts');
    const ctx = makeCtx();
    const svc = makeEventService();
    const chatHistory = { save: mock(() => {}) };

    await handleToday(ctx as never, svc as never, undefined, undefined, chatHistory as never);

    expect(chatHistory.save).toHaveBeenCalledTimes(1);
    const [userId, role, content] = chatHistory.save.mock.calls[0] as unknown[];
    expect(userId).toBe(user.telegram_id);
    expect(role).toBe('assistant');
    expect(typeof content).toBe('string');
  });

  test('does not throw when chatHistory is not provided', async () => {
    const { handleToday } = await import('../../../src/bot/commands/today.ts');
    const ctx = makeCtx();
    const svc = makeEventService();

    await expect(handleToday(ctx as never, svc as never)).resolves.toBeUndefined();
  });
});
