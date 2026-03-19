# Scheduled AI Calls & Trigger System

**Date:** 2026-03-19
**Status:** Approved

## Overview

Two complementary systems that allow time-based and event-based invocation of the AI/intent pipeline on behalf of a user — without any visible trigger message in the chat. The result (AI response, voice call, etc.) arrives to the user as normal.

- **Scheduled AI Calls** — inject a message into the pipeline at a specific time or on a recurring schedule (via BullMQ delayed/repeat jobs).
- **Triggers** — inject a message into the pipeline when a domain event occurs (optionally filtered by a condition expression).

Both systems share a single `ai-messages` BullMQ queue and a synthetic pipeline runner that replicates the normal IntentMatcher → AiAgent priority chain.

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
  cron        TEXT,                    -- cron expression: recurring execution
  job_id      TEXT,                    -- BullMQ job ID for cancellation
  enabled     INTEGER DEFAULT 1,
  run_count   INTEGER DEFAULT 0,
  last_run_at TEXT,
  created_at  TEXT NOT NULL
);
```

Exactly one of `run_at` or `cron` must be set.

### Table: `ai_triggers`

```sql
CREATE TABLE ai_triggers (
  id            TEXT PRIMARY KEY,      -- nanoid
  user_id       INTEGER NOT NULL,
  topic         TEXT NOT NULL,         -- dot-path topic e.g. 'myCalendar.newEvent'
  condition     TEXT,                  -- optional expression evaluated against event payload
  action        TEXT NOT NULL,         -- message injected into pipeline when trigger fires
  label         TEXT,
  once          INTEGER DEFAULT 0,     -- if 1: auto-disable after first fire
  enabled       INTEGER DEFAULT 1,
  fire_count    INTEGER DEFAULT 0,
  last_fired_at TEXT,
  created_at    TEXT NOT NULL
);
```

---

## Domain Event Bus

`DomainEventBus` — typed wrapper over Node.js `EventEmitter`. Singleton, injected into services that emit domain events.

```ts
type DomainEventMap = {
  'myCalendar.newEvent':         { userId: number; newEvent: CalendarEvent }
  'myCalendar.updatedEvent':     { userId: number; updatedEvent: CalendarEvent; oldEvent: CalendarEvent }
  'myCalendar.deletedEvent':     { userId: number; eventId: number; title: string }
  'myCalendar.conflictDetected': { userId: number; event: CalendarEvent; conflictsWith: CalendarEvent }
  'myCalendar.eventStarting':    { userId: number; event: CalendarEvent }
  'myInvitations.accepted':      { userId: number; inviteeId: number; event: CalendarEvent }
  'myInvitations.rejected':      { userId: number; inviteeId: number; event: CalendarEvent }
  'myGroup.newEvent':            { userId: number; groupChatId: number; newEvent: CalendarEvent; createdBy: number }
}
```

Future namespaces (`group.*`, `delegated.*`) are reserved but not implemented.

**Emission points:**

| Domain event | Emitted from |
|---|---|
| `myCalendar.newEvent` | `EventService.createEvent()` |
| `myCalendar.updatedEvent` | `EventService.updateEvent()` |
| `myCalendar.deletedEvent` | `EventService.deleteEvent()` |
| `myCalendar.conflictDetected` | `EventService.createEvent()` + `updateEvent()` when overlap detected |
| `myCalendar.eventStarting` | `EventStartingChecker` BullMQ cron worker |
| `myInvitations.accepted` | `InvitationService.accept()` |
| `myInvitations.rejected` | `InvitationService.reject()` |
| `myGroup.newEvent` | `EventService.createGroupEvent()` |

### `myCalendar.eventStarting` implementation

Not a pure domain event — emitted by a dedicated cron worker (`event-starting-checker`) that runs every minute, finds events starting within the next 60 seconds, emits `myCalendar.eventStarting` for each, and marks them as notified in a `event_starting_notified` set to prevent duplicates.

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
2. Evaluates optional `condition` expression using existing `expression-evaluator.ts`, with the full event payload as context
3. If condition passes (or absent): pushes `{ userId, message: trigger.action }` to `ai-messages` queue
4. Increments `fire_count`, updates `last_fired_at`
5. If `trigger.once`: disables the trigger

### `ScheduledAiCallService`

- `create(userId, message, runAt|cron, label?)` → saves to DB + adds BullMQ job (delayed or repeat), stores `job_id`
- `list(userId)` → returns all schedules with next run time
- `cancel(id)` → removes BullMQ job by `job_id`, marks disabled in DB

---

## `ai-messages` Queue & Worker

**Queue name:** `ai-messages`
**Job data:** `{ userId: number; message: string; source: 'scheduled' | 'trigger'; scheduleId?: string; triggerId?: string }`

**Worker:**

1. Looks up user by `userId`
2. Calls `buildAgentContext(user, message, deps)` — shared factory (also used by GramIO handlers)
3. Runs `syntheticPipeline(agentCtx, message)`: IntentMatcher → AiAgent, same priority order as live messages
4. Response is delivered to the user's Telegram chat via normal `TelegramSender`

The user sees no "sent message" — only the bot's response/action.

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
Returns all active schedules with id, label, next run time, run count.

**`schedule_ai_call_cancel`**
```
id: string
```

### Triggers

**`add_trigger`**
```
topic: string      — one of the DomainEventMap keys
action: string     — message to inject into pipeline when fired
condition?: string — expression evaluated against event payload
label?: string
once?: boolean     — auto-disable after first fire
```

**`list_triggers`**
Returns all triggers with id, topic, condition, label, enabled, fire_count, last_fired_at.

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
    ai-messages-queue.ts          ← queue + worker + syntheticPipeline
    event-starting-checker.ts     ← cron for myCalendar.eventStarting
  services/ai/
    tool-handlers/scheduled.ts    ← 6 new tool handlers
```

### Modified files

| File | Change |
|---|---|
| `src/database/migrations.ts` | +2 tables |
| `src/services/event/event-service.ts` | emit domain events after mutations |
| `src/services/sharing/invitation-service.ts` | emit `myInvitations.*` |
| `src/services/ai/tools.ts` | +6 tool definitions |
| `src/services/ai/tool-executor.ts` | route 6 new tool names |
| `src/services/ai/types.ts` | +`scheduledCallService`, `triggerService` to `AgentContext` |
| `src/index.ts` | init worker, TriggerService, event-starting-checker |

---

## Error Handling & Safety

- Condition eval errors → log warning, skip trigger (fail-closed)
- BullMQ job failure → standard retry (attempts: 3, exponential backoff)
- `syntheticPipeline` errors → log with `{ userId, source, scheduleId/triggerId }`, do not rethrow (prevents queue poison-pill)
- `once` triggers: disable happens atomically in the same DB transaction as `fire_count` increment to prevent double-fire on retry

---

## Testing

- Unit: `TriggerService` — condition evaluation, `once` flag, disabled triggers skipped
- Unit: `ScheduledAiCallService` — create/cancel/list, BullMQ job lifecycle
- Unit: `DomainEventBus` — typed emit/on
- Integration: `ai-messages` worker — synthetic pipeline runs correctly, response delivered
- Regression: `once` trigger fires exactly once even if job retries
