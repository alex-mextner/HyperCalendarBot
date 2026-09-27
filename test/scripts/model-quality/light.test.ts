import { expect, test } from 'bun:test';
import { gradeLight, lightCases, lightSchemas } from '../../../scripts/model-quality/light-cases.ts';

test('all frozen Light labels satisfy their requested schemas', () => {
  expect(lightCases.length).toBe(36);
  for (const c of lightCases) expect(gradeLight(c, c.expected)).toBe(true);
});
test('delivery cannot be inferred from success flag', () => {
  const c = lightCases.find((x) => x.id === 'outcome-6')!;
  expect(gradeLight(c, { operation: 'applied', delivery: 'delivered', may_claim_delivered: true })).toBe(false);
});
test('noncatalog enum cannot be used as execution permission', () =>
  expect(lightSchemas.catalog.safeParse({ groups: ['delete_everything'] }).success).toBe(false));
