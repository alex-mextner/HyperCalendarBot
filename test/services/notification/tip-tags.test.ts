import { describe, expect, test } from 'bun:test';
import { t } from '../../../src/config/constants.ts';
import { FEATURE_KEYS } from '../../../src/database/repositories/feature-usage.repository.ts';
import { BOT_TIP_FEATURE_MAP } from '../../../src/services/notification/tip-tags.ts';

describe('BOT_TIP_FEATURE_MAP', () => {
  test('has same length as EN botTips array', () => {
    expect(BOT_TIP_FEATURE_MAP.length).toBe(t('en').botTips.length);
  });

  test('has same length as RU botTips array', () => {
    expect(BOT_TIP_FEATURE_MAP.length).toBe(t('ru').botTips.length);
  });

  test('all entries are valid FEATURE_KEYS values', () => {
    const validKeys = new Set(Object.values(FEATURE_KEYS));
    for (const key of BOT_TIP_FEATURE_MAP) {
      expect(validKeys.has(key)).toBe(true);
    }
  });
});
