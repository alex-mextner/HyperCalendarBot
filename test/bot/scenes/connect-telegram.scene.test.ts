import { describe, expect, test } from 'bun:test';
import {
  CODE_REGEX,
  isConnectCooldownActive,
  isOtpLikeText,
  isPhoneLikeText,
  normalizeOtpCode,
  normalizePhone,
  PHONE_REGEX,
  pendingStepTransitions,
  registerConnectAttempt,
} from '../../../src/bot/scenes/connect-telegram.scene.ts';
import { t } from '../../../src/config/constants.ts';
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

describe('pendingStepTransitions guard', () => {
  test('delete returns true when userId is in the Set, preventing step re-processing', () => {
    const userId = 770001;
    pendingStepTransitions.add(userId);
    // Step 2 handler calls pendingStepTransitions.delete() and returns early if true
    const guardHit = pendingStepTransitions.delete(userId);
    expect(guardHit).toBe(true);
  });

  test('Set is empty after the guard fires', () => {
    const userId = 770002;
    pendingStepTransitions.add(userId);
    pendingStepTransitions.delete(userId);
    expect(pendingStepTransitions.has(userId)).toBe(false);
    expect(pendingStepTransitions.size).toBe(0);
  });

  test('delete returns false when userId was never added', () => {
    const guardHit = pendingStepTransitions.delete(770003);
    expect(guardHit).toBe(false);
  });
});

describe('normalizePhone', () => {
  test('strips spaces from phone number', () => {
    expect(normalizePhone('+375 29 134 6026')).toBe('+375291346026');
  });

  test('adds + prefix when missing', () => {
    expect(normalizePhone('375291346026')).toBe('+375291346026');
  });

  test('strips dashes from phone number', () => {
    expect(normalizePhone('+375-29-134-6026')).toBe('+375291346026');
  });

  test('strips parentheses from phone number', () => {
    expect(normalizePhone('(375)291346026')).toBe('+375291346026');
  });

  test('handles mixed separators', () => {
    expect(normalizePhone('+375 (29) 134-6026')).toBe('+375291346026');
  });

  test('returns undefined for empty string', () => {
    expect(normalizePhone('')).toBeUndefined();
  });

  test('normalized result passes PHONE_REGEX', () => {
    const phone = normalizePhone('+375 29 134 6026');
    expect(phone).toBeDefined();
    expect(PHONE_REGEX.test(phone!)).toBe(true);
  });
});

describe('normalizeOtpCode', () => {
  test('strips spaces from code', () => {
    const normalized = normalizeOtpCode('1 2 3 4 5');
    expect(normalized).toBe('12345');
    expect(CODE_REGEX.test(normalized)).toBe(true);
  });

  test('strips dashes from code', () => {
    const normalized = normalizeOtpCode('123-45');
    expect(normalized).toBe('12345');
    expect(CODE_REGEX.test(normalized)).toBe(true);
  });

  test('plain code passes through unchanged', () => {
    const normalized = normalizeOtpCode('12345');
    expect(normalized).toBe('12345');
    expect(CODE_REGEX.test(normalized)).toBe(true);
  });

  test('mixed separators are stripped', () => {
    const normalized = normalizeOtpCode('1 2-3 4 5');
    expect(normalized).toBe('12345');
    expect(CODE_REGEX.test(normalized)).toBe(true);
  });

  test('letters are not stripped (result fails CODE_REGEX)', () => {
    const normalized = normalizeOtpCode('1a2b3');
    expect(CODE_REGEX.test(normalized)).toBe(false);
  });
});

describe('isOtpLikeText', () => {
  test('accepts plain digits', () => {
    expect(isOtpLikeText('12345')).toBe(true);
    expect(isOtpLikeText('1234')).toBe(true);
  });

  test('accepts digits with spaces and dashes', () => {
    expect(isOtpLikeText('1 2 3 4 5')).toBe(true);
    expect(isOtpLikeText('123-45')).toBe(true);
    expect(isOtpLikeText('1 2-3 4 5')).toBe(true);
    expect(isOtpLikeText('12 345')).toBe(true);
  });

  test('rejects natural-language text', () => {
    expect(isOtpLikeText('what is my calendar?')).toBe(false);
    expect(isOtpLikeText('покажи события')).toBe(false);
    expect(isOtpLikeText('code is 12345')).toBe(false);
  });

  test('rejects text with letters among digits', () => {
    expect(isOtpLikeText('1a2b3')).toBe(false);
    expect(isOtpLikeText('123 abc')).toBe(false);
  });

  test('rejects empty string', () => {
    expect(isOtpLikeText('')).toBe(false);
  });
});

describe('isPhoneLikeText', () => {
  test('accepts digit-only strings', () => {
    expect(isPhoneLikeText('12345')).toBe(true);
    expect(isPhoneLikeText('79001234567')).toBe(true);
  });

  test('accepts phone-shaped strings with separators', () => {
    expect(isPhoneLikeText('+79001234567')).toBe(true);
    expect(isPhoneLikeText('+7 900 123 45 67')).toBe(true);
    expect(isPhoneLikeText('+7-900-123-45-67')).toBe(true);
    expect(isPhoneLikeText('+7 (900) 123-45-67')).toBe(true);
  });

  test('rejects natural-language text', () => {
    expect(isPhoneLikeText('what is my calendar?')).toBe(false);
    expect(isPhoneLikeText('покажи события')).toBe(false);
    expect(isPhoneLikeText('call me at +79001234567')).toBe(false);
  });

  test('rejects strings with letters', () => {
    expect(isPhoneLikeText('+7900abc1234')).toBe(false);
    expect(isPhoneLikeText('phone')).toBe(false);
  });

  test('rejects empty string', () => {
    expect(isPhoneLikeText('')).toBe(false);
  });
});

describe('cancel-authorization i18n', () => {
  test('EN connectTelegram exposes new cancel strings', () => {
    const ct = t('en').connectTelegram;
    expect(ct.btnCancelAuth).toBe('Cancel authorization');
    expect(ct.authCancelled).toBe('Authorization cancelled.');
    expect(ct.authCancelledAnswering).toContain('Authorization cancelled');
    expect(ct.authCancelledAnswering).toContain('Answering');
    expect(ct.orCancelAuth).toContain('cancel');
  });

  test('RU connectTelegram exposes new cancel strings', () => {
    const ct = t('ru').connectTelegram;
    expect(ct.btnCancelAuth).toBe('Отменить авторизацию');
    expect(ct.authCancelled).toBe('Авторизация отменена.');
    expect(ct.authCancelledAnswering).toContain('Авторизация отменена');
    expect(ct.authCancelledAnswering).toContain('Отвечаю');
    expect(ct.orCancelAuth).toContain('отмени');
  });
});
