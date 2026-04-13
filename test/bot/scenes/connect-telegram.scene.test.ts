import { describe, expect, test } from 'bun:test';
import {
  CODE_REGEX,
  isConnectCooldownActive,
  PHONE_REGEX,
  registerConnectAttempt,
} from '../../../src/bot/scenes/connect-telegram.scene.ts';
import { SessionBridge } from '../../../src/services/telegram-session/session-bridge.ts';

describe('connect-telegram scene helpers', () => {
  test('PHONE_REGEX accepts valid international numbers', () => {
    expect(PHONE_REGEX.test('+79001234567')).toBe(true);
    expect(PHONE_REGEX.test('+1234567890')).toBe(true);
    expect(PHONE_REGEX.test('+380501234567')).toBe(true);
  });

  test('PHONE_REGEX rejects invalid formats', () => {
    expect(PHONE_REGEX.test('79001234567')).toBe(false);
    expect(PHONE_REGEX.test('+123')).toBe(false);
    expect(PHONE_REGEX.test('+1234567890123456')).toBe(false);
    expect(PHONE_REGEX.test('+7900abc1234')).toBe(false);
    expect(PHONE_REGEX.test('')).toBe(false);
  });

  test('CODE_REGEX accepts 5-digit codes only', () => {
    expect(CODE_REGEX.test('12345')).toBe(true);
    expect(CODE_REGEX.test('00000')).toBe(true);
    expect(CODE_REGEX.test('1234')).toBe(false);
    expect(CODE_REGEX.test('123456')).toBe(false);
    expect(CODE_REGEX.test('abcde')).toBe(false);
  });

  test('phoneHash is deterministic', () => {
    expect(SessionBridge.phoneHash('+79001234567')).toBe(SessionBridge.phoneHash('+79001234567'));
  });

  test('cooldown: second entry within window returns true', () => {
    const userId = 999001;
    registerConnectAttempt(userId);
    expect(isConnectCooldownActive(userId)).toBe(true);
  });

  test('cooldown: unknown user returns false', () => {
    expect(isConnectCooldownActive(999002)).toBe(false);
  });
});
