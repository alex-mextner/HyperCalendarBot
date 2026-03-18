import { describe, expect, mock, test } from 'bun:test';

function makeCtx(overrides = {}) {
  return {
    dbUser: { telegram_id: 100, language: 'en' as const, timezone: 'UTC' },
    scene: {
      enter: mock(() => Promise.resolve()),
    },
    ...overrides,
  };
}

describe('handleTimezone', () => {
  test('enters the timezone scene', async () => {
    const { handleTimezone } = await import('../../../src/bot/commands/timezone.ts');
    const ctx = makeCtx();
    const timezoneScene = {} as never;

    await handleTimezone(ctx as never, timezoneScene);

    expect(ctx.scene.enter).toHaveBeenCalledTimes(1);
    expect(ctx.scene.enter).toHaveBeenCalledWith(timezoneScene);
  });

  test('passes the scene object to enter', async () => {
    const { handleTimezone } = await import('../../../src/bot/commands/timezone.ts');
    const ctx = makeCtx();
    const timezoneScene = { id: 'timezone' } as never;

    await handleTimezone(ctx as never, timezoneScene);

    const sceneArg = (ctx.scene.enter.mock.calls[0] as unknown[])[0];
    expect(sceneArg).toBe(timezoneScene);
  });
});
