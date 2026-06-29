# Scheduled AI Calls & Trigger System

**Date:** 2026-03-19
**Status:** Approved

## Overview

Two complementary systems that allow time-based and event-based invocation of the AI/intent pipeline on behalf of a user — without any visible trigger message in the chat. The result (AI response, voice call, etc.) arrives to the user as normal.

- **Scheduled AI Calls** — inject a message into the pipeline at a specific time or on a recurring schedule (via BullMQ delayed/repeat jobs).
- **Triggers** — inject a message into the pipeline when a domain event occurs (optionally filtered by a condition expression).

Both systems share a single `ai-messages` BullMQ queue and a `SyntheticPipelineRunner` that replicates the normal IntentMatcher → AiAgent priority chain without requiring a GramIO context.

---

## Data Layer

### Table: `scheduled_ai_calls`

```sql
CREATE TABLE scheduled_ai_calls (
  id          TEXT PRIMARY KEY,        -- nanoid
  user_id     INTEGER NOT NULL,
  message     TEXT NOT NULL,           -- injected into pipeline as user message
  label       TEXT,                    -- human-readable description
  run_at      TEXT,                    -- ISO 8601 UTC: one-time execution
  cron        TEXT,                    -- cron expression in UTC: recurring execution
  enabled     INTEGER DEFAULT 1,
  run_count   INTEGER DEFAULT 0,
  last_run_at TEXT,
  created_at  TEXT NOT NULL
);
```

Exactly one of `run_at` or `cron` must be set. BullMQ job IDs are not stored — cancellation of one-time jobs uses `queue.getDelayed()` + match by schedule id in job data; cancellation of repeat jobs uses `queue.removeRepeatable(name, { pattern: cron })`.

### Table: `ai_triggers`

```sql
CREATE TABLE ai_triggers (
  id            TEXT PRIMARY KEY,      -- nanoid
  user_id       INTEGER NOT NULL,
  topic         TEXT NOT NULL,         -- dot-path topic e.g. 'myCalendar.newEvent'
  condition     TEXT,                  -- optional expression evaluated against event payload
  action        TEXT NOT NULL,         -- message injected into pipeline when fired
  label         TEXT,
  once          INTEGER DEFAULT 0,     -- if 1: auto-disable after first fire
  enabled       INTEGER DEFAULT 1,
  fire_count    INTEGER DEFAULT 0,
  last_fired_at TEXT,
  created_at    TEXT NOT NULL
);
```

### Table: `event_starting_log`

```sql
CREATE TABLE event_starting_log (
  event_id   INTEGER PRIMARY KEY,
  notified_at TEXT NOT NULL
);
```

Used by `EventStartingChecker` to prevent duplicate `myCalendar.eventStarting` emissions across restarts.

### Per-user limits

- Max 50 active `scheduled_ai_calls` per user (enforced at create time, error returned to AI tool)
- Max 50 active `ai_triggers` per user (same)

---

## Domain Event Bus

`DomainEventBus` — typed wrapper over Node.js `EventEmitter`. Singleton created at startup, passed to services that emit domain events.

```ts
type DomainEventMap = {
  'myCalendar.newEvent':         { userId: number; newEvent: CalendarEvent }
  'myCalendar.updatedEvent':     { userId: number; updatedEvent: CalendarEvent; oldEvent: CalendarEvent }
  'myCalendar.deletedEvent':     { userId: number; eventId: number; title: string }
  'myCalendar.eventStarting':    { userId: number; event: CalendarEvent }
  'myInvitations.accepted':      { userId: number; inviteeId: number; event: CalendarEvent }
  'myInvitations.rejected':      { userId: number; inviteeId: number; event: CalendarEvent }
  'myGroup.newEvent':            { userId: number; groupChatId: number; newEvent: CalendarEvent; createdBy: number }
}
```

`userId` in every payload = the user whose triggers are evaluated. For `myGroup.newEvent`, `userId` = the user who created the event (not all group members — triggers fire for the creator only in v1). Future namespaces (`group.*`, `delegated.*`) reserved but not implemented.

**Known limitation:** `DomainEventBus` is in-process synchronous. If the process crashes between a domain event emission and `TriggerService` pushing to BullMQ, that event is silently lost. At-most-once delivery is the accepted guarantee.

### Emission points

| Domain event | Emitted from |
|---|---|
| `myCalendar.newEvent` | `EventService.createEvent()` — new 9th optional param `domainEvents` |
| `myCalendar.updatedEvent` | `EventService.updateEvent()` |
| `myCalendar.deletedEvent` | `EventService.deleteEvent()` |
| `myCalendar.eventStarting` | `EventStartingChecker` BullMQ cron worker |
| `myInvitations.accepted` | `InvitationService.accept()` |
| `myInvitations.rejected` | `InvitationService.reject()` |
| `myGroup.newEvent` | `EventService.createEvent()` when `owner_type === 'group'` |

### `myCalendar.eventStarting` — deduplication

`EventStartingChecker` is a BullMQ cron job (every 1 minute). It:
1. Queries events starting in the next 60 seconds
2. Filters out `all_day = 1` events (no fixed time)
3. Filters out event IDs already in `event_starting_log`
4. Emits `myCalendar.eventStarting` for each remaining event
5. Inserts those IDs into `event_starting_log`

`event_starting_log` persists across restarts, preventing duplicate emissions.

---

## Services

### `DomainEventBus`

```ts
class DomainEventBus {
  emit<T extends keyof DomainEventMap>(topic: T, payload: DomainEventMap[T]): void
  on<T extends keyof DomainEventMap>(topic: T, handler: (payload: DomainEventMap[T]) => void): void
}
```

### `TriggerService`

Subscribes to all topics at startup. On each event:

1. Finds all enabled triggers for `payload.userId` with matching `topic`
2. Evaluates optional `condition` using `expression-evaluator.ts` with the full event payload as context
3. If condition passes (or absent):
   - In a DB transaction: increment `fire_count`, update `last_fired_at`, and if `trigger.once` set `enabled = 0`
   - Push `{ userId, message: trigger.action, source: 'trigger', triggerId: trigger.id }` to `ai-messages` queue
   - If BullMQ push fails: log error, action is lost (trigger is already disabled if `once` — acceptable trade-off: no double-fire over no-fire)

Condition eval errors → log warning, skip trigger (fail-closed, same as intent `when` conditions).

Condition expressions are validated at trigger creation time (`add_trigger` tool) via a dry-run through the evaluator with an empty context object. If the expression throws a parse error, the tool returns an error before saving.

### `ScheduledAiCallService`

- `create(userId, message, runAt|cron, label?)`:
  - Enforce per-user limit (50)
  - Save to DB
  - Add BullMQ job: one-time uses `{ delay: ms }`, recurring uses `{ repeat: { pattern: cron } }`
  - Job data includes `scheduleId` for matching on cancel
- `list(userId)` → returns all schedules with id, label, next run time, run count
- `cancel(id)`:
  - For one-time: iterate `queue.getDelayed()`, find job with matching `scheduleId`, remove it
  - For recurring: `queue.removeRepeatable('ai-schedule', { pattern: schedule.cron })`
  - Mark `enabled = 0` in DB

---

## `ai-messages` Queue & Worker

**Queue name:** `ai-messages`
**Job data:**
```ts
{
  userId: number
  message: string
  source: 'scheduled' | 'trigger'
  scheduleId?: string
  triggerId?: string
}
```

### `SyntheticPipelineRunner`

The worker does not create a GramIO `BotCommandContext` shim. Instead, it runs pipeline logic directly at the service layer:

1. Look up user by `userId`
2. Call `agentContextBuilder(user, userId /* chatId = DM */, message)` — the same builder function used by `createAiAgentLayer`, extracted and shared
3. Try IntentMatcher: `matcher.match(message)` → if match, run `IntentExecutor.run(...)` → send result via `agentContext.sender`
4. If no intent match: `agent.run(agentContext)`
5. Response is delivered to the user via `TelegramSender` targeting `userId` as chatId (DM)

`agentContextBuilder` is already defined as a function passed to `AgentLayerDeps.agentContextBuilder`. It is extracted to a shared location (e.g., `src/bot/agent-context-factory.ts`) so the worker can import it without depending on the GramIO bot instance.

Worker error handling: errors are caught per-job, logged with `{ userId, source, scheduleId?, triggerId? }`, not rethrown (prevents poison-pill). BullMQ retries: 3 attempts, exponential backoff.

---

## AI Tools

### Scheduled Calls

**`schedule_ai_call`**
```
message: string   — what to inject into pipeline
run_at?: string   — ISO 8601 UTC datetime (one-time)
cron?: string     — cron expression in UTC (recurring)
label?: string    — human-readable description
```
Exactly one of `run_at` or `cron` required. AI converts user's local time to UTC using `user.timezone` before calling.

**`schedule_ai_calls_list`**
Returns all active schedules: id, label, run_at or cron, run_count, last_run_at.

**`schedule_ai_call_cancel`**
```
id: string
```

### Triggers

**`add_trigger`**
```
topic: string      — one of the DomainEventMap keys
action: string     — message to inject into pipeline when fired
condition?: string — expression evaluated against event payload (validated at create time)
label?: string
once?: boolean     — auto-disable after first fire (default false)
```

**`list_triggers`**
Returns all triggers: id, topic, condition, label, once, enabled, fire_count, last_fired_at.

**`remove_trigger`**
```
id: string
```

---

## File Structure

```
src/
  services/
    scheduled/
      domain-event-bus.ts
      trigger.repository.ts
      trigger.service.ts
      scheduled-ai-call.repository.ts
      scheduled-ai-call.service.ts
  worker/
    ai-messages-queue.ts          ← queue + worker + SyntheticPipelineRunner
    event-starting-checker.ts     ← cron for myCalendar.eventStarting
  bot/
    agent-context-factory.ts      ← extracted from ai-agent-layer, shared with worker
  services/ai/
    tool-handlers/scheduled.ts    ← 6 new tool handlers
```

### Modified files

| File | Change |
|---|---|
| `src/database/migrations.ts` | +3 tables: `scheduled_ai_calls`, `ai_triggers`, `event_starting_log` |
| `src/services/event/event-service.ts` | +optional `domainEvents?: DomainEventBus` param (9th), emit on create/update/delete |
| `src/services/sharing/invitation-service.ts` | +optional `domainEvents?: DomainEventBus` param, emit `myInvitations.*` |
| `src/services/ai/tools.ts` | +6 tool definitions |
| `src/services/ai/tool-executor.ts` | route 6 new tool names |
| `src/services/ai/types.ts` | +`scheduledCallService`, `triggerService` to `AgentContext` |
| `src/bot/pipeline/ai-agent-layer.ts` | `agentContextBuilder` moved to `agent-context-factory.ts`, re-exported |
| `src/bot/index.ts` | wire `DomainEventBus`, `TriggerService`, pass to `EventService` + `InvitationService` |
| `src/index.ts` | init `ai-messages` worker, `EventStartingChecker` cron |

---

## Error Handling & Safety

- Condition eval errors at runtime → log warning, skip trigger (fail-closed)
- Condition expression validated at `add_trigger` time — invalid expressions rejected before saving
- BullMQ job failure → 3 attempts, exponential backoff
- Worker errors → caught per-job, logged, not rethrown (no poison-pill)
- `once` triggers: DB transaction (fire_count + disable) commits *before* BullMQ push — no double-fire; a failed push after disable means the action is lost (acceptable: no double-fire preferred over no-fire)
- In-process event bus: at-most-once delivery — crash between emit and queue push loses the event (documented limitation)

---

## Testing

- Unit: `TriggerService` — condition evaluation, `once` flag (DB disabled before push), disabled triggers skipped, condition eval error → skip
- Unit: `ScheduledAiCallService` — create/cancel/list, one-time vs repeat BullMQ lifecycle
- Unit: `DomainEventBus` — typed emit/on, multiple subscribers
- Unit: `SyntheticPipelineRunner` — intent match path, AI fallback path
- Unit: `EventStartingChecker` — all_day skipped, already-notified skipped, log inserted
- Regression: `once` trigger: if BullMQ push throws after DB disable, trigger stays disabled (action lost, no second fire)
- Regression: per-user limit enforced — 51st schedule/trigger returns error
