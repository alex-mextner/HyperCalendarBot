import { describe, expect, test } from 'bun:test';
import { getToolDefinitions, toolDefinitions } from '../../../src/services/ai/tools.ts';

describe('toolDefinitions', () => {
  test('includes calculate tool', () => {
    const tool = toolDefinitions.find((t) => t.name === 'calculate');
    expect(tool).toBeDefined();
    expect(tool!.input_schema.required).toContain('expression');
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
    'manage_settings',
    'get_upcoming',
    'snooze_event',
    'get_event',
    'get_reminders',
    'find_user',
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

describe('getToolDefinitions supplement_skip', () => {
  test('supplement_skip is absent when supplementMode is false', () => {
    const tools = getToolDefinitions(undefined, undefined, false);
    expect(tools.some((t) => t.name === 'supplement_skip')).toBe(false);
  });

  test('supplement_skip is absent when supplementMode is undefined', () => {
    const tools = getToolDefinitions();
    expect(tools.some((t) => t.name === 'supplement_skip')).toBe(false);
  });

  test('supplement_skip is present when supplementMode is true', () => {
    const tools = getToolDefinitions(undefined, undefined, true);
    const tool = tools.find((t) => t.name === 'supplement_skip');
    expect(tool).toBeDefined();
    expect(tool?.input_schema?.properties).toEqual({});
  });

  test('supplement_skip does not appear in normal text mode', () => {
    const tools = getToolDefinitions('text', undefined, false);
    expect(tools.some((t) => t.name === 'supplement_skip')).toBe(false);
  });
});

const ASSISTANT_TOOLS = [
  'claude_chat',
  'claude_new_chat',
  'claude_list_chats',
  'claude_open_chat',
  'claude_list_projects',
  'claude_artifact',
  'bash_execute',
  'playwright_action',
  'applescript_run',
];

describe('UserCapabilities gating', () => {
  test('assistant tools hidden when both false', () => {
    const names = getToolDefinitions('text', { assistantEnabled: false, agentConnected: false }).map((t) => t.name);
    for (const tool of ASSISTANT_TOOLS) expect(names).not.toContain(tool);
  });

  test('assistant tools hidden when only assistantEnabled=true', () => {
    const names = getToolDefinitions('text', { assistantEnabled: true, agentConnected: false }).map((t) => t.name);
    for (const tool of ASSISTANT_TOOLS) expect(names).not.toContain(tool);
  });

  test('assistant tools hidden when only agentConnected=true', () => {
    const names = getToolDefinitions('text', { assistantEnabled: false, agentConnected: true }).map((t) => t.name);
    for (const tool of ASSISTANT_TOOLS) expect(names).not.toContain(tool);
  });

  test('assistant tools visible when both true', () => {
    const names = getToolDefinitions('text', { assistantEnabled: true, agentConnected: true }).map((t) => t.name);
    for (const tool of ASSISTANT_TOOLS) expect(names).toContain(tool);
  });

  test('no caps passed → assistant tools hidden', () => {
    const names = getToolDefinitions('text').map((t) => t.name);
    for (const tool of ASSISTANT_TOOLS) expect(names).not.toContain(tool);
  });
});
