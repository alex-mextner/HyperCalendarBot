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
