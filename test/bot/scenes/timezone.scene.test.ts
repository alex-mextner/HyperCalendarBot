import { describe, expect, test } from 'bun:test';
import { Composer } from 'gramio';
import type { UserResolverComposer } from '../../../src/bot/middleware/user-resolver.ts';
import { createTimezoneScene } from '../../../src/bot/scenes/timezone.scene.ts';
import { CB } from '../../../src/config/constants.ts';
import type { DatabaseService } from '../../../src/database/index.ts';

const mockComposer = new Composer() as unknown as UserResolverComposer;

function makeDb() {
  return {
    users: {
      update: () => null,
      findByTelegramId: () => null,
    },
  } as unknown as DatabaseService;
}

describe('createTimezoneScene', () => {
  test('creates scene with name "timezone"', () => {
    const scene = createTimezoneScene(makeDb(), mockComposer);
    expect(scene.name).toBe('timezone');
  });

  test('has one step for message/location/callback handling', () => {
    const scene = createTimezoneScene(makeDb(), mockComposer);
    expect(scene.stepsCount).toBe(1);
  });
});

describe('CB.TZ_TYPE_CITY', () => {
  test('is defined and distinct from TZ_CANCEL', () => {
    expect(CB.TZ_TYPE_CITY).toBeDefined();
    expect(CB.TZ_TYPE_CITY).not.toBe(CB.TZ_CANCEL);
  });
});
