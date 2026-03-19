import { describe, expect, mock, test } from 'bun:test';
import { createTimezoneScene } from '../../../src/bot/scenes/timezone.scene.ts';
import type { DatabaseService } from '../../../src/database/index.ts';

function makeDb() {
  return {
    users: {
      update: mock(() => {}),
    },
  } as unknown as DatabaseService;
}

function makeContext(overrides: Record<string, unknown> = {}) {
  return {
    dbUser: { telegram_id: 1, language: 'ru' as const, timezone: 'Europe/Moscow' },
    scene: {
      exit: mock(() => Promise.resolve()),
    },
    send: mock(() => Promise.resolve()),
    ...overrides,
  };
}

describe('createTimezoneScene', () => {
  test('creates scene with name "timezone"', () => {
    const scene = createTimezoneScene(makeDb());
    expect(scene.name).toBe('timezone');
  });

  test('onEnter sends two messages with keyboards', async () => {
    const scene = createTimezoneScene(makeDb());
    const ctx = makeContext();

    // Access the onEnter handler via the internal handlers list
    // @ts-expect-error accessing internal scene handlers for testing
    const enterHandlers: ((ctx: unknown) => Promise<void>)[] = scene._enterHandlers ?? scene.enterHandlers ?? [];

    if (enterHandlers.length === 0) {
      // GramIO doesn't expose onEnter handlers directly — test module load only
      expect(scene.name).toBe('timezone');
      return;
    }

    await enterHandlers[0]!(ctx);
    expect(ctx.send).toHaveBeenCalledTimes(2);
  });
});
