// test/services/ai/model-presets.test.ts
// The preset registry is the one table that says which model/effort pairs may serve which role,
// what they cost, and whether a measurement ever admitted them.

import { describe, expect, test } from 'bun:test';
import {
  estimateCostMicroUsd,
  excludedModelReason,
  HISTORY_PASS_REQUIRED,
  isQualifiedFor,
  MODEL_PRESETS,
  type ModelPreset,
  presetById,
  presetRequestFields,
  ROLE_PASS_MIN,
} from '../../../src/services/ai/model-presets.ts';
import type { ProviderId } from '../../../src/services/ai/provider-ids.ts';

function preset(overrides: Partial<ModelPreset> = {}): ModelPreset {
  return {
    id: 'test',
    models: { openrouter: 'vendor/model' },
    roles: ['executor'],
    prices: {},
    qualifications: {},
    ...overrides,
  };
}

describe('seeded presets', () => {
  test('ids are unique and resolvable', () => {
    const ids = MODEL_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(presetById(id)?.id).toBe(id);
    expect(presetById('nope')).toBeNull();
  });

  test('carry the ids measured on 2026-09-27 and verified on OpenRouter on 2026-10-23', () => {
    expect(presetById('deepseek41-flash')?.models.openrouter).toBe('deepseek/deepseek-v4.1-flash');
    expect(presetById('glm53-flash-low')?.models.openrouter).toBe('z-ai/glm-5.3-flash');
    expect(presetById('glm53-flash-low')?.models.zai).toBe('glm-5.3-flash');
    expect(presetById('glm53-flash-low')?.effort).toBe('low');
    expect(presetById('glm53-low')?.models.openrouter).toBe('z-ai/glm-5.3');
  });

  test('no seeded model is on the excluded list', () => {
    for (const p of MODEL_PRESETS) {
      for (const model of Object.values(p.models)) expect(excludedModelReason(model)).toBeNull();
    }
  });

  test('nothing is qualified until a measurement says so', () => {
    for (const p of MODEL_PRESETS) {
      expect(p.qualifications).toEqual({});
      for (const role of p.roles) {
        for (const provider of Object.keys(p.models) as ProviderId[]) {
          expect(isQualifiedFor(p, role, provider)).toBe(false);
        }
      }
    }
  });

  test('every price states its date and source, and none is zero', () => {
    for (const p of MODEL_PRESETS) {
      for (const price of Object.values(p.prices)) {
        expect(price.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(price.source.length).toBeGreaterThan(0);
        expect(price.inputUsdPerMTok).toBeGreaterThan(0);
        expect(price.outputUsdPerMTok).toBeGreaterThan(0);
      }
    }
  });
});

describe('the excluded list', () => {
  test.each([
    'openai/gpt-oss-120b',
    'gpt-oss-20b',
    'openai/gpt-oss-120b:free',
    'GPT-OSS-120B',
    'qwen/qwen3.8-27b',
  ])('%s can never be selected', (model) => {
    expect(excludedModelReason(model)).not.toBeNull();
  });

  test.each([
    'deepseek/deepseek-v4.1-flash',
    'z-ai/glm-5.3',
    'claude-haiku-5-5',
    'glm-5.3-flash',
  ])('%s is allowed', (model) => {
    expect(excludedModelReason(model)).toBeNull();
  });
});

describe('the qualification gate', () => {
  const sha = 'abc1234';
  const qualified = (rolePass: number, historyPass: number | null) =>
    preset({
      qualifications: {
        openrouter: { sha, measuredAt: '2026-10-23', rolePass: { executor: rolePass }, historyPass },
      },
    });

  test('thresholds are 95% own-role and 100% history', () => {
    expect(ROLE_PASS_MIN).toBe(0.95);
    expect(HISTORY_PASS_REQUIRED).toBe(1);
  });

  test('a NaN score (zero cases measured) is never a pass', () => {
    expect(isQualifiedFor(qualified(Number.NaN, 1), 'executor', 'openrouter')).toBe(false);
    expect(isQualifiedFor(qualified(1, Number.NaN), 'executor', 'openrouter')).toBe(false);
  });
  test('admits only at or above both thresholds', () => {
    expect(isQualifiedFor(qualified(0.95, 1), 'executor', 'openrouter')).toBe(true);
    expect(isQualifiedFor(qualified(0.949, 1), 'executor', 'openrouter')).toBe(false);
    expect(isQualifiedFor(qualified(1, 0.99), 'executor', 'openrouter')).toBe(false);
  });

  test('an unmeasured history is not a pass', () => {
    expect(isQualifiedFor(qualified(1, null), 'executor', 'openrouter')).toBe(false);
  });

  test('a role it was never measured for is not qualified, even if the preset lists the role', () => {
    const p = preset({
      roles: ['executor', 'repair'],
      qualifications: {
        openrouter: { sha, measuredAt: '2026-10-23', rolePass: { executor: 1 }, historyPass: 1 },
      },
    });
    expect(isQualifiedFor(p, 'executor', 'openrouter')).toBe(true);
    expect(isQualifiedFor(p, 'repair', 'openrouter')).toBe(false);
  });

  test('a role outside the preset role set is never qualified', () => {
    const p = preset({
      roles: ['planner'],
      qualifications: {
        openrouter: { sha, measuredAt: '2026-10-23', rolePass: { executor: 1 }, historyPass: 1 },
      },
    });
    expect(isQualifiedFor(p, 'executor', 'openrouter')).toBe(false);
  });
});

describe('qualification is per provider', () => {
  const sha = 'abc1234';
  const viaOpenrouter = preset({
    models: { openrouter: 'vendor/model', zai: 'model' },
    qualifications: {
      openrouter: { sha, measuredAt: '2026-10-23', rolePass: { executor: 1 }, historyPass: 1 },
    },
  });

  test('a preset measured through OpenRouter is not qualified on z.ai, where the effort control was never verified', () => {
    expect(isQualifiedFor(viaOpenrouter, 'executor', 'openrouter')).toBe(true);
    expect(isQualifiedFor(viaOpenrouter, 'executor', 'zai')).toBe(false);
  });

  test('a provider the preset has no model for is never qualified, whatever the table says', () => {
    const p = preset({
      models: { openrouter: 'vendor/model' },
      qualifications: { zai: { sha, measuredAt: '2026-10-23', rolePass: { executor: 1 }, historyPass: 1 } },
    });
    expect(isQualifiedFor(p, 'executor', 'zai')).toBe(false);
  });
});

describe('estimateCostMicroUsd (the dated price table, used only when the provider reported no cost)', () => {
  const priced = preset({
    models: { openrouter: 'vendor/model' },
    prices: {
      openrouter: { inputUsdPerMTok: 0.3, outputUsdPerMTok: 1.2, asOf: '2026-10-23', source: 'test' },
    },
  });

  test('is tokens times the per-million price in micro-USD', () => {
    expect(estimateCostMicroUsd('openrouter', 'vendor/model', 1000, 500, [priced])).toBe(900);
    expect(estimateCostMicroUsd('openrouter', 'vendor/model', 1_000_000, 1_000_000, [priced])).toBe(1_500_000);
  });

  test('is unknown, never zero, without a price for that provider and model', () => {
    expect(estimateCostMicroUsd('zai', 'vendor/model', 1000, 500, [priced])).toBeNull();
    expect(estimateCostMicroUsd('openrouter', 'other/model', 1000, 500, [priced])).toBeNull();
  });

  test('is unknown when either token count was not reported', () => {
    expect(estimateCostMicroUsd('openrouter', 'vendor/model', null, 500, [priced])).toBeNull();
    expect(estimateCostMicroUsd('openrouter', 'vendor/model', 1000, null, [priced])).toBeNull();
  });

  test('a real zero-token answer costs a known zero', () => {
    expect(estimateCostMicroUsd('openrouter', 'vendor/model', 0, 0, [priced])).toBe(0);
  });

  test('defaults to the seeded registry, which prices the OpenRouter models', () => {
    expect(estimateCostMicroUsd('openrouter', 'deepseek/deepseek-v4.1-flash', 1_000_000, 0)).toBe(300_000);
    expect(estimateCostMicroUsd('claude', 'claude-haiku-5-5', 1000, 1000)).toBeNull();
  });
});

describe('presetRequestFields', () => {
  test('OpenRouter gets the reasoning effort', () => {
    expect(presetRequestFields('openrouter', preset({ effort: 'low' }))).toEqual({ reasoning: { effort: 'low' } });
  });

  test('no effort, no extra field', () => {
    expect(presetRequestFields('openrouter', preset())).toEqual({});
  });

  test('providers whose effort control was never verified get nothing rather than a guess', () => {
    expect(presetRequestFields('zai', preset({ effort: 'low' }))).toEqual({});
    expect(presetRequestFields('hf', preset({ effort: 'low' }))).toEqual({});
    expect(presetRequestFields('claude', preset({ effort: 'low' }))).toEqual({});
  });
});
