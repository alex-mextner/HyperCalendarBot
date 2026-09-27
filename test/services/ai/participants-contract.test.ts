import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import type OpenAI from 'openai';
import { migrations } from '../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../../src/database/repositories/event-reminder.repository.ts';
import { HolidayRepository } from '../../../src/database/repositories/holiday.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { buildSystemPrompt } from '../../../src/services/ai/system-prompt.ts';
import { executeTool } from '../../../src/services/ai/tool-executor.ts';
import { createToolExposure, DISCOVERY_TOOL } from '../../../src/services/ai/tool-exposure.ts';
import { toolSchemas } from '../../../src/services/ai/tool-schemas.ts';
import { getToolDefinitions } from '../../../src/services/ai/tools.ts';
import type { AgentContext } from '../../../src/services/ai/types.ts';
import { ConversationLogger } from '../../../src/services/conversation-logger.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../src/services/holiday/holiday-service.ts';
import { jsonCodec } from '../../../src/utils/json-codec.ts';

// Incident 2026-09-27: "встреча в 15 с Леной, Алексом, Аней и мной" was created with the
// four names (the inviter included) as the description, and the inviter was later told he
// "already participates because his name is in the description". The prompt and the tool
// schema must say that people are invited, never described, and that attendance comes from
// invitation data. The prompt's example call is an executable fixture, run below.

const USER_ID = 202;
// The executor throttles identical write calls per chat for 5 s across tests; a fresh chat
// per test keeps every run of the same example a real execution.
let nextChatId = 1_000;
const ZONES = ['UTC', 'Europe/Belgrade', 'America/New_York', 'Asia/Kolkata'];
const MODES = ['full', 'lazy'] as const;

interface StoredEvent {
  title: string;
  start_at: string;
  description: string | null;
}

function makeContext(timezone: string): { ctx: AgentContext; db: Database } {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  const userRepo = new UserRepository(db);
  const user = userRepo.create({ telegram_id: USER_ID, first_name: 'Owner', timezone, language: 'ru' });
  const chatHistory = new ChatHistoryRepository(db);
  const ctx: AgentContext = {
    user,
    chatId: nextChatId++,
    messageText: 'добавь встречу в 15 с Леной и мной',
    isGroup: false,
    eventService: new EventService({ eventRepo: new EventRepository(db) }),
    holidayService: new HolidayService(new HolidayRepository(db)),
    chatHistory,
    userRepo,
    eventReminderRepo: new EventReminderRepository(db),
    conversationLogger: new ConversationLogger(chatHistory),
  };
  return { ctx, db };
}

/** The prompt the model actually receives in each tool-schema mode (see CalendarBotAgent.run). */
function promptFor(ctx: AgentContext, mode: (typeof MODES)[number]): string {
  const base = buildSystemPrompt(ctx);
  return mode === 'lazy' ? `${base}\n\n${createToolExposure(getToolDefinitions('text')).prompt}` : base;
}

function createEventExamples(prompt: string): string[] {
  return [...prompt.matchAll(/create_event\((\{[^\n]*?\})\)/g)].map((match) => match[1] ?? '');
}

function schemaProperty(tools: OpenAI.ChatCompletionTool[], tool: string, property: string): string {
  const found = tools.find((t) => t.type === 'function' && t.function.name === tool);
  if (!found || found.type !== 'function') throw new Error(`${tool} missing from catalog`);
  const properties: unknown = found.function.parameters?.properties;
  const prop: unknown = properties && typeof properties === 'object' ? Reflect.get(properties, property) : undefined;
  const description: unknown = prop && typeof prop === 'object' ? Reflect.get(prop, 'description') : undefined;
  return typeof description === 'string' ? description : '';
}

afterEach(() => {
  setSystemTime();
});

describe('participants are invited, never written into the description', () => {
  for (const mode of MODES) {
    for (const timezone of ZONES) {
      test(`${mode} mode, ${timezone}: the prompt's create_event example runs through the real schema and handler`, async () => {
        // Before the example date, so the real handler accepts it rather than PAST_EVENT.
        setSystemTime(new Date('2026-03-01T09:00:00Z'));
        const { ctx, db } = makeContext(timezone);
        const prompt = promptFor(ctx, mode);
        const examples = createEventExamples(prompt);
        expect(examples.length).toBeGreaterThan(0);

        for (const raw of examples) {
          const parsed = jsonCodec(toolSchemas.create_event).safeParse(raw);
          expect(parsed.success, raw).toBe(true);
          const args = parsed.data;
          if (!args || typeof args !== 'object') throw new Error(`unparsable example ${raw}`);
          expect(Object.keys(args)).not.toContain('description');

          // The example obeys the prompt's own local → UTC rule for this zone and date (DST included).
          const converted = await executeTool(ctx, 'calculate', { expression: `2026-03-15 15:00 ${timezone} to UTC` });
          expect(Reflect.get(args, 'start_at')).toBe(converted.output);

          if (mode === 'lazy') {
            const exposure = createToolExposure(getToolDefinitions('text'));
            expect(exposure.intercept('create_event', args, exposure.snapshot())?.success).toBe(false);
            expect(exposure.intercept(DISCOVERY_TOOL, { tools: ['create_event'] }, exposure.snapshot())?.success).toBe(
              true,
            );
            expect(exposure.intercept('create_event', args, exposure.snapshot())).toBeUndefined();
          }

          const result = await executeTool(ctx, 'create_event', args);
          expect(result.success, result.error).toBe(true);
          expect(result.disposition).toBe('executed');
        }

        const stored = db
          .query<StoredEvent, [number]>('SELECT title, start_at, description FROM events WHERE user_id = ?')
          .all(USER_ID);
        expect(stored.length).toBe(examples.length);
        for (const event of stored) {
          expect(event.description).toBeNull();
          expect(event.title).not.toContain('мной');
        }
      });
    }

    test(`${mode} mode: the prompt forbids people in description and grounds attendance in invitations`, () => {
      const { ctx } = makeContext('Europe/Belgrade');
      const prompt = promptFor(ctx, mode);
      expect(prompt).toContain('never write people into description');
      expect(prompt).toContain('the organizer: never invite, pick or list them');
      expect(prompt).toContain('only from get_invitation_status, never from description');
    });
  }

  test('the create_event and update_event schemas carry the rule in every tool set', () => {
    for (const tools of [
      getToolDefinitions('text'),
      getToolDefinitions('live_call'),
      getToolDefinitions('text', true),
    ]) {
      expect(schemaProperty(tools, 'create_event', 'description')).toContain('never participant names');
      expect(schemaProperty(tools, 'update_event', 'description')).toContain('never participant names');
    }
  });

  test('a rejected description retries with the rule in its schema excerpt', async () => {
    setSystemTime(new Date('2026-03-01T09:00:00Z'));
    const { ctx } = makeContext('UTC');
    const result = await executeTool(ctx, 'create_event', {
      title: 'Встреча',
      start_at: '2026-03-15T15:00:00.000Z',
      description: ['Лена', 'Алекс'],
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('never participant names');
  });

  test('the lazy index names get_invitation_status as the source of who takes part', () => {
    const exposure = createToolExposure(getToolDefinitions('text'));
    expect(exposure.prompt).toMatch(/get_invitation_status: [^\n]*only source for who takes part/);
  });
});
