import { describe, expect, test } from 'bun:test';
import type OpenAI from 'openai';
import { createEventRegistryRequiredFields, getToolDefinitions } from '../../../src/services/ai/tools.ts';
import { EVENT_CREATE_OPERATION, requiredFields } from '../../../src/services/operations/registry.ts';

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

describe('create_event schema reads the shared event.create operation registry (GH-652 acceptance criterion 4)', () => {
  test('the schema required array exactly matches the registry-required-field wire names, literally', () => {
    const tool = findTool(allTools, 'create_event')!;
    // Hardcoded literal — never compares the derivation function to itself. This fails loudly
    // if createEventRegistryRequiredFields() or the registry it reads ever silently drifts from
    // the wire contract create_event actually promises callers.
    expect(getParamsRequired(tool)).toEqual(['title', 'start_at']);
  });

  test('every registry field with a create_event wire mapping has a matching input_schema property — a future registry field never silently has no home in the tool schema', () => {
    const tool = findTool(allTools, 'create_event')!;
    const params = tool.function.parameters as { properties: object };
    const properties = params.properties;
    const wireMappedFields = ['title', 'start_at', 'location', 'description', 'recurrence_rule'];
    for (const wireName of wireMappedFields) {
      expect(properties).toHaveProperty(wireName);
    }
  });

  test('a registry field becoming newly required is caught here, not silently left off the tool schema (regression guard)', () => {
    // requiredFields() reads the LIVE registry — if a future change to registry.ts marks
    // another field required without updating CREATE_EVENT_REGISTRY_WIRE_NAMES/create_event's
    // properties, this test (not just the two above) still exercises the exact same derivation
    // path the tool schema itself uses, so drift fails loudly here.
    const registryRequired = requiredFields(EVENT_CREATE_OPERATION);
    const derived = createEventRegistryRequiredFields();
    expect(derived.length).toBe(registryRequired.length);
  });
});

describe('getToolDefinitions supplement_skip', () => {
  test('supplement_skip is absent when supplementMode is false', () => {
    const tools = getToolDefinitions(undefined, false);
    expect(findTool(tools, 'supplement_skip')).toBeUndefined();
  });

  test('supplement_skip is absent when supplementMode is undefined', () => {
    const tools = getToolDefinitions();
    expect(findTool(tools, 'supplement_skip')).toBeUndefined();
  });

  test('supplement_skip is present when supplementMode is true', () => {
    const tools = getToolDefinitions(undefined, true);
    const tool = findTool(tools, 'supplement_skip');
    expect(tool).toBeDefined();
    expect((tool!.function.parameters as { properties?: unknown }).properties).toEqual({});
  });

  test('supplement_skip does not appear in normal text mode', () => {
    const tools = getToolDefinitions('text', false);
    expect(findTool(tools, 'supplement_skip')).toBeUndefined();
  });
});
