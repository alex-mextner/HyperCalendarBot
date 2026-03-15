import { describe, expect, test } from 'bun:test';
import { toolDefinitions } from '../../../src/services/ai/tools.ts';

describe('toolDefinitions', () => {
  test('exports 16 tool definitions', () => {
    expect(toolDefinitions.length).toBe(16);
  });

  test('each tool has name, description, and input_schema', () => {
    for (const tool of toolDefinitions) {
      expect(typeof tool.name).toBe('string');
      expect(typeof tool.description).toBe('string');
      expect(tool.input_schema).toBeDefined();
      expect(tool.input_schema.type).toBe('object');
    }
  });

  test('tool names are unique', () => {
    const names = toolDefinitions.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  const expectedTools = [
    'get_events',
    'create_event',
    'update_event',
    'delete_event',
    'get_free_slots',
    'search_events',
    'set_reminder',
    'get_holidays',
    'get_user_settings',
    'update_user_settings',
  ];

  for (const name of expectedTools) {
    test(`includes ${name} tool`, () => {
      const tool = toolDefinitions.find((t) => t.name === name);
      expect(tool).toBeDefined();
    });
  }

  test('create_event requires title and start_at', () => {
    const tool = toolDefinitions.find((t) => t.name === 'create_event')!;
    expect(tool.input_schema.required).toContain('title');
    expect(tool.input_schema.required).toContain('start_at');
  });

  test('update_event requires event_id', () => {
    const tool = toolDefinitions.find((t) => t.name === 'update_event')!;
    expect(tool.input_schema.required).toContain('event_id');
  });

  test('delete_event requires event_id', () => {
    const tool = toolDefinitions.find((t) => t.name === 'delete_event')!;
    expect(tool.input_schema.required).toContain('event_id');
  });
});
