import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import type OpenAI from 'openai';
import { migrations } from '../../../src/database/migrations.ts';
import { CalendarProposalRepository } from '../../../src/database/repositories/calendar-proposal.repository.ts';
import { ChatHistoryRepository } from '../../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../../src/database/repositories/event-reminder.repository.ts';
import { HolidayRepository } from '../../../src/database/repositories/holiday.repository.ts';
import { SecretaryRepository } from '../../../src/database/repositories/secretary.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import type { EventOccurrence } from '../../../src/database/types.ts';
import {
  assembleSystemPrompt,
  buildSystemPrompt,
  buildSystemPromptParts,
  type SystemPromptParts,
} from '../../../src/services/ai/system-prompt.ts';
import { createToolExposure } from '../../../src/services/ai/tool-exposure.ts';
import { getToolDefinitions } from '../../../src/services/ai/tools.ts';
import type { AgentContext } from '../../../src/services/ai/types.ts';
import { ConversationLogger } from '../../../src/services/conversation-logger.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../src/services/holiday/holiday-service.ts';
import { commonPrefixLength } from '../../helpers/common-prefix.ts';

/**
 * Providers cache a request by its leading bytes (z.ai's implicit cache, Anthropic's
 * cache_control breakpoints). Everything up to the first byte that differs between two
 * requests is what a second request can reuse, so a per-request value early in the
 * request (the clock used to sit on the second line of the system prompt) throws the
 * whole static remainder away. These tests build real requests for two unlike users at
 * two unlike moments and measure how much of the request is byte-identical.
 */

function createTestDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

interface Scenario {
  ctx: AgentContext;
  /** Values that belong to this user and must never reach the shared prefix; the prompt does show them. */
  shown: string[];
  /** Identifiers that may or may not be rendered but must never reach the shared prefix. */
  hidden: string[];
}

describe('prompt prefix stability', () => {
  let db: Database;
  let userRepo: UserRepository;
  let base: Omit<AgentContext, 'user' | 'chatId'>;

  beforeEach(() => {
    db = createTestDb();
    userRepo = new UserRepository(db);
    const chatHistory = new ChatHistoryRepository(db);
    base = {
      messageText: 'hello',
      isGroup: false,
      eventService: new EventService({ eventRepo: new EventRepository(db) }),
      holidayService: new HolidayService(new HolidayRepository(db)),
      chatHistory,
      conversationLogger: new ConversationLogger(chatHistory),
      userRepo,
      eventReminderRepo: new EventReminderRepository(db),
    };
  });

  afterEach(() => {
    setSystemTime();
  });

  function occurrences(count: number): EventOccurrence[] {
    return Array.from({ length: count }, (_, index) => ({
      event: { title: `Standup ${index}` },
      occurrence_start: new Date(Date.UTC(2026, 9, 26, 8 + (index % 8), 0)).toISOString(),
    })) as unknown as EventOccurrence[];
  }

  /** Two users that differ in every per-request field the prompt carries. */
  function scenarios(): [Scenario, Scenario] {
    const alice = userRepo.create({
      telegram_id: 111_222_333,
      username: 'alice_cal',
      first_name: 'Alice',
      timezone: 'Europe/Kyiv',
      language: 'en',
    });
    const boris = userRepo.create({
      telegram_id: 444_555_666,
      username: 'boris_cal',
      first_name: 'Борис',
      timezone: 'Pacific/Auckland',
      language: 'ru',
    });
    userRepo.update(boris.telegram_id, { default_event_duration_minutes: 45, city: 'Окленд' });
    return [
      {
        ctx: { ...base, user: alice, chatId: alice.telegram_id, botUsername: 'cal_bot' },
        shown: ['Europe/Kyiv', 'Alice'],
        hidden: ['alice_cal', '111222333'],
      },
      {
        ctx: {
          ...base,
          user: userRepo.findByTelegramId(boris.telegram_id)!,
          chatId: boris.telegram_id,
          botUsername: 'cal_bot',
          recentEventsWindow: occurrences(8),
          secretary: {
            secretaryRepo: new SecretaryRepository(db),
            secretaryForLine: '@carol_pm (read+write)',
            calendarProposalRepo: new CalendarProposalRepository(db),
          },
        },
        shown: ['Pacific/Auckland', 'Борис', 'Окленд', 'Standup 3', '@carol_pm'],
        hidden: ['boris_cal', '444555666'],
      },
    ];
  }

  /** What a provider receives up to and including the system prompt: tools first, then the prompt. */
  function requestHead(ctx: AgentContext, prompt: string): string {
    return `${JSON.stringify(getToolDefinitions(ctx.inputMode, ctx.supplementMode))}\n${prompt}`;
  }

  function build(ctx: AgentContext, at: string): { parts: SystemPromptParts; request: string } {
    setSystemTime(new Date(at));
    const parts = buildSystemPromptParts(ctx);
    return { parts, request: requestHead(ctx, assembleSystemPrompt(parts)) };
  }

  test('two different users at two different times share the whole static part byte for byte', () => {
    const [alice, boris] = scenarios();
    const a = build(alice.ctx, '2026-10-25T09:07:00Z');
    const b = build(boris.ctx, '2026-11-02T22:41:00Z');

    expect(a.parts.stable.length).toBeGreaterThan(8_000);
    expect(a.parts.stable).toBe(b.parts.stable);
    expect(a.parts.modeRules).toBe(b.parts.modeRules);

    // A DM has no mode rules; the static head is then the tools and the stable text alone.
    const staticHead = requestHead(alice.ctx, a.parts.stable);
    expect(commonPrefixLength(a.request, b.request)).toBeGreaterThanOrEqual(staticHead.length);
  });

  test('no per-user or per-moment value appears before the dynamic section', () => {
    const [alice, boris] = scenarios();
    for (const [scenario, at] of [
      [alice, '2026-10-25T09:07:00Z'],
      [boris, '2026-11-02T22:41:00Z'],
    ] as const) {
      const { parts } = build(scenario.ctx, at);
      const staticText = `${parts.stable}\n${parts.modeRules}`;
      const local = new Intl.DateTimeFormat('en-CA', {
        timeZone: scenario.ctx.user.timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date(at));
      // The clock line, the weekday list and the dated example all carry the local date.
      for (const value of [...scenario.shown, local, 'Current local time:']) {
        expect(staticText).not.toContain(value);
        expect(parts.dynamic).toContain(value);
      }
      for (const value of scenario.hidden) expect(staticText).not.toContain(value);
    }
  });

  test('the first request-specific token comes after the static part', () => {
    const [alice] = scenarios();
    const { parts } = build(alice.ctx, '2026-10-25T09:07:00Z');
    const prompt = assembleSystemPrompt(parts);
    const firstVolatile = Math.min(
      ...['Alice', 'Europe/Kyiv', 'Current local time:'].map((value) => prompt.indexOf(value)),
    );
    expect(firstVolatile).toBeGreaterThanOrEqual(parts.stable.length + parts.modeRules.length);
    expect(firstVolatile / prompt.length).toBeGreaterThan(0.8);
  });

  test('group mode appends its own static rules after the shared part and keeps the group title out of them', () => {
    const [alice] = scenarios();
    const dm = build(alice.ctx, '2026-10-25T09:07:00Z');
    const group = build(
      { ...alice.ctx, isGroup: true, groupTitle: 'Friday Climbers', groupChatId: -100_777 },
      '2026-10-25T09:07:00Z',
    );
    expect(group.parts.stable).toBe(dm.parts.stable);
    expect(group.parts.modeRules).not.toBe(dm.parts.modeRules);
    expect(group.parts.modeRules).toContain('propose_calendar_change');
    for (const value of ['Friday Climbers', '-100777']) {
      expect(group.parts.modeRules).not.toContain(value);
      expect(group.parts.dynamic).toContain(value);
    }
    // The static group rules lead with the shared bytes, so a group request still reuses the DM cache entry.
    expect(commonPrefixLength(dm.request, group.request)).toBeGreaterThanOrEqual(
      requestHead(alice.ctx, dm.parts.stable).length,
    );
  });

  test('two users in the same group share the whole mode-rules text byte for byte', () => {
    const [alice, boris] = scenarios();
    const inGroup = (scenario: Scenario) => ({
      ...scenario.ctx,
      isGroup: true,
      groupTitle: 'Friday Climbers',
      groupChatId: -100_777,
    });
    const a = build(inGroup(alice), '2026-10-25T09:07:00Z');
    const b = build(inGroup(boris), '2026-11-02T22:41:00Z');
    expect(a.parts.modeRules.length).toBeGreaterThan(3_000);
    expect(a.parts.modeRules).toBe(b.parts.modeRules);
    expect(a.parts.stable).toBe(b.parts.stable);
    for (const value of [...alice.shown, ...alice.hidden, ...boris.shown, ...boris.hidden]) {
      expect(a.parts.modeRules).not.toContain(value);
    }
  });

  test.each([
    'voice_message',
    'live_call',
  ] as const)('two users in %s mode share the whole mode-rules text byte for byte', (inputMode) => {
    const [alice, boris] = scenarios();
    const a = build({ ...alice.ctx, inputMode }, '2026-10-25T09:07:00Z');
    const b = build({ ...boris.ctx, inputMode }, '2026-11-02T22:41:00Z');
    expect(a.parts.modeRules.length).toBeGreaterThan(200);
    expect(a.parts.modeRules).toBe(b.parts.modeRules);
    expect(a.parts.stable).toBe(b.parts.stable);
    for (const value of [...alice.shown, ...alice.hidden, ...boris.shown, ...boris.hidden]) {
      expect(a.parts.modeRules).not.toContain(value);
    }
  });

  test('the same user a minute later changes only the dynamic section', () => {
    const [alice] = scenarios();
    const first = build(alice.ctx, '2026-10-25T09:07:00Z');
    const second = build(alice.ctx, '2026-10-25T09:08:00Z');
    expect(second.parts.stable).toBe(first.parts.stable);
    expect(second.parts.modeRules).toBe(first.parts.modeRules);
    expect(second.parts.dynamic).not.toBe(first.parts.dynamic);
  });

  test('the lazy tool index is static, so it sits before the dynamic section', () => {
    const [alice] = scenarios();
    const { parts } = build(alice.ctx, '2026-10-25T09:07:00Z');
    const exposure = createToolExposure(getToolDefinitions('text'));
    const prompt = assembleSystemPrompt(parts, exposure.prompt);
    expect(prompt.indexOf(exposure.prompt)).toBeLessThan(prompt.indexOf(parts.dynamic));
    expect(prompt.startsWith(parts.stable)).toBe(true);
  });

  test('the assembled prompt keeps every section the one-string prompt had', () => {
    const [, boris] = scenarios();
    setSystemTime(new Date('2026-10-25T09:07:00Z'));
    const prompt = buildSystemPrompt(boris.ctx);
    for (const heading of [
      '## User Info',
      '## Context',
      '## Rules\n',
      '## Rules for This User',
      '## Proactive Behavior',
      '## Shared Events',
    ]) {
      expect(prompt).toContain(heading);
    }
    expect(prompt).toContain('Secretary Access');
    expect(prompt).toBe(assembleSystemPrompt(buildSystemPromptParts(boris.ctx)));
  });
});

describe('tool catalog order', () => {
  const names = (tools: OpenAI.ChatCompletionTool[]) =>
    tools.flatMap((tool) => (tool.type === 'function' ? [tool.function.name] : []));

  test('is deterministic: the serialized catalog is identical call after call', () => {
    expect(JSON.stringify(getToolDefinitions('text'))).toBe(JSON.stringify(getToolDefinitions('text')));
  });

  test('offering make_call inserts it without reordering any other tool', () => {
    const without = names(getToolDefinitions('text', false, { calls: false }));
    const withCalls = names(getToolDefinitions('text', false, { calls: true }));
    expect(withCalls.filter((name) => name !== 'make_call')).toEqual(without);
  });

  test('supplement mode only drops end_conversation and appends its own tool at the end', () => {
    const plain = names(getToolDefinitions('text'));
    const supplement = names(getToolDefinitions('text', true));
    expect(supplement.slice(0, -1)).toEqual(plain.filter((name) => name !== 'end_conversation'));
    expect(supplement.at(-1)).toBe('supplement_skip');
  });
});
