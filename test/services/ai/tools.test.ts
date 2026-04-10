import { describe, expect, test } from 'bun:test';
import type OpenAI from 'openai';
import { getToolDefinitions } from '../../../src/services/ai/tools.ts';

/**
 * Tools are exposed through getToolDefinitions() as OpenAI.ChatCompletionTool[].
 * These helpers narrow to function-shaped tools (which is all we emit) and give
 * tests a concise way to inspect name / description / parameters without type casts.
 */
function fnTool(t: OpenAI.ChatCompletionTool): OpenAI.ChatCompletionFunctionTool {
  if (t.type !== 'function') throw new Error(`expected function tool, got ${t.type}`);
  return t;
}

function findTool(tools: OpenAI.ChatCompletionTool[], name: string): OpenAI.ChatCompletionFunctionTool | undefined {
  const match = tools.find((t) => t.type === 'function' && t.function.name === name);
  return match ? fnTool(match) : undefined;
}

function getParamsRequired(t: OpenAI.ChatCompletionFunctionTool): string[] {
  const params = t.function.parameters as { required?: string[] } | undefined;
  return params?.required ?? [];
}

const allTools = getToolDefinitions('text');

describe('toolDefinitions', () => {
  test('includes calculate tool with required expression', () => {
    const tool = findTool(allTools, 'calculate');
    expect(tool).toBeDefined();
    expect(getParamsRequired(tool!)).toContain('expression');
  });

  test('every tool has type=function with name, description, parameters', () => {
    for (const tool of allTools) {
      expect(tool.type).toBe('function');
      const fn = fnTool(tool);
      expect(typeof fn.function.name).toBe('string');
      expect(typeof fn.function.description).toBe('string');
      expect(fn.function.parameters).toBeDefined();
      expect((fn.function.parameters as { type?: string }).type).toBe('object');
    }
  });

  test('tool names are unique', () => {
    const names = allTools.filter((t) => t.type === 'function').map((t) => fnTool(t).function.name);
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
      expect(findTool(allTools, name)).toBeDefined();
    });
  }

  test('create_event requires title and start_at', () => {
    const tool = findTool(allTools, 'create_event')!;
    const required = getParamsRequired(tool);
    expect(required).toContain('title');
    expect(required).toContain('start_at');
  });

  test('update_event requires event_id', () => {
    const tool = findTool(allTools, 'update_event')!;
    expect(getParamsRequired(tool)).toContain('event_id');
  });

  test('delete_event requires event_id', () => {
    const tool = findTool(allTools, 'delete_event')!;
    expect(getParamsRequired(tool)).toContain('event_id');
  });
});

describe('getToolDefinitions supplement_skip', () => {
  test('supplement_skip is absent when supplementMode is false', () => {
    const tools = getToolDefinitions(undefined, undefined, false);
    expect(findTool(tools, 'supplement_skip')).toBeUndefined();
  });

  test('supplement_skip is absent when supplementMode is undefined', () => {
    const tools = getToolDefinitions();
    expect(findTool(tools, 'supplement_skip')).toBeUndefined();
  });

  test('supplement_skip is present when supplementMode is true', () => {
    const tools = getToolDefinitions(undefined, undefined, true);
    const tool = findTool(tools, 'supplement_skip');
    expect(tool).toBeDefined();
    expect((tool!.function.parameters as { properties?: unknown }).properties).toEqual({});
  });

  test('supplement_skip does not appear in normal text mode', () => {
    const tools = getToolDefinitions('text', undefined, false);
    expect(findTool(tools, 'supplement_skip')).toBeUndefined();
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

function toolNames(tools: OpenAI.ChatCompletionTool[]): string[] {
  return tools.filter((t) => t.type === 'function').map((t) => fnTool(t).function.name);
}

describe('UserCapabilities gating', () => {
  test('assistant tools hidden when assistantEnabled=false', () => {
    const names = toolNames(getToolDefinitions('text', { assistantEnabled: false }));
    for (const tool of ASSISTANT_TOOLS) expect(names).not.toContain(tool);
  });

  test('assistant tools visible when assistantEnabled=true', () => {
    const names = toolNames(getToolDefinitions('text', { assistantEnabled: true }));
    for (const tool of ASSISTANT_TOOLS) expect(names).toContain(tool);
  });

  test('no caps passed → assistant tools hidden', () => {
    const names = toolNames(getToolDefinitions('text'));
    for (const tool of ASSISTANT_TOOLS) expect(names).not.toContain(tool);
  });
});
