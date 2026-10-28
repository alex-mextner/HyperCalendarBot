> Part 1 of 4 of [AI Agent Implementation Plan](../2026-03-13-ai-agent.md) — next: [02-tasks-7-8.md](02-tasks-7-8.md)

## Chunk 1: Data Layer

### Task 1: Migration 005 — `chat_history` table

**Files:**

- Modify: `src/database/migrations.ts`
- Test: `test/database/schema.test.ts`

- [ ] **Step 1: Write failing test for migration 005**

Add to `test/database/schema.test.ts`:

```typescript
test('migration 005 creates chat_history table', () => {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chat_history'")
    .all() as { name: string }[];
  expect(tables.length).toBe(1);

  const columns = db.prepare('PRAGMA table_info(chat_history)').all() as { name: string }[];
  const colNames = columns.map((c) => c.name);
  expect(colNames).toContain('id');
  expect(colNames).toContain('user_id');
  expect(colNames).toContain('role');
  expect(colNames).toContain('content');
  expect(colNames).toContain('created_at');
});
```

Run: `bun test test/database/schema.test.ts`
Expected: FAIL — table `chat_history` does not exist.

- [ ] **Step 2: Add migration 005 to migrations.ts**

Add to the `migrations` array in `src/database/migrations.ts`:

```typescript
{
  name: '005_create_chat_history',
  up: (db) => {
    db.exec(`
      CREATE TABLE chat_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
      );
      CREATE INDEX idx_chat_history_user ON chat_history(user_id, created_at);
    `);
  },
},
```

Run: `bun test test/database/schema.test.ts`
Expected: PASS

---

### Task 2: ChatHistoryRepository

**Files:**

- Create: `src/database/repositories/chat-history.repository.ts`
- Modify: `src/database/types.ts`
- Test: `test/database/repositories/chat-history.repository.test.ts`

- [ ] **Step 1: Add ChatHistoryMessage type to types.ts**

Add to `src/database/types.ts`:

```typescript
export interface ChatHistoryMessage {
  id: number;
  user_id: number;
  role: 'user' | 'assistant' | 'tool';
  content: string; // plain text for user, JSON content blocks for assistant/tool
  created_at: string;
}
```

- [ ] **Step 2: Write failing tests for ChatHistoryRepository**

Create `test/database/repositories/chat-history.repository.test.ts`:

```typescript
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../src/database/repositories/chat-history.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

describe('ChatHistoryRepository', () => {
  let db: Database;
  let repo: ChatHistoryRepository;
  const USER_ID = 123;

  beforeEach(() => {
    db = createTestDb();
    new UserRepository(db).create({ telegram_id: USER_ID });
    repo = new ChatHistoryRepository(db);
  });

  test('save inserts a user text message', () => {
    repo.save(USER_ID, 'user', 'Hello');
    const messages = repo.getRecent(USER_ID);
    expect(messages.length).toBe(1);
    expect(messages[0]!.role).toBe('user');
    expect(messages[0]!.content).toBe('Hello');
  });

  test('save stores assistant content blocks as JSON', () => {
    const blocks = JSON.stringify([
      { type: 'text', text: 'Let me check...' },
      { type: 'tool_use', id: 'call_1', name: 'get_events', input: { start_date: '2026-03-15' } },
    ]);
    repo.save(USER_ID, 'assistant', blocks);
    const messages = repo.getRecent(USER_ID);
    expect(messages[0]!.role).toBe('assistant');
    const parsed = JSON.parse(messages[0]!.content);
    expect(parsed).toBeArray();
    expect(parsed[1].name).toBe('get_events');
  });

  test('save stores tool_result messages', () => {
    const toolResult = JSON.stringify([
      { type: 'tool_result', tool_use_id: 'call_1', content: '{"events":[]}' },
    ]);
    repo.save(USER_ID, 'tool', toolResult);
    const messages = repo.getRecent(USER_ID);
    expect(messages[0]!.role).toBe('tool');
  });

  test('saveInteraction stores full multi-round exchange', () => {
    // Simulate: user msg → assistant (text+tool_use) → tool_result → assistant (final text)
    repo.save(USER_ID, 'user', 'What events today?');
    repo.save(USER_ID, 'assistant', JSON.stringify([
      { type: 'text', text: 'Checking...' },
      { type: 'tool_use', id: 'c1', name: 'get_events', input: {} },
    ]));
    repo.save(USER_ID, 'tool', JSON.stringify([
      { type: 'tool_result', tool_use_id: 'c1', content: '[]' },
    ]));
    repo.save(USER_ID, 'assistant', JSON.stringify([
      { type: 'text', text: 'No events today.' },
    ]));
    const messages = repo.getRecent(USER_ID);
    expect(messages.length).toBe(4);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  });

  test('getRecent returns last N messages ordered by created_at', () => {
    repo.save(USER_ID, 'user', 'First');
    repo.save(USER_ID, 'assistant', 'Response 1');
    repo.save(USER_ID, 'user', 'Second');
    repo.save(USER_ID, 'assistant', 'Response 2');

    const messages = repo.getRecent(USER_ID, 3);
    expect(messages.length).toBe(3);
    expect(messages[0]!.content).toBe('Response 1');
    expect(messages[2]!.content).toBe('Response 2');
  });

  test('getRecent defaults to 50 messages', () => {
    for (let i = 0; i < 60; i++) {
      repo.save(USER_ID, 'user', `msg ${i}`);
    }
    const messages = repo.getRecent(USER_ID);
    expect(messages.length).toBe(50);
    // Oldest returned should be msg 10 (60 total, last 50)
    expect(messages[0]!.content).toBe('msg 10');
  });

  test('clear removes all messages for user', () => {
    repo.save(USER_ID, 'user', 'Hello');
    repo.save(USER_ID, 'assistant', 'Hi');
    repo.clear(USER_ID);
    const messages = repo.getRecent(USER_ID);
    expect(messages.length).toBe(0);
  });

  test('messages are isolated per user', () => {
    const OTHER_USER = 456;
    new UserRepository(db).create({ telegram_id: OTHER_USER });

    repo.save(USER_ID, 'user', 'User 1 msg');
    repo.save(OTHER_USER, 'user', 'User 2 msg');

    const msgs1 = repo.getRecent(USER_ID);
    const msgs2 = repo.getRecent(OTHER_USER);
    expect(msgs1.length).toBe(1);
    expect(msgs2.length).toBe(1);
    expect(msgs1[0]!.content).toBe('User 1 msg');
    expect(msgs2[0]!.content).toBe('User 2 msg');
  });
});
```

Run: `bun test test/database/repositories/chat-history.repository.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement ChatHistoryRepository**

Create `src/database/repositories/chat-history.repository.ts`:

```typescript
import type { Database } from 'bun:sqlite';
import type { ChatHistoryMessage } from '../types.ts';

export class ChatHistoryRepository {
  constructor(private db: Database) {}

  save(userId: number, role: 'user' | 'assistant' | 'tool', content: string): void {
    this.db
      .prepare('INSERT INTO chat_history (user_id, role, content) VALUES (?, ?, ?)')
      .run(userId, role, content);
  }

  getRecent(userId: number, limit = 50): ChatHistoryMessage[] {
    return this.db
      .prepare(`
        SELECT * FROM (
          SELECT * FROM chat_history
          WHERE user_id = ?
          ORDER BY created_at DESC, id DESC
          LIMIT ?
        ) sub ORDER BY created_at ASC, id ASC
      `)
      .all(userId, limit) as ChatHistoryMessage[];
  }

  clear(userId: number): void {
    this.db.prepare('DELETE FROM chat_history WHERE user_id = ?').run(userId);
  }
}
```

Run: `bun test test/database/repositories/chat-history.repository.test.ts`
Expected: PASS

---

### Task 3: Wire ChatHistoryRepository into DatabaseService

**Files:**

- Modify: `src/database/index.ts`

- [ ] **Step 1: Add chatHistory to DatabaseService**

In `src/database/index.ts`, add the import:

```typescript
import { ChatHistoryRepository } from './repositories/chat-history.repository.ts';
```

Add to the `DatabaseService` class property declarations:

```typescript
readonly chatHistory: ChatHistoryRepository;
```

Add to the constructor, after `this.holidays = new HolidayRepository(this.db);`:

```typescript
this.chatHistory = new ChatHistoryRepository(this.db);
```

Run: `bun test test/database/schema.test.ts && bun test test/database/repositories/chat-history.repository.test.ts`
Expected: PASS

---

## Chunk 2: Types, System Prompt, and Tool Definitions

### Task 4: AI Types

**Files:**

- Create: `src/services/ai/types.ts`

- [ ] **Step 1: Create AI types**

Create `src/services/ai/types.ts`:

```typescript
import type { ChatHistoryRepository } from '../../database/repositories/chat-history.repository.ts';
import type { ReminderRepository } from '../../database/repositories/reminder.repository.ts';
import type { UserRepository } from '../../database/repositories/user.repository.ts';
import type { User } from '../../database/types.ts';
import type { EventService } from '../event/event-service.ts';
import type { HolidayService } from '../holiday/holiday-service.ts';

export interface AgentContext {
  user: User;
  chatId: number;
  messageText: string;
  eventService: EventService;
  holidayService: HolidayService;
  chatHistory: ChatHistoryRepository;
  userRepo: UserRepository;
  reminderRepo: ReminderRepository;
}

export interface ToolResult {
  success: boolean;
  output?: string;
  error?: string;
}

export interface AgentConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface TelegramSender {
  sendMessage(chatId: number, text: string, parseMode?: string): Promise<{ message_id: number }>;
  editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    parseMode?: string,
  ): Promise<void>;
}
```

No test needed — pure type definitions.

---

### Task 5: System Prompt Builder

**Files:**

- Create: `src/services/ai/system-prompt.ts`
- Test: `test/services/ai/system-prompt.test.ts`

- [ ] **Step 1: Write failing tests for buildSystemPrompt**

Create `test/services/ai/system-prompt.test.ts`:

```typescript
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { HolidayRepository } from '../../../src/database/repositories/holiday.repository.ts';
import { ReminderRepository } from '../../../src/database/repositories/reminder.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../src/services/holiday/holiday-service.ts';
import { buildSystemPrompt } from '../../../src/services/ai/system-prompt.ts';
import type { AgentContext } from '../../../src/services/ai/types.ts';

function createTestDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

describe('buildSystemPrompt', () => {
  let db: Database;
  let ctx: AgentContext;
  const USER_ID = 123;

  beforeEach(() => {
    db = createTestDb();
    const userRepo = new UserRepository(db);
    const eventRepo = new EventRepository(db);
    const reminderRepo = new ReminderRepository(db);
    const chatHistoryRepo = new ChatHistoryRepository(db);
    const holidayRepo = new HolidayRepository(db);
    const user = userRepo.create({
      telegram_id: USER_ID,
      username: 'testuser',
      first_name: 'Test',
      timezone: 'Europe/Kyiv',
      language: 'en',
    });
    const eventService = new EventService(eventRepo, reminderRepo);
    const holidayService = new HolidayService(holidayRepo);
    ctx = {
      user,
      chatId: USER_ID,
      messageText: 'hello',
      eventService,
      holidayService,
      chatHistory: chatHistoryRepo,
      userRepo,
      reminderRepo,
    };
  });

  test('includes user timezone', () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('Europe/Kyiv');
  });

  test('includes user name', () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('Test');
  });

  test('includes user language', () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('en');
  });

  test('includes formatting rules', () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('ISO 8601');
  });

  test('includes today events when they exist', () => {
    const eventRepo = new EventRepository(db);
    const reminderRepo = new ReminderRepository(db);
    const eventService = new EventService(eventRepo, reminderRepo);
    eventService.createEvent({
      user_id: USER_ID,
      title: 'Morning Standup',
      start_at: new Date().toISOString(),
      timezone: 'Europe/Kyiv',
    });
    ctx.eventService = eventService;

    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('Morning Standup');
  });

  test('includes language instruction for ru user', () => {
    const userRepo = new UserRepository(db);
    userRepo.update(USER_ID, { language: 'ru' });
    ctx.user = userRepo.findByTelegramId(USER_ID)!;

    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('Russian');
  });
});
```

Run: `bun test test/services/ai/system-prompt.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 2: Implement buildSystemPrompt**

Create `src/services/ai/system-prompt.ts`:

```typescript
import { TZDate } from '@date-fns/tz';
import { addDays, format, startOfDay } from 'date-fns';
import type { AgentContext } from './types.ts';

function getEventsForPrompt(ctx: AgentContext, date: Date, label: string): string {
  const occurrences = ctx.eventService.getEventsForDay(
    ctx.user.telegram_id,
    date,
    ctx.user.timezone,
  );
  if (occurrences.length === 0) return `${label}: No events.`;

  const lines = occurrences.map((occ) => {
    const start = format(new TZDate(occ.occurrence_start, ctx.user.timezone), 'HH:mm');
    const end = occ.occurrence_end
      ? format(new TZDate(occ.occurrence_end, ctx.user.timezone), 'HH:mm')
      : null;
    const time = end ? `${start}–${end}` : start;
    const loc = occ.event.location ? ` (${occ.event.location})` : '';
    const desc = occ.event.description ? ` — ${occ.event.description}` : '';
    return `  - ${time} ${occ.event.title}${loc}${desc}`;
  });

  return `${label}:\n${lines.join('\n')}`;
}

export function buildSystemPrompt(ctx: AgentContext): string {
  const now = TZDate.tz(ctx.user.timezone);
  const currentDateTime = format(now, 'yyyy-MM-dd HH:mm EEEE');
  const today = startOfDay(now);
  const tomorrow = addDays(today, 1);

  const todayEvents = getEventsForPrompt(ctx, new Date(today.toISOString()), "Today's events");
  const tomorrowEvents = getEventsForPrompt(
    ctx,
    new Date(tomorrow.toISOString()),
    "Tomorrow's events",
  );

  const langInstruction =
    ctx.user.language === 'ru'
      ? 'The user speaks Russian. Always respond in Russian.'
      : 'The user speaks English. Always respond in English.';

  return `You are a calendar assistant for a Telegram bot. You help users manage their schedule.

## User Info
- Name: ${ctx.user.first_name ?? ctx.user.username ?? 'User'}
- Language: ${ctx.user.language}
- Timezone: ${ctx.user.timezone}
- Current date/time: ${currentDateTime}

## ${todayEvents}

## ${tomorrowEvents}

## Rules
- ${langInstruction}
- All dates/times in tool calls must use ISO 8601 UTC format (e.g., "2026-03-15T14:00:00Z").
- Convert user's local times to UTC using their timezone (${ctx.user.timezone}) before passing to tools.
- When displaying times to the user, convert from UTC to their local timezone.
- Be concise. No unnecessary preamble.
- For event creation, always confirm the details before creating.
- Use Telegram-safe formatting: bold with *, italic with _, code with \`.
- Never invent events — only report what tools return.
- If a tool returns an error, explain it to the user clearly.
- When the user asks about free time, use the get_free_slots tool.
- For recurring events, use RRULE format (e.g., "FREQ=WEEKLY;INTERVAL=2").`;
}
```

Run: `bun test test/services/ai/system-prompt.test.ts`
Expected: PASS

---

### Task 6: Tool Definitions (Anthropic Schemas)

**Files:**

- Create: `src/services/ai/tools.ts`
- Test: `test/services/ai/tools.test.ts`

- [ ] **Step 1: Write tests for tool definitions**

Create `test/services/ai/tools.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { toolDefinitions } from '../../../src/services/ai/tools.ts';

describe('toolDefinitions', () => {
  test('exports 10 tool definitions', () => {
    expect(toolDefinitions.length).toBe(10);
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
```

Run: `bun test test/services/ai/tools.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 2: Install @anthropic-ai/sdk**

Run: `bun add @anthropic-ai/sdk`

- [ ] **Step 3: Implement tool definitions**

Create `src/services/ai/tools.ts`:

```typescript
import type Anthropic from '@anthropic-ai/sdk';

type ToolDefinition = Anthropic.Tool;

export const toolDefinitions: ToolDefinition[] = [
  {
    name: 'get_events',
    description: 'Get events for a date range. Returns a list of events with their details.',
    input_schema: {
      type: 'object' as const,
      properties: {
        start_date: {
          type: 'string',
          description: 'Start date in ISO 8601 UTC (e.g., "2026-03-15T00:00:00Z")',
        },
        end_date: {
          type: 'string',
          description: 'End date in ISO 8601 UTC (e.g., "2026-03-15T23:59:59Z")',
        },
      },
      required: ['start_date', 'end_date'],
    },
  },
  {
    name: 'create_event',
    description: 'Create a new calendar event. Returns the created event.',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Event title' },
        start_at: {
          type: 'string',
          description: 'Start time in ISO 8601 UTC (e.g., "2026-03-15T14:00:00Z")',
        },
        end_at: {
          type: 'string',
          description: 'End time in ISO 8601 UTC. Optional.',
        },
        description: { type: 'string', description: 'Event description. Optional.' },
        location: { type: 'string', description: 'Event location. Optional.' },
        all_day: {
          type: 'boolean',
          description: 'Whether this is an all-day event. Optional.',
        },
        recurrence_rule: {
          type: 'string',
          description:
            'RRULE string for recurring events (e.g., "FREQ=WEEKLY;INTERVAL=2"). Optional.',
        },
        reminder_minutes: {
          type: 'array',
          items: { type: 'number' },
          description:
            'Minutes before event to send reminders (e.g., [15, 60]). Optional.',
        },
      },
      required: ['title', 'start_at'],
    },
  },
  {
    name: 'update_event',
    description:
      'Update an existing calendar event. Only pass fields that need to change.',
    input_schema: {
      type: 'object' as const,
      properties: {
        event_id: { type: 'number', description: 'ID of the event to update' },
        title: { type: 'string', description: 'New title. Optional.' },
        start_at: {
          type: 'string',
          description: 'New start time in ISO 8601 UTC. Optional.',
        },
        end_at: {
          type: 'string',
          description: 'New end time in ISO 8601 UTC. Pass null to remove. Optional.',
        },
        description: {
          type: 'string',
          description: 'New description. Pass null to remove. Optional.',
        },
        location: {
          type: 'string',
          description: 'New location. Pass null to remove. Optional.',
        },
        recurrence_rule: {
          type: 'string',
          description:
            'New RRULE string. Pass null to remove recurrence. Optional.',
        },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'delete_event',
    description: 'Delete a calendar event by its ID.',
    input_schema: {
      type: 'object' as const,
      properties: {
        event_id: {
          type: 'number',
          description: 'ID of the event to delete',
        },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'get_free_slots',
    description:
      'Get available free time slots for a specific date. Returns gaps between existing events.',
    input_schema: {
      type: 'object' as const,
      properties: {
        date: {
          type: 'string',
          description: 'Date in ISO 8601 UTC (e.g., "2026-03-15T00:00:00Z")',
        },
      },
      required: ['date'],
    },
  },
  {
    name: 'search_events',
    description: 'Search events by title. Returns matching events.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Search query to match against event titles',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'set_reminder',
    description: 'Set reminder(s) for an event. Replaces existing reminders.',
    input_schema: {
      type: 'object' as const,
      properties: {
        event_id: {
          type: 'number',
          description: 'ID of the event',
        },
        minutes_before: {
          type: 'array',
          items: { type: 'number' },
          description:
            'Array of minutes before event to send reminders (e.g., [15, 60])',
        },
      },
      required: ['event_id', 'minutes_before'],
    },
  },
  {
    name: 'get_holidays',
    description:
      "Get upcoming holidays for the user's subscribed countries.",
    input_schema: {
      type: 'object' as const,
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of holidays to return. Default: 10.',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_user_settings',
    description:
      "Get the user's current settings (timezone, language, country).",
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'update_user_settings',
    description:
      'Update user settings. Only pass fields that need to change.',
    input_schema: {
      type: 'object' as const,
      properties: {
        timezone: {
          type: 'string',
          description: 'IANA timezone (e.g., "Europe/Kyiv"). Optional.',
        },
        language: {
          type: 'string',
          enum: ['en', 'ru'],
          description: 'Interface language. Optional.',
        },
      },
      required: [],
    },
  },
];
```

Run: `bun test test/services/ai/tools.test.ts`
Expected: PASS

---

