import { describe, expect, mock, test } from 'bun:test';

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

function makeSlot(start: string, end: string, durationMinutes: number) {
  return { start, end, durationMinutes };
}

describe('handleFree', () => {
  test('sends free slots for today when no args', async () => {
    const { handleFree } = await import('../../../src/bot/commands/free.ts');
    const ctx = makeCtx();
    const svc = {
      getFreeSlots: mock(() => [makeSlot('2026-03-18T09:00:00Z', '2026-03-18T12:00:00Z', 180)]),
    };

    await handleFree(ctx as never, svc as never);

    expect(ctx.send).toHaveBeenCalledTimes(1);
    const text = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(text).toContain('Free slots');
    expect(text).toContain('3h');
  });

  test('sends "full day busy" when no free slots', async () => {
    const { handleFree } = await import('../../../src/bot/commands/free.ts');
    const ctx = makeCtx();
    const svc = { getFreeSlots: mock(() => []) };

    await handleFree(ctx as never, svc as never);

    const text = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(text).toContain('Full day busy');
  });

  test('sends russian busy message', async () => {
    const { handleFree } = await import('../../../src/bot/commands/free.ts');
    const ctx = makeCtx({ dbUser: userRu });
    const svc = { getFreeSlots: mock(() => []) };

    await handleFree(ctx as never, svc as never);

    const text = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(text).toContain('Весь день занят');
  });

  test('formats duration with hours and minutes', async () => {
    const { handleFree } = await import('../../../src/bot/commands/free.ts');
    const ctx = makeCtx();
    const svc = {
      getFreeSlots: mock(() => [makeSlot('2026-03-18T09:00:00Z', '2026-03-18T10:30:00Z', 90)]),
    };

    await handleFree(ctx as never, svc as never);

    const text = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(text).toContain('1h30m');
  });

  test('formats duration with minutes only', async () => {
    const { handleFree } = await import('../../../src/bot/commands/free.ts');
    const ctx = makeCtx();
    const svc = {
      getFreeSlots: mock(() => [makeSlot('2026-03-18T09:00:00Z', '2026-03-18T09:45:00Z', 45)]),
    };

    await handleFree(ctx as never, svc as never);

    const text = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(text).toContain('45m');
  });

  test('returns day off message when holidayService marks the day as off', async () => {
    const { handleFree } = await import('../../../src/bot/commands/free.ts');
    const ctx = makeCtx();
    const svc = { getFreeSlots: mock(() => []) };
    const holidayService = {
      isDayOff: mock(() => true),
    };

    await handleFree(ctx as never, svc as never, holidayService as never);

    expect(svc.getFreeSlots).not.toHaveBeenCalled();
    const text = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(text).toContain('Day off');
  });

  test('does not return day off message when holidayService says false', async () => {
    const { handleFree } = await import('../../../src/bot/commands/free.ts');
    const ctx = makeCtx();
    const svc = { getFreeSlots: mock(() => [makeSlot('2026-03-18T09:00:00Z', '2026-03-18T17:00:00Z', 480)]) };
    const holidayService = {
      isDayOff: mock(() => false),
    };

    await handleFree(ctx as never, svc as never, holidayService as never);

    expect(svc.getFreeSlots).toHaveBeenCalledTimes(1);
    const text = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(text).toContain('Free slots');
  });

  test('parses date from args and uses it', async () => {
    const { handleFree } = await import('../../../src/bot/commands/free.ts');
    const ctx = makeCtx({ args: '2026-04-01' });
    const svc = { getFreeSlots: mock(() => []) };

    await handleFree(ctx as never, svc as never);

    expect(svc.getFreeSlots).toHaveBeenCalledTimes(1);
    const text = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(text).toContain('Full day busy');
  });

  test('in group with timezone calls getFreeSlotsForGroup', async () => {
    const { handleFree } = await import('../../../src/bot/commands/free.ts');
    const ctx = makeCtx({ chat: { type: 'group', id: -200 } });
    const svc = {
      getFreeSlots: mock(() => []),
      getFreeSlotsForGroup: mock(() => [makeSlot('2026-03-18T09:00:00Z', '2026-03-18T17:00:00Z', 480)]),
    };
    const groupRepo = { getTimezone: mock(() => 'Europe/Moscow') };

    await handleFree(ctx as never, svc as never, undefined, groupRepo as never);

    expect(svc.getFreeSlotsForGroup).toHaveBeenCalledWith(-200, expect.any(Date), 'Europe/Moscow');
    expect(svc.getFreeSlots).not.toHaveBeenCalled();
  });

  test('in group without timezone prompts to set timezone', async () => {
    const { handleFree } = await import('../../../src/bot/commands/free.ts');
    const ctx = makeCtx({ chat: { type: 'group', id: -200 } });
    const svc = {
      getFreeSlots: mock(() => []),
      getFreeSlotsForGroup: mock(() => []),
    };
    const groupRepo = { getTimezone: mock(() => null) };

    await handleFree(ctx as never, svc as never, undefined, groupRepo as never);

    expect(svc.getFreeSlotsForGroup).not.toHaveBeenCalled();
    expect(svc.getFreeSlots).not.toHaveBeenCalled();
    const text = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(text).toContain('/settings');
  });

  test('in group with no free slots sends busy message', async () => {
    const { handleFree } = await import('../../../src/bot/commands/free.ts');
    const ctx = makeCtx({ chat: { type: 'group', id: -200 } });
    const svc = {
      getFreeSlots: mock(() => []),
      getFreeSlotsForGroup: mock(() => []),
    };
    const groupRepo = { getTimezone: mock(() => 'UTC') };

    await handleFree(ctx as never, svc as never, undefined, groupRepo as never);

    const text = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(text).toContain('Full day busy');
  });

  test('in group with date arg parses the date', async () => {
    const { handleFree } = await import('../../../src/bot/commands/free.ts');
    const ctx = makeCtx({ chat: { type: 'group', id: -200 }, args: '2026-04-01' });
    const svc = {
      getFreeSlots: mock(() => []),
      getFreeSlotsForGroup: mock(() => []),
    };
    const groupRepo = { getTimezone: mock(() => 'UTC') };

    await handleFree(ctx as never, svc as never, undefined, groupRepo as never);

    expect(svc.getFreeSlotsForGroup).toHaveBeenCalledTimes(1);
    const text = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(text).toContain('Full day busy');
  });
});
