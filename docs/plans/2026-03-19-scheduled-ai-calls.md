# Scheduled AI Calls & Trigger System — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add time-based scheduled AI pipeline invocations and event-driven trigger system so users can say "call me tomorrow" or "notify me when a meeting is added".

**Architecture:** BullMQ `ai-messages` queue + `SyntheticPipelineRunner` that runs IntentMatcher → AiAgent without a GramIO context. `DomainEventBus` (in-process typed EventEmitter) carries domain events to `TriggerService` which evaluates conditions and pushes jobs to the same queue. 6 new AI tools expose both systems.

**Tech Stack:** BullMQ, bun:sqlite, `expression-evaluator.ts` (existing), `nanoid`, TypeScript

**Spec:** `docs/specs/2026-03-19-scheduled-ai-calls-design.md`

---

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

## Task 5: ScheduledAiCallService

**Files:**
- Create: `src/services/scheduled/scheduled-ai-call.service.ts`
- Create: `test/services/scheduled/scheduled-ai-call.service.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// test/services/scheduled/scheduled-ai-call.service.test.ts
import { describe, expect, mock, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { runMigrations } from '../../../src/database/schema.ts';
import { migrations } from '../../../src/database/migrations.ts';
import { ScheduledAiCallRepository } from '../../../src/services/scheduled/scheduled-ai-call.repository.ts';
import { ScheduledAiCallService } from '../../../src/services/scheduled/scheduled-ai-call.service.ts';

function makeService() {
  const db = new Database(':memory:');
  runMigrations(db, migrations);
  const repo = new ScheduledAiCallRepository(db);
  const addDelayed = mock(async (_data: unknown, _delayMs: number) => 'job-1');
  const addRepeat = mock(async (_data: unknown, _cron: string) => {});
  const removeDelayed = mock(async (_scheduleId: string) => {});
  const removeRepeat = mock(async (_cron: string) => {});
  const service = new ScheduledAiCallService(repo, { addDelayed, addRepeat, removeDelayed, removeRepeat });
  return { service, repo, addDelayed, addRepeat, removeDelayed, removeRepeat };
}

describe('ScheduledAiCallService', () => {
  test('create one-time schedule: saves to DB and calls addDelayed', async () => {
    const { service, repo, addDelayed } = makeService();
    const futureTime = new Date(Date.now() + 60_000).toISOString();
    const id = await service.create({ userId: 1, message: 'call me', runAt: futureTime, cron: null, label: 'test' });
    expect(addDelayed).toHaveBeenCalledTimes(1);
    expect(repo.findById(id)).not.toBeNull();
  });

  test('create recurring schedule: saves to DB and calls addRepeat', async () => {
    const { service, repo, addRepeat } = makeService();
    const id = await service.create({ userId: 1, message: 'ping', runAt: null, cron: '0 11 * * *', label: null });
    expect(addRepeat).toHaveBeenCalledTimes(1);
    expect(repo.findById(id)?.cron).toBe('0 11 * * *');
  });

  test('enforces per-user limit of 50', async () => {
    const { service } = makeService();
    const futureTime = new Date(Date.now() + 60_000).toISOString();
    for (let i = 0; i < 50; i++) {
      await service.create({ userId: 1, message: 'x', runAt: futureTime, cron: null, label: null });
    }
    await expect(service.create({ userId: 1, message: 'x', runAt: futureTime, cron: null, label: null }))
      .rejects.toThrow('limit');
  });

  test('cancel disables in DB and calls removeDelayed', async () => {
    const { service, repo, removeDelayed } = makeService();
    const futureTime = new Date(Date.now() + 60_000).toISOString();
    const id = await service.create({ userId: 1, message: 'x', runAt: futureTime, cron: null, label: null });
    await service.cancel(id);
    expect(removeDelayed).toHaveBeenCalledWith(id);
    expect(repo.findById(id)?.enabled).toBe(0);
  });

  test('cancel recurring calls removeRepeat with cron pattern', async () => {
    const { service, repo, removeRepeat } = makeService();
    const id = await service.create({ userId: 1, message: 'x', runAt: null, cron: '0 9 * * 1', label: null });
    await service.cancel(id);
    expect(removeRepeat).toHaveBeenCalledWith('0 9 * * 1');
    expect(repo.findById(id)?.enabled).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test test/services/scheduled/scheduled-ai-call.service.test.ts
```
Expected: FAIL — `ScheduledAiCallService` not found.

- [ ] **Step 3: Implement ScheduledAiCallService**

```ts
// src/services/scheduled/scheduled-ai-call.service.ts
import { logger } from '../../utils/logger.ts';
import type { ScheduledAiCall, ScheduledAiCallRepository } from './scheduled-ai-call.repository.ts';

const scheduleLogger = logger.child({ module: 'scheduled-ai-call' });

const USER_LIMIT = 50;

export interface CreateScheduleInput {
  userId: number;
  message: string;
  runAt: string | null;
  cron: string | null;
  label: string | null;
}

export interface QueueAdapter {
  addDelayed(data: Record<string, unknown>, delayMs: number): Promise<string>;
  addRepeat(data: Record<string, unknown>, cron: string): Promise<void>;
  removeDelayed(scheduleId: string): Promise<void>;
  removeRepeat(cron: string): Promise<void>;
}

export class ScheduledAiCallService {
  constructor(
    private repo: ScheduledAiCallRepository,
    private queue: QueueAdapter,
  ) {}

  async create(input: CreateScheduleInput): Promise<string> {
    if (!input.runAt && !input.cron) throw new Error('Either runAt or cron must be provided');
    if (input.runAt && input.cron) throw new Error('Only one of runAt or cron may be provided');

    const count = this.repo.countEnabled(input.userId);
    if (count >= USER_LIMIT) throw new Error(`Scheduled calls limit (${USER_LIMIT}) reached for this user`);

    const schedule = this.repo.create({
      userId: input.userId,
      message: input.message,
      label: input.label,
      runAt: input.runAt,
      cron: input.cron,
    });

    if (input.runAt) {
      const delayMs = new Date(input.runAt).getTime() - Date.now();
      if (delayMs < 0) throw new Error('run_at must be in the future');
      await this.queue.addDelayed(
        { userId: input.userId, message: input.message, source: 'scheduled', scheduleId: schedule.id },
        delayMs,
      );
    } else {
      await this.queue.addRepeat(
        { userId: input.userId, message: input.message, source: 'scheduled', scheduleId: schedule.id },
        input.cron!,
      );
    }

    scheduleLogger.info({ scheduleId: schedule.id, userId: input.userId }, 'Scheduled AI call created');
    return schedule.id;
  }

  list(userId: number): ScheduledAiCall[] {
    return this.repo.listEnabled(userId);
  }

  async cancel(id: string): Promise<void> {
    const schedule = this.repo.findById(id);
    if (!schedule) return;

    if (schedule.cron) {
      await this.queue.removeRepeat(schedule.cron);
    } else {
      await this.queue.removeDelayed(id);
    }

    this.repo.disable(id);
    scheduleLogger.info({ scheduleId: id }, 'Scheduled AI call cancelled');
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test test/services/scheduled/scheduled-ai-call.service.test.ts
```
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/services/scheduled/scheduled-ai-call.service.ts test/services/scheduled/scheduled-ai-call.service.test.ts src/services/scheduled/scheduled-ai-call.repository.ts
git commit -m "feat(scheduled): add ScheduledAiCallService with BullMQ integration"
```

---

## Task 6: Create AgentContextBuilder shared type

**Files:**
- Create: `src/bot/agent-context-factory.ts`
- Modify: `src/bot/pipeline/ai-agent-layer.ts`

The actual `agentContextBuilder` implementation lives in `src/bot/handlers/message.handler.ts` as `buildAgentContextFactory(deps)` (line 331). This task creates a shared type so the worker can import it without depending on GramIO. No code is moved.

- [ ] **Step 1: Create the type-only factory file**

```ts
// src/bot/agent-context-factory.ts
// Shared type for the agentContextBuilder function.
// Implementation: buildAgentContextFactory() in src/bot/handlers/message.handler.ts
// This file exists so worker code can import the type without depending on GramIO.

import type { User } from '../database/types.ts';
import type { AgentContext } from '../services/ai/types.ts';

export type AgentContextBuilder = (
  user: User,
  chatId: number,
  messageText: string,
  groupInfo?: {
    isGroup: boolean;
    groupChatId?: number;
    groupTitle?: string;
    onBotResponse?: (messageId: number) => void;
  },
) => AgentContext;
```

- [ ] **Step 2: Update ai-agent-layer.ts to import AgentContextBuilder from shared file**

In `src/bot/pipeline/ai-agent-layer.ts`, the `agentContextBuilder` in `AgentLayerDeps` already has an inline type. Replace that inline type with an import:

```ts
import type { AgentContextBuilder } from '../agent-context-factory.ts';

export interface AgentLayerDeps {
  agent: CalendarBotAgent;
  agentContextBuilder: AgentContextBuilder;
  intentLearner?: IntentLearner;
}
```

- [ ] **Step 3: Verify no TypeScript errors**

```bash
bun run lint
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/bot/agent-context-factory.ts src/bot/pipeline/ai-agent-layer.ts
git commit -m "refactor(bot): extract AgentContextBuilder type to shared file"
```

---

## Task 7: ai-messages queue + SyntheticPipelineRunner

**Files:**
- Create: `src/worker/ai-messages-queue.ts`
- Create: `test/worker/ai-messages-queue.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// test/worker/ai-messages-queue.test.ts
import { describe, expect, mock, test } from 'bun:test';
import { SyntheticPipelineRunner } from '../../src/worker/ai-messages-queue.ts';
import type { AgentContext } from '../../src/services/ai/types.ts';
import type { User } from '../../src/database/types.ts';

const fakeUser: User = {
  telegram_id: 1,
  language: 'en',
  timezone: 'UTC',
  username: null,
  first_name: null,
  country_code: null,
  google_refresh_token_enc: null,
  google_calendar_id: null,
  onboarding_completed: 1,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
} as User;

describe('SyntheticPipelineRunner', () => {
  test('runs intent path when intent matches', async () => {
    const agentCtx = { user: fakeUser, sender: { sendMessage: mock(async () => ({ message_id: 1 })) } } as unknown as AgentContext;
    const contextBuilder = mock(() => agentCtx);
    const intentRun = mock(async () => ({ handled: true, response: 'ok' }));
    const agentRun = mock(async () => {});

    const runner = new SyntheticPipelineRunner({ contextBuilder, intentRun, agentRun });
    await runner.run(fakeUser, 'test message');

    expect(intentRun).toHaveBeenCalledTimes(1);
    expect(agentRun).not.toHaveBeenCalled();
  });

  test('falls through to AI agent when no intent matches', async () => {
    const agentCtx = { user: fakeUser } as unknown as AgentContext;
    const contextBuilder = mock(() => agentCtx);
    const intentRun = mock(async () => ({ handled: false }));
    const agentRun = mock(async () => {});

    const runner = new SyntheticPipelineRunner({ contextBuilder, intentRun, agentRun });
    await runner.run(fakeUser, 'test message');

    expect(intentRun).toHaveBeenCalledTimes(1);
    expect(agentRun).toHaveBeenCalledTimes(1);
  });

  test('catches errors and does not rethrow', async () => {
    const contextBuilder = mock(() => { throw new Error('context build failed'); });
    const intentRun = mock(async () => ({ handled: false }));
    const agentRun = mock(async () => {});

    const runner = new SyntheticPipelineRunner({ contextBuilder, intentRun, agentRun });
    // Must not throw
    await expect(runner.run(fakeUser, 'test')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test test/worker/ai-messages-queue.test.ts
```
Expected: FAIL — `SyntheticPipelineRunner` not found.

- [ ] **Step 3: Implement ai-messages-queue.ts**

```ts
// src/worker/ai-messages-queue.ts
import { Queue, Worker } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import type { User } from '../database/types.ts';
import type { AgentContext } from '../services/ai/types.ts';
import type { AgentContextBuilder } from '../bot/agent-context-factory.ts';
import { logger } from '../utils/logger.ts';

const queueLogger = logger.child({ module: 'ai-messages' });

export interface AiMessageJobData {
  userId: number;
  message: string;
  source: 'scheduled' | 'trigger';
  scheduleId?: string;
  triggerId?: string;
}

export interface SyntheticPipelineRunnerDeps {
  contextBuilder: AgentContextBuilder;
  intentRun: (agentCtx: AgentContext, message: string) => Promise<{ handled: boolean; response?: string }>;
  agentRun: (agentCtx: AgentContext) => Promise<void>;
}

export class SyntheticPipelineRunner {
  constructor(private deps: SyntheticPipelineRunnerDeps) {}

  async run(user: User, message: string): Promise<void> {
    try {
      const agentCtx = this.deps.contextBuilder(user, user.telegram_id, message);
      const intentResult = await this.deps.intentRun(agentCtx, message);
      if (!intentResult.handled) {
        await this.deps.agentRun(agentCtx);
      }
    } catch (err: unknown) {
      queueLogger.error({ err, userId: user.telegram_id, message }, 'SyntheticPipelineRunner error');
    }
  }
}

export function createAiMessagesQueue(connection: ConnectionOptions) {
  const queue = new Queue<AiMessageJobData>('ai-messages', {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 10_000 },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500 },
    },
  });

  return {
    queue,
    async addDelayed(data: Record<string, unknown>, delayMs: number): Promise<string> {
      const job = await queue.add('ai-schedule', data as AiMessageJobData, { delay: delayMs });
      return job.id ?? '';
    },
    async addRepeat(data: Record<string, unknown>, cron: string): Promise<void> {
      await queue.add('ai-schedule', data as AiMessageJobData, { repeat: { pattern: cron } });
    },
    async removeDelayed(scheduleId: string): Promise<void> {
      const delayed = await queue.getDelayed();
      for (const job of delayed) {
        if ((job.data as AiMessageJobData).scheduleId === scheduleId) {
          await job.remove();
          return;
        }
      }
    },
    async removeRepeat(cron: string): Promise<void> {
      await queue.removeRepeatable('ai-schedule', { pattern: cron });
    },
    async pushTrigger(data: AiMessageJobData): Promise<void> {
      await queue.add('ai-trigger', data);
    },
  };
}

export function createAiMessagesWorker(
  connection: ConnectionOptions,
  runner: SyntheticPipelineRunner,
  getUserById: (id: number) => User | null,
  onRunComplete?: (scheduleId: string) => void,
) {
  const worker = new Worker<AiMessageJobData>(
    'ai-messages',
    async (job) => {
      const { userId, message, scheduleId } = job.data;
      queueLogger.info({ userId, source: job.data.source, scheduleId, triggerId: job.data.triggerId }, 'Processing ai-message job');

      const user = getUserById(userId);
      if (!user) {
        queueLogger.warn({ userId }, 'User not found for ai-message job, skipping');
        return;
      }

      await runner.run(user, message);

      if (scheduleId && onRunComplete) {
        onRunComplete(scheduleId);
      }
    },
    { connection, concurrency: 5 },
  );

  worker.on('failed', (job, err) => {
    queueLogger.error({ jobId: job?.id, err }, 'ai-messages job failed');
  });

  return worker;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test test/worker/ai-messages-queue.test.ts
```
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/worker/ai-messages-queue.ts test/worker/ai-messages-queue.test.ts
git commit -m "feat(scheduled): add ai-messages BullMQ queue and SyntheticPipelineRunner"
```

---

## Task 8: EventStartingChecker

**Files:**
- Create: `src/worker/event-starting-checker.ts`
- Create: `test/worker/event-starting-checker.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// test/worker/event-starting-checker.test.ts
import { describe, expect, mock, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { runMigrations } from '../../src/database/schema.ts';
import { migrations } from '../../src/database/migrations.ts';
import { EventStartingChecker } from '../../src/worker/event-starting-checker.ts';
import { DomainEventBus } from '../../src/services/scheduled/domain-event-bus.ts';
import type { CalendarEvent } from '../../src/database/types.ts';

function makeDb() {
  const db = new Database(':memory:');
  runMigrations(db, migrations);
  return db;
}

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 1, user_id: 1, title: 'Test', start_at: new Date(Date.now() + 30_000).toISOString(),
    end_at: null, all_day: 0, description: null, category: null, timezone: 'UTC',
    location: null, recurrence_rule: null, recurrence_end_at: null,
    owner_type: 'user', group_id: null, created_by: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    ...overrides,
  } as CalendarEvent;
}

describe('EventStartingChecker', () => {
  test('emits eventStarting for upcoming non-all-day events', async () => {
    const db = makeDb();
    const bus = new DomainEventBus();
    const handler = mock(() => {});
    bus.on('myCalendar.eventStarting', handler);
    const getUpcoming = mock(() => [makeEvent()]);
    const checker = new EventStartingChecker(db, bus, getUpcoming);

    await checker.check();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('skips all_day events', async () => {
    const db = makeDb();
    const bus = new DomainEventBus();
    const handler = mock(() => {});
    bus.on('myCalendar.eventStarting', handler);
    const getUpcoming = mock(() => [makeEvent({ all_day: 1 })]);
    const checker = new EventStartingChecker(db, bus, getUpcoming);

    await checker.check();
    expect(handler).not.toHaveBeenCalled();
  });

  test('does not emit for already-notified events', async () => {
    const db = makeDb();
    const bus = new DomainEventBus();
    const handler = mock(() => {});
    bus.on('myCalendar.eventStarting', handler);
    const event = makeEvent();
    const getUpcoming = mock(() => [event]);
    const checker = new EventStartingChecker(db, bus, getUpcoming);

    await checker.check();
    expect(handler).toHaveBeenCalledTimes(1);

    await checker.check();
    expect(handler).toHaveBeenCalledTimes(1); // not called again
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test test/worker/event-starting-checker.test.ts
```
Expected: FAIL — `EventStartingChecker` not found.

- [ ] **Step 3: Implement EventStartingChecker**

```ts
// src/worker/event-starting-checker.ts
import type { Database } from 'bun:sqlite';
import type { CalendarEvent } from '../database/types.ts';
import type { DomainEventBus } from '../services/scheduled/domain-event-bus.ts';
import { logger } from '../utils/logger.ts';

const checkerLogger = logger.child({ module: 'event-starting-checker' });

export class EventStartingChecker {
  constructor(
    private db: Database,
    private bus: DomainEventBus,
    private getUpcomingEvents: (withinMs: number) => CalendarEvent[],
  ) {}

  async check(): Promise<void> {
    const events = this.getUpcomingEvents(60_000);

    for (const event of events) {
      if (event.all_day) continue;

      const already = this.db
        .prepare('SELECT 1 FROM event_starting_log WHERE event_id = ?')
        .get(event.id);
      if (already) continue;

      this.bus.emit('myCalendar.eventStarting', { userId: event.user_id, event });

      this.db
        .prepare('INSERT OR IGNORE INTO event_starting_log (event_id, notified_at) VALUES (?, ?)')
        .run(event.id, new Date().toISOString());

      checkerLogger.info({ eventId: event.id, userId: event.user_id }, 'Emitted eventStarting');
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test test/worker/event-starting-checker.test.ts
```
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/worker/event-starting-checker.ts test/worker/event-starting-checker.test.ts
git commit -m "feat(scheduled): add EventStartingChecker with event_starting_log dedup"
```

---

## Task 9: Emit domain events from EventService + InvitationService

**Files:**
- Modify: `src/services/event/event-service.ts`
- Modify: `src/services/sharing/invitation-service.ts`

- [ ] **Step 1: Add optional `domainEvents` to EventService constructor**

In `src/services/event/event-service.ts`, add `private domainEvents?: DomainEventBus` as the 9th parameter:

```ts
import type { DomainEventBus } from '../scheduled/domain-event-bus.ts';

export class EventService {
  constructor(
    private eventRepo: EventRepository,
    private reminderRepo: ReminderRepository,
    private materializer?: ReminderMaterializer,
    private pushSync?: (userId: number, eventId: number, action: 'create' | 'update' | 'delete') => void,
    private onEventDeleted?: (eventId: number, userId: number) => void,
    private onEventTimeChanged?: (eventId: number, userId: number, newStartAt: string) => void,
    private participantRepo?: ParticipantRepository,
    private onParticipantsNotify?: (userIds: number[], text: string) => void,
    private domainEvents?: DomainEventBus,
  ) {}
```

- [ ] **Step 2: Emit after createEvent, updateEvent, deleteEvent**

After `this.eventRepo.create(data)` in `createEvent()`, emit:
```ts
if (this.domainEvents) {
  if (event.owner_type === 'group' && event.group_id) {
    this.domainEvents.emit('myGroup.newEvent', {
      userId: event.created_by ?? event.user_id,
      groupChatId: event.group_id,
      newEvent: event,
      createdBy: event.created_by ?? event.user_id,
    });
  } else {
    this.domainEvents.emit('myCalendar.newEvent', { userId: event.user_id, newEvent: event });
  }
}
```

After `updateEvent` completes, emit `myCalendar.updatedEvent` with `{ userId, updatedEvent, oldEvent }`.

After `deleteEvent` completes, emit `myCalendar.deletedEvent` with `{ userId, eventId, title }`.

- [ ] **Step 3: Add optional `domainEvents` to InvitationService constructor**

In `src/services/sharing/invitation-service.ts`, add 6th optional param and emit in `accept()`/`reject()` methods:

```ts
constructor(
  private invRepo: InvitationRepository,
  private eventRepo: EventRepository,
  private settingsRepo: SharingSettingsRepository,
  private participantRepo?: ParticipantRepository,
  private conflictChecker?: ConflictChecker,
  private domainEvents?: DomainEventBus,
) {}
```

In `accept()` after success: `this.domainEvents?.emit('myInvitations.accepted', { userId: invitation.inviter_id, inviteeId: invitation.invitee_id, event })`.

In `reject()` after success: `this.domainEvents?.emit('myInvitations.rejected', { userId: invitation.inviter_id, inviteeId: invitation.invitee_id, event })`.

- [ ] **Step 4: Run existing tests to verify no regressions**

```bash
bun test test/services/event/ test/services/sharing/
```
Expected: all tests pass (optional param is backward-compatible, existing callers pass no 9th/6th arg).

- [ ] **Step 5: Commit**

```bash
git add src/services/event/event-service.ts src/services/sharing/invitation-service.ts
git commit -m "feat(scheduled): emit domain events from EventService and InvitationService"
```

---

## Task 10: Emit conflictDetected from events tool handler

**Files:**
- Modify: `src/services/ai/tool-handlers/events.ts`
- Modify: `src/services/ai/types.ts`

- [ ] **Step 1: Add `domainEvents` to AgentContext**

In `src/services/ai/types.ts`, add to `AgentContext`:

```ts
import type { DomainEventBus } from '../scheduled/domain-event-bus.ts';
// ...
export interface AgentContext {
  // ... existing fields ...
  domainEvents?: DomainEventBus;
  scheduledCallService?: import('../scheduled/scheduled-ai-call.service.ts').ScheduledAiCallService;
  triggerService?: { repo: import('../scheduled/trigger.repository.ts').TriggerRepository };
}
```

- [ ] **Step 2: Emit conflictDetected in events tool handler**

In `src/services/ai/tool-handlers/events.ts`, find where conflict detection runs after `create_event`/`update_event`. After a conflict is found and returned to the user, also emit:

```ts
if (ctx.domainEvents && conflict) {
  ctx.domainEvents.emit('myCalendar.conflictDetected', {
    userId: ctx.user.telegram_id,
    event: newEvent,
    conflictsWith: conflict,
  });
}
```

- [ ] **Step 3: Run lint**

```bash
bun run lint
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/services/ai/types.ts src/services/ai/tool-handlers/events.ts
git commit -m "feat(scheduled): emit conflictDetected domain event from events tool handler"
```

---

## Task 11: AI tool handlers for scheduled calls + triggers

**Files:**
- Create: `src/services/ai/tool-handlers/scheduled.ts`
- Create: `test/services/ai/tool-handlers/scheduled.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// test/services/ai/tool-handlers/scheduled.test.ts
import { describe, expect, mock, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { runMigrations } from '../../../src/database/schema.ts';
import { migrations } from '../../../src/database/migrations.ts';
import { TriggerRepository } from '../../../src/services/scheduled/trigger.repository.ts';
import { ScheduledAiCallRepository } from '../../../src/services/scheduled/scheduled-ai-call.repository.ts';
import { ScheduledAiCallService } from '../../../src/services/scheduled/scheduled-ai-call.service.ts';
import {
  handleScheduleAiCall,
  handleScheduleAiCallsList,
  handleScheduleAiCallCancel,
  handleAddTrigger,
  handleListTriggers,
  handleRemoveTrigger,
} from '../../../src/services/ai/tool-handlers/scheduled.ts';
import type { AgentContext } from '../../../src/services/ai/types.ts';
import type { User } from '../../../src/database/types.ts';

function makeCtx(overrides: Partial<AgentContext> = {}): AgentContext {
  const db = new Database(':memory:');
  runMigrations(db, migrations);
  const triggerRepo = new TriggerRepository(db);
  const scheduleRepo = new ScheduledAiCallRepository(db);
  const queue = {
    addDelayed: mock(async () => 'j1'),
    addRepeat: mock(async () => {}),
    removeDelayed: mock(async () => {}),
    removeRepeat: mock(async () => {}),
  };
  const scheduledCallService = new ScheduledAiCallService(scheduleRepo, queue);
  return {
    user: { telegram_id: 1, language: 'en', timezone: 'UTC' } as User,
    scheduledCallService,
    triggerService: { repo: triggerRepo },
    ...overrides,
  } as unknown as AgentContext;
}

describe('handleAddTrigger', () => {
  test('creates trigger and returns success', () => {
    const ctx = makeCtx();
    const result = handleAddTrigger(ctx, {
      topic: 'myCalendar.newEvent',
      action: 'call me',
      label: 'test',
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain('myCalendar.newEvent');
  });

  test('rejects invalid topic', () => {
    const ctx = makeCtx();
    const result = handleAddTrigger(ctx, { topic: 'invalid.topic', action: 'x' });
    expect(result.success).toBe(false);
  });

  test('rejects invalid condition expression', () => {
    const ctx = makeCtx();
    const result = handleAddTrigger(ctx, { topic: 'myCalendar.newEvent', action: 'x', condition: '!!! bad' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('condition');
  });
});

describe('handleListTriggers', () => {
  test('returns empty list when none exist', () => {
    const ctx = makeCtx();
    const result = handleListTriggers(ctx);
    expect(result.success).toBe(true);
  });
});

describe('handleRemoveTrigger', () => {
  test('removes existing trigger', () => {
    const ctx = makeCtx();
    handleAddTrigger(ctx, { topic: 'myCalendar.newEvent', action: 'x' });
    const list = handleListTriggers(ctx);
    const id = (list.data as { id: string }[])[0]?.id;
    expect(id).toBeDefined();
    const result = handleRemoveTrigger(ctx, { id: id! });
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test test/services/ai/tool-handlers/scheduled.test.ts
```
Expected: FAIL — handlers not found.

- [ ] **Step 3: Implement scheduled.ts tool handlers**

```ts
// src/services/ai/tool-handlers/scheduled.ts
import { ALL_TOPICS } from '../../scheduled/domain-event-bus.ts';
import { evaluate } from '../../intent/expression-evaluator.ts';
import { t } from '../../../config/constants.ts';
import type { AgentContext, ToolResult } from '../types.ts';

function requireScheduledCallService(ctx: AgentContext): ToolResult | null {
  if (!ctx.scheduledCallService) return { success: false, error: 'Scheduled calls not available.' };
  return null;
}

function requireTriggerRepo(ctx: AgentContext): ToolResult | null {
  if (!ctx.triggerService?.repo) return { success: false, error: 'Trigger service not available.' };
  return null;
}

export async function handleScheduleAiCall(
  ctx: AgentContext,
  input: { message: string; run_at?: string; cron?: string; label?: string },
): Promise<ToolResult> {
  const err = requireScheduledCallService(ctx);
  if (err) return err;
  try {
    const id = await ctx.scheduledCallService!.create({
      userId: ctx.user.telegram_id,
      message: input.message,
      runAt: input.run_at ?? null,
      cron: input.cron ?? null,
      label: input.label ?? null,
    });
    const when = input.run_at ?? `cron: ${input.cron}`;
    return { success: true, output: `Scheduled (id: ${id}): "${input.message}" at ${when}` };
  } catch (e: unknown) {
    return { success: false, error: String(e) };
  }
}

export function handleScheduleAiCallsList(ctx: AgentContext): ToolResult {
  const err = requireScheduledCallService(ctx);
  if (err) return err;
  const schedules = ctx.scheduledCallService!.list(ctx.user.telegram_id);
  if (schedules.length === 0) return { success: true, output: 'No scheduled calls.', data: [] };
  const lines = schedules.map((s) => `[${s.id}] "${s.label ?? s.message}" — ${s.run_at ?? `cron: ${s.cron}`} (runs: ${s.run_count})`);
  return { success: true, output: lines.join('\n'), data: schedules };
}

export async function handleScheduleAiCallCancel(ctx: AgentContext, input: { id: string }): Promise<ToolResult> {
  const err = requireScheduledCallService(ctx);
  if (err) return err;
  await ctx.scheduledCallService!.cancel(input.id);
  return { success: true, output: `Schedule ${input.id} cancelled.` };
}

export function handleAddTrigger(
  ctx: AgentContext,
  input: { topic: string; action: string; condition?: string; label?: string; once?: boolean },
): ToolResult {
  const err = requireTriggerRepo(ctx);
  if (err) return err;

  if (!(ALL_TOPICS as readonly string[]).includes(input.topic)) {
    return { success: false, error: `Unknown topic "${input.topic}". Available: ${ALL_TOPICS.join(', ')}` };
  }

  if (input.condition) {
    try {
      evaluate(input.condition, {});
    } catch {
      // Parse error with empty context is expected (missing vars), but syntax errors throw differently
      // Run a second check: tokenize only
      try {
        evaluate(input.condition, { newEvent: {}, updatedEvent: {}, oldEvent: {}, event: {}, inviteeId: 0 });
      } catch (e2: unknown) {
        return { success: false, error: `Invalid condition expression: ${String(e2)}` };
      }
    }
  }

  const repo = ctx.triggerService!.repo;
  const count = repo.countEnabled(ctx.user.telegram_id);
  if (count >= 50) return { success: false, error: 'Trigger limit (50) reached.' };

  const id = repo.create({
    userId: ctx.user.telegram_id,
    topic: input.topic,
    action: input.action,
    condition: input.condition ?? null,
    label: input.label ?? null,
    once: input.once ?? false,
  });

  return {
    success: true,
    output: `Trigger created (id: ${id}): when ${input.topic}${input.condition ? ` and (${input.condition})` : ''} → "${input.action}"`,
  };
}

export function handleListTriggers(ctx: AgentContext): ToolResult {
  const err = requireTriggerRepo(ctx);
  if (err) return err;
  const triggers = ctx.triggerService!.repo.listByUser(ctx.user.telegram_id);
  if (triggers.length === 0) return { success: true, output: 'No triggers.', data: [] };
  const lines = triggers.map((tr) =>
    `[${tr.id}] ${tr.topic}${tr.condition ? ` if (${tr.condition})` : ''} → "${tr.action}" ${tr.enabled ? '✅' : '⬜'} fires:${tr.fire_count}${tr.once ? ' once' : ''}`,
  );
  return { success: true, output: lines.join('\n'), data: triggers };
}

export function handleRemoveTrigger(ctx: AgentContext, input: { id: string }): ToolResult {
  const err = requireTriggerRepo(ctx);
  if (err) return err;
  ctx.triggerService!.repo.remove(input.id, ctx.user.telegram_id);
  return { success: true, output: `Trigger ${input.id} removed.` };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test test/services/ai/tool-handlers/scheduled.test.ts
```
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/services/ai/tool-handlers/scheduled.ts test/services/ai/tool-handlers/scheduled.test.ts
git commit -m "feat(scheduled): add 6 AI tool handlers for scheduled calls and triggers"
```

---

## Task 12: Wire tools.ts + tool-executor.ts

**Files:**
- Modify: `src/services/ai/tools.ts`
- Modify: `src/services/ai/tool-executor.ts`

- [ ] **Step 1: Add 6 tool definitions to tools.ts**

Append to the `toolDefinitions` array in `src/services/ai/tools.ts`:

```ts
  {
    name: 'schedule_ai_call',
    description: 'Schedule a one-time or recurring message to be injected into the AI pipeline on your behalf at a future time. The bot will process it as if you sent it. Use run_at for one-time, cron for recurring. Always convert user local time to UTC using their timezone before calling.',
    input_schema: {
      type: 'object' as const,
      properties: {
        message: { type: 'string', description: 'Message to inject (e.g. "call me", "show today events")' },
        run_at: { type: 'string', description: 'ISO 8601 UTC datetime for one-time execution' },
        cron: { type: 'string', description: 'Cron expression in UTC for recurring execution (e.g. "0 8 * * *")' },
        label: { type: 'string', description: 'Human-readable description' },
      },
      required: ['message'],
    },
  },
  {
    name: 'schedule_ai_calls_list',
    description: 'List all active scheduled AI calls for the user.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'schedule_ai_call_cancel',
    description: 'Cancel a scheduled AI call by id.',
    input_schema: {
      type: 'object' as const,
      properties: { id: { type: 'string', description: 'Schedule id from schedule_ai_calls_list' } },
      required: ['id'],
    },
  },
  {
    name: 'add_trigger',
    description: `Add an event-driven trigger. When the specified topic fires (and optional condition is true), the action message is injected into the AI pipeline.
Available topics: myCalendar.newEvent, myCalendar.updatedEvent, myCalendar.deletedEvent, myCalendar.conflictDetected, myCalendar.eventStarting, myInvitations.accepted, myInvitations.rejected, myGroup.newEvent.
Condition is an expression using dot-notation on the event payload (e.g. "newEvent.title == \\"standup\\"").`,
    input_schema: {
      type: 'object' as const,
      properties: {
        topic: { type: 'string', description: 'Domain event topic to listen for' },
        action: { type: 'string', description: 'Message to inject when trigger fires' },
        condition: { type: 'string', description: 'Optional filter expression evaluated against event payload' },
        label: { type: 'string', description: 'Human-readable description' },
        once: { type: 'boolean', description: 'If true, trigger auto-disables after first fire' },
      },
      required: ['topic', 'action'],
    },
  },
  {
    name: 'list_triggers',
    description: 'List all triggers for the user.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'remove_trigger',
    description: 'Remove a trigger by id.',
    input_schema: {
      type: 'object' as const,
      properties: { id: { type: 'string', description: 'Trigger id from list_triggers' } },
      required: ['id'],
    },
  },
```

- [ ] **Step 2: Add routing in tool-executor.ts**

`dispatchTool()` in `src/services/ai/tool-executor.ts` uses a `switch (toolName)` statement (line 82). Add new `case` labels **before** the `default:` at the end of the switch. Also add the imports at the top of the file:

```ts
import {
  handleAddTrigger,
  handleListTriggers,
  handleRemoveTrigger,
  handleScheduleAiCall,
  handleScheduleAiCallCancel,
  handleScheduleAiCallsList,
} from './tool-handlers/scheduled.ts';

// Inside switch (toolName) { ... }, before the default case:
      case 'schedule_ai_call':
        return handleScheduleAiCall(ctx, input as never);
      case 'schedule_ai_calls_list':
        return handleScheduleAiCallsList(ctx);
      case 'schedule_ai_call_cancel':
        return handleScheduleAiCallCancel(ctx, input as never);
      case 'add_trigger':
        return handleAddTrigger(ctx, input as never);
      case 'list_triggers':
        return handleListTriggers(ctx);
      case 'remove_trigger':
        return handleRemoveTrigger(ctx, input as never);
```

- [ ] **Step 3: Run lint**

```bash
bun run lint
```
Expected: no errors.

- [ ] **Step 4: Run full test suite**

```bash
bun test
```
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/ai/tools.ts src/services/ai/tool-executor.ts
git commit -m "feat(scheduled): register 6 new AI tools in tools.ts and tool-executor.ts"
```

---

## Task 13: Expose agentContextBuilder + runSyntheticPipeline from createBot()

**Files:**
- Modify: `src/bot/index.ts`

`createBot()` currently returns `{ bot, inlineBot, eventService, ... }`. The worker needs `agentContextBuilder` and a way to run IntentMatcher + Agent. This task adds those to the return value and accepts a `DomainEventBus` param so `EventService`/`InvitationService` can emit domain events.

Key facts about `src/bot/index.ts`:
- `buildAgentContextFactory` is imported from `./handlers/message.handler.ts`
- `agent` is `new CalendarBotAgent(aiConfig, telegramSender)` at line 175
- `intentMatcher`, `intentExecutor` are local variables
- `msgDeps` is constructed at line 200 and includes `agent`, `intentMatcher`, `intentExecutor`
- `createBot()` signature: `export function createBot(token, db, aiConfig, googleDeps?, renderService?, callQueue?, ...)` — add `domainEventBus?: DomainEventBus` as a new last param

- [ ] **Step 1: Add `domainEventBus` param to createBot() signature**

At the top of `createBot()`'s param list additions, add the import and new optional param:

```ts
import { DomainEventBus } from '../services/scheduled/domain-event-bus.ts';
import { TriggerRepository } from '../services/scheduled/trigger.repository.ts';
import { ScheduledAiCallRepository } from '../services/scheduled/scheduled-ai-call.repository.ts';
import { ScheduledAiCallService } from '../services/scheduled/scheduled-ai-call.service.ts';
import { TriggerService, type AiMessageJobData } from '../services/scheduled/trigger.service.ts';
```

Add to the `createBot()` function signature (new last param):
```ts
  domainEventBus?: DomainEventBus,
  pushAiMessage?: (data: AiMessageJobData) => Promise<void>,
```

- [ ] **Step 2: Pass domainEventBus to EventService and InvitationService**

Find where `new EventService(...)` is called in `bot/index.ts`. The current call has 8 args. Add `domainEventBus` as the 9th:

```ts
const eventService = new EventService(
  db.events,
  db.reminders,
  materializer,
  pushSync,
  onEventDeleted,
  onEventTimeChanged,
  db.participants,
  onParticipantsNotify,
  domainEventBus,   // NEW — 9th arg
);
```

Find where `new InvitationService(...)` is called. Add `domainEventBus` as the 6th arg:
```ts
const invitationService = new InvitationService(
  db.invitations,
  db.events,
  db.sharingSettings,
  db.participants,
  conflictChecker,
  domainEventBus,   // NEW — 6th arg
);
```

- [ ] **Step 3: Create TriggerService and ScheduledAiCallService inside createBot()**

After `const agent = new CalendarBotAgent(...)`:

```ts
const triggerRepo = new TriggerRepository(db.raw);
const scheduleRepo = new ScheduledAiCallRepository(db.raw);
const triggerService = pushAiMessage
  ? new TriggerService(domainEventBus ?? new DomainEventBus(), triggerRepo, pushAiMessage)
  : undefined;
triggerService?.subscribe();
const scheduledCallService = pushAiMessage
  ? new ScheduledAiCallService(scheduleRepo, {
      addDelayed: async (data, delay) => { await pushAiMessage(data as AiMessageJobData); return ''; },
      addRepeat: async (data, cron) => { /* deferred to queue in index.ts */ },
      removeDelayed: async () => {},
      removeRepeat: async () => {},
    })
  : undefined;
```

**Note:** The `ScheduledAiCallService` BullMQ adapter is fully wired in `src/index.ts` (Step 4). Inside `createBot()` we only need stub adapters so the service can be instantiated. The real queue adapter is passed when `createAiMessagesQueue` is created in `src/index.ts`. A cleaner approach: do NOT create `ScheduledAiCallService` inside `createBot()` — return `scheduleRepo` and `triggerRepo` and let `src/index.ts` wire the services. See Step 4.

**Revised approach (cleaner):** Inside `createBot()`, only create the repos. Return them. `src/index.ts` creates the services.

```ts
const triggerRepo = new TriggerRepository(db.raw);
const scheduleRepo = new ScheduledAiCallRepository(db.raw);
```

- [ ] **Step 4: Add scheduledCallService/triggerService to msgDeps and return from createBot()**

In `msgDeps` (line ~200), add:
```ts
    scheduledCallService: undefined as ScheduledAiCallService | undefined, // patched by src/index.ts
    triggerService: undefined as { repo: TriggerRepository } | undefined,  // patched by src/index.ts
    domainEvents: domainEventBus,
```

**Important:** `msgDeps` is a mutable object. `src/index.ts` will patch `scheduledCallService` and `triggerService` onto it after creating them, so the `agentContextBuilder` closure picks them up automatically (since `msgDeps` is captured by reference).

Add to `createBot()` return value:
```ts
  return {
    bot,
    inlineBot,
    eventService,
    // ... existing ...
    // NEW:
    agentContextBuilder: buildAgentContextFactory(msgDeps),
    agent,
    intentMatcher,
    intentExecutor,
    scheduleRepo,
    triggerRepo,
    msgDeps,  // exposed so src/index.ts can patch scheduledCallService/triggerService
    db,
    renderService,
  };
```

- [ ] **Step 5: Run lint**

```bash
bun run lint
```
Expected: no errors. Fix any type errors from new return fields.

- [ ] **Step 6: Commit**

```bash
git add src/bot/index.ts
git commit -m "feat(scheduled): expose agentContextBuilder, agent, repos from createBot()"
```

---

## Task 14: Wire ai-messages worker + EventStartingChecker in src/index.ts

**Files:**
- Modify: `src/index.ts`

`src/index.ts` is where all workers are initialized (see existing BullMQ queue setups at lines 140, 162, 274, 320). Follow the same pattern.

- [ ] **Step 1: Create DomainEventBus before calling createBot()**

```ts
import { DomainEventBus } from './services/scheduled/domain-event-bus.ts';
import { TriggerService } from './services/scheduled/trigger.service.ts';
import { ScheduledAiCallService } from './services/scheduled/scheduled-ai-call.service.ts';
import { createAiMessagesQueue, createAiMessagesWorker, SyntheticPipelineRunner } from './worker/ai-messages-queue.ts';
import { EventStartingChecker } from './worker/event-starting-checker.ts';

const domainEventBus = new DomainEventBus();
```

Add `if (config.REDIS_URL)` block (matching the pattern of other queue init blocks):

```ts
if (config.REDIS_URL) {
  const aiMsgQueue = createAiMessagesQueue({ url: config.REDIS_URL });

  // Create bot with domainEventBus and the queue's pushTrigger
  // NOTE: createBot() call is ~line 452. Move domainEventBus creation before that call
  // and add it as a param. Since createBot() accepts it as an optional last param:
}
```

- [ ] **Step 2: Pass domainEventBus to createBot()**

Find the `createBot(...)` call at line 452 and add `domainEventBus` as the last argument:

```ts
const { bot, agentContextBuilder, agent, intentMatcher, intentExecutor, scheduleRepo, triggerRepo, msgDeps } = createBot(
  config.BOT_TOKEN,
  db,
  { apiKey: config.ANTHROPIC_API_KEY, baseUrl: config.AI_BASE_URL, model: config.AI_MODEL },
  googleDeps,
  renderService,
  callQueue,
  transcriptionService,
  mtprotoSendAsUser,
  stressDictionary,
  sileroTts,
  kokoroTts,
  fallbackTts,
  mtprotoResolveUsername,
  eventMentionStore,
  domainEventBus,   // NEW last arg
);
```

- [ ] **Step 3: Wire ai-messages queue, services, and worker**

After the `createBot()` call, inside `if (config.REDIS_URL)`:

```ts
if (config.REDIS_URL) {
  const aiMsgQueue = createAiMessagesQueue({ url: config.REDIS_URL });

  // TriggerService
  const triggerService = new TriggerService(domainEventBus, triggerRepo, (data) => aiMsgQueue.pushTrigger(data));
  triggerService.subscribe();

  // ScheduledAiCallService
  const scheduledCallService = new ScheduledAiCallService(scheduleRepo, aiMsgQueue);

  // Patch msgDeps so agentContextBuilder picks up the services
  msgDeps.scheduledCallService = scheduledCallService;
  msgDeps.triggerService = { repo: triggerRepo };

  // SyntheticPipelineRunner — runs IntentMatcher → AiAgent without GramIO context
  const syntheticRunner = new SyntheticPipelineRunner({
    contextBuilder: (user, chatId, message) => {
      const ctx = agentContextBuilder(user, chatId, message);
      ctx.sender = agent.getSender();           // needed for ask_user / send_invitation in intent path
      ctx.scheduledCallService = scheduledCallService;
      ctx.triggerService = { repo: triggerRepo };
      ctx.domainEvents = domainEventBus;
      return ctx;
    },
    intentRun: async (agentCtx, message) => {
      const match = intentMatcher.match(message);
      if (!match) return { handled: false };
      // Run intent executor (mirrors IntentMatcherLayer logic)
      const userCtx = {
        userId: agentCtx.user.telegram_id,
        language: agentCtx.user.language,
        timezone: agentCtx.user.timezone,
        username: agentCtx.user.username ?? undefined,
        firstName: agentCtx.user.first_name ?? undefined,
      };
      const result = await intentExecutor.run(
        match.intent.workflow as Record<string, unknown>,
        match.captures,
        userCtx,
        (toolName, input) => executeTool(agentCtx, toolName, input),
      );
      if (result.response && agentCtx.sender) {
        await agentCtx.sender.sendMessage(agentCtx.chatId, result.response);
      }
      return { handled: true, response: result.response };
    },
    agentRun: async (agentCtx) => {
      await agent.run(agentCtx);
    },
  });

  const aiWorker = createAiMessagesWorker(
    { url: config.REDIS_URL },
    syntheticRunner,
    (userId) => db.users.findByTelegramId(userId),
    (scheduleId) => scheduleRepo.recordRun(scheduleId),
  );

  // EventStartingChecker — 1-minute cron
  const eventStartingChecker = new EventStartingChecker(
    db.raw,
    domainEventBus,
    (withinMs) => db.events.findStartingWithin(withinMs),  // add this method in next step
  );

  const checkerQueue = new Queue('event-starting-checker', { connection: { url: config.REDIS_URL } });
  await checkerQueue.add('tick', {}, { repeat: { every: 60_000 }, jobId: 'event-starting-checker-tick', removeOnComplete: true });
  const checkerWorker = new Worker('event-starting-checker', async () => {
    await eventStartingChecker.check();
  }, { connection: { url: config.REDIS_URL } });

  checkerWorker.on('failed', (job, err) => {
    botLogger.error({ jobId: job?.id, err }, 'EventStartingChecker job failed');
  });

  // Cleanup on shutdown
  process.on('SIGTERM', async () => {
    await aiWorker.close();
    await checkerWorker.close();
    await checkerQueue.close();
  });
}
```

- [ ] **Step 4: Add `findStartingWithin(withinMs)` to EventRepository**

`EventStartingChecker` needs to query events starting within the next N ms. Add to `src/database/repositories/event.repository.ts`:

```ts
findStartingWithin(withinMs: number): CalendarEvent[] {
  const now = new Date().toISOString();
  const until = new Date(Date.now() + withinMs).toISOString();
  return this.db
    .prepare(`
      SELECT * FROM events
      WHERE start_at >= ? AND start_at <= ?
      AND all_day = 0
      AND recurrence_rule IS NULL
      ORDER BY start_at ASC
    `)
    .all(now, until) as CalendarEvent[];
}
```

And expose `db.raw` from the database setup (or pass `db` directly from the `createBot()` return). Check `src/database/schema.ts` for how `db` is structured — it's likely `{ raw: Database, events: EventRepository, ... }`.

- [ ] **Step 5: Add `executeTool` import in src/index.ts**

The `intentRun` lambda calls `executeTool(agentCtx, toolName, input)`. Import it:

```ts
import { executeTool } from './services/ai/tool-executor.ts';
```

- [ ] **Step 6: Run lint**

```bash
bun run lint
```
Expected: no errors.

- [ ] **Step 7: Run full test suite**

```bash
bun test
```
Expected: all existing + new tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/index.ts src/database/repositories/event.repository.ts
git commit -m "feat(scheduled): wire ai-messages worker, TriggerService, ScheduledAiCallService, EventStartingChecker"
```

---

## Task 15: Final verification

- [ ] **Step 1: Run full test suite with coverage**

```bash
bun test --coverage
```
Expected: all tests pass, no regressions, new code covered.

- [ ] **Step 2: Run lint**

```bash
bun run lint
```
Expected: zero warnings, zero errors.

- [ ] **Step 3: Manual smoke test (bot running)**

Ask the bot: "напомни мне через 2 минуты сказать привет"
Expected: AI calls `schedule_ai_call`, 2 minutes later a message arrives.

Ask the bot: "добавь триггер когда появится новое событие скажи мне об этом"
Expected: AI calls `add_trigger(topic: 'myCalendar.newEvent', action: '...')`, next event creation triggers the message.

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat(scheduled): scheduled AI calls and trigger system complete"
```
