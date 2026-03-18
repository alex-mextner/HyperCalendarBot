import { describe, expect, mock, test } from 'bun:test';

const user = { telegram_id: 100, language: 'en' as const, timezone: 'UTC' };
const userRu = { telegram_id: 100, language: 'ru' as const, timezone: 'UTC' };

function makeCtx(overrides = {}) {
  return {
    dbUser: user,
    send: mock(() => Promise.resolve()),
    ...overrides,
  };
}

describe('handleHelp', () => {
  test('sends english help text', async () => {
    const { handleHelp } = await import('../../../src/bot/commands/help.ts');
    const ctx = makeCtx();

    await handleHelp(ctx as never);

    expect(ctx.send).toHaveBeenCalledTimes(1);
    const args = ctx.send.mock.calls[0] as unknown[];
    const msg = args[0] as string;
    expect(msg).toContain('HyperCalendar Commands');
    expect(msg).toContain('/today');
    expect(msg).toContain('/ping');
    expect(args[1]).toHaveProperty('parse_mode', 'HTML');
  });

  test('sends russian help text', async () => {
    const { handleHelp } = await import('../../../src/bot/commands/help.ts');
    const ctx = makeCtx({ dbUser: userRu });

    await handleHelp(ctx as never);

    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('Команды HyperCalendar');
    expect(msg).toContain('/today');
  });

  test('falls back to english when language is not set', async () => {
    const { handleHelp } = await import('../../../src/bot/commands/help.ts');
    const ctx = makeCtx({ dbUser: {} });

    await handleHelp(ctx as never);

    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('HyperCalendar Commands');
  });

  test('uses HTML parse_mode', async () => {
    const { handleHelp } = await import('../../../src/bot/commands/help.ts');
    const ctx = makeCtx();

    await handleHelp(ctx as never);

    const opts = (ctx.send.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(opts.parse_mode).toBe('HTML');
  });
});
