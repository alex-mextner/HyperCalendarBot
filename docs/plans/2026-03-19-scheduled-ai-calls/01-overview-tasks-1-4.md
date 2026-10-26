> Part 1 of 3 of [Scheduled AI Calls & Trigger System — Implementation Plan](../2026-03-19-scheduled-ai-calls.md) — next: [02-tasks-5-10.md](02-tasks-5-10.md)

## File Map

**New files:**
- `src/services/scheduled/domain-event-bus.ts` — typed EventEmitter wrapper
- `src/services/scheduled/trigger.repository.ts` — CRUD for `ai_triggers` table
- `src/services/scheduled/scheduled-ai-call.repository.ts` — CRUD for `scheduled_ai_calls`
- `src/services/scheduled/trigger.service.ts` — subscribes to bus, evals conditions, pushes to queue
- `src/services/scheduled/scheduled-ai-call.service.ts` — manages BullMQ delayed/repeat jobs
- `src/bot/agent-context-factory.ts` — extracted `agentContextBuilder` shared by layer + worker
- `src/worker/ai-messages-queue.ts` — BullMQ queue + worker + SyntheticPipelineRunner
- `src/worker/event-starting-checker.ts` — 1-minute cron that emits `myCalendar.eventStarting`
- `src/services/ai/tool-handlers/scheduled.ts` — 6 AI tool handlers
- `test/services/scheduled/domain-event-bus.test.ts`
- `test/services/scheduled/trigger.service.test.ts`
- `test/services/scheduled/trigger.repository.test.ts`
- `test/services/scheduled/scheduled-ai-call.service.test.ts`
- `test/worker/ai-messages-queue.test.ts`
- `test/worker/event-starting-checker.test.ts`
- `test/services/ai/tool-handlers/scheduled.test.ts`

**Modified files:**
- `src/database/migrations.ts` — add migrations 030, 031, 032
- `src/services/event/event-service.ts` — add optional 9th param `domainEvents`, emit on create/update/delete
- `src/services/sharing/invitation-service.ts` — add optional param `domainEvents`, emit `myInvitations.*`
- `src/services/ai/tool-handlers/events.ts` — emit `myCalendar.conflictDetected` after conflict check
- `src/services/ai/tools.ts` — +6 tool definitions
- `src/services/ai/tool-executor.ts` — route 6 new tool names to handlers
- `src/services/ai/types.ts` — add `scheduledCallService`, `triggerService` to `AgentContext`
- `src/bot/pipeline/ai-agent-layer.ts` — use `agentContextBuilder` from factory (re-export)
- `src/bot/index.ts` — wire `DomainEventBus`, `TriggerService`, pass to services
- `src/index.ts` — init `ai-messages` worker, `EventStartingChecker`

---

## Task 1: DB migrations — 3 new tables

**Files:**
- Modify: `src/database/migrations.ts`

- [ ] **Step 1: Add 3 migrations at the bottom of the migrations array**

Append after the last entry (`029_drop_notification_utc_columns`):

```ts
  {
    name: '030_scheduled_ai_calls',
    up: (db) => {
      db.exec(`
        CREATE TABLE scheduled_ai_calls (
          id          TEXT PRIMARY KEY,
          user_id     INTEGER NOT NULL,
          message     TEXT NOT NULL,
          label       TEXT,
          run_at      TEXT,
          cron        TEXT,
          enabled     INTEGER NOT NULL DEFAULT 1,
          run_count   INTEGER NOT NULL DEFAULT 0,
          last_run_at TEXT,
          created_at  TEXT NOT NULL
        )
      `);
    },
  },
  {
    name: '031_ai_triggers',
    up: (db) => {
      db.exec(`
        CREATE TABLE ai_triggers (
          id            TEXT PRIMARY KEY,
          user_id       INTEGER NOT NULL,
          topic         TEXT NOT NULL,
          condition     TEXT,
          action        TEXT NOT NULL,
          label         TEXT,
          once          INTEGER NOT NULL DEFAULT 0,
          enabled       INTEGER NOT NULL DEFAULT 1,
          fire_count    INTEGER NOT NULL DEFAULT 0,
          last_fired_at TEXT,
          created_at    TEXT NOT NULL
        )
      `);
    },
  },
  {
    name: '032_event_starting_log',
    up: (db) => {
      db.exec(`
        CREATE TABLE event_starting_log (
          event_id    INTEGER PRIMARY KEY,
          notified_at TEXT NOT NULL
        )
      `);
    },
  },
```

- [ ] **Step 2: Run migrations to verify**

```bash
bun run src/index.ts --dry-run 2>&1 | head -20
# Or just verify migration file parses:
bun run -e "import('./src/database/migrations.ts').then(m => console.log(m.migrations.length + ' migrations'))"
```
Expected: no TypeScript errors, count increased by 3.

- [ ] **Step 3: Commit**

```bash
git add src/database/migrations.ts
git commit -m "feat(scheduled): add scheduled_ai_calls, ai_triggers, event_starting_log migrations"
```

---

## Task 2: DomainEventBus

**Files:**
- Create: `src/services/scheduled/domain-event-bus.ts`
- Create: `test/services/scheduled/domain-event-bus.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// test/services/scheduled/domain-event-bus.test.ts
import { describe, expect, mock, test } from 'bun:test';
import { DomainEventBus } from '../../../src/services/scheduled/domain-event-bus.ts';

describe('DomainEventBus', () => {
  test('emits typed event to subscriber', () => {
    const bus = new DomainEventBus();
    const handler = mock(() => {});
    bus.on('myCalendar.newEvent', handler);
    const payload = { userId: 1, newEvent: { id: 1, title: 'Test' } as never };
    bus.emit('myCalendar.newEvent', payload);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(payload);
  });

  test('multiple subscribers all receive event', () => {
    const bus = new DomainEventBus();
    const h1 = mock(() => {});
    const h2 = mock(() => {});
    bus.on('myCalendar.deletedEvent', h1);
    bus.on('myCalendar.deletedEvent', h2);
    bus.emit('myCalendar.deletedEvent', { userId: 1, eventId: 1, title: 'Test' });
    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
  });

  test('subscriber for different topic does not receive event', () => {
    const bus = new DomainEventBus();
    const handler = mock(() => {});
    bus.on('myInvitations.accepted', handler);
    bus.emit('myCalendar.newEvent', { userId: 1, newEvent: { id: 1, title: 'Test' } as never });
    expect(handler).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test test/services/scheduled/domain-event-bus.test.ts
```
Expected: FAIL — `DomainEventBus` not found.

- [ ] **Step 3: Implement**

```ts
// src/services/scheduled/domain-event-bus.ts
import { EventEmitter } from 'node:events';
import type { CalendarEvent } from '../../database/types.ts';

export type DomainEventMap = {
  'myCalendar.newEvent':         { userId: number; newEvent: CalendarEvent }
  'myCalendar.updatedEvent':     { userId: number; updatedEvent: CalendarEvent; oldEvent: CalendarEvent }
  'myCalendar.deletedEvent':     { userId: number; eventId: number; title: string }
  'myCalendar.conflictDetected': { userId: number; event: CalendarEvent; conflictsWith: CalendarEvent }
  'myCalendar.eventStarting':    { userId: number; event: CalendarEvent }
  'myInvitations.accepted':      { userId: number; inviteeId: number; event: CalendarEvent }
  'myInvitations.rejected':      { userId: number; inviteeId: number; event: CalendarEvent }
  'myGroup.newEvent':            { userId: number; groupChatId: number; newEvent: CalendarEvent; createdBy: number }
}

export type DomainEventTopic = keyof DomainEventMap;

export const ALL_TOPICS = Object.freeze([
  'myCalendar.newEvent',
  'myCalendar.updatedEvent',
  'myCalendar.deletedEvent',
  'myCalendar.conflictDetected',
  'myCalendar.eventStarting',
  'myInvitations.accepted',
  'myInvitations.rejected',
  'myGroup.newEvent',
] as const satisfies readonly DomainEventTopic[]);

export class DomainEventBus {
  private emitter = new EventEmitter();

  emit<T extends DomainEventTopic>(topic: T, payload: DomainEventMap[T]): void {
    this.emitter.emit(topic, payload);
  }

  on<T extends DomainEventTopic>(topic: T, handler: (payload: DomainEventMap[T]) => void): void {
    this.emitter.on(topic, handler as (payload: unknown) => void);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test test/services/scheduled/domain-event-bus.test.ts
```
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/services/scheduled/domain-event-bus.ts test/services/scheduled/domain-event-bus.test.ts
git commit -m "feat(scheduled): add DomainEventBus"
```

---

## Task 3: TriggerRepository + ScheduledAiCallRepository

**Files:**
- Create: `src/services/scheduled/trigger.repository.ts`
- Create: `src/services/scheduled/scheduled-ai-call.repository.ts`
- Create: `test/services/scheduled/trigger.repository.test.ts`

- [ ] **Step 1: Write failing tests for TriggerRepository**

```ts
// test/services/scheduled/trigger.repository.test.ts
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { runMigrations } from '../../../src/database/schema.ts';
import { migrations } from '../../../src/database/migrations.ts';
import { TriggerRepository } from '../../../src/services/scheduled/trigger.repository.ts';

function makeDb() {
  const db = new Database(':memory:');
  runMigrations(db, migrations);
  return db;
}

describe('TriggerRepository', () => {
  test('create and findEnabled', () => {
    const repo = new TriggerRepository(makeDb());
    const id = repo.create({ userId: 1, topic: 'myCalendar.newEvent', action: 'call me', label: null, condition: null, once: false });
    const results = repo.findEnabled(1, 'myCalendar.newEvent');
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe(id);
    expect(results[0]!.action).toBe('call me');
  });

  test('findEnabled excludes disabled', () => {
    const db = makeDb();
    const repo = new TriggerRepository(db);
    const id = repo.create({ userId: 1, topic: 'myCalendar.newEvent', action: 'x', label: null, condition: null, once: false });
    repo.disable(id);
    expect(repo.findEnabled(1, 'myCalendar.newEvent')).toHaveLength(0);
  });

  test('incrementFireCount and disable atomically', () => {
    const db = makeDb();
    const repo = new TriggerRepository(db);
    const id = repo.create({ userId: 1, topic: 'myCalendar.newEvent', action: 'x', label: null, condition: null, once: true });
    repo.recordFire(id, true);
    const results = repo.findEnabled(1, 'myCalendar.newEvent');
    expect(results).toHaveLength(0); // disabled
    const all = repo.listByUser(1);
    expect(all[0]!.fire_count).toBe(1);
    expect(all[0]!.enabled).toBe(0);
  });

  test('countEnabled respects limit check', () => {
    const db = makeDb();
    const repo = new TriggerRepository(db);
    for (let i = 0; i < 3; i++) {
      repo.create({ userId: 1, topic: 'myCalendar.newEvent', action: 'x', label: null, condition: null, once: false });
    }
    expect(repo.countEnabled(1)).toBe(3);
  });

  test('remove deletes trigger', () => {
    const db = makeDb();
    const repo = new TriggerRepository(db);
    const id = repo.create({ userId: 1, topic: 'myCalendar.newEvent', action: 'x', label: null, condition: null, once: false });
    repo.remove(id, 1);
    expect(repo.listByUser(1)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test test/services/scheduled/trigger.repository.test.ts
```
Expected: FAIL — `TriggerRepository` not found.

- [ ] **Step 3: Implement TriggerRepository**

```ts
// src/services/scheduled/trigger.repository.ts
import type { Database } from 'bun:sqlite';

export interface Trigger {
  id: string;
  user_id: number;
  topic: string;
  condition: string | null;
  action: string;
  label: string | null;
  once: number;
  enabled: number;
  fire_count: number;
  last_fired_at: string | null;
  created_at: string;
}

export interface CreateTriggerData {
  userId: number;
  topic: string;
  action: string;
  condition: string | null;
  label: string | null;
  once: boolean;
}

export class TriggerRepository {
  constructor(private db: Database) {}

  create(data: CreateTriggerData): string {
    const id = crypto.randomUUID();
    this.db
      .prepare(`
        INSERT INTO ai_triggers (id, user_id, topic, condition, action, label, once, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        data.userId,
        data.topic,
        data.condition ?? null,
        data.action,
        data.label ?? null,
        data.once ? 1 : 0,
        new Date().toISOString(),
      );
    return id;
  }

  findEnabled(userId: number, topic: string): Trigger[] {
    return this.db
      .prepare('SELECT * FROM ai_triggers WHERE user_id = ? AND topic = ? AND enabled = 1')
      .all(userId, topic) as Trigger[];
  }

  listByUser(userId: number): Trigger[] {
    return this.db
      .prepare('SELECT * FROM ai_triggers WHERE user_id = ? ORDER BY created_at DESC')
      .all(userId) as Trigger[];
  }

  countEnabled(userId: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as n FROM ai_triggers WHERE user_id = ? AND enabled = 1')
      .get(userId) as { n: number };
    return row.n;
  }

  disable(id: string): void {
    this.db.prepare('UPDATE ai_triggers SET enabled = 0 WHERE id = ?').run(id);
  }

  /**
   * Atomically increment fire_count, update last_fired_at, and optionally disable.
   * DB transaction ensures no double-fire for `once` triggers.
   */
  recordFire(id: string, disableAfter: boolean): void {
    this.db.transaction(() => {
      this.db
        .prepare('UPDATE ai_triggers SET fire_count = fire_count + 1, last_fired_at = ? WHERE id = ?')
        .run(new Date().toISOString(), id);
      if (disableAfter) {
        this.db.prepare('UPDATE ai_triggers SET enabled = 0 WHERE id = ?').run(id);
      }
    })();
  }

  remove(id: string, userId: number): void {
    this.db.prepare('DELETE FROM ai_triggers WHERE id = ? AND user_id = ?').run(id, userId);
  }
}
```

- [ ] **Step 4: Implement ScheduledAiCallRepository**

```ts
// src/services/scheduled/scheduled-ai-call.repository.ts
import type { Database } from 'bun:sqlite';

export interface ScheduledAiCall {
  id: string;
  user_id: number;
  message: string;
  label: string | null;
  run_at: string | null;
  cron: string | null;
  enabled: number;
  run_count: number;
  last_run_at: string | null;
  created_at: string;
}

export interface CreateScheduleData {
  userId: number;
  message: string;
  label: string | null;
  runAt: string | null;
  cron: string | null;
}

export class ScheduledAiCallRepository {
  constructor(private db: Database) {}

  create(data: CreateScheduleData): ScheduledAiCall {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(`
        INSERT INTO scheduled_ai_calls (id, user_id, message, label, run_at, cron, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(id, data.userId, data.message, data.label ?? null, data.runAt ?? null, data.cron ?? null, now);
    return this.findById(id)!;
  }

  findById(id: string): ScheduledAiCall | null {
    return this.db.prepare('SELECT * FROM scheduled_ai_calls WHERE id = ?').get(id) as ScheduledAiCall | null;
  }

  listEnabled(userId: number): ScheduledAiCall[] {
    return this.db
      .prepare('SELECT * FROM scheduled_ai_calls WHERE user_id = ? AND enabled = 1 ORDER BY created_at DESC')
      .all(userId) as ScheduledAiCall[];
  }

  countEnabled(userId: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as n FROM scheduled_ai_calls WHERE user_id = ? AND enabled = 1')
      .get(userId) as { n: number };
    return row.n;
  }

  disable(id: string): void {
    this.db.prepare('UPDATE scheduled_ai_calls SET enabled = 0 WHERE id = ?').run(id);
  }

  recordRun(id: string): void {
    this.db
      .prepare('UPDATE scheduled_ai_calls SET run_count = run_count + 1, last_run_at = ? WHERE id = ?')
      .run(new Date().toISOString(), id);
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
bun test test/services/scheduled/trigger.repository.test.ts
```
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add src/services/scheduled/trigger.repository.ts src/services/scheduled/scheduled-ai-call.repository.ts test/services/scheduled/trigger.repository.test.ts
git commit -m "feat(scheduled): add TriggerRepository and ScheduledAiCallRepository"
```

---

## Task 4: TriggerService

**Files:**
- Create: `src/services/scheduled/trigger.service.ts`
- Create: `test/services/scheduled/trigger.service.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// test/services/scheduled/trigger.service.test.ts
import { describe, expect, mock, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { runMigrations } from '../../../src/database/schema.ts';
import { migrations } from '../../../src/database/migrations.ts';
import { DomainEventBus } from '../../../src/services/scheduled/domain-event-bus.ts';
import { TriggerRepository } from '../../../src/services/scheduled/trigger.repository.ts';
import { TriggerService } from '../../../src/services/scheduled/trigger.service.ts';

function makeSetup() {
  const db = new Database(':memory:');
  runMigrations(db, migrations);
  const bus = new DomainEventBus();
  const repo = new TriggerRepository(db);
  const push = mock(async () => {});
  const service = new TriggerService(bus, repo, push);
  service.subscribe();
  return { bus, repo, push };
}

describe('TriggerService', () => {
  test('fires action when topic matches and no condition', async () => {
    const { bus, repo, push } = makeSetup();
    repo.create({ userId: 1, topic: 'myCalendar.newEvent', action: 'call me', label: null, condition: null, once: false });
    bus.emit('myCalendar.newEvent', { userId: 1, newEvent: { id: 1, title: 'X' } as never });
    await Promise.resolve();
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ userId: 1, message: 'call me', source: 'trigger' }));
  });

  test('does not fire when condition is false', async () => {
    const { bus, repo, push } = makeSetup();
    repo.create({ userId: 1, topic: 'myCalendar.newEvent', action: 'x', label: null, condition: 'newEvent.id == 99', once: false });
    bus.emit('myCalendar.newEvent', { userId: 1, newEvent: { id: 1, title: 'X' } as never });
    await Promise.resolve();
    expect(push).not.toHaveBeenCalled();
  });

  test('fires when condition is true', async () => {
    const { bus, repo, push } = makeSetup();
    repo.create({ userId: 1, topic: 'myCalendar.newEvent', action: 'x', label: null, condition: 'newEvent.id == 1', once: false });
    bus.emit('myCalendar.newEvent', { userId: 1, newEvent: { id: 1, title: 'X' } as never });
    await Promise.resolve();
    expect(push).toHaveBeenCalledTimes(1);
  });

  test('once trigger is disabled after fire', async () => {
    const { bus, repo, push } = makeSetup();
    const id = repo.create({ userId: 1, topic: 'myCalendar.newEvent', action: 'x', label: null, condition: null, once: true });
    bus.emit('myCalendar.newEvent', { userId: 1, newEvent: { id: 1, title: 'X' } as never });
    await Promise.resolve();
    expect(push).toHaveBeenCalledTimes(1);
    // Second emit should not fire
    bus.emit('myCalendar.newEvent', { userId: 1, newEvent: { id: 2, title: 'Y' } as never });
    await Promise.resolve();
    expect(push).toHaveBeenCalledTimes(1);
    expect(repo.findEnabled(1, 'myCalendar.newEvent')).toHaveLength(0);
  });

  test('skips trigger with invalid condition (fail-closed)', async () => {
    const { bus, repo, push } = makeSetup();
    repo.create({ userId: 1, topic: 'myCalendar.newEvent', action: 'x', label: null, condition: '!!! invalid !!!', once: false });
    bus.emit('myCalendar.newEvent', { userId: 1, newEvent: { id: 1, title: 'X' } as never });
    await Promise.resolve();
    expect(push).not.toHaveBeenCalled();
  });

  test('once trigger stays disabled if push throws', async () => {
    const db = new Database(':memory:');
    runMigrations(db, migrations);
    const bus = new DomainEventBus();
    const repo = new TriggerRepository(db);
    const pushFail = mock(async () => { throw new Error('Redis down'); });
    const service = new TriggerService(bus, repo, pushFail);
    service.subscribe();
    repo.create({ userId: 1, topic: 'myCalendar.newEvent', action: 'x', label: null, condition: null, once: true });
    bus.emit('myCalendar.newEvent', { userId: 1, newEvent: { id: 1, title: 'X' } as never });
    await Promise.resolve();
    // Trigger is disabled even though push failed
    expect(repo.findEnabled(1, 'myCalendar.newEvent')).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test test/services/scheduled/trigger.service.test.ts
```
Expected: FAIL — `TriggerService` not found.

- [ ] **Step 3: Implement TriggerService**

```ts
// src/services/scheduled/trigger.service.ts
import { evaluate } from '../intent/expression-evaluator.ts';
import { logger } from '../../utils/logger.ts';
import { type DomainEventTopic, ALL_TOPICS, type DomainEventBus, type DomainEventMap } from './domain-event-bus.ts';
import type { TriggerRepository } from './trigger.repository.ts';

const triggerLogger = logger.child({ module: 'trigger-service' });

export interface AiMessageJobData {
  userId: number;
  message: string;
  source: 'scheduled' | 'trigger';
  scheduleId?: string;
  triggerId?: string;
}

export class TriggerService {
  constructor(
    private bus: DomainEventBus,
    private repo: TriggerRepository,
    private pushToQueue: (data: AiMessageJobData) => Promise<void>,
  ) {}

  subscribe(): void {
    for (const topic of ALL_TOPICS) {
      this.bus.on(topic, (payload) => {
        this.handleEvent(topic, payload as DomainEventMap[DomainEventTopic]).catch((err: unknown) => {
          triggerLogger.error({ err, topic }, 'TriggerService: unhandled error in handleEvent');
        });
      });
    }
  }

  private async handleEvent(topic: DomainEventTopic, payload: DomainEventMap[DomainEventTopic]): Promise<void> {
    const { userId } = payload;
    const triggers = this.repo.findEnabled(userId, topic);
    if (triggers.length === 0) return;

    for (const trigger of triggers) {
      if (trigger.condition) {
        try {
          const passes = evaluate(trigger.condition, payload as Record<string, unknown>);
          if (!passes) continue;
        } catch (err: unknown) {
          triggerLogger.warn({ err, triggerId: trigger.id, condition: trigger.condition }, 'Condition eval failed, skipping');
          continue;
        }
      }

      // Commit DB state BEFORE pushing to queue (once = no double-fire)
      this.repo.recordFire(trigger.id, trigger.once === 1);

      try {
        await this.pushToQueue({
          userId,
          message: trigger.action,
          source: 'trigger',
          triggerId: trigger.id,
        });
      } catch (err: unknown) {
        triggerLogger.error({ err, triggerId: trigger.id }, 'Failed to push trigger action to queue — action lost');
      }
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test test/services/scheduled/trigger.service.test.ts
```
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/services/scheduled/trigger.service.ts test/services/scheduled/trigger.service.test.ts
git commit -m "feat(scheduled): add TriggerService with condition eval and once-atomicity"
```

---

