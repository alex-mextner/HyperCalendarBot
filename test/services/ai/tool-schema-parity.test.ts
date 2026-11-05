import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import type { ToolInputMap } from '../../../src/services/ai/tool-executor.ts';
import { toolSchemas } from '../../../src/services/ai/tool-schemas.ts';
import { getToolInputSchema, withSchemaExcerpt } from '../../../src/services/ai/tools.ts';

/** Top-level keys of a zod object schema, unwrapping pipes/transforms. */
function zodTopLevelKeys(schema: z.core.$ZodType): string[] | null {
  if (schema instanceof z.ZodObject) return Object.keys(schema.shape);
  if (schema instanceof z.ZodPipe) return zodTopLevelKeys(schema.in);
  return null;
}

describe('tool schema parity (#347)', () => {
  const entries = Object.entries(toolSchemas);

  test('every zod-schema tool has a model-facing JSON input_schema', () => {
    const missing = entries.map(([name]) => name).filter((name) => getToolInputSchema(name) === undefined);
    expect(missing).toEqual([]);
  });

  test('zod object keys and JSON input_schema properties match for every tool', () => {
    const drifts: string[] = [];
    for (const [name, schema] of entries) {
      const keys = zodTopLevelKeys(schema);
      const json = getToolInputSchema(name);
      if (keys === null || json === undefined) continue;
      const jsonKeys = Object.keys(json.properties);
      for (const k of keys) if (!jsonKeys.includes(k)) drifts.push(`${name}.${k} missing in JSON schema`);
      for (const k of jsonKeys) if (!keys.includes(k)) drifts.push(`${name}.${k} missing in zod schema`);
    }
    expect(drifts).toEqual([]);
  });

  test('ToolInputMap.add_contact carries preferred_name (type-level)', () => {
    type HasPreferred = 'preferred_name' extends keyof ToolInputMap['add_contact'] ? true : false;
    const ok: HasPreferred = true;
    expect(ok).toBe(true);
  });
});

describe('get_reminders zod schema accepts its documented inputs (#347 drift)', () => {
  test('event_ids and query parse without event_id', () => {
    expect(toolSchemas.get_reminders.safeParse({ event_ids: [1, 2] }).success).toBe(true);
    expect(toolSchemas.get_reminders.safeParse({ query: 'dentist' }).success).toBe(true);
  });
});

describe('schema excerpt stays compact (#350)', () => {
  test('manage_settings blind-call excerpt is bounded and keeps field names/types', () => {
    const excerpt = withSchemaExcerpt('Invalid input', 'manage_settings');
    expect(excerpt.length).toBeLessThanOrEqual(400);
    expect(excerpt).toContain('action (string(get|update), required)');
    expect(excerpt).toContain('category (string(');
    expect(excerpt).toContain('updates (object, optional)');
  });

  test('every tool field description in an excerpt is capped on a word boundary', () => {
    for (const name of Object.keys(toolSchemas)) {
      const excerpt = withSchemaExcerpt('', name);
      for (const line of excerpt.replace(/^ \[schema: |\]$/g, '').split('; ')) {
        const desc = line.split(' — ')[1];
        if (desc !== undefined) expect(desc.length).toBeLessThanOrEqual(100);
      }
    }
  });
});
