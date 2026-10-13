import { expect, test } from 'bun:test';
import { billedOutputUpperEstimate } from '../../../scripts/model-quality/usage.ts';

test('Gemini total can include generated tokens missing from completion count', () =>
  expect(billedOutputUpperEstimate(16, 6, 47)).toBe(31));
test('ordinary completion counts are not counted twice', () => expect(billedOutputUpperEstimate(84, 59, 143)).toBe(59));
