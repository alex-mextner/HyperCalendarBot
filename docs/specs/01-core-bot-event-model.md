# Sub-Project #1: Core Bot + Event Model

## Overview & Goals

Foundation layer for HyperCalendarBot — a personal/multi-user Telegram calendar bot with its own event model, optional Google Calendar bidirectional sync, and AI-powered natural language event creation.

**Goals:**

- Scaffold the project with proven patterns from ExpenseSyncBot
- Set up GramIO bot with middleware pipeline (user resolution, timezone context, rate limiting)
- Design a solid SQLite schema for users and events that supports recurrence, timezones, reminders, and future Google Calendar sync
- Implement full CRUD for events via Telegram commands and inline keyboards
- Onboard users with timezone detection (geolocation or manual) and language preference
- Build all /commands for day-to-day calendar management

**Non-goals for this sub-project:**

- AI agent / natural language parsing (sub-project 02)
- Google Calendar sync (sub-project 03)
- Notification dispatch via BullMQ (sub-project 04)
- Playwright image rendering (sub-project 05 — worker process)
- Voice call reminders (sub-project 07)
- Holiday subscriptions data source (external API integration — sub-project 08)

---

## Directory Structure

```
hypercalendarbot/
├── index.ts                          # Entry point — boot bot + OAuth server
├── package.json
├── tsconfig.json
├── bunfig.toml
├── .env                              # Not committed
├── .env.example
├── .gitignore
├── data/                             # SQLite DB file (gitignored)
│   └── calendar.db
├── src/
│   ├── bot/
│   │   ├── index.ts                  # createBot(), startBot()
│   │   ├── types.ts                  # Ctx type aliases for GramIO
│   │   ├── middleware/
│   │   │   ├── user-resolver.ts      # Lookup/create user on every message
│   │   │   ├── timezone-context.ts   # Attach user timezone to context
│   │   │   └── rate-limiter.ts       # Per-user rate limiting
│   │   ├── commands/
│   │   │   ├── start.ts              # /start — onboarding
│   │   │   ├── today.ts              # /today — today's schedule
│   │   │   ├── tomorrow.ts           # /tomorrow
│   │   │   ├── week.ts              # /week — 7-day view
│   │   │   ├── add.ts               # /add — create event
│   │   │   ├── edit.ts              # /edit — modify event
│   │   │   ├── delete.ts            # /delete — remove event
│   │   │   ├── timezone.ts          # /timezone — update timezone
│   │   │   ├── settings.ts          # /settings — preferences hub
│   │   │   ├── notify.ts            # /notify — notification preferences
│   │   │   ├── share.ts             # /share — share agenda/event
│   │   │   ├── holidays.ts          # /holidays — holiday subscriptions
│   │   │   ├── help.ts              # /help — command reference
│   │   │   ├── search.ts            # /search — find events by text
│   │   │   ├── month.ts             # /month — monthly overview
│   │   │   ├── free.ts              # /free — find free time slots
│   │   │   ├── import.ts            # /import — import .ics file
│   │   │   ├── export.ts            # /export — export events to .ics
│   │   │   └── ping.ts              # /ping — health check
│   │   ├── handlers/
│   │   │   ├── callback.handler.ts  # Inline keyboard button callbacks
│   │   │   └── message.handler.ts   # Free-text messages (future: AI parsing)
│   │   └── keyboards.ts             # Inline keyboard builders
│   ├── config/
│   │   ├── env.ts                   # Validated env config
│   │   └── constants.ts             # Bot messages, keyboard texts, limits
│   ├── database/
│   │   ├── index.ts                 # DatabaseService singleton with repositories
│   │   ├── schema.ts               # Migration runner
│   │   ├── types.ts                # TypeScript interfaces for all DB models
│   │   └── repositories/
│   │       ├── user.repository.ts
│   │       ├── event.repository.ts
│   │       ├── recurrence.repository.ts
│   │       ├── reminder.repository.ts
│   │       └── holiday-subscription.repository.ts  # See sub-project 08
│   │       # notification-preferences.repository.ts — part of sub-project 04
│   ├── services/
│   │   ├── event/
│   │   │   ├── event-service.ts     # Business logic: create/update/delete/query events
│   │   │   ├── recurrence.ts        # Expand recurrence rules into concrete dates
│   │   │   └── formatters.ts        # Format events for Telegram display
│   │   ├── timezone/
│   │   │   └── timezone-service.ts  # Resolve timezone from coords, list popular timezones
│   │   ├── ics/
│   │   │   ├── parser.ts            # Parse .ics files
│   │   │   └── generator.ts         # Generate .ics export
│   │   └── google/                  # Placeholder — sub-project 03
│   │       └── oauth.ts
│   ├── utils/
│   │   ├── date.ts                  # date-fns helpers, timezone conversions
│   │   └── telegram.ts              # Telegram message formatting helpers
│   └── web/
│       └── oauth-callback.ts        # Bun.serve() for Google OAuth callback
└── test/
    └── ...
```

---

## Environment Variables

```env
# Required
BOT_TOKEN=your_telegram_bot_token
ENCRYPTION_KEY=                   # 64-char hex (32 bytes) for AES-256-GCM — required for production

# Database
DATABASE_PATH=./data/calendar.db

# Redis (for BullMQ workers)
REDIS_URL=redis://localhost:6379

# Google OAuth (sub-project 03)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:3311/callback
OAUTH_SERVER_PORT=3311

# AI (Anthropic-compatible via Z.ai — sub-project 02)
ANTHROPIC_API_KEY=
AI_BASE_URL=https://api.z.ai/api/anthropic
AI_MODEL=glm-5

# Environment
NODE_ENV=development
```

Config validation (`src/config/env.ts`):

```typescript
interface EnvConfig {
  BOT_TOKEN: string;
  ENCRYPTION_KEY: string;
  DATABASE_PATH: string;
  REDIS_URL: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_REDIRECT_URI: string;
  OAUTH_SERVER_PORT: number;
  ANTHROPIC_API_KEY: string;
  AI_BASE_URL: string;
  AI_MODEL: string;
  NODE_ENV: 'development' | 'production';
}
```

Only `BOT_TOKEN` is required for sub-project 01. `ENCRYPTION_KEY` is required for production (a default dev key is used with a warning in development). Everything else has sensible defaults or is optional.

---

## SQLite Schema

All datetimes stored as ISO 8601 strings in UTC. Timezone-aware display is handled at the application layer using each user's timezone setting.

### Table: `migrations`

Standard migration tracking. Same pattern as ExpenseSyncBot.

```sql
CREATE TABLE migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### Table: `users`

```sql
CREATE TABLE users (
  telegram_id INTEGER PRIMARY KEY,                 -- Telegram user ID, primary key
  username TEXT,                                    -- cached @username
  first_name TEXT,                                  -- cached first name
  language TEXT NOT NULL DEFAULT 'en',              -- 'en' | 'ru'
  timezone TEXT NOT NULL DEFAULT 'UTC',             -- IANA timezone (e.g. 'Europe/Moscow')
  country_code TEXT,                                -- ISO 3166-1 alpha-2 (for holidays)
  -- Google Calendar (encrypted — sub-project 03)
  google_refresh_token_enc TEXT,                    -- AES-256-GCM encrypted
  google_calendar_id TEXT,                          -- primary calendar ID to sync
  -- Metadata
  onboarding_completed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**Notes:**

- `telegram_id` is the primary key — no separate `id` auto-increment.
- Notification preferences (`morning_agenda_*`, `evening_review_*`, `reminder_default_minutes`) live in the `notification_preferences` table (sub-project 04).
- `google_refresh_token` is stored encrypted as `google_refresh_token_enc`.

### Table: `events`

Core event model. Each row is either a standalone event or a "template" for a recurring series (identified by `recurrence_rule IS NOT NULL`).

```sql
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,                        -- telegram_id
  title TEXT NOT NULL,
  description TEXT,
  -- Category
  category TEXT,                                   -- 'work' | 'personal' | 'health' | 'social' | etc.
  -- Time
  start_at TEXT NOT NULL,                          -- ISO 8601 UTC datetime
  end_at TEXT,                                     -- nullable = point-in-time event
  all_day INTEGER NOT NULL DEFAULT 0,              -- 1 = all-day event (date only, no time)
  timezone TEXT NOT NULL,                           -- IANA timezone event was created in
  -- Location
  location TEXT,
  -- Recurrence
  recurrence_rule TEXT,                            -- RRULE string (RFC 5545), NULL = one-off
  recurrence_end_at TEXT,                          -- When recurring series ends (UTC)
  parent_event_id INTEGER,                         -- Points to recurring template for exceptions
  original_start_at TEXT,                           -- Original occurrence date this exception replaces
  is_cancelled INTEGER NOT NULL DEFAULT 0,         -- 1 = this occurrence was deleted
  -- Reminders (per-event override)
  reminder_overrides TEXT,                         -- JSON array of minutes, e.g. [5, 30], NULL = use defaults
  -- Sync (sub-project 03)
  google_event_id TEXT,
  google_calendar_id TEXT,
  last_synced_at TEXT,
  -- Metadata
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE,
  FOREIGN KEY (parent_event_id) REFERENCES events(id) ON DELETE CASCADE
);

CREATE INDEX idx_events_user_id ON events(user_id);
CREATE INDEX idx_events_start_at ON events(start_at);
CREATE INDEX idx_events_user_start ON events(user_id, start_at);
CREATE INDEX idx_events_parent_id ON events(parent_event_id);
CREATE INDEX idx_events_google_id ON events(google_event_id);
CREATE INDEX idx_events_recurrence ON events(user_id, recurrence_rule)
  WHERE recurrence_rule IS NOT NULL;
```

**Changes from original:**

- `category` field added (referenced by AI Agent tools).
- `reminder_overrides` added for per-event reminder customization.
- `shared_with` REMOVED — replaced by proper sharing tables in sub-project 06.
- `user_id` references `users(telegram_id)`, not `users(id)`.

**Recurrence model explained:**

- A recurring event has `recurrence_rule` set to an RRULE string (e.g., `FREQ=WEEKLY;BYDAY=MO,WE,FR`)
- Individual occurrences are computed at query time by expanding the RRULE — no rows created per occurrence
- If a user edits/deletes a single occurrence, an **exception row** is created with `parent_event_id` pointing to the template, `original_start_at` set to the occurrence date being replaced, and modified fields or `is_cancelled=1`
- This matches the Google Calendar / iCal model, making sync trivial later

### Table: `reminders` (basic, sub-project 01)

Simple per-event reminders for core functionality before the full notification system is built (sub-project 04).

```sql
CREATE TABLE reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  minutes_before INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);

CREATE INDEX idx_reminders_event_id ON reminders(event_id);
```

**Note:** The `sent_at` tracking and materialized reminder dispatch live in the `event_reminders` table (sub-project 04). This table is just the user's desired reminder intervals per event.

### Holiday Tables

Holiday-related tables (`holiday_countries`, `holidays`, `holiday_subscriptions`, `holiday_overrides`) are defined in sub-project 08. See `08-holidays.md` for the canonical schema.

---

## Migration Strategy

Same pattern as ExpenseSyncBot: sequential named migrations in an array, each with an `up()` function, tracked in the `migrations` table. Migrations run on startup before bot starts polling.

```typescript
const migrations = [
  { name: '001_create_users', up: () => { ... } },
  { name: '002_create_events', up: () => { ... } },
  { name: '003_create_reminders', up: () => { ... } },
  // 004+ — holiday tables, AI chat_history, notifications, etc. — see 00-common-architecture.md
];
```

For column additions: use `ALTER TABLE ... ADD COLUMN` with idempotency check via `pragma_table_info`. For constraint changes: recreate table with new constraints, copy data, swap. All proven patterns from ExpenseSyncBot.

---

## Key Types (TypeScript)

### User

```typescript
interface User {
  telegram_id: number;                 // Primary key
  username: string | null;
  first_name: string | null;
  language: 'en' | 'ru';
  timezone: string;                    // IANA timezone
  country_code: string | null;
  google_refresh_token_enc: string | null;  // Encrypted
  google_calendar_id: string | null;
  onboarding_completed: number;        // 0 | 1
  created_at: string;
  updated_at: string;
}

interface CreateUserData {
  telegram_id: number;
  username?: string;
  first_name?: string;
  language?: 'en' | 'ru';
  timezone?: string;
  country_code?: string;
}

interface UpdateUserData {
  username?: string;
  first_name?: string;
  language?: 'en' | 'ru';
  timezone?: string;
  country_code?: string;
  google_refresh_token_enc?: string | null;
  google_calendar_id?: string | null;
  onboarding_completed?: number;
}
```

**Note:** Notification preference fields (`morning_agenda_*`, `evening_review_*`, `reminder_default_minutes`) are in the `NotificationPreferences` interface (sub-project 04).

### Event

```typescript
interface CalendarEvent {
  id: number;
  user_id: number;                     // telegram_id
  title: string;
  description: string | null;
  category: string | null;             // 'work' | 'personal' | 'health' | 'social' | etc.
  start_at: string;                    // ISO 8601 UTC
  end_at: string | null;
  all_day: number;                     // 0 | 1
  timezone: string;
  location: string | null;
  recurrence_rule: string | null;      // RRULE string
  recurrence_end_at: string | null;
  parent_event_id: number | null;
  original_start_at: string | null;
  is_cancelled: number;
  reminder_overrides: string | null;   // JSON array of minutes, e.g. "[5, 30]"
  google_event_id: string | null;
  google_calendar_id: string | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

interface CreateEventData {
  user_id: number;                     // telegram_id
  title: string;
  description?: string;
  category?: string;
  start_at: string;
  end_at?: string;
  all_day?: boolean;
  timezone: string;
  location?: string;
  recurrence_rule?: string;
  recurrence_end_at?: string;
  reminder_minutes?: number[];         // Creates corresponding reminder rows
}

interface UpdateEventData {
  title?: string;
  description?: string | null;
  category?: string | null;
  start_at?: string;
  end_at?: string | null;
  all_day?: boolean;
  timezone?: string;
  location?: string | null;
  recurrence_rule?: string | null;
  recurrence_end_at?: string | null;
}

/** Materialized occurrence — computed from template + RRULE expansion */
interface EventOccurrence {
  event: CalendarEvent;
  occurrence_start: string;            // Actual start for this occurrence
  occurrence_end: string | null;
  is_exception: boolean;               // Was this modified from the template
}
```

### Reminder

```typescript
interface Reminder {
  id: number;
  event_id: number;
  minutes_before: number;
  created_at: string;
}
```

---

## Commands

### /start — Onboarding

Triggers the onboarding flow (see Onboarding Flow section below). If user already completed onboarding, shows a welcome-back message with a quick command reference.

```
User: /start

Bot: Welcome to HyperCalendar! Let's set you up.

First, what's your timezone? You can:
1. Share your location (most accurate)
2. Choose from popular timezones

[Share Location] [Choose Manually]
```

### /today — Today's Schedule

Shows all events for today in the user's timezone. Includes recurring event occurrences and holiday subscriptions.

```
User: /today

Bot: 📅 Tuesday, March 11

  09:00 — 09:30  Daily standup
  12:00 — 13:00  Lunch with Alex
  15:00           Dentist appointment
  19:00 — 20:30  Yoga class (weekly)

3 reminders set for today.
No more events. Enjoy your evening.
```

Empty state:

```
Bot: 📅 Tuesday, March 11

No events today. Use /add to create one.
```

### /tomorrow — Tomorrow's Schedule

Same format as /today, for the next day.

### /week — 7-Day View

Shows a compact 7-day overview starting from today.

```
User: /week

Bot: 📅 Week of Mar 11–17

Tue 11  ▪ 3 events
  09:00 Daily standup
  12:00 Lunch with Alex
  15:00 Dentist

Wed 12  ▪ 1 event
  09:00 Daily standup

Thu 13  ▪ 2 events
  09:00 Daily standup
  18:00 Team dinner

Fri 14  ▪ 1 event
  09:00 Daily standup

Sat 15  — no events
Sun 16  — no events
Mon 17  ▪ 1 event
  10:00 Sprint planning
```

### /month — Monthly Overview

Shows a high-level count per day for the current month, with navigation buttons.

```
User: /month

Bot: 📅 March 2026

Mo Tu We Th Fr Sa Su
                   1
 2  3  4  5  6  7  8
 9 10 11 12 13 14 15
16 17 18 19 20 21 22
23 24 25 26 27 28 29
30 31

Events: 11·2  12·1  13·2  14·1  17·1  20·3  25·1

[< Feb]  [> Apr]
```

### /add — Create Event

Interactive event creation. Supports quick single-message format or multi-step wizard.

**Quick format:**

```
User: /add Dentist tomorrow at 15:00

Bot: ✅ Created: "Dentist"
📅 Wed, Mar 12 at 15:00
⏰ Reminder: 15 min before

[Edit] [Add Reminder] [Delete]
```

**Wizard (no arguments):**

```
User: /add

Bot: Let's create an event. What's the title?

User: Team dinner

Bot: When? (e.g., "tomorrow 18:00", "Mar 15 19:30", "next Friday 12:00")

User: Thursday 18:00

Bot: How long? (e.g., "1h", "30m", "2h30m") or skip for no end time.

User: 2h

Bot: ✅ Created: "Team dinner"
📅 Thu, Mar 13 at 18:00–20:00
⏰ Reminder: 15 min before

[Add Description] [Add Location] [Make Recurring] [Add Reminder] [Delete]
```

**Implementation:** The `/add` wizard is a `@gramio/scenes` Scene. The collected `title`, parsed `when`, and `duration` are stored in scene state (SQLite-backed) until the event is created or the user cancels.

### /edit — Modify Event

Shows upcoming events to pick from, or accepts event ID.

```
User: /edit

Bot: Which event to edit? Pick from upcoming:

1. Today 15:00 — Dentist
2. Thu 18:00 — Team dinner
3. Mon 10:00 — Sprint planning

[1] [2] [3] [Cancel]
```

After selection:

```
Bot: Editing: "Team dinner" (Thu 18:00–20:00)

What to change?
[Title] [Time] [Duration] [Description] [Location] [Recurrence] [Reminders]
```

For recurring events:

```
Bot: This is a recurring event. Edit:
[This occurrence only] [All future occurrences] [All occurrences]
```

### /delete — Remove Event

```
User: /delete

Bot: Which event to delete?

1. Today 15:00 — Dentist
2. Thu 18:00 — Team dinner

[1] [2] [Cancel]
```

Confirmation:

```
Bot: Delete "Dentist" (Today 15:00)?
[Yes, delete] [Cancel]
```

For recurring:

```
Bot: This is a recurring event. Delete:
[This occurrence only] [All future occurrences] [All occurrences]
```

### /timezone — Update Timezone

```
User: /timezone

Bot: Current timezone: Europe/Moscow (UTC+3)

Change it?
[Share Location] [Choose Manually]
```

Manual chooser shows region -> city selection via inline keyboards.

### /settings — Preferences Hub

```
User: /settings

Bot: ⚙️ Settings

🌍 Timezone: Europe/Moscow (UTC+3)
🔔 Morning agenda: ON at 08:00
🌙 Evening review: OFF
⏰ Default reminder: 15 min before
🗣 Language: English
🏳️ Holidays: Russia

[Timezone] [Notifications] [Language] [Holidays]
```

### /notify — Notification Preferences

> **Implementation deferred to sub-project 04 (Notifications).** Listed here for completeness — all commands WILL be implemented.

```
User: /notify

Bot: 🔔 Notification Settings

Morning agenda: ✅ ON at 08:00
  Sends your day's schedule every morning.

Evening review: ❌ OFF
  Summary of tomorrow's events.

Default reminder: 15 min before
  Applied to new events automatically.

[Toggle Morning] [Set Morning Time]
[Toggle Evening] [Set Evening Time]
[Change Default Reminder]
```

### /share — Share Agenda or Event

> **Implementation deferred to sub-project 06 (Sharing & Social).** Listed here for completeness — all commands WILL be implemented.

```
User: /share

Bot: What to share?
[Today's agenda] [Specific event] [This week]
```

Generates a clean text block that the user can forward, or sends directly to another Telegram user if they specify a @username.

### /holidays — Manage Holiday Subscriptions

> **Implementation deferred to sub-project 08 (Holidays).** Listed here for completeness — all commands WILL be implemented.

```
User: /holidays

Bot: 🏳️ Holiday Subscriptions

Active:
  🇷🇺 Russia — 14 holidays/year

[Add Country] [Remove Country] [View Upcoming]
```

"View Upcoming" shows next 5 holidays:

```
Bot: 🗓 Upcoming Holidays (Russia)

Mar 8  — International Women's Day
May 1  — Spring and Labour Day
May 9  — Victory Day
Jun 12 — Russia Day
Nov 4  — Unity Day
```

### /search — Find Events

```
User: /search dentist

Bot: 🔍 Found 2 events:

1. Wed Mar 12 15:00 — Dentist
2. Wed Apr 9 15:00 — Dentist (recurring)

[View #1] [View #2]
```

### /free — Find Free Time

```
User: /free tomorrow

Bot: 📋 Free slots tomorrow (Wed, Mar 12):

  00:00–09:00  (9h)
  09:30–12:00  (2h30m)
  13:00–23:59  (11h)

Busy: 09:00–09:30 standup, 12:00–13:00 lunch
```

### /import — Import .ics File

```
User: /import
[Sends .ics file]

Bot: Parsed 12 events from calendar.ics
  8 new, 3 duplicates skipped, 1 conflict

[Import All 8] [Review One by One] [Cancel]
```

### /export — Export to .ics

```
User: /export

Bot: Export which events?
[All events] [This month] [Next 30 days] [Custom range]
```

Returns an .ics file attachment.

### /help — Command Reference

```
User: /help

Bot: 📖 HyperCalendar Commands

📅 Schedule Views
  /today — today's events
  /tomorrow — tomorrow's events
  /week — 7-day overview
  /month — monthly calendar

✏️ Manage Events
  /add — create event
  /edit — modify event
  /delete — remove event
  /search — find events

⚙️ Settings
  /timezone — change timezone
  /settings — all preferences
  /notify — notification settings
  /holidays — holiday subscriptions

📤 Import/Export
  /import — import .ics file
  /export — export events
  /share — share agenda

🔧 Other
  /free — find free time slots
  /ping — check bot status
  /help — this message
```

### /ping — Health Check

```
User: /ping

Bot: pong (12ms)
```

---

## Onboarding Flow

Triggered on first `/start` or when `user.onboarding_completed == 0`.

### Step 1: Language

```
Bot: 🌍 Choose your language / Выберите язык:

[English] [Русский]
```

### Step 2: Timezone

```
Bot: Now let's set your timezone. The most accurate way is to share your location.

[📍 Share Location] [⌨️ Choose Manually]
```

**If Share Location:**

- User sends location via Telegram's location sharing button (KeyboardButton with `request_location: true`)
- Bot resolves coordinates to IANA timezone via a timezone lookup library (e.g., `geo-tz` or a simple lookup table)
- Also extracts country_code for holiday suggestions

```
Bot: Got it! Your timezone is Europe/Belgrade (UTC+1).
Is this correct?

[Yes ✓] [No, choose manually]
```

**If Choose Manually:**

- Show region selection: `[Europe] [Asia] [Americas] [Africa] [Oceania]`
- Then show popular cities in that region as inline buttons
- User taps a city

### Step 3: Country for Holidays (optional)

```
Bot: Want to see public holidays in your calendar?

Based on your location: 🇷🇸 Serbia

[Yes, add Serbia holidays] [Choose different country] [Skip]
```

### Step 4: Morning Agenda

```
Bot: I can send you a morning summary of your day's events.

Enable morning agenda at 08:00?

[Yes, 08:00] [Change time] [No thanks]
```

### Step 5: Done

```
Bot: ✅ All set! Here's what you can do:

/add — create your first event
/today — view today's schedule
/help — see all commands

Or just type something like "Meeting tomorrow at 10" and I'll figure it out.
```

Sets `onboarding_completed = 1`.

**Implementation:** The onboarding flow is a `@gramio/scenes` Scene (see spec 00 §7). State (collected language, timezone, country) is persisted in SQLite so it survives bot restarts. If a user abandons mid-flow and returns later, they continue from where they left off.

---

## Middleware Pipeline

Middleware runs on every incoming update, in order:

### 1. User Resolver (`user-resolver.ts`)

- Extracts `telegram_id` from the update (message, callback_query, etc.)
- Looks up user in DB by `telegram_id`
- If not found: creates a new user row with defaults
- Updates cached `username` and `first_name` if changed
- Attaches `user` object to the context via GramIO's `derive()` mechanism

```typescript
// Pseudo-code
export function userResolverMiddleware(bot: Bot) {
  bot.derive(async (context) => {
    const telegramId = context.from?.id;
    if (!telegramId) return {};

    let user = database.users.findByTelegramId(telegramId);
    if (!user) {
      user = database.users.create({
        telegram_id: telegramId,
        username: context.from.username,
        first_name: context.from.firstName,
      });
    }
    return { dbUser: user };
  });
}
```

### 2. Timezone Context (`timezone-context.ts`)

- Reads `user.timezone` and makes it available as a derived context property
- Provides a helper `toUserTime(utcDate)` on context for formatting dates in the user's timezone

### 3. Rate Limiter (`rate-limiter.ts`)

Product-level rate limiting to prevent abuse. Not anti-DDoS — just sane limits.

- Per-user: 30 messages per minute, 200 per hour
- Per-user command-specific: `/add` max 20 per hour, `/export` max 5 per hour
- Implementation: in-memory Map with sliding window (reset on process restart is fine)
- Exceeded rate limit: respond once with "Slow down, you're sending too many messages" and silently drop for 60 seconds

---

## Event Service — Business Logic

### Creating Events

```typescript
class EventService {
  create(data: CreateEventData): CalendarEvent {
    // 1. Convert user-local time to UTC using data.timezone
    // 2. Validate: start_at must be valid date, end_at > start_at if set
    // 3. Insert event row
    // 4. Create reminder rows (from data.reminder_minutes or user's default)
    // 5. Return created event
  }
}
```

### Querying Events for a Date Range

```typescript
class EventService {
  getEventsInRange(userId: number, startUtc: string, endUtc: string): EventOccurrence[] {
    // 1. Fetch all non-recurring events in [start, end]
    // 2. Fetch all recurring templates where:
    //    - recurrence_end_at is null OR recurrence_end_at >= start
    //    - start_at <= end (the series started before our window ends)
    // 3. Expand each recurring template's RRULE within [start, end]
    // 4. Apply exceptions (modified or cancelled occurrences)
    // 5. Merge non-recurring + expanded recurring, sort by start
    // 6. Return EventOccurrence[]
  }
}
```

### Recurrence Expansion

Use a lightweight RRULE parser. Either:

- A bundled micro-library (parse RRULE string, iterate dates)
- Or `rrule` npm package if it works well under Bun

Supported RRULE properties:

- `FREQ`: DAILY, WEEKLY, MONTHLY, YEARLY
- `INTERVAL`: every N periods
- `BYDAY`: MO, TU, WE, TH, FR, SA, SU (for WEEKLY)
- `BYMONTHDAY`: day of month (for MONTHLY)
- `COUNT`: max occurrences
- `UNTIL`: end date

Examples:

- Daily: `FREQ=DAILY`
- Weekdays: `FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR`
- Monthly on the 15th: `FREQ=MONTHLY;BYMONTHDAY=15`
- Every 2 weeks: `FREQ=WEEKLY;INTERVAL=2`
- Yearly on birthday: `FREQ=YEARLY`

### Editing Recurring Events

When editing a single occurrence:

1. Create a new event row with `parent_event_id` = template ID
2. Set `original_start_at` to the occurrence date being replaced
3. Copy all fields from template, apply modifications
4. The occurrence expander skips `original_start_at` from the template and uses the exception row instead

When editing "all future":

1. Set `recurrence_end_at` on original template to one period before the edit point
2. Create a new recurring template starting from the edit point with modifications

When editing "all occurrences":

1. Update the template row directly
2. Delete all exception rows (they no longer apply)

---

## Callback Handling

All inline keyboard interactions route through a single callback handler. Callback data format: `action:param1:param2`.

```typescript
// Callback data examples:
// "event_view:42"          — view event details
// "event_edit:42:title"    — edit event title
// "event_delete:42"        — delete event (show confirmation)
// "event_delete_confirm:42" — confirm deletion
// "event_recurrence:42:this" — edit this occurrence only
// "event_reminder:42:add"  — add reminder to event
// "onboard_lang:en"        — set language during onboarding
// "onboard_tz_region:europe" — timezone region selection
// "onboard_tz:Europe/Moscow" — timezone city selection
// "month_nav:2026-04"      — navigate to April 2026
// "settings_toggle:morning_agenda" — toggle morning agenda
```

Callback data is limited to 64 bytes by Telegram. For data that doesn't fit, use a temporary lookup table (in-memory Map with TTL) that maps a short ID to the full payload.

---

## Error Handling Strategy

### Layers

1. **Command handlers** — try/catch around each handler, send user-friendly error message
2. **Middleware** — catch errors in user resolver gracefully (create user on retry)
3. **Bot-level** — GramIO's `bot.onError()` catches unhandled errors, logs them, sends generic "Something went wrong" to user
4. **Process-level** — `process.on('uncaughtException')` and `process.on('unhandledRejection')` — log and continue (don't crash for transient errors)

### User-Facing Errors

- Never expose stack traces or internal details
- Use consistent error format: "Something went wrong. Try again or use /help."
- For validation errors (bad date format, etc.): specific helpful message with example
- For rate limiting: short message, then silence

### Logging

Simple `console.log` / `console.error` with prefix for category:

```
[BOT] Starting...
[DB] Migration 001_create_users applied
[CMD:add] User 12345 created event "Dentist"
[ERR] Failed to parse date: "not a date" for user 12345
[RATE] User 12345 exceeded 30/min limit
```

No external logging library for now. Structured logging (JSON) can be added later if needed for production monitoring.

---

## Open Questions / Risks

### Open Questions

1. **RRULE library choice**: The `rrule` npm package is ~30KB and well-tested. Alternatively, write a minimal parser that handles only the subset we need (FREQ, INTERVAL, BYDAY, BYMONTHDAY, COUNT, UNTIL). The minimal approach reduces dependencies but increases maintenance burden. Leaning toward `rrule` package.

2. **Timezone library**: `date-fns-tz` vs Bun's native `Intl.DateTimeFormat` with timezone support. `Intl` is built-in and zero-dependency, but more verbose. `date-fns` is already in the stack (from ExpenseSyncBot patterns), so `date-fns-tz` is the natural choice.

3. **Geo-to-timezone mapping**: For location-based timezone detection. Options:
   - `geo-tz` package (~4MB of timezone shape data) — accurate but heavy
   - Simple lat/lng -> UTC offset approximation — inaccurate across DST boundaries
   - External API call (e.g., Google Timezone API) — adds latency and API dependency
   - Leaning toward `geo-tz` — one-time cost, works offline, accurate

4. **Holiday data source**: Nager.Date API (free, covers ~100 countries) vs Google Calendar holiday calendars vs hardcoded data. Nager.Date API seems best for v1 — cache results in `holidays_cache` table, refresh yearly.

5. **Multi-language**: Start with EN + RU only? Or design for extensibility from the start? Recommend: start with EN/RU, use a simple key-value i18n approach (not a full i18n framework), keep messages in a constants file per language.

6. **Shared events model**: Sharing is handled by proper tables (`invitations`, `shared_events`, `sharing_settings`, etc.) in sub-project 06. No `shared_with` column on events.

### Risks

1. **RRULE expansion performance**: Expanding recurring events across large date ranges with many series could be slow. Mitigation: limit expansion window (never expand more than 1 year ahead), index recurring templates separately, consider materialized occurrence cache for heavily recurring events.

2. **SQLite concurrency under load**: WAL mode helps, but write contention is possible with many simultaneous users. Mitigation: keep write transactions short, use prepared statements (already the pattern from ExpenseSyncBot), consider connection pooling if needed. Not a real concern until ~1000+ active users.

3. **Callback data 64-byte limit**: Complex interactions (editing recurring events with many parameters) may hit this limit. Mitigation: use action-based routing with minimal parameters, for wizard/multi-step state, use `@gramio/scenes` (see spec 00 §7); for truly transient callback overflow, use a short-lived in-memory Map (reset on restart is fine).

4. **Timezone DST transitions**: Events created during DST transition periods may display incorrectly if not handled carefully. Mitigation: always store UTC, always convert at display time using the IANA timezone, use `date-fns-tz` which handles DST correctly.

5. **Onboarding drop-off**: Multi-step onboarding in a chat bot is fragile — users may abandon mid-flow. Mitigation: every step is optional with sensible defaults (UTC timezone, EN language, no holidays). User can always come back and change settings later. The bot works even without completing onboarding.

---

## Dependencies (additions to package.json)

```json
{
  "dependencies": {
    "gramio": "^0.7.0",
    "date-fns": "^4.1.0",
    "@date-fns/tz": "^1.4.1",
    "rrule": "^2.8.1",
    "geo-tz": "^8.1.6",
    "pino": "^10.3.1"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "pino-pretty": "^13.1.3"
  }
}
```

Future sub-projects will add: `@anthropic-ai/sdk`, `bullmq`, `playwright`, `@roamhq/wrtc`, `googleapis`.
