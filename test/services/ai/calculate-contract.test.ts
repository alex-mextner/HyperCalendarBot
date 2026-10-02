import { describe, expect, test } from 'bun:test';
import { handleCalculate } from '../../../src/services/ai/tool-handlers/calculate.ts';

describe('calculator operand contract', () => {
  test.each([
    '1 +',
    '()',
    '*2',
    '2 *',
    '1 /',
    '( )',
    '1 + ()',
  ])('rejects absent operands instead of inventing zero: %s', (expression) => {
    expect(handleCalculate({ expression }).success).toBe(false);
  });
  test('accepts the whitespace allowed by its numeric grammar', () => {
    expect(handleCalculate({ expression: '1\t+\n2' })).toMatchObject({ success: true, output: '3' });
  });
  test('bounds input before recursive arithmetic parsing', () => {
    expect(handleCalculate({ expression: `${'1+'.repeat(300)}1` }).success).toBe(false);
  });
  test.each(['0', '1 + 2', '2 * (3 + 4)', '-2 + 3'])('keeps complete numeric expressions valid: %s', (expression) => {
    expect(handleCalculate({ expression }).success).toBe(true);
  });
});

describe('standalone explicit-offset timestamp normalization', () => {
  test.each([
    ['2026-09-28T12:30:00+02:00', '2026-09-28T10:30:00.000Z'],
    ['2026-09-28T12:30:45.123+05:30', '2026-09-28T07:00:45.123Z'],
    ['2026-01-01T00:10:00+14:00', '2025-12-31T10:10:00.000Z'],
  ])('normalizes the real rejected expression without a fake +0hours: %s', (expression, output) => {
    expect(handleCalculate({ expression })).toMatchObject({ success: true, output });
  });
  test.each([
    '2026-02-30T12:30:00+02:00',
    '2026-09-28T25:30:00+02:00',
    '2026-09-28T12:30:00',
    '2026-09-28T12:30:00+25:00',
  ])('does not normalize nonexistent dates, bad offsets or unspecified zones: %s', (expression) => {
    expect(handleCalculate({ expression }).success).toBe(false);
  });
});
