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

describe('handlePing', () => {
  test('sends pong with ms in english', async () => {
    const { handlePing } = await import('../../../src/bot/commands/ping.ts');
    const ctx = makeCtx();

    await handlePing(ctx as never);

    expect(ctx.send).toHaveBeenCalledTimes(1);
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('pong');
    expect(msg).toContain('ms');
  });

  test('sends pong in russian', async () => {
    const { handlePing } = await import('../../../src/bot/commands/ping.ts');
    const ctx = makeCtx({ dbUser: userRu });

    await handlePing(ctx as never);

    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('понг');
    expect(msg).toContain('мс');
  });

  test('falls back to en when dbUser is null', async () => {
    const { handlePing } = await import('../../../src/bot/commands/ping.ts');
    const ctx = makeCtx({ dbUser: null });

    await handlePing(ctx as never);

    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('pong');
  });
});
