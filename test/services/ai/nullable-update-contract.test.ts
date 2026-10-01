import { expect, test } from 'bun:test';
import { toolCallKey } from '../../../src/services/ai/agent.ts';
import { toolSchemas } from '../../../src/services/ai/tool-schemas.ts';
import { getToolDefinitions } from '../../../src/services/ai/tools.ts';

for (const field of ['end_at', 'description', 'location', 'recurrence_rule']) {
  test(`advertised update schema and dedup agree on null clearing ${field}`, () => {
    const tool = getToolDefinitions('text').find(
      (item) => item.type === 'function' && item.function.name === 'update_event',
    );
    if (tool?.type !== 'function') throw new Error('update_event definition is missing');
    const properties = tool.function.parameters?.properties;
    if (typeof properties !== 'object' || properties === null) throw new Error('properties are missing');
    expect(Reflect.get(properties, field).type).toEqual(['string', 'null']);
    expect(tool.function.description).toContain('Omitted fields stay unchanged');
    expect(toolCallKey('update_event', { event_id: 5, [field]: null })).not.toBe(
      toolCallKey('update_event', { event_id: 5 }),
    );
  });
}

for (const field of ['title', 'start_at', 'event_id']) {
  test(`update schema still rejects null for non-removable ${field}`, () => {
    expect(toolSchemas.update_event.safeParse({ event_id: 5, [field]: null }).success).toBe(false);
  });
}
for (const field of ['title', 'start_at']) {
  test(`dedup does not give stray ${field} null a clearing meaning`, () => {
    expect(toolCallKey('update_event', { event_id: 5, [field]: null })).toBe(
      toolCallKey('update_event', { event_id: 5 }),
    );
  });
}
