> Part 2 of 4 of [AI Agent Implementation Plan](../2026-03-13-ai-agent.md) — previous: [01-tasks-1-6.md](01-tasks-1-6.md) · next: [03-tasks-9-11.md](03-tasks-9-11.md)

## Chunk 3: Tool Handlers

### Task 7: Event Tool Handlers

**Files:**

- Create: `src/services/ai/tool-handlers/events.ts`
- Test: `test/services/ai/tool-handlers/events.test.ts`

- [ ] **Step 1: Write failing tests for event tool handlers**

Create `test/services/ai/tool-handlers/events.test.ts`:

```typescript
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../../../src/database/repositories/event.repository.ts';
import { HolidayRepository } from '../../../../src/database/repositories/holiday.repository.ts';
import { ReminderRepository } from '../../../../src/database/repositories/reminder.repository.ts';
import { UserRepository } from '../../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../../src/database/schema.ts';
import {
  handleCreateEvent,
  handleDeleteEvent,
  handleGetEvents,
  handleSearchEvents,
  handleUpdateEvent,
} from '../../../../src/services/ai/tool-handlers/events.ts';
import type { AgentContext } from '../../../../src/services/ai/types.ts';
import { EventService } from '../../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../../src/services/holiday/holiday-service.ts';

function createTestDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

describe('event tool handlers', () => {
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
    userRepo.create({ telegram_id: USER_ID, timezone: 'UTC' });
    const eventService = new EventService(eventRepo, reminderRepo);
    const holidayService = new HolidayService(holidayRepo);
    ctx = {
      user: userRepo.findByTelegramId(USER_ID)!,
      chatId: USER_ID,
      messageText: '',
      eventService,
      holidayService,
      chatHistory: chatHistoryRepo,
      userRepo,
      reminderRepo,
    };
  });

  describe('handleGetEvents', () => {
    test('returns events in range', () => {
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Test Event',
        start_at: '2026-03-15T10:00:00Z',
        end_at: '2026-03-15T11:00:00Z',
        timezone: 'UTC',
      });
      const result = handleGetEvents(ctx, {
        start_date: '2026-03-15T00:00:00Z',
        end_date: '2026-03-15T23:59:59Z',
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Test Event');
    });

    test('returns message when no events found', () => {
      const result = handleGetEvents(ctx, {
        start_date: '2026-03-15T00:00:00Z',
        end_date: '2026-03-15T23:59:59Z',
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('No events');
    });
  });

  describe('handleCreateEvent', () => {
    test('creates event and returns details', () => {
      const result = handleCreateEvent(ctx, {
        title: 'New Meeting',
        start_at: '2026-03-15T14:00:00Z',
        end_at: '2026-03-15T15:00:00Z',
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('New Meeting');
      expect(result.output).toContain('id');
    });

    test('creates event with description and location', () => {
      const result = handleCreateEvent(ctx, {
        title: 'Lunch',
        start_at: '2026-03-15T12:00:00Z',
        description: 'Team lunch',
        location: 'Cafe',
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Lunch');
    });
  });

  describe('handleUpdateEvent', () => {
    test('updates event title', () => {
      const event = ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Old Title',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
      });
      const result = handleUpdateEvent(ctx, {
        event_id: event.id,
        title: 'New Title',
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('New Title');
    });

    test('returns error for non-existent event', () => {
      const result = handleUpdateEvent(ctx, {
        event_id: 9999,
        title: 'Whatever',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('handleDeleteEvent', () => {
    test('deletes event', () => {
      const event = ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'To Delete',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
      });
      const result = handleDeleteEvent(ctx, { event_id: event.id });
      expect(result.success).toBe(true);
    });

    test('returns error for non-existent event', () => {
      const result = handleDeleteEvent(ctx, { event_id: 9999 });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('handleSearchEvents', () => {
    test('finds events by title', () => {
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Team Standup',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
      });
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Lunch Break',
        start_at: '2026-03-15T12:00:00Z',
        timezone: 'UTC',
      });
      const result = handleSearchEvents(ctx, { query: 'Standup' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Team Standup');
      expect(result.output).not.toContain('Lunch Break');
    });

    test('returns message when nothing found', () => {
      const result = handleSearchEvents(ctx, { query: 'nonexistent' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('No events');
    });
  });
});
```

Run: `bun test test/services/ai/tool-handlers/events.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 2: Implement event tool handlers**

Create `src/services/ai/tool-handlers/events.ts`:

```typescript
import type { AgentContext, ToolResult } from '../types.ts';

interface GetEventsInput {
  start_date: string;
  end_date: string;
}

interface CreateEventInput {
  title: string;
  start_at: string;
  end_at?: string;
  description?: string;
  location?: string;
  all_day?: boolean;
  recurrence_rule?: string;
  reminder_minutes?: number[];
}

interface UpdateEventInput {
  event_id: number;
  title?: string;
  start_at?: string;
  end_at?: string | null;
  description?: string | null;
  location?: string | null;
  recurrence_rule?: string | null;
}

interface DeleteEventInput {
  event_id: number;
}

interface SearchEventsInput {
  query: string;
}

export function handleGetEvents(ctx: AgentContext, input: GetEventsInput): ToolResult {
  const occurrences = ctx.eventService.getEventsInRange(
    ctx.user.telegram_id,
    input.start_date,
    input.end_date,
  );

  if (occurrences.length === 0) {
    return { success: true, output: 'No events found in this range.' };
  }

  const lines = occurrences.map((occ) => {
    const e = occ.event;
    const parts = [`id: ${e.id}`, `title: ${e.title}`, `start: ${occ.occurrence_start}`];
    if (occ.occurrence_end) parts.push(`end: ${occ.occurrence_end}`);
    if (e.description) parts.push(`description: ${e.description}`);
    if (e.location) parts.push(`location: ${e.location}`);
    if (e.recurrence_rule) parts.push(`recurrence: ${e.recurrence_rule}`);
    return parts.join(', ');
  });

  return { success: true, output: lines.join('\n') };
}

export function handleCreateEvent(ctx: AgentContext, input: CreateEventInput): ToolResult {
  try {
    const event = ctx.eventService.createEvent({
      user_id: ctx.user.telegram_id,
      title: input.title,
      start_at: input.start_at,
      end_at: input.end_at,
      description: input.description,
      location: input.location,
      all_day: input.all_day,
      timezone: ctx.user.timezone,
      recurrence_rule: input.recurrence_rule,
      reminder_minutes: input.reminder_minutes,
    });

    const parts = [`id: ${event.id}`, `title: ${event.title}`, `start: ${event.start_at}`];
    if (event.end_at) parts.push(`end: ${event.end_at}`);
    if (event.description) parts.push(`description: ${event.description}`);
    if (event.location) parts.push(`location: ${event.location}`);

    return { success: true, output: `Event created: ${parts.join(', ')}` };
  } catch (error) {
    return { success: false, error: `Failed to create event: ${String(error)}` };
  }
}

export function handleUpdateEvent(ctx: AgentContext, input: UpdateEventInput): ToolResult {
  const { event_id, ...updates } = input;
  const updated = ctx.eventService.updateEvent(event_id, ctx.user.telegram_id, updates);

  if (!updated) {
    return { success: false, error: `Event ${event_id} not found or not owned by you.` };
  }

  const parts = [`id: ${updated.id}`, `title: ${updated.title}`, `start: ${updated.start_at}`];
  if (updated.end_at) parts.push(`end: ${updated.end_at}`);
  if (updated.description) parts.push(`description: ${updated.description}`);
  if (updated.location) parts.push(`location: ${updated.location}`);

  return { success: true, output: `Event updated: ${parts.join(', ')}` };
}

export function handleDeleteEvent(ctx: AgentContext, input: DeleteEventInput): ToolResult {
  const event = ctx.eventService.getEvent(input.event_id, ctx.user.telegram_id);
  if (!event) {
    return { success: false, error: `Event ${input.event_id} not found or not owned by you.` };
  }

  ctx.eventService.deleteEvent(input.event_id, ctx.user.telegram_id);
  return { success: true, output: `Event "${event.title}" (id: ${event.id}) deleted.` };
}

export function handleSearchEvents(ctx: AgentContext, input: SearchEventsInput): ToolResult {
  const events = ctx.eventService.searchEvents(ctx.user.telegram_id, input.query);

  if (events.length === 0) {
    return { success: true, output: 'No events found matching the query.' };
  }

  const lines = events.map((e) => {
    const parts = [`id: ${e.id}`, `title: ${e.title}`, `start: ${e.start_at}`];
    if (e.end_at) parts.push(`end: ${e.end_at}`);
    if (e.location) parts.push(`location: ${e.location}`);
    return parts.join(', ');
  });

  return { success: true, output: lines.join('\n') };
}
```

Run: `bun test test/services/ai/tool-handlers/events.test.ts`
Expected: PASS

---

### Task 8: Slots Tool Handler

**Files:**

- Create: `src/services/ai/tool-handlers/slots.ts`
- Test: `test/services/ai/tool-handlers/slots.test.ts`

- [ ] **Step 1: Write failing tests for slots handler**

Create `test/services/ai/tool-handlers/slots.test.ts`:

```typescript
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../../../src/database/repositories/event.repository.ts';
import { HolidayRepository } from '../../../../src/database/repositories/holiday.repository.ts';
import { ReminderRepository } from '../../../../src/database/repositories/reminder.repository.ts';
import { UserRepository } from '../../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../../src/database/schema.ts';
import { handleGetFreeSlots } from '../../../../src/services/ai/tool-handlers/slots.ts';
import type { AgentContext } from '../../../../src/services/ai/types.ts';
import { EventService } from '../../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../../src/services/holiday/holiday-service.ts';

function createTestDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

describe('handleGetFreeSlots', () => {
  let ctx: AgentContext;
  const USER_ID = 123;

  beforeEach(() => {
    const db = createTestDb();
    const userRepo = new UserRepository(db);
    const eventRepo = new EventRepository(db);
    const reminderRepo = new ReminderRepository(db);
    const chatHistoryRepo = new ChatHistoryRepository(db);
    const holidayRepo = new HolidayRepository(db);
    userRepo.create({ telegram_id: USER_ID, timezone: 'UTC' });
    const eventService = new EventService(eventRepo, reminderRepo);
    const holidayService = new HolidayService(holidayRepo);
    ctx = {
      user: userRepo.findByTelegramId(USER_ID)!,
      chatId: USER_ID,
      messageText: '',
      eventService,
      holidayService,
      chatHistory: chatHistoryRepo,
      userRepo,
      reminderRepo,
    };
  });

  test('returns free slots for a day with events', () => {
    ctx.eventService.createEvent({
      user_id: USER_ID,
      title: 'Morning',
      start_at: '2026-03-15T09:00:00Z',
      end_at: '2026-03-15T10:00:00Z',
      timezone: 'UTC',
    });
    const result = handleGetFreeSlots(ctx, { date: '2026-03-15T00:00:00Z' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('Free slots');
  });

  test('returns full day as free when no events', () => {
    const result = handleGetFreeSlots(ctx, { date: '2026-03-15T00:00:00Z' });
    expect(result.success).toBe(true);
    expect(result.output).toBeDefined();
  });
});
```

Run: `bun test test/services/ai/tool-handlers/slots.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 2: Implement slots handler**

Create `src/services/ai/tool-handlers/slots.ts`:

```typescript
import type { AgentContext, ToolResult } from '../types.ts';

interface GetFreeSlotsInput {
  date: string;
}

export function handleGetFreeSlots(ctx: AgentContext, input: GetFreeSlotsInput): ToolResult {
  const date = new Date(input.date);
  const slots = ctx.eventService.getFreeSlots(ctx.user.telegram_id, date, ctx.user.timezone);

  if (slots.length === 0) {
    return { success: true, output: 'No free slots — the entire day is busy.' };
  }

  const lines = slots.map((s) => {
    const hours = Math.floor(s.durationMinutes / 60);
    const mins = s.durationMinutes % 60;
    const duration =
      hours > 0 ? (mins > 0 ? `${hours}h ${mins}m` : `${hours}h`) : `${mins}m`;
    return `${s.start} — ${s.end} (${duration})`;
  });

  return { success: true, output: `Free slots:\n${lines.join('\n')}` };
}
```

Run: `bun test test/services/ai/tool-handlers/slots.test.ts`
Expected: PASS

---

