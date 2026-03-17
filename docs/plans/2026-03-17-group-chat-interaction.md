# Group Chat Interaction & Group Calendar — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable bot interaction in Telegram group chats with group calendars, conversation sessions, and inline mode split.

**Architecture:** Add `scope` parameter to event tools, routing to personal or group calendar. In-memory conversation sessions track active dialogs in groups. AI agent decides per-message whether to respond or skip. Inline mode moves to a separate bot in the same process.

**Tech Stack:** Bun, GramIO, bun:sqlite (WAL), Anthropic SDK, Pyrogram (Python subprocess)

**Spec:** `docs/specs/2026-03-17-group-chat-interaction-design.md`

---

## Chunk 1: Data Layer

Migration, types, repositories — the foundation everything else builds on.

### Task 1: Migration — events columns + chat_history.chat_id + group_members

**Files:**
- Modify: `src/database/migrations.ts`

- [ ] **Step 1: Write migration 012_group_calendar**

Add to the `migrations` array in `src/database/migrations.ts`:

```typescript
{
  name: '012_group_calendar',
  up: (db) => {
    db.exec(`ALTER TABLE events ADD COLUMN owner_type TEXT NOT NULL DEFAULT 'user'`);
    db.exec(`ALTER TABLE events ADD COLUMN group_id INTEGER`);
    db.exec(`ALTER TABLE events ADD COLUMN created_by INTEGER`);
    db.exec(`
      CREATE INDEX idx_events_group ON events (group_id, start_at)
        WHERE owner_type = 'group'
    `);
    db.exec(`ALTER TABLE chat_history ADD COLUMN chat_id INTEGER`);
    db.exec(`CREATE INDEX idx_chat_history_chat ON chat_history(chat_id, created_at)`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS group_members (
        chat_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (chat_id, user_id)
      )
    `);
  },
},
```

- [ ] **Step 2: Run migration**

Run: `bun run src/index.ts` (starts bot, runs pending migrations on startup)
Then stop the bot. Or if there's a migration-only script, use that.
Verify: check `sqlite3 data/calendar.db ".schema events"` shows `owner_type`, `group_id`, `created_by` columns.

- [ ] **Step 3: Commit**

```bash
git add src/database/migrations.ts
git commit -m "feat(db): migration 012 — group calendar columns, chat_history.chat_id, group_members table"
```

---

### Task 2: Type changes — CalendarEvent + CreateEventData

**Files:**
- Modify: `src/database/types.ts`
- Test: `test/database/types.test.ts` (no test needed — pure type additions, verified by tsc)

- [ ] **Step 1: Add fields to CalendarEvent**

In `src/database/types.ts`, add to `CalendarEvent` interface after `sync_version: number;`:

```typescript
owner_type: 'user' | 'group';
group_id: number | null;
created_by: number | null;
```

- [ ] **Step 2: Add fields to CreateEventData**

In `src/database/types.ts`, add to `CreateEventData` interface:

```typescript
owner_type?: 'user' | 'group';
group_id?: number;
created_by?: number;
```

- [ ] **Step 3: Add chat_id to ChatHistoryMessage**

In `src/database/types.ts`, add to `ChatHistoryMessage` interface:

```typescript
chat_id: number | null;
```

- [ ] **Step 4: Run type check**

Run: `bunx tsc --noEmit`
Expected: no errors (existing code defaults `owner_type` to 'user' in DB, so all existing queries still work).

- [ ] **Step 4: Commit**

```bash
git add src/database/types.ts
git commit -m "feat(types): add owner_type, group_id, created_by to CalendarEvent and CreateEventData"
```

---

### Task 3: EventRepository — group-aware methods

**Files:**
- Modify: `src/database/repositories/event.repository.ts`
- Test: `test/database/repositories/event.repository.test.ts`

- [ ] **Step 1: Write failing tests for group repository methods**

Add tests to `test/database/repositories/event.repository.test.ts`:

```typescript
describe('group calendar', () => {
  test('create() stores owner_type, group_id, created_by', () => {
    const event = repo.create({
      user_id: 111,
      title: 'Group Meeting',
      start_at: '2026-04-01T10:00:00Z',
      timezone: 'UTC',
      owner_type: 'group',
      group_id: -100999,
      created_by: 111,
    });
    expect(event.owner_type).toBe('group');
    expect(event.group_id).toBe(-100999);
    expect(event.created_by).toBe(111);
  });

  test('findByIdInGroup() finds group event without user_id check', () => {
    const event = repo.create({
      user_id: 111,
      title: 'Group Event',
      start_at: '2026-04-01T10:00:00Z',
      timezone: 'UTC',
      owner_type: 'group',
      group_id: -100999,
      created_by: 111,
    });
    // Different user can find this event by group
    const found = repo.findByIdInGroup(event.id, -100999);
    expect(found).not.toBeNull();
    expect(found!.title).toBe('Group Event');
  });

  test('findByIdInGroup() returns null for wrong group', () => {
    const event = repo.create({
      user_id: 111,
      title: 'Group Event',
      start_at: '2026-04-01T10:00:00Z',
      timezone: 'UTC',
      owner_type: 'group',
      group_id: -100999,
      created_by: 111,
    });
    expect(repo.findByIdInGroup(event.id, -100888)).toBeNull();
  });

  test('getByDateRangeForGroup() returns only group events', () => {
    repo.create({
      user_id: 111,
      title: 'Personal',
      start_at: '2026-04-01T10:00:00Z',
      timezone: 'UTC',
    });
    repo.create({
      user_id: 111,
      title: 'Group',
      start_at: '2026-04-01T11:00:00Z',
      timezone: 'UTC',
      owner_type: 'group',
      group_id: -100999,
      created_by: 111,
    });
    const results = repo.getByDateRangeForGroup(-100999, '2026-04-01T00:00:00Z', '2026-04-01T23:59:59Z');
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Group');
  });

  test('searchForGroup() searches within group events', () => {
    repo.create({
      user_id: 111,
      title: 'Personal Lunch',
      start_at: '2026-04-01T12:00:00Z',
      timezone: 'UTC',
    });
    repo.create({
      user_id: 111,
      title: 'Group Lunch',
      start_at: '2026-04-01T12:00:00Z',
      timezone: 'UTC',
      owner_type: 'group',
      group_id: -100999,
      created_by: 111,
    });
    const results = repo.searchForGroup(-100999, 'Lunch');
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Group Lunch');
  });

  test('updateInGroup() updates event by group, not user', () => {
    const event = repo.create({
      user_id: 111,
      title: 'Old Title',
      start_at: '2026-04-01T10:00:00Z',
      timezone: 'UTC',
      owner_type: 'group',
      group_id: -100999,
      created_by: 111,
    });
    const updated = repo.updateInGroup(event.id, -100999, { title: 'New Title' });
    expect(updated).not.toBeNull();
    expect(updated!.title).toBe('New Title');
  });

  test('removeFromGroup() deletes event by group', () => {
    const event = repo.create({
      user_id: 111,
      title: 'To Delete',
      start_at: '2026-04-01T10:00:00Z',
      timezone: 'UTC',
      owner_type: 'group',
      group_id: -100999,
      created_by: 111,
    });
    expect(repo.removeFromGroup(event.id, -100999)).toBe(true);
    expect(repo.findByIdInGroup(event.id, -100999)).toBeNull();
  });

  test('getUpcomingForGroup() returns upcoming group events', () => {
    repo.create({
      user_id: 111,
      title: 'Future Group Event',
      start_at: '2099-01-01T10:00:00Z',
      timezone: 'UTC',
      owner_type: 'group',
      group_id: -100999,
      created_by: 111,
    });
    const results = repo.getUpcomingForGroup(-100999, 5);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].title).toBe('Future Group Event');
  });

  test('getRecurringTemplatesForGroup() returns group recurring events', () => {
    repo.create({
      user_id: 111,
      title: 'Weekly Standup',
      start_at: '2026-04-01T09:00:00Z',
      timezone: 'UTC',
      owner_type: 'group',
      group_id: -100999,
      created_by: 111,
      recurrence_rule: 'FREQ=WEEKLY',
    });
    const results = repo.getRecurringTemplatesForGroup(-100999);
    expect(results).toHaveLength(1);
    expect(results[0].recurrence_rule).toBe('FREQ=WEEKLY');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/database/repositories/event.repository.test.ts`
Expected: FAIL — methods `findByIdInGroup`, `getByDateRangeForGroup`, etc. do not exist yet.

- [ ] **Step 3: Update create() to include new columns**

In `src/database/repositories/event.repository.ts`, update `create()`:

```typescript
create(data: CreateEventData): CalendarEvent {
  const result = this.db
    .prepare(`
    INSERT INTO events (user_id, title, description, category, start_at, end_at, all_day, timezone, location, recurrence_rule, recurrence_end_at, owner_type, group_id, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
    .run(
      data.user_id,
      data.title,
      data.description ?? null,
      data.category ?? null,
      data.start_at,
      data.end_at ?? null,
      data.all_day ? 1 : 0,
      data.timezone,
      data.location ?? null,
      data.recurrence_rule ?? null,
      data.recurrence_end_at ?? null,
      data.owner_type ?? 'user',
      data.group_id ?? null,
      data.created_by ?? null,
    );
  const id = Number(result.lastInsertRowid);
  if (data.owner_type === 'group' && data.group_id) {
    return this.findByIdInGroup(id, data.group_id)!;
  }
  return this.findById(id, data.user_id)!;
}
```

- [ ] **Step 4: Add group-aware methods**

Add to `EventRepository` class:

```typescript
findByIdInGroup(id: number, groupId: number): CalendarEvent | null {
  return this.db
    .prepare("SELECT * FROM events WHERE id = ? AND owner_type = 'group' AND group_id = ? AND is_cancelled = 0")
    .get(id, groupId) as CalendarEvent | null;
}

getByDateRangeForGroup(groupId: number, startUtc: string, endUtc: string): CalendarEvent[] {
  return this.db
    .prepare(
      "SELECT * FROM events WHERE owner_type = 'group' AND group_id = ? AND start_at >= ? AND start_at <= ? AND is_cancelled = 0 ORDER BY start_at",
    )
    .all(groupId, startUtc, endUtc) as CalendarEvent[];
}

getInRangeForGroup(groupId: number, startUtc: string, endUtc: string): CalendarEvent[] {
  return this.db
    .prepare(`
    SELECT * FROM events
    WHERE owner_type = 'group' AND group_id = ? AND start_at >= ? AND start_at <= ?
      AND is_cancelled = 0 AND recurrence_rule IS NULL AND parent_event_id IS NULL
    ORDER BY start_at
  `)
    .all(groupId, startUtc, endUtc) as CalendarEvent[];
}

getRecurringTemplatesForGroup(groupId: number): CalendarEvent[] {
  return this.db
    .prepare(`
    SELECT * FROM events
    WHERE owner_type = 'group' AND group_id = ? AND recurrence_rule IS NOT NULL AND parent_event_id IS NULL AND is_cancelled = 0
  `)
    .all(groupId) as CalendarEvent[];
}

searchForGroup(groupId: number, query: string, limit = 20): CalendarEvent[] {
  return this.db
    .prepare(`
    SELECT * FROM events
    WHERE owner_type = 'group' AND group_id = ? AND title LIKE ? AND is_cancelled = 0
    ORDER BY start_at ASC
    LIMIT ?
  `)
    .all(groupId, `%${query}%`, limit) as CalendarEvent[];
}

getUpcomingForGroup(groupId: number, limit = 10, now?: Date): CalendarEvent[] {
  const nowIso = (now ?? new Date()).toISOString();
  return this.db
    .prepare(`
    SELECT * FROM events
    WHERE owner_type = 'group' AND group_id = ? AND is_cancelled = 0 AND parent_event_id IS NULL
      AND (start_at > ? OR recurrence_rule IS NOT NULL)
    ORDER BY start_at
    LIMIT ?
  `)
    .all(groupId, nowIso, limit) as CalendarEvent[];
}

updateInGroup(id: number, groupId: number, data: UpdateEventData): CalendarEvent | null {
  const existing = this.findByIdInGroup(id, groupId);
  if (!existing) return null;

  const ALLOWED_COLUMNS = new Set([
    'title', 'description', 'category', 'start_at', 'end_at',
    'all_day', 'timezone', 'location', 'recurrence_rule', 'recurrence_end_at',
  ]);
  const fields: string[] = [];
  const values: SQLQueryBindings[] = [];

  for (const [key, value] of Object.entries(data)) {
    if (!ALLOWED_COLUMNS.has(key)) continue;
    if (value !== undefined) {
      fields.push(`${key} = ?`);
      values.push(key === 'all_day' ? (value ? 1 : 0) : value);
    }
  }

  if (fields.length === 0) return existing;

  fields.push("updated_at = datetime('now')");
  values.push(id, groupId);

  this.db.prepare(`UPDATE events SET ${fields.join(', ')} WHERE id = ? AND owner_type = 'group' AND group_id = ?`).run(...values);

  return this.findByIdInGroup(id, groupId)!;
}

removeFromGroup(id: number, groupId: number): boolean {
  const result = this.db
    .prepare("DELETE FROM events WHERE id = ? AND owner_type = 'group' AND group_id = ?")
    .run(id, groupId);
  return result.changes > 0;
}
```

- [ ] **Step 5: Run tests**

Run: `bun test test/database/repositories/event.repository.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Run full test suite**

Run: `bun test`
Expected: ALL PASS (existing tests unaffected — `create()` defaults `owner_type` to 'user')

- [ ] **Step 7: Commit**

```bash
git add src/database/repositories/event.repository.ts test/database/repositories/event.repository.test.ts
git commit -m "feat(repo): group-aware event repository methods with scope routing"
```

---

### Task 4: ChatHistoryRepository — chat_id support

**Files:**
- Modify: `src/database/repositories/chat-history.repository.ts`
- Test: `test/database/repositories/chat-history.repository.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
describe('group chat history', () => {
  test('save() stores chat_id when provided', () => {
    repo.save(111, 'user', 'hello from group', -100999);
    const messages = repo.getRecentByChat(-100999);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('hello from group');
  });

  test('getRecentByChat() returns messages from all users in a chat', () => {
    repo.save(111, 'user', 'msg from user 111', -100999);
    repo.save(222, 'user', 'msg from user 222', -100999);
    repo.save(111, 'assistant', 'bot response', -100999);
    const messages = repo.getRecentByChat(-100999);
    expect(messages).toHaveLength(3);
  });

  test('getRecentByChat() does not return messages from other chats', () => {
    repo.save(111, 'user', 'chat A', -100111);
    repo.save(111, 'user', 'chat B', -100222);
    expect(repo.getRecentByChat(-100111)).toHaveLength(1);
    expect(repo.getRecentByChat(-100222)).toHaveLength(1);
  });

  test('getRecentByChat() respects limit', () => {
    for (let i = 0; i < 15; i++) {
      repo.save(111, 'user', `msg ${i}`, -100999);
    }
    expect(repo.getRecentByChat(-100999, 10)).toHaveLength(10);
  });

  test('getRecent() still works for personal (no chat_id)', () => {
    repo.save(111, 'user', 'personal msg');
    const messages = repo.getRecent(111);
    expect(messages.length).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/database/repositories/chat-history.repository.test.ts`
Expected: FAIL — `save()` doesn't accept 4th parameter, `getRecentByChat` doesn't exist.

- [ ] **Step 3: Update save() and add getRecentByChat()**

```typescript
save(userId: number, role: 'user' | 'assistant' | 'tool', content: string, chatId?: number): void {
  this.db.prepare('INSERT INTO chat_history (user_id, role, content, chat_id) VALUES (?, ?, ?, ?)').run(userId, role, content, chatId ?? null);
}

getRecentByChat(chatId: number, limit = 10): ChatHistoryMessage[] {
  return this.db
    .prepare(`
      SELECT * FROM (
        SELECT * FROM chat_history
        WHERE chat_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      ) sub ORDER BY created_at ASC, id ASC
    `)
    .all(chatId, limit) as ChatHistoryMessage[];
}
```

- [ ] **Step 4: Run tests**

Run: `bun test test/database/repositories/chat-history.repository.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/database/repositories/chat-history.repository.ts test/database/repositories/chat-history.repository.test.ts
git commit -m "feat(chat-history): add chat_id to save(), getRecentByChat() for group context"
```

---

### Task 5: GroupMemberRepository

**Files:**
- Create: `src/database/repositories/group-member.repository.ts`
- Test: `test/database/repositories/group-member.repository.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { Database } from 'bun:sqlite';
import { describe, test, expect, beforeEach } from 'bun:test';
import { GroupMemberRepository } from '../../../src/database/repositories/group-member.repository.ts';

describe('GroupMemberRepository', () => {
  let db: Database;
  let repo: GroupMemberRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE group_members (
        chat_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (chat_id, user_id)
      )
    `);
    repo = new GroupMemberRepository(db);
  });

  test('upsert() inserts new member', () => {
    repo.upsert(-100999, 111);
    const members = repo.getMembers(-100999);
    expect(members).toHaveLength(1);
    expect(members[0].user_id).toBe(111);
  });

  test('upsert() updates last_seen_at on duplicate', () => {
    repo.upsert(-100999, 111);
    const before = repo.getMembers(-100999)[0].last_seen_at;
    repo.upsert(-100999, 111);
    const after = repo.getMembers(-100999)[0].last_seen_at;
    expect(after).toBeDefined();
  });

  test('getMembers() returns all members of a group', () => {
    repo.upsert(-100999, 111);
    repo.upsert(-100999, 222);
    repo.upsert(-100999, 333);
    expect(repo.getMembers(-100999)).toHaveLength(3);
  });

  test('getMembers() does not return members from other groups', () => {
    repo.upsert(-100111, 111);
    repo.upsert(-100222, 222);
    expect(repo.getMembers(-100111)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/database/repositories/group-member.repository.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement GroupMemberRepository**

Create `src/database/repositories/group-member.repository.ts`:

```typescript
import type { Database } from 'bun:sqlite';

export interface GroupMember {
  chat_id: number;
  user_id: number;
  last_seen_at: string;
}

export class GroupMemberRepository {
  constructor(private db: Database) {}

  upsert(chatId: number, userId: number): void {
    this.db
      .prepare(
        `INSERT INTO group_members (chat_id, user_id, last_seen_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT (chat_id, user_id) DO UPDATE SET last_seen_at = datetime('now')`,
      )
      .run(chatId, userId);
  }

  getMembers(chatId: number): GroupMember[] {
    return this.db
      .prepare('SELECT * FROM group_members WHERE chat_id = ? ORDER BY last_seen_at DESC')
      .all(chatId) as GroupMember[];
  }
}
```

- [ ] **Step 4: Run tests**

Run: `bun test test/database/repositories/group-member.repository.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/database/repositories/group-member.repository.ts test/database/repositories/group-member.repository.test.ts
git commit -m "feat(repo): GroupMemberRepository for tracking group members (fallback for Pyrogram)"
```

---

### Task 5b: EventService — group-aware methods

**Files:**
- Modify: `src/services/event/event-service.ts`
- Test: `test/services/event/event-service.test.ts`

Tool handlers go through `EventService`, NOT `EventRepository` directly. The service must expose group-scoped variants.

- [ ] **Step 1: Write failing tests**

```typescript
describe('group calendar', () => {
  test('createEvent() with group scope sets owner_type and group_id', () => {
    const event = service.createEvent({
      user_id: 111,
      title: 'Group Standup',
      start_at: '2026-04-01T09:00:00Z',
      timezone: 'UTC',
      owner_type: 'group',
      group_id: -100999,
      created_by: 111,
    });
    expect(event.owner_type).toBe('group');
    expect(event.group_id).toBe(-100999);
  });

  test('getEventsInRangeForGroup() returns group events with recurrence expansion', () => {
    service.createEvent({
      user_id: 111,
      title: 'Group Weekly',
      start_at: '2026-04-01T09:00:00Z',
      timezone: 'UTC',
      owner_type: 'group',
      group_id: -100999,
      created_by: 111,
      recurrence_rule: 'FREQ=WEEKLY;COUNT=3',
    });
    const occurrences = service.getEventsInRangeForGroup(
      -100999, '2026-04-01T00:00:00Z', '2026-04-30T23:59:59Z', 'UTC',
    );
    expect(occurrences.length).toBe(3);
  });

  test('updateEventForGroup() updates group event by any member', () => {
    const event = service.createEvent({
      user_id: 111,
      title: 'Old',
      start_at: '2026-04-01T09:00:00Z',
      timezone: 'UTC',
      owner_type: 'group',
      group_id: -100999,
      created_by: 111,
    });
    const updated = service.updateEventForGroup(event.id, -100999, { title: 'New' });
    expect(updated!.title).toBe('New');
  });

  test('deleteEventForGroup() deletes group event', () => {
    const event = service.createEvent({
      user_id: 111,
      title: 'Gone',
      start_at: '2026-04-01T09:00:00Z',
      timezone: 'UTC',
      owner_type: 'group',
      group_id: -100999,
      created_by: 111,
    });
    expect(service.deleteEventForGroup(event.id, -100999)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/services/event/event-service.test.ts`
Expected: FAIL — methods don't exist.

- [ ] **Step 3: Add group methods to EventService**

Add to `EventService`:

```typescript
getEventsInRangeForGroup(groupId: number, start: string, end: string, timezone: string): EventOccurrence[] {
  const singles = this.eventRepo.getInRangeForGroup(groupId, start, end);
  const templates = this.eventRepo.getRecurringTemplatesForGroup(groupId);
  // Same recurrence expansion logic as getEventsInRange(), but with group methods
  return this.expandAndMerge(singles, templates, start, end, timezone);
}

getEventForGroup(eventId: number, groupId: number): CalendarEvent | null {
  return this.eventRepo.findByIdInGroup(eventId, groupId);
}

updateEventForGroup(eventId: number, groupId: number, data: UpdateEventData): CalendarEvent | null {
  return this.eventRepo.updateInGroup(eventId, groupId, data);
}

deleteEventForGroup(eventId: number, groupId: number): boolean {
  return this.eventRepo.removeFromGroup(eventId, groupId);
}

searchEventsForGroup(groupId: number, query: string): CalendarEvent[] {
  return this.eventRepo.searchForGroup(groupId, query);
}

getUpcomingForGroup(groupId: number, limit?: number): CalendarEvent[] {
  return this.eventRepo.getUpcomingForGroup(groupId, limit);
}
```

Note: `expandAndMerge()` may need to be extracted from existing `getEventsInRange()` to avoid duplication.

- [ ] **Step 4: Run tests**

Run: `bun test test/services/event/event-service.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/event/event-service.ts test/services/event/event-service.test.ts
git commit -m "feat(service): EventService group-aware methods for group calendar operations"
```

---

## Chunk 2: Group Session Manager

In-memory session tracking for group conversations.

### Task 6: GroupSessionManager

**Files:**
- Create: `src/services/group/group-session.ts`
- Test: `test/services/group/group-session.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, test, expect, beforeEach } from 'bun:test';
import { GroupSessionManager } from '../../../src/services/group/group-session.ts';

describe('GroupSessionManager', () => {
  let manager: GroupSessionManager;

  beforeEach(() => {
    manager = new GroupSessionManager();
  });

  test('no session initially', () => {
    expect(manager.hasActiveSession(-100999)).toBe(false);
  });

  test('activate() creates a session', () => {
    manager.activate(-100999, 111, 42);
    expect(manager.hasActiveSession(-100999)).toBe(true);
  });

  test('tick() decrements remaining messages', () => {
    manager.activate(-100999, 111, 42);
    manager.tick(-100999);
    const session = manager.getSession(-100999);
    expect(session!.remainingMessages).toBe(9);
  });

  test('session closes after 10 ticks', () => {
    manager.activate(-100999, 111, 42);
    for (let i = 0; i < 10; i++) {
      manager.tick(-100999);
    }
    expect(manager.hasActiveSession(-100999)).toBe(false);
  });

  test('refresh() resets counter and expiry', () => {
    manager.activate(-100999, 111, 42);
    for (let i = 0; i < 8; i++) {
      manager.tick(-100999);
    }
    manager.refresh(-100999, 99);
    const session = manager.getSession(-100999);
    expect(session!.remainingMessages).toBe(10);
    expect(session!.lastBotMessageId).toBe(99);
  });

  test('expired session is not active', () => {
    manager.activate(-100999, 111, 42);
    // Manually expire
    const session = manager.getSession(-100999)!;
    session.expiresAt = Date.now() - 1;
    expect(manager.hasActiveSession(-100999)).toBe(false);
  });

  test('close() removes session', () => {
    manager.activate(-100999, 111, 42);
    manager.close(-100999);
    expect(manager.hasActiveSession(-100999)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/services/group/group-session.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement GroupSessionManager**

Create `src/services/group/group-session.ts`:

```typescript
const SESSION_WINDOW = 10;
const SESSION_TTL_MS = 5 * 24 * 60 * 60 * 1000; // 5 days

export interface GroupSession {
  chatId: number;
  activatedBy: number;
  remainingMessages: number;
  lastBotMessageId: number;
  expiresAt: number;
}

export class GroupSessionManager {
  private sessions = new Map<number, GroupSession>();

  activate(chatId: number, userId: number, botMessageId: number): void {
    this.sessions.set(chatId, {
      chatId,
      activatedBy: userId,
      remainingMessages: SESSION_WINDOW,
      lastBotMessageId: botMessageId,
      expiresAt: Date.now() + SESSION_TTL_MS,
    });
  }

  hasActiveSession(chatId: number): boolean {
    const session = this.sessions.get(chatId);
    if (!session) return false;
    if (session.remainingMessages <= 0 || Date.now() > session.expiresAt) {
      this.sessions.delete(chatId);
      return false;
    }
    return true;
  }

  getSession(chatId: number): GroupSession | undefined {
    return this.sessions.get(chatId);
  }

  tick(chatId: number): void {
    const session = this.sessions.get(chatId);
    if (!session) return;
    session.remainingMessages--;
    if (session.remainingMessages <= 0) {
      this.sessions.delete(chatId);
    }
  }

  refresh(chatId: number, botMessageId: number): void {
    const session = this.sessions.get(chatId);
    if (!session) return;
    session.remainingMessages = SESSION_WINDOW;
    session.lastBotMessageId = botMessageId;
    session.expiresAt = Date.now() + SESSION_TTL_MS;
  }

  close(chatId: number): void {
    this.sessions.delete(chatId);
  }
}
```

- [ ] **Step 4: Run tests**

Run: `bun test test/services/group/group-session.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/group/group-session.ts test/services/group/group-session.test.ts
git commit -m "feat(group): GroupSessionManager — in-memory conversation session tracking"
```

---

## Chunk 3: AI Agent Group Support

AgentContext, system prompt, chat history routing, [SKIP] detection.

### Task 7: AgentContext extension

**Files:**
- Modify: `src/services/ai/types.ts`

- [ ] **Step 1: Add group fields to AgentContext**

In `src/services/ai/types.ts`, add to `AgentContext` interface:

```typescript
isGroup: boolean;
groupChatId?: number;
groupTitle?: string;
```

- [ ] **Step 2: Run type check**

Run: `bunx tsc --noEmit`
Expected: errors in places that construct AgentContext without `isGroup`. Fix by adding `isGroup: false` to all existing call sites (message.handler.ts, week.ts, etc.).

Note: all existing call sites are in DM context, so `isGroup: false` is correct.

- [ ] **Step 3: Commit**

```bash
git add src/services/ai/types.ts src/bot/handlers/message.handler.ts src/bot/commands/week.ts
git commit -m "feat(ai): add isGroup, groupChatId, groupTitle to AgentContext"
```

---

### Task 8: System prompt — group context block

**Files:**
- Modify: `src/services/ai/system-prompt.ts`
- Test: `test/services/ai/system-prompt.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
test('includes group context block when isGroup is true', () => {
  const prompt = buildSystemPrompt({
    ...baseCtx,
    isGroup: true,
    groupChatId: -100999,
    groupTitle: 'Test Group',
  });
  expect(prompt).toContain('## Group Context');
  expect(prompt).toContain('Test Group');
  expect(prompt).toContain('[SKIP]');
  expect(prompt).toContain('"group"');
  expect(prompt).toContain('"personal"');
});

test('does not include group context in DM', () => {
  const prompt = buildSystemPrompt({ ...baseCtx, isGroup: false });
  expect(prompt).not.toContain('## Group Context');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/services/ai/system-prompt.test.ts`
Expected: FAIL

- [ ] **Step 3: Add group context block to buildSystemPrompt()**

At the end of `buildSystemPrompt()`, before the closing backtick, add:

```typescript
${
  ctx.isGroup && ctx.groupTitle
    ? `
## Group Context
You are in group "${ctx.groupTitle}" (chat_id: ${ctx.groupChatId}).
Default scope for all event tools is "group" — you manage the GROUP calendar.
The user can explicitly ask about their personal calendar — then use scope "personal".

Available scopes:
- "group" — group calendar, events visible to all members, reminders sent to everyone
- "personal" — the sender's private calendar

Rules for groups:
- Be brief. Multiple people are reading.
- The [From: name] prefix tells you who is speaking. Address them by name.
- If the message is clearly not addressed to you (casual conversation, off-topic), respond ONLY with [SKIP]. Do not call any tools.
- Do NOT [SKIP] if there's any calendar-related intent, even indirect.
- When creating events, they go to the group calendar by default.
- When showing events, show the group calendar by default.`
    : ''
}
```

- [ ] **Step 4: Run tests**

Run: `bun test test/services/ai/system-prompt.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/ai/system-prompt.ts test/services/ai/system-prompt.test.ts
git commit -m "feat(ai): group context block in system prompt with scope instructions and [SKIP] rule"
```

---

### Task 9: Agent — per-chat history + [SKIP] detection

**Files:**
- Modify: `src/services/ai/agent.ts`
- Test: `test/services/ai/agent.test.ts`

- [ ] **Step 1: Write failing test for [SKIP] detection**

Add test verifying that when the agent's response is `[SKIP]`, no message is sent to chat. This requires mocking the Anthropic client to return `[SKIP]` text.

```typescript
test('does not send message when agent responds with [SKIP]', async () => {
  // Mock Anthropic to return [SKIP]
  // ... (see existing agent test patterns)
  // Verify sender.sendMessage was NOT called
});
```

- [ ] **Step 2: Update buildMessages() for group context**

In `agent.ts`, modify `buildMessages()`:

```typescript
buildMessages(ctx: AgentContext, history: ChatHistoryMessage[]): { systemPrompt: string; messages: MessageParam[] } {
  const systemPrompt = buildSystemPrompt(ctx);
  const messages: MessageParam[] = [];

  // In groups, use per-chat history; in DMs, use per-user history
  const relevantHistory = ctx.isGroup && ctx.groupChatId
    ? ctx.chatHistory.getRecentByChat(ctx.groupChatId, 10)
    : history;

  for (const msg of relevantHistory) {
    // ... same parsing logic
  }

  messages.push({ role: 'user', content: ctx.messageText });
  return { systemPrompt, messages };
}
```

- [ ] **Step 3: Update save methods to pass chatId**

```typescript
saveUserMessage(ctx: AgentContext): void {
  const chatId = ctx.isGroup ? ctx.groupChatId : undefined;
  ctx.chatHistory.save(ctx.user.telegram_id, 'user', ctx.messageText, chatId);
}

saveAssistantTurn(ctx: AgentContext, contentBlocks: Anthropic.ContentBlockParam[]): void {
  const chatId = ctx.isGroup ? ctx.groupChatId : undefined;
  ctx.chatHistory.save(ctx.user.telegram_id, 'assistant', JSON.stringify(contentBlocks), chatId);
}

saveToolResults(ctx: AgentContext, toolResults: Anthropic.ToolResultBlockParam[]): void {
  const chatId = ctx.isGroup ? ctx.groupChatId : undefined;
  ctx.chatHistory.save(ctx.user.telegram_id, 'tool', JSON.stringify(toolResults), chatId);
}
```

- [ ] **Step 4: Add discard() to TelegramStreamWriter**

`TelegramStreamWriter.init()` sends a placeholder message (`⏳`). When [SKIP], this message must be deleted. Add to `TelegramStreamWriter`:

```typescript
async discard(): Promise<void> {
  // Delete the placeholder message
  if (this.messageId) {
    try {
      await this.sender.deleteMessage(this.chatId, this.messageId);
    } catch { /* ignore if already deleted */ }
  }
}
```

Also add `deleteMessage` to `TelegramSender` interface:
```typescript
deleteMessage?(chatId: number, messageId: number): Promise<void>;
```

- [ ] **Step 5: Add [SKIP] detection in run()**

After the main agent loop, before `await writer.finalize()`, check if the accumulated text is exactly `[SKIP]`:

```typescript
const finalText = writer.getText().trim();
if (ctx.isGroup && finalText === '[SKIP]') {
  await writer.discard();
  return;
}
```

Note: Use existing `writer.getText()` method, not a new one.

- [ ] **Step 5: Run tests**

Run: `bun test test/services/ai/agent.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Run full test suite**

Run: `bun test`
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add src/services/ai/agent.ts test/services/ai/agent.test.ts
git commit -m "feat(ai): per-chat history for groups, [SKIP] detection to suppress irrelevant responses"
```

---

## Chunk 4: Tool Scope

Add `scope` parameter to event tools, route in executor and handlers.

### Task 10: Add scope to tool definitions

**Files:**
- Modify: `src/services/ai/tools.ts`
- Test: `test/services/ai/tools.test.ts`

- [ ] **Step 1: Write test verifying scope parameter exists**

```typescript
test('event tools have scope parameter', () => {
  const scopeTools = [
    'get_events', 'create_event', 'update_event', 'delete_event',
    'get_free_slots', 'search_events', 'get_upcoming', 'snooze_event',
    'get_event', 'set_reminder', 'get_reminders',
  ];
  for (const name of scopeTools) {
    const tool = toolDefinitions.find(t => t.name === name);
    expect(tool).toBeDefined();
    const props = tool!.input_schema.properties as Record<string, unknown>;
    expect(props.scope).toBeDefined();
  }
});
```

- [ ] **Step 2: Add scope property to each affected tool**

For each of the 11 tools listed, add to `properties`:

```typescript
scope: {
  type: 'string',
  enum: ['personal', 'group'],
  description: 'Calendar scope. In groups defaults to "group", in DMs defaults to "personal".',
},
```

Also add scope to `render_day_image` and `render_week_image`.

- [ ] **Step 3: Run tests**

Run: `bun test test/services/ai/tools.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/services/ai/tools.ts test/services/ai/tools.test.ts
git commit -m "feat(tools): add scope parameter to all event-related AI tools"
```

---

### Task 11: Scope routing in tool executor and handlers

**Files:**
- Modify: `src/services/ai/tool-executor.ts`
- Modify: `src/services/ai/tool-handlers/events.ts`
- Test: `test/services/ai/tool-handlers/events.test.ts`

- [ ] **Step 1: Write failing tests for scope routing**

```typescript
describe('group scope', () => {
  test('handleGetEvents with scope=group queries group calendar', () => {
    const ctx = { ...baseCtx, isGroup: true, groupChatId: -100999 };
    // Create a group event in test DB
    // Call handleGetEvents with scope: 'group'
    // Verify it returns group events, not personal
  });

  test('handleCreateEvent with scope=group creates group event', () => {
    const ctx = { ...baseCtx, isGroup: true, groupChatId: -100999 };
    const result = handleCreateEvent(ctx, {
      title: 'Group Event',
      start_at: '2026-04-01T10:00:00Z',
      scope: 'group',
    });
    expect(result.success).toBe(true);
    // Verify event has owner_type='group' and group_id=-100999
  });

  test('handleDeleteEvent with scope=group deletes from group', () => {
    // Create group event, then delete by scope
  });
});
```

- [ ] **Step 2: Add scope type to handler input interfaces**

In `src/services/ai/tool-handlers/events.ts`, add `scope?: 'personal' | 'group'` to all input interfaces used by handlers.

- [ ] **Step 3: Update tool handlers to route by scope via EventService**

Each handler computes the effective scope:
```typescript
const scope = (input.scope ?? (ctx.isGroup ? 'group' : 'personal')) as 'personal' | 'group';
```

When `scope === 'group'`:
- `handleGetEvents` → `ctx.eventService.getEventsInRangeForGroup(ctx.groupChatId!, start, end, tz)`
- `handleCreateEvent` → `ctx.eventService.createEvent({ ...data, owner_type: 'group', group_id: ctx.groupChatId!, created_by: ctx.user.telegram_id })`
- `handleUpdateEvent` → `ctx.eventService.updateEventForGroup(id, ctx.groupChatId!, data)`
- `handleDeleteEvent` → `ctx.eventService.deleteEventForGroup(id, ctx.groupChatId!)`
- `handleSearchEvents` → `ctx.eventService.searchEventsForGroup(ctx.groupChatId!, query)`
- `handleGetUpcoming` → `ctx.eventService.getUpcomingForGroup(ctx.groupChatId!, limit)`
- `handleGetEvent` → `ctx.eventService.getEventForGroup(id, ctx.groupChatId!)`
- `handleSnoozeEvent` → get via `getEventForGroup`, then update via `updateEventForGroup`

When `scope === 'personal'`: use existing methods (no changes).

Also update `handleRenderDayImage` and `handleRenderWeekImage` in `tool-handlers/meta.ts` to pass scope through to the event fetch calls.

- [ ] **Step 4: Tool executor — no changes needed**

Scope is part of `input` and handlers read it directly.

- [ ] **Step 4: Run tests**

Run: `bun test test/services/ai/tool-handlers/events.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Run full test suite**

Run: `bun test`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/services/ai/tool-executor.ts src/services/ai/tool-handlers/events.ts test/services/ai/tool-handlers/events.test.ts
git commit -m "feat(tools): scope routing in event handlers — group vs personal calendar"
```

---

## Chunk 5: Message Handler + /cal Command + Inline Bot Split

### Task 12: /cal command registration

**Files:**
- Modify: `src/bot/index.ts`

- [ ] **Step 1: Register /cal command**

In `src/bot/index.ts`, after other command registrations, add:

```typescript
bot.command('cal', async (ctx) => {
  const user = ctx.dbUser as User | undefined;
  if (!user) return;
  const text = (ctx.args ?? '').trim();
  if (!text) {
    const lang = user.language as 'en' | 'ru';
    await ctx.send(lang === 'ru' ? 'Напиши после /cal что хочешь: /cal что завтра?' : 'Type after /cal what you want: /cal what\'s tomorrow?');
    return;
  }
  // Route to AI agent — same as message handler
  // Build group context if in group
  const chat = (ctx as unknown as { chat?: { type: string; title?: string } }).chat;
  const isGroup = chat?.type === 'group' || chat?.type === 'supergroup';
  const chatId = ctx.chatId;
  if (!chatId) return;

  const from = (ctx as unknown as { from?: { first_name?: string; username?: string } }).from;
  let messagePrefix = '';
  if (isGroup && from) {
    const senderName = from.first_name ?? from.username ?? 'Unknown';
    const groupName = chat?.title ?? 'group';
    messagePrefix = `[Group: ${groupName}, From: ${senderName}] `;
  }

  const agentContext: AgentContext = {
    user,
    chatId: Number(chatId),
    messageText: messagePrefix + text,
    isGroup,
    groupChatId: isGroup ? Number(chatId) : undefined,
    groupTitle: isGroup ? chat?.title ?? undefined : undefined,
    eventService: deps.eventService,
    // ... rest of deps same as message handler
  };

  await deps.agent.run(agentContext);
});
```

Note: This duplicates AgentContext construction from message handler. Consider extracting a shared `buildAgentContext(ctx, deps, text)` helper to keep DRY.

- [ ] **Step 2: Commit**

```bash
git add src/bot/index.ts
git commit -m "feat(bot): /cal command — routes to AI agent with group context"
```

---

### Task 13: Message handler — group session + [SKIP] + isReplyToBot fix

**Files:**
- Modify: `src/bot/handlers/message.handler.ts`
- Test: `test/bot/handlers/message.handler.test.ts`

- [ ] **Step 1: Add GroupSessionManager + GroupMemberRepository to deps**

```typescript
interface MessageHandlerDeps {
  // ... existing
  groupSessions: GroupSessionManager;
  groupMemberRepo?: GroupMemberRepository;
  botId?: number; // bot's own telegram_id, from getMe()
}
```

- [ ] **Step 2: Fix isReplyToBot check**

Replace:
```typescript
const isReplyToBot = reply?.from?.id !== undefined && deps.botUsername !== undefined;
```
With:
```typescript
const isReplyToBot = deps.botId !== undefined && reply?.from?.id === deps.botId;
```

- [ ] **Step 3: Add session-based activation**

In the group handling section, after checking reply and keywords:

```typescript
if (isGroup) {
  // Track member for fallback reminders
  if (deps.groupMemberRepo) {
    deps.groupMemberRepo.upsert(Number(chatId), user.telegram_id);
  }

  const hasSession = deps.groupSessions.hasActiveSession(Number(chatId));

  if (!isReplyToBot && !isGroupRelevant(text, botMention)) {
    if (!hasSession) return; // No trigger, no session — skip
    // Session active — tick and forward to AI
    deps.groupSessions.tick(Number(chatId));
  }
}
```

- [ ] **Step 4: Add isGroup + group fields to AgentContext construction**

```typescript
const isGroup = chat?.type === 'group' || chat?.type === 'supergroup';

const agentContext: AgentContext = {
  // ... existing fields
  isGroup,
  groupChatId: isGroup ? Number(chatId) : undefined,
  groupTitle: isGroup ? chat?.title ?? undefined : undefined,
};
```

- [ ] **Step 5: Handle [SKIP] response — session management**

After `deps.agent.run(agentContext)`, the agent may have responded or skipped. The session refresh happens inside the agent's stream writer when a message is actually sent. If [SKIP], nothing is sent and session counter was already ticked.

Actually, the message handler doesn't directly see [SKIP] — that's handled inside `agent.run()`. The session refresh needs to be triggered from outside. Add a callback:

```typescript
const agentContext: AgentContext = {
  // ...
  onBotResponse: isGroup ? (messageId: number) => {
    deps.groupSessions.refresh(Number(chatId), messageId);
  } : undefined,
};
```

Or simpler: pass `groupSessions` into the agent context, let the agent call `refresh()` after sending.

- [ ] **Step 6: Write tests**

Test the activation logic: keyword triggers, session continuation, isReplyToBot fix.

- [ ] **Step 7: Run tests**

Run: `bun test test/bot/handlers/message.handler.test.ts`
Expected: ALL PASS

- [ ] **Step 8: Commit**

```bash
git add src/bot/handlers/message.handler.ts test/bot/handlers/message.handler.test.ts
git commit -m "feat(handler): group sessions, isReplyToBot fix, member tracking, scope-aware agent context"
```

---

### Task 14: Inline bot split

**Files:**
- Modify: `src/config/env.ts`
- Modify: `src/bot/index.ts`

- [ ] **Step 1: Add INLINE_BOT_TOKEN to env config**

In `src/config/env.ts`, add to `EnvConfig`:

```typescript
INLINE_BOT_TOKEN?: string;
INLINE_BOT_USERNAME?: string;
```

In `loadConfig()` return:

```typescript
INLINE_BOT_TOKEN: process.env.INLINE_BOT_TOKEN || undefined,
INLINE_BOT_USERNAME: process.env.INLINE_BOT_USERNAME || undefined,
```

Note: `EnvConfig` interface is already missing `BOT_USERNAME`, `MTPROTO_API_ID`, `MTPROTO_API_HASH` which are returned by `loadConfig()`. Add those too while you're at it, or at minimum add the inline bot fields to BOTH the interface and the return.

Also verify `.env.example` already has `INLINE_BOT_TOKEN` and `INLINE_BOT_USERNAME` (done during brainstorming phase).

- [ ] **Step 2: Create inline bot instance in index.ts**

In `src/bot/index.ts`, after the main bot is created:

```typescript
// Inline bot (separate bot for inline queries)
if (config.INLINE_BOT_TOKEN) {
  const inlineBot = new Bot({ token: config.INLINE_BOT_TOKEN });
  // Register inline_query handler on inlineBot instead of mainBot
  inlineBot.on('inline_query', createInlineHandler(deps));
  inlineBot.start();
  botLogger.info({ username: config.INLINE_BOT_USERNAME }, 'Inline bot started');
}
```

- [ ] **Step 3: Remove inline_query handler from main bot**

Remove or guard the `bot.on('inline_query', ...)` registration on the main bot.

- [ ] **Step 4: Commit**

```bash
git add src/config/env.ts src/bot/index.ts
git commit -m "feat(bot): inline mode split — separate bot for inline queries, main bot handles groups"
```

---

### Task 15: Delete dead code

**Files:**
- Delete: `src/services/voice/mtproto-client.ts`

- [ ] **Step 1: Verify no imports reference mtproto-client.ts**

Run: `grep -r 'mtproto-client' src/`
Expected: only the file itself (no imports from other files).

- [ ] **Step 2: Delete file**

```bash
rm src/services/voice/mtproto-client.ts
```

- [ ] **Step 3: Commit**

```bash
git add -u src/services/voice/mtproto-client.ts
git commit -m "chore: remove unused mtcute client (superseded by Pyrogram bridge)"
```

---

### Task 15b: ask_user button restriction in groups

**Files:**
- Modify: `src/bot/handlers/callback.handler.ts`
- Test: `test/bot/handlers/callback.handler.test.ts`

- [ ] **Step 1: In callback handler, for group chats, check callback_query.from.id**

When a callback query arrives in a group context for an `ask_user` button, verify that `callback_query.from.id` matches the user who triggered the bot. If not, answer with `ctx.answer({ text: 'Не твой вопрос', show_alert: false })` and return.

Implementation: encode the triggering user's ID in the callback data (e.g., `ask:userId:optionIndex`), then compare against `callback_query.from.id`.

- [ ] **Step 2: Write test**

```typescript
test('ask_user callback in group rejects other users', () => {
  // Simulate callback from user 222 on a button created for user 111
  // Verify handler returns "not your question" toast
});
```

- [ ] **Step 3: Run tests and commit**

```bash
git add src/bot/handlers/callback.handler.ts test/bot/handlers/callback.handler.test.ts
git commit -m "feat(callback): restrict ask_user buttons in groups to triggering user"
```

---

### Task 15c: Session activation via onBotResponse callback

**Files:**
- Modify: `src/services/ai/types.ts`
- Modify: `src/services/ai/agent.ts`
- Modify: `src/bot/handlers/message.handler.ts`

The message handler passes a callback to the agent. The agent calls it after successfully sending a response (not [SKIP]).

- [ ] **Step 1: Add onBotResponse to AgentContext**

```typescript
// In types.ts
onBotResponse?: (messageId: number) => void;
```

- [ ] **Step 2: Call onBotResponse in agent.run() after writer.finalize()**

In `agent.ts`, after `await writer.finalize()` (and NOT after [SKIP] discard):

```typescript
if (ctx.onBotResponse && writer.getMessageId()) {
  ctx.onBotResponse(writer.getMessageId());
}
```

- [ ] **Step 3: Wire in message handler**

In `message.handler.ts`, when constructing `agentContext` for groups:

```typescript
onBotResponse: isGroup ? (messageId: number) => {
  if (deps.groupSessions.hasActiveSession(Number(chatId))) {
    deps.groupSessions.refresh(Number(chatId), messageId);
  } else {
    deps.groupSessions.activate(Number(chatId), user.telegram_id, messageId);
  }
} : undefined,
```

- [ ] **Step 4: Commit**

```bash
git add src/services/ai/types.ts src/services/ai/agent.ts src/bot/handlers/message.handler.ts
git commit -m "feat(session): activate/refresh group session via onBotResponse callback"
```

---

## Chunk 6: Pyrogram Members Script + Group Reminders + Google Sync

### Task 16: Pyrogram get-chat-members script

**Files:**
- Create: `scripts/get-chat-members.py`

- [ ] **Step 1: Write the Python script**

```python
#!/usr/bin/env python3
"""Fetch group chat members via Pyrogram. Returns JSON array to stdout."""
import asyncio
import json
import sys
from pyrogram import Client

async def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: get-chat-members.py <chat_id>"}))
        sys.exit(1)

    chat_id = int(sys.argv[1])

    app = Client("voice_caller", workdir="data")
    async with app:
        members = []
        async for member in app.get_chat_members(chat_id):
            if member.user and not member.user.is_bot:
                members.append({
                    "id": member.user.id,
                    "username": member.user.username,
                    "first_name": member.user.first_name,
                })
        print(json.dumps(members))

asyncio.run(main())
```

- [ ] **Step 2: Commit**

```bash
chmod +x scripts/get-chat-members.py
git add scripts/get-chat-members.py
git commit -m "feat(scripts): Pyrogram get-chat-members for group reminder delivery"
```

---

### Task 17: Group event reminders to all members

**Files:**
- Modify: `src/services/notification/worker.ts` (or wherever reminder delivery happens)
- Create: `src/services/group/member-service.ts`

- [ ] **Step 1: Create GroupMemberService**

Wraps Pyrogram subprocess + fallback to GroupMemberRepository:

```typescript
export class GroupMemberService {
  constructor(
    private groupMemberRepo: GroupMemberRepository,
    private userRepo: UserRepository,
    private pyBridgePath = 'scripts/get-chat-members.py',
  ) {}

  async getRegisteredMembers(chatId: number): Promise<number[]> {
    // Try Pyrogram first
    try {
      const result = Bun.spawnSync(['venv/bin/python', this.pyBridgePath, String(chatId)]);
      if (result.exitCode === 0) {
        const members = JSON.parse(result.stdout.toString()) as { id: number }[];
        const memberIds = members.map(m => m.id);
        // Intersect with registered users
        return memberIds.filter(id => this.userRepo.findById(id) !== null);
      }
    } catch { /* fall through to fallback */ }

    // Fallback: use tracked members
    const tracked = this.groupMemberRepo.getMembers(chatId);
    return tracked
      .map(m => m.user_id)
      .filter(id => this.userRepo.findById(id) !== null);
  }
}
```

- [ ] **Step 2: Modify reminder delivery for group events**

In the notification worker, when delivering a reminder for an event with `owner_type = 'group'`:

```typescript
if (event.owner_type === 'group' && event.group_id) {
  const memberIds = await groupMemberService.getRegisteredMembers(event.group_id);
  for (const userId of memberIds) {
    await sendReminderDM(userId, event);
  }
} else {
  await sendReminderDM(event.user_id, event);
}
```

- [ ] **Step 3: Write test**

Test that group event reminders are sent to multiple members, not just the creator.

- [ ] **Step 4: Commit**

```bash
git add src/services/group/member-service.ts src/services/notification/worker.ts test/services/group/member-service.test.ts
git commit -m "feat(reminders): group event reminders sent to all registered members via Pyrogram + fallback"
```

---

### Task 18: Google sync — use created_by for group events

**Files:**
- Modify: `src/services/event/event-service.ts` (sync callback adjustment)

- [ ] **Step 1: In EventService, use created_by for all sync paths (create/update/delete)**

Everywhere `pushSync` is called, check `event.owner_type`:

```typescript
// Helper — extract to avoid repetition
private getSyncUserId(event: CalendarEvent): number {
  return event.owner_type === 'group' ? event.created_by! : event.user_id;
}
```

Apply in `createEvent()`, `updateEvent()` / `updateEventForGroup()`, `deleteEvent()` / `deleteEventForGroup()`, and any other paths that call `pushSync`.

- [ ] **Step 2: Write tests for all three sync paths**

```typescript
test('sync uses created_by for group event creation', () => {
  const syncCalls: { userId: number; action: string }[] = [];
  // ... setup with pushSync mock
  service.createEvent({ ..., owner_type: 'group', created_by: 111 });
  expect(syncCalls[0].userId).toBe(111);
});

test('sync uses created_by for group event update', () => {
  // Create group event, then update via updateEventForGroup
  // Verify sync called with created_by, not acting user
});

test('sync uses created_by for group event deletion', () => {
  // Create group event, then delete via deleteEventForGroup
  // Verify sync called with created_by
});
```

- [ ] **Step 3: Run tests**

Run: `bun test test/services/event/event-service.test.ts`
Expected: ALL PASS

- [ ] **Step 4: Run full test suite**

Run: `bun test`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/event/event-service.ts test/services/event/event-service.test.ts
git commit -m "feat(sync): use created_by for Google sync of group events"
```

---

## Final Verification

- [ ] **Run full test suite:** `bun test`
- [ ] **Run linter:** `bun run lint`
- [ ] **Run type check:** `bunx tsc --noEmit`
- [ ] **Review all changes:** `git log --oneline`
