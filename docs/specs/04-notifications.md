# Sub-Project #4: Notifications

## Overview

Fully configurable notification system for HyperCalendarBot. Users get morning agendas, event reminders, and evening reviews — all timezone-aware, all configurable, all delivered through BullMQ workers.

The system runs a per-minute BullMQ repeatable job. Each tick queries SQLite for due notifications, enqueues them into the BullMQ notifications queue, and the worker process delivers via GramIO. Deduplication is enforced at both the scheduling and delivery layers.

---

## 1. Notification Types and Triggers

### 1.1 Morning Agenda

| Property | Detail |
|---|---|
| **Trigger** | Daily at user-configured time (default: 08:00 local) |
| **Condition** | Only fires if user has events today |
| **Content** | List of today's events with times. Optionally: weather (future), agenda image (sub-project #5) |
| **Format** | Text message OR generated image (user preference) |
| **Toggle** | on/off per user |

### 1.2 Event Reminders

| Property | Detail |
|---|---|
| **Trigger** | N minutes/hours/days before event start |
| **Defaults** | User-configurable default intervals, e.g. `[15min, 1hr]` |
| **Per-event override** | Individual events can specify their own reminder intervals, replacing defaults |
| **Content** | Event title, time, location (if any), how long until start |
| **Format** | Text message. Voice call trigger interface for sub-project #7 |

### 1.3 Evening Review

| Property | Detail |
|---|---|
| **Trigger** | Daily at user-configured time (default: 21:00 local) |
| **Condition** | Only fires if user has events tomorrow |
| **Content** | Summary of tomorrow's schedule |
| **Format** | Text message OR generated image |
| **Toggle** | on/off per user |

### 1.4 Notification Delivery Channels

Each notification resolves to one of these delivery types:

```typescript
type NotificationChannel =
  | "telegram_text"     // plain text via GramIO
  | "telegram_image"    // generated image via Playwright (sub-project #5)
  | "voice_call";       // trigger interface only (sub-project #7)
```

---

## 2. Scheduling Architecture

### 2.1 High-Level Flow

```
┌─────────────────────────────────────────────────────────┐
│                     BOT PROCESS                         │
│                                                         │
│  BullMQ repeatable job (every: 60_000)                  │
│       │                                                 │
│       ▼                                                 │
│  NotificationScheduler.tick()                           │
│       │                                                 │
│       ├─ Query due morning agendas (UTC-converted)      │
│       ├─ Query due event reminders                      │
│       ├─ Query due evening reviews                      │
│       │                                                 │
│       ▼                                                 │
│  Filter: quiet hours, already-sent, disabled            │
│       │                                                 │
│       ▼                                                 │
│  Insert into notification_log (status = "queued")       │
│       │                                                 │
│       ▼                                                 │
│  Enqueue into BullMQ "notifications" queue              │
└─────────────────────┬───────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────┐
│                    WORKER PROCESS                       │
│                                                         │
│  BullMQ Worker ("notifications")                        │
│       │                                                 │
│       ▼                                                 │
│  NotificationWorker.process(job)                        │
│       │                                                 │
│       ├─ Resolve delivery channel                       │
│       ├─ Build message content                          │
│       ├─ Send via GramIO / trigger image gen / etc.     │
│       │                                                 │
│       ▼                                                 │
│  Update notification_log (status = "sent" | "failed")   │
└─────────────────────────────────────────────────────────┘
```

### 2.2 Tick Logic (every minute via BullMQ repeatable job)

```typescript
// BullMQ repeatable job instead of node-cron
await notificationQueue.add('tick', {}, {
  repeat: { every: 60_000 },
  removeOnComplete: true,
});
```

The tick handler is a BullMQ worker processor, not a cron callback:

```typescript
// Pseudocode for NotificationScheduler.tick()

async function tick(nowUtc: Date): Promise<void> {
  const currentMinuteUtc = truncateToMinute(nowUtc);

  // 1. Morning agendas
  const morningUsers = getMorningAgendaUsers(currentMinuteUtc);
  for (const user of morningUsers) {
    const events = getTodayEvents(user);
    if (events.length === 0) continue;
    if (isQuietHours(user, currentMinuteUtc)) continue;
    await enqueueNotification(user, "morning_agenda", { events });
  }

  // 2. Event reminders
  const dueReminders = getDueEventReminders(currentMinuteUtc);
  for (const reminder of dueReminders) {
    if (isQuietHours(reminder.user, currentMinuteUtc)) continue;
    await enqueueNotification(reminder.user, "event_reminder", {
      event: reminder.event,
      intervalLabel: reminder.intervalLabel,
    });
  }

  // 3. Evening reviews
  const eveningUsers = getEveningReviewUsers(currentMinuteUtc);
  for (const user of eveningUsers) {
    const events = getTomorrowEvents(user);
    if (events.length === 0) continue;
    if (isQuietHours(user, currentMinuteUtc)) continue;
    await enqueueNotification(user, "evening_review", { events });
  }
}
```

### 2.3 How `getMorningAgendaUsers(currentMinuteUtc)` Works

The key insight: users store their preferred morning time in local time (e.g. "08:00"). The tick runs every minute in UTC. To find who should get their morning agenda *right now*:

```sql
SELECT u.telegram_id, u.timezone, np.morning_agenda_time
FROM users u
JOIN notification_preferences np ON np.user_id = u.telegram_id
WHERE np.morning_agenda_enabled = 1
  AND np.morning_agenda_time IS NOT NULL;
```

Then in code, for each user: convert `currentMinuteUtc` to user's local time, and check if it matches `morning_agenda_time`. This is done in-memory, not in SQL, because SQLite has no native timezone functions.

**Optimization at scale** (Section 8): pre-compute UTC send times and use indexed lookups.

### 2.4 How `getDueEventReminders(currentMinuteUtc)` Works

Event reminders are pre-materialized. When an event is created or updated, its reminder rows are computed and inserted into `event_reminders`. The cron tick simply queries:

```sql
SELECT er.id, er.event_id, er.user_id, er.remind_at_utc, er.interval_label,
       e.title, e.start_at, e.location
FROM event_reminders er
JOIN events e ON e.id = er.event_id
WHERE er.remind_at_utc >= :windowStart
  AND er.remind_at_utc < :windowEnd
  AND er.sent = 0;
```

Where `windowStart` = current minute (truncated), `windowEnd` = current minute + 60 seconds. This is a simple indexed range scan.

---

## 3. SQLite Schema

### 3.1 `notification_preferences` table

Stores per-user notification settings. One row per user.

```sql
CREATE TABLE notification_preferences (
  user_id                    INTEGER PRIMARY KEY,               -- telegram_id
  morning_agenda_enabled     INTEGER NOT NULL DEFAULT 1,
  morning_agenda_time        TEXT NOT NULL DEFAULT '08:00',
  morning_agenda_utc         TEXT,                              -- pre-computed for fast lookups
  morning_agenda_format      TEXT NOT NULL DEFAULT 'text',
  default_reminder_intervals TEXT NOT NULL DEFAULT '[15]',
  evening_review_enabled     INTEGER NOT NULL DEFAULT 0,
  evening_review_time        TEXT NOT NULL DEFAULT '21:00',
  evening_review_utc         TEXT,
  evening_review_format      TEXT NOT NULL DEFAULT 'text',
  quiet_hours_enabled        INTEGER NOT NULL DEFAULT 0,
  quiet_hours_start          TEXT,
  quiet_hours_end            TEXT,
  updated_at                 TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
);
```

### 3.2 `event_reminders` table

Pre-materialized reminder instances. Created/updated whenever an event is created, updated, or deleted.

```sql
CREATE TABLE event_reminders (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id         INTEGER NOT NULL,
  user_id          INTEGER NOT NULL,                   -- telegram_id
  remind_at_utc    TEXT NOT NULL,
  interval_minutes INTEGER NOT NULL,
  interval_label   TEXT NOT NULL,
  sent             INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
);

CREATE INDEX idx_event_reminders_due
  ON event_reminders(remind_at_utc, sent) WHERE sent = 0;
CREATE INDEX idx_event_reminders_event ON event_reminders(event_id);
```

### 3.3 Per-Event Reminder Overrides via `events.reminder_overrides`

The canonical `events` table (defined in `00-common-architecture.md`) already includes:

```sql
  reminder_overrides TEXT,  -- JSON array of minutes, e.g. [5, 30], NULL = use defaults
```

This is part of the events schema from migration 002. No `ALTER TABLE` is needed.

When `reminder_overrides` is NULL, use `notification_preferences.default_reminder_intervals`. When set, use only those intervals for this event.

### 3.4 `notification_log` table

Tracks every notification attempt. Primary deduplication mechanism and audit trail.

```sql
CREATE TABLE notification_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL,                   -- telegram_id
  type            TEXT NOT NULL,
  reference_key   TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'queued',
  channel         TEXT NOT NULL DEFAULT 'telegram_text',
  payload         TEXT,
  error           TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at         TEXT,
  FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_notification_log_dedup ON notification_log(reference_key);
CREATE INDEX idx_notification_log_status ON notification_log(status, created_at);
```

---

## 4. Reminder Materialization

When an event is created or updated, the system computes and writes all reminder rows. This happens synchronously in the event CRUD operations.

```typescript
async function materializeReminders(event: Event, userId: number): Promise<void> {
  // Delete old reminders for this event
  db.run(`DELETE FROM event_reminders WHERE event_id = ?`, [event.id]);

  // Determine intervals
  const overrides = event.reminderOverrides; // number[] | null
  const prefs = getNotificationPreferences(userId);
  const intervals: number[] = overrides ?? JSON.parse(prefs.defaultReminderIntervals);

  const eventStartUtc = new Date(event.startAt); // stored as UTC

  for (const minutes of intervals) {
    const remindAt = new Date(eventStartUtc.getTime() - minutes * 60_000);

    // Don't create reminders in the past
    if (remindAt.getTime() < Date.now()) continue;

    const label = formatIntervalLabel(minutes); // "15 minutes", "1 hour", etc.

    db.run(
      `INSERT INTO event_reminders (event_id, user_id, remind_at_utc, interval_minutes, interval_label)
       VALUES (?, ?, ?, ?, ?)`,
      [event.id, userId, truncateToMinute(remindAt).toISOString(), minutes, label]
    );
  }
}
```

**When to re-materialize:**

- Event created -> materialize
- Event start time changed -> re-materialize
- Event `reminder_overrides` changed -> re-materialize
- User changes `default_reminder_intervals` -> re-materialize ALL future events for that user
- Event deleted -> CASCADE handles it

---

## 5. Settings UI Flow (Inline Keyboards)

### 5.1 Entry Point: `/notify`

Sends a message with main settings menu:

```
⚙️ Notification Settings

Morning agenda: ✅ 08:00
Default reminders: 15min, 1hr
Evening review: ❌
Quiet hours: ❌
```

Inline keyboard:

```
[🌅 Morning Agenda]  [⏰ Reminders]
[🌙 Evening Review]  [🔇 Quiet Hours]
```

### 5.2 Morning Agenda Submenu

```
🌅 Morning Agenda

Status: ✅ Enabled
Time: 08:00
Format: Text
```

```
[✅ Enabled / ❌ Disable]
[🕐 Change Time]
[📝 Text / 🖼 Image]
[← Back]
```

**Time picker flow:** User taps "Change Time" -> bot sends hour picker (grid of hours 05-12) -> user picks hour -> bot sends minute picker (00, 15, 30, 45) -> done, confirm.

### 5.3 Default Reminders Submenu

```
⏰ Default Reminders

Active intervals:
  ✅ 5 minutes before
  ✅ 15 minutes before
  ❌ 30 minutes before
  ✅ 1 hour before
  ❌ 1 day before
```

```
[5min ✅]  [15min ✅]  [30min ❌]
[1hr ✅]   [1day ❌]
[← Back]
```

Tapping an interval toggles it. State updates in real-time by editing the message.

### 5.4 Evening Review Submenu

Same pattern as morning agenda: enable/disable, time picker, format picker.

### 5.5 Quiet Hours Submenu

```
🔇 Quiet Hours

Status: ❌ Disabled
```

```
[Enable]
[← Back]
```

When enabled:

```
🔇 Quiet Hours

Status: ✅ 23:00 — 07:00
No notifications during this window.
```

```
[❌ Disable]
[🕐 Change Start]  [🕐 Change End]
[← Back]
```

### 5.6 Callback Data Convention

Callback data format: `notify:<section>:<action>:<value>`

Examples:

- `notify:menu` — main menu
- `notify:morning:toggle` — toggle morning agenda
- `notify:morning:time` — open time picker
- `notify:morning:hour:08` — set hour to 08
- `notify:morning:minute:30` — set minute to 30
- `notify:morning:format:image` — set format to image
- `notify:reminders:toggle:15` — toggle 15min reminder
- `notify:quiet:start` — open start time picker
- `notify:quiet:end` — open end time picker

### 5.7 Per-Event Reminder Override

Not part of `/notify`. Instead, when creating/editing an event (via AI agent or inline editing), the system exposes:

```
⏰ Reminders for "Team Standup":
Using defaults (15min, 1hr)

[Use defaults]  [Customize]
```

If "Customize" is tapped, same toggle grid as Section 5.3, but saves to `events.reminder_overrides` instead of `notification_preferences.default_reminder_intervals`.

---

## 6. Deduplication Strategy

### 6.1 Reference Keys

Every notification gets a unique `reference_key` that encodes what it is and when it was supposed to fire. The `UNIQUE` index on `notification_log(reference_key)` prevents double-insertion.

Key formats:

| Type | Reference Key Pattern | Example |
|---|---|---|
| Morning agenda | `ma:{userId}:{date}` | `ma:42:2026-03-11` |
| Event reminder | `er:{eventReminderId}` | `er:1337` |
| Evening review | `ev:{userId}:{date}` | `ev:42:2026-03-11` |

### 6.2 Two-Layer Dedup

**Layer 1 — Scheduling (bot process):**
Before enqueuing, attempt `INSERT INTO notification_log` with the reference key. If it fails with UNIQUE constraint violation, skip — already scheduled.

```typescript
async function enqueueNotification(
  user: User,
  type: NotificationType,
  payload: Record<string, unknown>
): Promise<boolean> {
  const referenceKey = buildReferenceKey(type, user, payload);

  try {
    db.run(
      `INSERT INTO notification_log (user_id, type, reference_key, channel, payload)
       VALUES (?, ?, ?, ?, ?)`,
      [user.telegramId, type, referenceKey, resolveChannel(user, type), JSON.stringify(payload)]
    );
  } catch (err) {
    if (isSqliteUniqueViolation(err)) return false; // already queued
    throw err;
  }

  await notificationQueue.add(type, {
    logId: lastInsertRowId(),
    telegramId: user.telegramId,
    type,
    payload,
  });

  return true;
}
```

**Layer 2 — Delivery (worker process):**
Before sending, the worker checks the log row status. If it's already "sent", skip.

```typescript
async function processNotification(job: Job): Promise<void> {
  const { logId } = job.data;

  const log = db.get(`SELECT * FROM notification_log WHERE id = ?`, [logId]);
  if (!log || log.status === 'sent') return; // already delivered or gone

  // ... send message ...

  db.run(
    `UPDATE notification_log SET status = 'sent', sent_at = datetime('now'), attempts = attempts + 1 WHERE id = ?`,
    [logId]
  );
}
```

### 6.3 For Event Reminders: `sent` flag

The `event_reminders.sent` flag is an additional fast-path filter so the cron query doesn't even consider already-processed reminders. Updated to 1 when the notification is enqueued (not when delivered — the log handles delivery tracking).

---

## 7. Timezone Handling

### 7.1 Storage

- All datetimes in SQLite are stored as **UTC** ISO 8601 strings.
- User's timezone is stored as IANA identifier (e.g. `"Europe/Moscow"`, `"America/New_York"`).
- Morning/evening times are stored as **local time HH:MM** strings (no date, no timezone offset).
- Quiet hours are stored as **local time HH:MM** strings.

### 7.2 Conversion Logic

```typescript
import { TZDate } from "@date-fns/tz";

function getUserLocalTime(utcNow: Date, timezone: string): { hours: number; minutes: number } {
  const local = new TZDate(utcNow, timezone);
  return { hours: local.getHours(), minutes: local.getMinutes() };
}

function isTimeMatch(utcNow: Date, timezone: string, targetTimeHHMM: string): boolean {
  const local = getUserLocalTime(utcNow, timezone);
  const [targetH, targetM] = targetTimeHHMM.split(":").map(Number);
  return local.hours === targetH && local.minutes === targetM;
}
```

### 7.3 Quiet Hours Check

Quiet hours can span midnight (e.g. 23:00 — 07:00). Logic:

```typescript
function isQuietHours(user: User, utcNow: Date): boolean {
  const prefs = getNotificationPreferences(user.telegramId);
  if (!prefs.quietHoursEnabled) return false;

  const local = getUserLocalTime(utcNow, user.timezone);
  const currentMinutes = local.hours * 60 + local.minutes;

  const [startH, startM] = prefs.quietHoursStart.split(":").map(Number);
  const [endH, endM] = prefs.quietHoursEnd.split(":").map(Number);
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  if (startMinutes <= endMinutes) {
    // Same day: e.g. 13:00 — 15:00
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  } else {
    // Spans midnight: e.g. 23:00 — 07:00
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }
}
```

### 7.4 Timezone Changes

When a user updates their timezone:

1. Update `users.timezone`.
2. Re-materialize all future `event_reminders` for that user (recalculate `remind_at_utc` if events were stored with local-time intent — but since events store UTC, no recalculation needed for reminders).
3. Morning/evening times are in local time, so they automatically adjust — the cron comparison logic handles it.

No migration of existing notification_log entries needed — they're historical.

---

## 8. Performance Considerations at Scale

### 8.1 The Problem

The naive approach (iterate all users every minute, convert timezone, compare) doesn't scale to thousands of users.

### 8.2 Pre-Computed UTC Send Time

The `notification_preferences` table already includes pre-computed UTC columns (`morning_agenda_utc` and `evening_review_utc`) as part of the canonical schema (see Section 3.1). No `ALTER TABLE` is needed.

These are recomputed:

- When user changes morning/evening time
- When user changes timezone
- On DST transitions (handled by a daily recomputation job)

Now the cron tick query becomes:

```sql
SELECT u.telegram_id, u.timezone, np.*
FROM users u
JOIN notification_preferences np ON np.user_id = u.telegram_id
WHERE np.morning_agenda_enabled = 1
  AND np.morning_agenda_utc = :currentTimeHHMM;
```

This is an indexed lookup, O(matching users) per tick, not O(all users).

### 8.3 DST Recomputation

DST recomputation runs as a BullMQ repeatable job (daily at 00:00 UTC, see `00-common-architecture.md` Section 2, "Cron/Scheduling via BullMQ"):

```typescript
// BullMQ repeatable job for daily DST recomputation
await notificationQueue.add('recompute-utc', {}, {
  repeat: { pattern: '0 0 * * *' }, // midnight UTC daily
});

// Worker processor
function recomputeUtcSendTimes(): void {
  const users = db.all(`
    SELECT u.telegram_id, u.timezone, np.morning_agenda_time, np.evening_review_time
    FROM users u
    JOIN notification_preferences np ON np.user_id = u.telegram_id
  `);

  for (const user of users) {
    const morningUtc = localTimeToUtcHHMM(user.morning_agenda_time, user.timezone);
    const eveningUtc = localTimeToUtcHHMM(user.evening_review_time, user.timezone);

    db.run(
      `UPDATE notification_preferences
       SET morning_agenda_utc = ?, evening_review_utc = ?
       WHERE user_id = ?`,
      [morningUtc, eveningUtc, user.telegram_id]
    );
  }
}
```

### 8.4 Event Reminders at Scale

Event reminders are already materialized with UTC timestamps and indexed. The per-minute query is a range scan on the index — efficient regardless of total event count.

### 8.5 BullMQ Throughput

At 10,000 users with an average of 3 notifications/day = ~30,000 jobs/day = ~20 jobs/minute average, with spikes at common morning/evening times (maybe 500-1000 jobs in a single minute for popular timezone offsets).

BullMQ handles this trivially. If needed:

- Worker concurrency can be increased
- Multiple worker instances can run in parallel
- Rate limiting per-user can be added via BullMQ's built-in rate limiter

### 8.6 SQLite Considerations

- All notification tables should be in WAL mode (already the default for bun:sqlite)
- The per-minute cron tick should use a single transaction for all reads
- Batch inserts for materialized reminders
- Index on `event_reminders(remind_at_utc, sent)` is critical
- Consider `PRAGMA journal_size_limit` to prevent WAL from growing unbounded
- Periodic cleanup of old notification_log entries (keep 30 days)

---

## 9. Failure Handling and Retries

### 9.1 BullMQ Retry Configuration

```typescript
const notificationQueue = new Queue("notifications", {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 30_000, // 30s, then 60s, then 120s
    },
    removeOnComplete: { age: 86400 },    // keep completed jobs for 24h
    removeOnFail: { age: 86400 * 7 },    // keep failed jobs for 7 days
  },
});
```

### 9.2 Worker Error Handling

```typescript
worker.on("failed", (job, err) => {
  if (!job) return;

  const { logId } = job.data;

  if (job.attemptsMade >= job.opts.attempts!) {
    // Final failure — mark in log
    db.run(
      `UPDATE notification_log SET status = 'failed', error = ?, attempts = ? WHERE id = ?`,
      [err.message, job.attemptsMade, logId]
    );

    // Alert: this is a critical failure. Log to monitoring.
    logger.error(`Notification delivery permanently failed`, {
      logId,
      telegramId: job.data.telegramId,
      type: job.data.type,
      error: err.message,
    });
  } else {
    // Transient failure — update attempt count, BullMQ will retry
    db.run(
      `UPDATE notification_log SET attempts = ?, error = ? WHERE id = ?`,
      [job.attemptsMade, err.message, logId]
    );
  }
});
```

### 9.3 Telegram-Specific Errors

| Error | Action |
|---|---|
| 403 Forbidden (bot blocked by user) | Mark user as inactive, stop future notifications |
| 429 Too Many Requests | Respect `retry_after` from Telegram, use BullMQ delayed retry |
| Network timeout | Standard retry with backoff |
| Chat not found | Mark user as inactive |

### 9.4 Stale Queue Recovery

If the bot process crashes and restarts, the cron tick will attempt to re-schedule any missed notifications. Deduplication via `reference_key` ensures no duplicates.

If the worker process crashes, BullMQ's persistence in Redis means jobs survive. On restart, the worker picks up where it left off.

### 9.5 Monitoring

Track these metrics (via structured logging, future Grafana/Prometheus integration):

- Notifications queued per minute
- Notifications sent per minute
- Notification delivery latency (queued_at -> sent_at)
- Failure rate by type
- Retry rate
- Queue depth

---

## 10. Notification Content Templates

### 10.1 Morning Agenda (Text)

```
☀️ Good morning! Here's your day:

📅 Tuesday, March 11

09:00 — Team Standup (30min)
11:00 — 1:1 with Alex (45min)
        📍 Meeting Room B
14:00 — Sprint Review (1hr)
18:30 — Gym

Have a productive day!
```

### 10.2 Event Reminder

```
⏰ Reminder: Team Standup in 15 minutes

🕐 09:00 — 09:30
📍 Meeting Room B
```

For 1-day-before:

```
⏰ Reminder: Team Standup tomorrow at 09:00

🕐 09:00 — 09:30
📍 Meeting Room B
```

### 10.3 Evening Review (Text)

```
🌙 Tomorrow's schedule:

📅 Wednesday, March 12

09:00 — Team Standup (30min)
13:00 — Lunch with Client
        📍 Restaurant Name
16:00 — Code Review Session (1hr)

3 events tomorrow. Good night!
```

---

## 11. API Surface (Internal)

### 11.1 NotificationScheduler

```typescript
interface NotificationScheduler {
  start(): void;          // Register BullMQ repeatable job
  stop(): void;           // Remove repeatable job
  tick(now?: Date): Promise<void>;  // Manual trigger (for testing)
}
```

### 11.2 NotificationPreferencesService

```typescript
interface NotificationPreferencesService {
  get(userId: number): NotificationPreferences;
  update(userId: number, patch: Partial<NotificationPreferences>): void;
  ensureDefaults(userId: number): void;  // Create row with defaults if missing
}
```

### 11.3 ReminderMaterializer

```typescript
interface ReminderMaterializer {
  materialize(event: Event, userId: number): void;
  rematerializeAllForUser(userId: number): void;  // After timezone/default change
  deleteForEvent(eventId: number): void;
}
```

### 11.4 NotificationRenderer

```typescript
interface NotificationRenderer {
  renderMorningAgenda(user: User, events: Event[]): RenderedNotification;
  renderEventReminder(user: User, event: Event, intervalLabel: string): RenderedNotification;
  renderEveningReview(user: User, events: Event[]): RenderedNotification;
}

interface RenderedNotification {
  channel: NotificationChannel;
  text?: string;
  imagePath?: string;  // for image format
}
```

---

## 12. File Structure

```
src/
  notifications/
    scheduler.ts              # Cron tick logic, NotificationScheduler
    worker.ts                 # BullMQ worker, delivery logic
    materializer.ts           # ReminderMaterializer
    renderer.ts               # NotificationRenderer, message templates
    preferences.ts            # NotificationPreferencesService
    quiet-hours.ts            # Quiet hours checking logic
    timezone.ts               # Timezone conversion utilities
    dedup.ts                  # Reference key generation
    types.ts                  # Shared types
  commands/
    notify.ts                 # /notify command, inline keyboard handlers
  db/
    migrations/
      006-notification-tables.sql
```

---

## 13. Migration: `006-notification-tables.sql`

Note: `events.reminder_overrides` is already part of the canonical events table (migration 002). No `ALTER TABLE` needed here.

```sql
-- Notification preferences
CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id                    INTEGER PRIMARY KEY,               -- telegram_id
  morning_agenda_enabled     INTEGER NOT NULL DEFAULT 1,
  morning_agenda_time        TEXT NOT NULL DEFAULT '08:00',
  morning_agenda_utc         TEXT,
  morning_agenda_format      TEXT NOT NULL DEFAULT 'text',
  default_reminder_intervals TEXT NOT NULL DEFAULT '[15]',
  evening_review_enabled     INTEGER NOT NULL DEFAULT 0,
  evening_review_time        TEXT NOT NULL DEFAULT '21:00',
  evening_review_utc         TEXT,
  evening_review_format      TEXT NOT NULL DEFAULT 'text',
  quiet_hours_enabled        INTEGER NOT NULL DEFAULT 0,
  quiet_hours_start          TEXT,
  quiet_hours_end            TEXT,
  updated_at                 TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
);

-- Pre-materialized event reminders
CREATE TABLE IF NOT EXISTS event_reminders (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id          INTEGER NOT NULL,
  user_id           INTEGER NOT NULL,                           -- telegram_id
  remind_at_utc     TEXT NOT NULL,
  interval_minutes  INTEGER NOT NULL,
  interval_label    TEXT NOT NULL,
  sent              INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_event_reminders_due
  ON event_reminders(remind_at_utc, sent)
  WHERE sent = 0;

CREATE INDEX IF NOT EXISTS idx_event_reminders_event
  ON event_reminders(event_id);

-- Notification delivery log
CREATE TABLE IF NOT EXISTS notification_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL,                             -- telegram_id
  type            TEXT NOT NULL,
  reference_key   TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'queued',
  channel         TEXT NOT NULL DEFAULT 'telegram_text',
  payload         TEXT,
  error           TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at         TEXT,
  FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_log_dedup
  ON notification_log(reference_key);

CREATE INDEX IF NOT EXISTS idx_notification_log_status
  ON notification_log(status, created_at);
```

---

## 14. Dependencies

| Package | Purpose |
|---|---|
| `bullmq` | Job queue for notification dispatch + repeatable jobs for scheduling |
| `@date-fns/tz` | Timezone conversions (lightweight, no moment.js) |
| `gramio` | Telegram bot API (already in stack) |

No new heavy dependencies. `bun:sqlite` and `Bun.redis` cover storage. BullMQ repeatable jobs handle all periodic scheduling (per-minute tick, daily DST recomputation) — no `node-cron` or `setInterval` needed.

---

## 15. Open Questions / Future Work

1. **Notification batching** — if a user has 3 events starting at the same time, send one combined message or three separate? Recommendation: combine into one message.
2. **Snooze** — "Remind me again in 5 minutes" button on reminders. Easy to add: callback creates a delayed BullMQ job.
3. **Weekly digest** — Sunday evening summary of the upcoming week. Natural extension of evening review.
4. **Image generation** (sub-project #5) — the `telegram_image` channel needs Playwright rendering. This spec defines the interface; implementation is in sub-project #5.
5. **Voice call trigger** (sub-project #7) — the `voice_call` channel needs a VoIP integration. This spec defines when to trigger; implementation is in sub-project #7.
6. **Notification_log cleanup** — implement a weekly job to delete entries older than 30 days.
7. **Quiet hours + event reminders** — should critical reminders (5min before) bypass quiet hours? Probably yes. Needs a `critical` flag on intervals.
