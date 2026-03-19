import { describe, expect, test } from 'bun:test';
import { getSceneLang, getSceneUser } from '../../../src/bot/scenes/helpers.ts';

describe('getSceneUser', () => {
  test('extracts dbUser from context', () => {
    const user = { telegram_id: 1, language: 'en', timezone: 'UTC' };
    const ctx = { dbUser: user };
    expect(getSceneUser(ctx)).toBe(user as unknown as import('../../../src/database/types.ts').User);
  });

  test('returns undefined when dbUser is not present', () => {
    expect(getSceneUser({})).toBeUndefined();
  });

  test('returns undefined for null context fields', () => {
    expect(getSceneUser({ dbUser: undefined })).toBeUndefined();
  });

  test('returns undefined from primitive context', () => {
    expect(getSceneUser(42)).toBeUndefined();
    expect(getSceneUser('text')).toBeUndefined();
  });
});

describe('getSceneLang', () => {
  test('returns user language when user exists', () => {
    const ctx = { dbUser: { telegram_id: 1, language: 'ru', timezone: 'UTC' } };
    expect(getSceneLang(ctx)).toBe('ru');
  });

  test('returns "en" when user exists with en language', () => {
    const ctx = { dbUser: { telegram_id: 1, language: 'en', timezone: 'UTC' } };
    expect(getSceneLang(ctx)).toBe('en');
  });

  test('defaults to "en" when no user', () => {
    expect(getSceneLang({})).toBe('en');
  });

  test('defaults to "en" when user has no language', () => {
    const ctx = { dbUser: { telegram_id: 1 } };
    expect(getSceneLang(ctx)).toBe('en');
  });
});
