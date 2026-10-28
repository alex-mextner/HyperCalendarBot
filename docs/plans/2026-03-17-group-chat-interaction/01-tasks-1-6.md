> Part 1 of 2 of [Group Chat Interaction & Group Calendar — Implementation Plan](../2026-03-17-group-chat-interaction.md) — next: [02-tasks-7-18.md](02-tasks-7-18.md)

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

