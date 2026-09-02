import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import type OpenAI from 'openai';
import { migrations } from '../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../../src/database/repositories/event-reminder.repository.ts';
import { HolidayRepository } from '../../../src/database/repositories/holiday.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { buildSystemPrompt } from '../../../src/services/ai/system-prompt.ts';
import { estimateTokens } from '../../../src/services/ai/token-estimate.ts';
import { getToolDefinitions } from '../../../src/services/ai/tools.ts';
import type { AgentContext } from '../../../src/services/ai/types.ts';
import { ConversationLogger } from '../../../src/services/conversation-logger.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../src/services/holiday/holiday-service.ts';

/**
 * The whole tool catalog is re-sent on every round of every message, so its size
 * is an operational limit, not a style preference. These budgets sit just above
 * the current sizes — they exist to catch a tool being added back at its full
 * verbose length, not to force further shrinking.
 *
 * The token budgets are in `estimateTokens` units, which are NOT any provider's
 * tokenizer: for this mix of JSON and Cyrillic the estimator reads high. The real
 * number, from Groq's own accounting on 2026-09-01, is 9 723 tokens for the
 * catalog plus the system prompt and one user turn, down from 11 977. Read the
 * budgets as "no bigger than today", never as "fits in provider X" — Groq's tier
 * caps a request at 8 000 tokens per minute, which even the reduced request does
 * not fit, and no budget here changes that.
 */
const TOOL_CATALOG_CHAR_BUDGET = 36_000;
const TOOL_CATALOG_TOKEN_BUDGET = 10_500;
/**
 * The catalog is the largest part of a request but not the whole of it: the
 * system prompt travels with it every time. Guarding only the catalog would let
 * the prompt grow back exactly what the catalog gave up, so the request as a
 * whole gets a budget too — one per shape, because they legitimately differ. A
 * group carries its consensus rules, computer access adds nine tools and their
 * instructions, and budgeting only the smallest shape would leave the largest
 * real requests free to grow.
 */
const FULL_REQUEST_TOKEN_BUDGETS = {
  direct: 15_000,
  group: 17_300,
  supplement: 15_200,
  computerAccess: 15_800,
  liveCall: 14_500,
} as const;
/**
 * Turning on computer access appends nine more tools, so that catalog is allowed
 * to be larger — but only by those nine, not by unbounded description growth.
 */
const ASSISTANT_CATALOG_CHAR_BUDGET = 38_500;

function names(tools: OpenAI.ChatCompletionTool[]): string[] {
  return tools.filter((t) => t.type === 'function').map((t) => t.function.name);
}

function catalogJson(tools: OpenAI.ChatCompletionTool[]): string {
  return JSON.stringify(tools);
}

/** A context shaped like a real one-to-one chat, on an empty calendar. */
function makeContext(overrides: Partial<AgentContext> = {}): AgentContext {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  const userRepo = new UserRepository(db);
  const user = userRepo.create({
    telegram_id: 123,
    username: 'testuser',
    first_name: 'Test',
    timezone: 'Europe/Kyiv',
    language: 'en',
  });
  const chatHistory = new ChatHistoryRepository(db);
  return {
    user,
    chatId: 123,
    messageText: 'Завтра 12:30 английский',
    isGroup: false,
    eventService: new EventService({ eventRepo: new EventRepository(db) }),
    holidayService: new HolidayService(new HolidayRepository(db)),
    chatHistory,
    userRepo,
    eventReminderRepo: new EventReminderRepository(db),
    conversationLogger: new ConversationLogger(chatHistory),
    ...overrides,
  };
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

  // A real request is the prompt and the catalog together, and they trade against
  // each other: text moved out of one can reappear in the other with both
  // per-part budgets still green.
  test.each([
    ['a direct message', () => makeContext(), () => getToolDefinitions('text'), FULL_REQUEST_TOKEN_BUDGETS.direct],
    [
      'a group chat',
      () => makeContext({ isGroup: true, groupChatId: -100, groupTitle: 'Family' }),
      () => getToolDefinitions('text'),
      FULL_REQUEST_TOKEN_BUDGETS.group,
    ],
    [
      'a supplement turn',
      () => makeContext({ supplementMode: true }),
      () => getToolDefinitions('text', undefined, true),
      FULL_REQUEST_TOKEN_BUDGETS.supplement,
    ],
    [
      'computer access',
      () => makeContext(),
      () => getToolDefinitions('text', { assistantEnabled: true }),
      FULL_REQUEST_TOKEN_BUDGETS.computerAccess,
    ],
    [
      'a live call',
      () => makeContext({ inputMode: 'live_call' }),
      () => getToolDefinitions('live_call'),
      FULL_REQUEST_TOKEN_BUDGETS.liveCall,
    ],
  ])('a whole request stays within its token budget: %s', (_name, context, catalog, budget) => {
    const ctx = context();
    const tools = catalog();
    const caps = { assistantEnabled: names(tools).includes('bash_execute') };
    const request = buildSystemPrompt(ctx, caps) + catalogJson(tools) + ctx.messageText;
    expect(estimateTokens(request)).toBeLessThanOrEqual(budget);
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

  test('the computer-access catalog stays within its own budget', () => {
    const chars = catalogJson(getToolDefinitions('text', { assistantEnabled: true })).length;
    expect(chars).toBeLessThanOrEqual(ASSISTANT_CATALOG_CHAR_BUDGET);
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
