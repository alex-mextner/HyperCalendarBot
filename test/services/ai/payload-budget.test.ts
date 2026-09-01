import { describe, expect, test } from 'bun:test';
import type OpenAI from 'openai';
import { estimateTokens } from '../../../src/services/ai/token-estimate.ts';
import { getToolDefinitions } from '../../../src/services/ai/tools.ts';

/**
 * The whole tool catalog is re-sent on every round of every message, so its size
 * is a hard operational limit, not a style preference: Groq's account tier caps a
 * request at 8 000 tokens per minute, and the catalog is the largest single part
 * of the request. These budgets sit just above the current measured size — they
 * exist to catch a tool being added back at its full verbose length, not to force
 * further shrinking.
 *
 * Measured with Groq's own accounting on 2026-09-01: the 62-tool catalog plus the
 * system prompt and one user turn is 9 723 tokens, down from 11 977.
 */
const TOOL_CATALOG_CHAR_BUDGET = 36_000;
const TOOL_CATALOG_TOKEN_BUDGET = 10_500;

function names(tools: OpenAI.ChatCompletionTool[]): string[] {
  return tools.filter((t) => t.type === 'function').map((t) => t.function.name);
}

function catalogJson(tools: OpenAI.ChatCompletionTool[]): string {
  return JSON.stringify(tools);
}

describe('tool catalog budget', () => {
  test('the default catalog stays within its character budget', () => {
    const chars = catalogJson(getToolDefinitions('text')).length;
    expect(chars).toBeLessThanOrEqual(TOOL_CATALOG_CHAR_BUDGET);
  });

  test('the default catalog stays within its token budget', () => {
    const tokens = estimateTokens(catalogJson(getToolDefinitions('text')));
    expect(tokens).toBeLessThanOrEqual(TOOL_CATALOG_TOKEN_BUDGET);
  });

  test('every other mode stays within the same budget', () => {
    const variants = [
      getToolDefinitions('live_call'),
      getToolDefinitions('text', undefined, true),
      getToolDefinitions('voice_message'),
    ];
    for (const tools of variants) {
      expect(catalogJson(tools).length).toBeLessThanOrEqual(TOOL_CATALOG_CHAR_BUDGET);
    }
  });

  test('no single tool is allowed to grow past 2 000 characters', () => {
    const oversized = getToolDefinitions('text')
      .filter((t) => t.type === 'function')
      .filter((t) => JSON.stringify(t).length > 2_000)
      .map((t) => t.function.name);
    expect(oversized).toEqual([]);
  });
});

describe('per-mode tool availability', () => {
  test('a live call drops what it cannot show and gains the hang-up tool', () => {
    const call = names(getToolDefinitions('live_call'));
    for (const absent of ['render_day_image', 'render_week_image', 'render_month_image', 'pick_users', 'make_call']) {
      expect(call).not.toContain(absent);
    }
    expect(call).toContain('end_call');
    // Everything a caller still needs to actually manage the calendar.
    for (const present of ['create_event', 'get_events', 'update_event', 'delete_event', 'ask_user', 'calculate']) {
      expect(call).toContain(present);
    }
  });

  test('text mode keeps the visual tools and withholds the hang-up tool', () => {
    const text = names(getToolDefinitions('text'));
    for (const present of ['render_day_image', 'render_week_image', 'render_month_image', 'pick_users', 'make_call']) {
      expect(text).toContain(present);
    }
    expect(text).not.toContain('end_call');
  });

  test('supplement mode swaps end_conversation for supplement_skip', () => {
    const supplement = names(getToolDefinitions('text', undefined, true));
    expect(supplement).toContain('supplement_skip');
    expect(supplement).not.toContain('end_conversation');
  });

  test('the computer-control tools appear only when the capability is enabled', () => {
    const off = names(getToolDefinitions('text', { assistantEnabled: false }));
    const on = names(getToolDefinitions('text', { assistantEnabled: true }));
    expect(off).not.toContain('bash_execute');
    expect(on).toContain('bash_execute');
    expect(on.length).toBe(off.length + 9);
  });
});

describe('shared schema fragments', () => {
  /**
   * Tools that read or write a calendar must be able to target a group calendar
   * and a delegated one; compressing descriptions must never drop the fields.
   */
  const CALENDAR_SCOPED_TOOLS = [
    'get_events',
    'create_event',
    'update_event',
    'delete_event',
    'get_free_slots',
    'search_events',
    'set_reminder',
    'get_upcoming',
    'snooze_event',
    'get_event',
    'get_reminders',
    'render_day_image',
    'render_week_image',
    'render_month_image',
  ];

  test('every calendar-scoped tool still accepts scope and owner_id', () => {
    const tools = getToolDefinitions('text').filter((t) => t.type === 'function');
    for (const name of CALENDAR_SCOPED_TOOLS) {
      const tool = tools.find((t) => t.function.name === name);
      expect(tool).toBeDefined();
      const params = tool?.function.parameters as { properties?: { [key: string]: unknown } } | undefined;
      expect(Object.keys(params?.properties ?? {})).toContain('scope');
      expect(Object.keys(params?.properties ?? {})).toContain('owner_id');
    }
  });

  test('scope and owner_id are described identically everywhere they appear', () => {
    const tools = getToolDefinitions('text').filter((t) => t.type === 'function');
    const scopeDescriptions = new Set<string>();
    const ownerDescriptions = new Set<string>();
    for (const tool of tools) {
      const params = tool.function.parameters as
        | { properties?: { scope?: { description?: string }; owner_id?: { description?: string } } }
        | undefined;
      const scope = params?.properties?.scope?.description;
      const owner = params?.properties?.owner_id?.description;
      if (scope) scopeDescriptions.add(scope);
      if (owner) ownerDescriptions.add(owner);
    }
    expect(scopeDescriptions.size).toBe(1);
    expect(ownerDescriptions.size).toBe(1);
  });
});
