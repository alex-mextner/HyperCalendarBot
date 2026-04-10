import { describe, expect, test } from 'bun:test';
import { t } from '../../../src/config/constants.ts';
import { FEATURE_KEYS } from '../../../src/database/repositories/feature-usage.repository.ts';
import { BOT_TIP_FEATURE_MAP } from '../../../src/services/notification/tip-tags.ts';

describe('BOT_TIP_FEATURE_MAP', () => {
  test('has same keys as EN botTips', () => {
    const tipKeys = Object.keys(t('en').botTips);
    const mapKeys = Object.keys(BOT_TIP_FEATURE_MAP);
    expect(mapKeys.sort()).toEqual(tipKeys.sort());
  });

  test('has same keys as RU botTips', () => {
    const tipKeys = Object.keys(t('ru').botTips);
    const mapKeys = Object.keys(BOT_TIP_FEATURE_MAP);
    expect(mapKeys.sort()).toEqual(tipKeys.sort());
  });

  test('EN and RU botTips have the same keys', () => {
    const enKeys = Object.keys(t('en').botTips).sort();
    const ruKeys = Object.keys(t('ru').botTips).sort();
    expect(enKeys).toEqual(ruKeys);
  });

  test('all entries are valid FEATURE_KEYS values', () => {
    const validKeys = new Set(Object.values(FEATURE_KEYS));
    for (const key of Object.values(BOT_TIP_FEATURE_MAP)) {
      expect(validKeys.has(key)).toBe(true);
    }
  });
});
