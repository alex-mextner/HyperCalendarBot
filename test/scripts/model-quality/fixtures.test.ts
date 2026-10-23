import { expect, test } from 'bun:test';
import { isWrite } from '../../../scripts/model-quality/core.ts';
import { fixtures } from '../../../scripts/model-quality/fixtures.ts';
import { tools } from '../../../scripts/model-quality/sandbox.ts';
import { toolSchemas } from '../../../src/services/ai/tool-schemas.ts';

const names = new Set(tools.flatMap((t) => (t.type === 'function' ? [t.function.name] : [])));

test('there are 32 scenarios with unique ids', () => {
  expect(fixtures).toHaveLength(32);
  expect(new Set(fixtures.map((f) => f.id)).size).toBe(32);
});

const properties = new Map(
  tools.flatMap((t) =>
    t.type === 'function'
      ? [[t.function.name, Object.keys(Reflect.get(t.function.parameters ?? {}, 'properties') ?? {})]]
      : [],
  ),
);

test('every expected call is a tool the bot exposes today, and expects only arguments its schema still has', () => {
  for (const fixture of fixtures)
    for (const expected of fixture.required) {
      expect(names.has(expected.name)).toBe(true);
      expect(Object.hasOwn(toolSchemas, expected.name)).toBe(true);
      const known = properties.get(expected.name) ?? [];
      expect({
        fixture: fixture.id,
        tool: expected.name,
        unknown: Object.keys(expected.args).filter((k) => !known.includes(k)),
      }).toEqual({
        fixture: fixture.id,
        tool: expected.name,
        unknown: [],
      });
    }
});

test('every write a scenario allows is a write the production classifier recognizes, and each expected write is allowed', () => {
  for (const fixture of fixtures) {
    for (const expected of fixture.required)
      if (isWrite(expected)) expect(fixture.allowedWrites).toContain(expected.name);
    expect(fixture.allowedWrites.length === 0 || fixture.maxWrites > 0).toBe(true);
  }
});
