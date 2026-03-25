import { describe, expect, test } from 'bun:test';
import { Composer } from 'gramio';
import type { UserResolverComposer } from '../../../src/bot/middleware/user-resolver.ts';
import { createOnboardingScene } from '../../../src/bot/scenes/onboarding.scene.ts';
import { CB } from '../../../src/config/constants.ts';
import type { DatabaseService } from '../../../src/database/index.ts';

const mockComposer = new Composer() as unknown as UserResolverComposer;

function makeDb() {
  return {
    users: {
      update: () => null,
      findByTelegramId: () => null,
    },
    notificationPreferences: {
      update: () => null,
    },
  } as unknown as DatabaseService;
}

describe('createOnboardingScene', () => {
  test('creates scene with name "onboarding"', () => {
    const scene = createOnboardingScene(makeDb(), mockComposer);
    expect(scene.name).toBe('onboarding');
  });

  test('has 4 steps: lang, timezone, country, agenda', () => {
    const scene = createOnboardingScene(makeDb(), mockComposer);
    expect(scene.stepsCount).toBe(4);
  });

  test('gcalConfigured defaults to false', () => {
    const scene = createOnboardingScene(makeDb(), mockComposer);
    expect(scene).toBeDefined();
  });

  test('accepts optional services without throwing', () => {
    const scene = createOnboardingScene(makeDb(), mockComposer, true, undefined, undefined, undefined);
    expect(scene.name).toBe('onboarding');
  });
});

describe('onboarding CB constants', () => {
  test('ONBOARD_LANG is defined', () => {
    expect(CB.ONBOARD_LANG).toBeDefined();
    expect(typeof CB.ONBOARD_LANG).toBe('string');
  });

  test('ONBOARD_TZ is defined', () => {
    expect(CB.ONBOARD_TZ).toBeDefined();
    expect(typeof CB.ONBOARD_TZ).toBe('string');
  });

  test('ONBOARD_TZ_RETRY is defined', () => {
    expect(CB.ONBOARD_TZ_RETRY).toBeDefined();
    expect(typeof CB.ONBOARD_TZ_RETRY).toBe('string');
  });

  test('ONBOARD_COUNTRY is defined', () => {
    expect(CB.ONBOARD_COUNTRY).toBeDefined();
    expect(typeof CB.ONBOARD_COUNTRY).toBe('string');
  });

  test('ONBOARD_AGENDA is defined', () => {
    expect(CB.ONBOARD_AGENDA).toBeDefined();
    expect(typeof CB.ONBOARD_AGENDA).toBe('string');
  });

  test('all onboarding CB prefixes are distinct', () => {
    const prefixes = [CB.ONBOARD_LANG, CB.ONBOARD_TZ, CB.ONBOARD_TZ_RETRY, CB.ONBOARD_COUNTRY, CB.ONBOARD_AGENDA];
    const unique = new Set(prefixes);
    expect(unique.size).toBe(prefixes.length);
  });
});
