# 00 — Common Architecture & Conventions

This document is the **single source of truth** for shared decisions across all HyperCalendarBot sub-projects. All specs MUST conform to these conventions. If a spec contradicts this document, this document wins.

---

## 1. Sub-Project Registry

Canonical numbering and implementation order:

| # | Spec File | Name | Dependencies | Status |
|---|-----------|------|-------------|--------|
| 01 | `01-core-bot-event-model.md` | Core Bot + Event Model | — | Design |
| 02 | `02-ai-agent.md` | AI Agent (NL interface) | 01 | Design |
| 03 | `03-google-calendar-sync.md` | Google Calendar Sync | 01 | Design |
| 04 | `04-notifications.md` | Notifications & Reminders | 01 | Design |
| 05 | `05-image-generation.md` | Image Generation (Playwright) | 01, 04 | Design |
| 06 | `06-sharing-social.md` | Sharing, Invitations & Social | 01, 05 | Design |
| 07 | `07-voice-calls.md` | Voice Call Reminders | 01, 04 | Design |
| 08 | `08-holidays.md` | Holiday Subscriptions | 01 | Design |

### Implementation Phases

**Phase A — Foundation:** 01 (Core Bot), 08 (Holidays)
**Phase B — Intelligence:** 02 (AI Agent), 04 (Notifications)
**Phase C — Visuals:** 05 (Image Generation)
**Phase D — Sync:** 03 (Google Calendar Sync)
**Phase E — Social:** 06 (Sharing & Social)
**Phase F — Voice:** 07 (Voice Call Reminders)

### Deferred Commands

Some commands in 01 belong to later sub-projects. They are listed in 01 for completeness but MUST NOT be implemented until their sub-project is active. Each command notes which sub-project owns it:

| Command | Owner Sub-Project | Phase |
|---------|-------------------|-------|
| `/today`, `/tomorrow`, `/week`, `/month` | 01 Core Bot | A |
| `/add`, `/edit`, `/delete`, `/search`, `/free` | 01 Core Bot | A |
| `/start`, `/timezone`, `/settings`, `/help`, `/ping` | 01 Core Bot | A |
| `/import`, `/export` | 01 Core Bot | A |
| `/holidays` | 08 Holidays | A |
| `/notify` | 04 Notifications | B |
| `/share`, `/invite`, `/invitations`, `/privacy`, `/unshare` | 06 Sharing & Social | E |

No commands are dropped. All listed commands WILL be implemented in their respective phases.

---

## 2. Technology Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Runtime | Bun | NOT Node.js. No `node:` prefix imports unless unavoidable |
| Language | TypeScript (strict) | |
| Bot framework | GramIO | |
| Bot sessions/FSM | `@gramio/scenes` + `@gramio/session` | Persistent via `@gramio/storage-sqlite` |
| Database | `bun:sqlite` (WAL mode) | |
| Job queue | BullMQ | Worker process, separate from bot |
| Redis | `Bun.redis` | For BullMQ, caching, sessions |
| HTTP server | `Bun.serve()` | For OAuth callbacks, WebRTC signaling, Mini App |
| AI model | Anthropic SDK via `api.z.ai` | GLM-5 model |
| Image rendering | Playwright (worker process) | |
| WebRTC | `@roamhq/wrtc` | Proven in `voice-ai-agent-ios` |
| TTS | Edge TTS (primary), OpenAI TTS (fallback) | |
| STT | Whisper on RunPod (primary), HuggingFace (fallback) | |
| Holiday data | `date-holidays` npm (offline) | Nager.Date API as fallback |
| Timezone | `date-fns` + `@date-fns/tz` | |
| Recurrence | `rrule` npm package | |
| Geo-to-timezone | `geo-tz` | |
| Logging | `pino` + `pino-pretty` (dev) | Structured JSON, fast, Bun-compatible |

### What NOT to use

- `node-cron` — use BullMQ repeatable jobs for scheduled tasks. `setInterval` is unreliable and `node-cron` is a Node.js dependency.
- `express` — use `Bun.serve()`.
- `dotenv` — Bun loads `.env` automatically.
- `better-sqlite3` — use `bun:sqlite`.
- `ws` — Bun has built-in WebSocket support.
- `ioredis` — use `Bun.redis`.

### Cron/Scheduling via BullMQ

Instead of `node-cron` or `setInterval`, use BullMQ repeatable jobs:

```typescript
// Per-minute notification tick
await notificationQueue.add('tick', {}, {
  repeat: { every: 60_000 }, // every 60 seconds
  removeOnComplete: true,
});

// Daily holiday refresh
await holidayQueue.add('refresh', {}, {
  repeat: { pattern: '0 3 1 1 *' }, // Jan 1st at 03:00 UTC
});

// Daily DST recomputation
await notificationQueue.add('recompute-utc', {}, {
  repeat: { pattern: '0 0 * * *' }, // midnight UTC daily
});
```

---

## 3. User Identity Convention

**`telegram_id` (INTEGER) is the primary user identifier everywhere.**

- The `users` table uses `telegram_id` as the lookup key (with a UNIQUE index).
- All other tables that reference a user store `telegram_id`, NOT an internal auto-increment `id`.
- Foreign keys reference `users(telegram_id)`.
- This eliminates the need to resolve internal IDs and simplifies queries.

```sql
-- Example: events reference user by telegram_id
CREATE TABLE events (
  ...
  user_id INTEGER NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  ...
);
```

The `users.id` auto-increment column is kept for internal use but should NOT appear in any other table's foreign keys.

---

## 4. Date/Time Convention

**All datetimes stored as ISO 8601 strings in UTC.**

- SQLite default: `DEFAULT (datetime('now'))` — produces ISO 8601 UTC strings.
- NEVER use `unixepoch()` or integer timestamps. Always ISO 8601 TEXT.
- User-facing times (morning_agenda_time, quiet_hours_start, etc.) stored as `HH:MM` TEXT in user's local timezone.
- Timezone-aware display: convert at application layer using `@date-fns/tz`.
- IANA timezone strings (e.g., `'Europe/Moscow'`).

---

## 5. Security & Encryption

**Principle: encrypt everything that can be used to impersonate or access external accounts.**

### What gets encrypted (AES-256-GCM)

| Data | Why |
|------|-----|
| `google_refresh_token` | Grants access to user's Google Calendar |
| `google_access_token` (if cached) | Short-lived but still sensitive |
| Deep link payloads (if containing user data) | Prevent enumeration |

### Encryption approach

```typescript
// src/utils/crypto.ts
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
// ENCRYPTION_KEY from env, 32 bytes hex

function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Store as: iv:tag:ciphertext (all base64)
  return `${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

function decrypt(encoded: string, key: Buffer): string {
  const [ivB64, tagB64, dataB64] = encoded.split(':');
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(data) + decipher.final('utf8');
}
```

### Environment variable

```
ENCRYPTION_KEY=<64-char hex string = 32 bytes>
```

Required for production. In development, a default key is used with a warning.

### What does NOT need encryption

- Event titles, descriptions, locations — user's own data in their own DB.
- Telegram user IDs — public information.
- Holiday data — public information.

### Other security measures

- Rate limiting on all user-facing endpoints.
- Input validation on all tool inputs (AI agent).
- HTML escaping for all user content in Telegram messages.
- No stack traces in user-facing errors.
- Event ownership verification on all mutations.
- Invitation spam limits (10/hour, configurable).
- Voice calls behind Telegram Stars paywall to limit abuse.

---

## 6. Image Caching Strategy

**Keep it simple. Telegram caches images on its own servers.**

- Do NOT cache rendered images in Redis or on disk.
- Render fresh on every request. Typical render time: 1.3-1.8s — acceptable.
- If performance becomes an issue later, add a short-lived cache (5 min TTL in Redis) with cache key based on `user_id + date + events_hash + theme + locale`.
- Retina rendering (`deviceScaleFactor: 2`) is mandatory — images must look crisp on all devices.

---

## 7. Session & Conversation State

**All multi-step user interactions (wizards, onboarding, flows) MUST survive bot restarts.**

### GramIO plugins

| Package | Purpose |
|---------|---------|
| `@gramio/scenes` | Step-based FSM for multi-step flows (onboarding, `/add` wizard, `/edit` wizard) |
| `@gramio/session` | Simple key-value session data on context (e.g. last viewed date) |
| `@gramio/storage-sqlite` | SQLite backend for both plugins, uses `bun:sqlite` natively |

Both plugins share the same `storage` interface. Use a single `sqliteStorage()` instance backed by the main DB file.

### Scenes (FSM)

Each multi-step flow is a `Scene` with typed state:

```typescript
import { Scene } from '@gramio/scenes';

const addEventScene = new Scene('add_event')
  .step('message', async (ctx) => {
    if (ctx.scene.step.firstTime) {
      await ctx.send('Event title?');
      return;
    }
    await ctx.scene.update({ title: ctx.text });
  })
  .step('message', async (ctx) => {
    if (ctx.scene.step.firstTime) {
      await ctx.send('Date and time?');
      return;
    }
    // parse and save...
    await ctx.scene.exit();
  });
```

- Enter scene: `ctx.scene.enter(sceneName)`
- State: `ctx.scene.state` (typed, persisted)
- Navigation: `ctx.scene.update(data)` advances to next step
- Exit: `ctx.scene.exit()`
- Abort: user sends `/cancel` or a new command

### Storage

```typescript
import { sqliteStorage } from '@gramio/storage-sqlite';

const storage = sqliteStorage({
  db: existingBunSqliteDb,  // reuse the main DB connection
  tableName: 'gramio_state',
});
```

The storage table is auto-created. TTL is supported (`$ttl` option in seconds).

### What stays in-memory

- **Rate limiter** — sliding window counters. Reset on restart is fine (users get fresh allowance).
- **Callback data overflow** — short-lived ID→payload map. Inline keyboards are regenerated on restart.

### What MUST be persistent

- Onboarding wizard state (spec 01)
- `/add` event wizard state (spec 01)
- `/edit` event wizard state (spec 01)
- `/timezone` location prompt state (spec 01)
- `/import` file upload waiting state (spec 01)
- OAuth CSRF state tokens (spec 03 — Redis)
- Share preview sessions (spec 06 — Redis)
- Voice call sessions (spec 07 — Redis or SQLite)

---

## 8. Canonical SQLite Schema


This is the unified schema. Individual specs may describe their tables for context, but this section is the canonical version. Conflicts are resolved here.

### Migration numbering

Migrations are numbered sequentially across all sub-projects:

| Migration | Sub-Project | Tables |
|-----------|-------------|--------|
| 001 | 01 Core | `migrations`, `users` |
| 002 | 01 Core | `events` |
| 003 | 01 Core | `reminders` (basic, pre-materialization) |
| 004 | 08 Holidays | `holiday_countries`, `holidays`, `holiday_subscriptions`, `holiday_overrides` |
| 005 | 02 AI Agent | `chat_history` |
| 006 | 04 Notifications | `notification_preferences`, `event_reminders`, `notification_log` |
| 007 | 03 Google Sync | `google_sync_state` (adds encrypted token columns to users) |
| 008 | 06 Social | `invitations`, `shared_events`, `sharing_settings`, `event_visibility`, `group_chats`, `group_shared_events`, `deep_links` |
| 009 | 07 Voice | `user_call_settings`, `call_log`, `call_daily_count`, `cold_start_analytics`, `tts_cache`, `call_sessions` |

### Table: `migrations`

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
  telegram_id INTEGER PRIMARY KEY,            -- Telegram user ID, primary key
  username TEXT,                               -- cached @username
  first_name TEXT,                             -- cached first name
  language TEXT NOT NULL DEFAULT 'en',         -- 'en' | 'ru'
  timezone TEXT NOT NULL DEFAULT 'UTC',        -- IANA timezone
  country_code TEXT,                           -- ISO 3166-1 alpha-2 (for holidays)
  -- Google Calendar (encrypted — sub-project 03)
  google_refresh_token_enc TEXT,              -- AES-256-GCM encrypted
  google_calendar_id TEXT,                     -- primary calendar ID to sync
  -- Metadata
  onboarding_completed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**Changes from individual specs:**

- `id` auto-increment removed. `telegram_id` IS the primary key.
- Notification preferences moved to separate `notification_preferences` table (no duplication).
- `google_refresh_token` renamed to `google_refresh_token_enc` (encrypted).
- `shared_with` JSON column on events REMOVED (replaced by proper sharing tables in 06).

### Table: `events`

```sql
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,                    -- telegram_id
  title TEXT NOT NULL,
  description TEXT,
  -- Category
  category TEXT,                               -- 'work' | 'personal' | 'health' | 'social' | etc.
  -- Time
  start_at TEXT NOT NULL,                      -- ISO 8601 UTC
  end_at TEXT,                                 -- nullable = point-in-time event
  all_day INTEGER NOT NULL DEFAULT 0,
  timezone TEXT NOT NULL,                       -- IANA timezone event was created in
  -- Location
  location TEXT,
  -- Recurrence
  recurrence_rule TEXT,                         -- RRULE string (RFC 5545)
  recurrence_end_at TEXT,                       -- When recurring series ends (UTC)
  parent_event_id INTEGER,                      -- Points to recurring template for exceptions
  original_start_at TEXT,                        -- Original occurrence date this exception replaces
  is_cancelled INTEGER NOT NULL DEFAULT 0,
  -- Reminders (per-event override)
  reminder_overrides TEXT,                      -- JSON array of minutes, e.g. [5, 30], NULL = use defaults
  -- Google Sync (sub-project 03)
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

**Changes:**

- `category` field added (referenced by AI Agent tools).
- `reminder_overrides` moved here from sub-project 04 spec.
- `shared_with` REMOVED (proper sharing tables in 06).
- `user_id` references `users(telegram_id)`.

### Table: `reminders` (basic, sub-project 01)

Simple per-event reminders for core functionality before notification system is built.

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

### Table: `chat_history` (sub-project 02)

```sql
CREATE TABLE chat_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,                   -- telegram_id
  role TEXT NOT NULL,                          -- 'user' | 'assistant'
  content TEXT NOT NULL,                       -- plain text or JSON array of content blocks
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
);

CREATE INDEX idx_chat_history_user ON chat_history(user_id, created_at);
```

### Tables: Holidays (sub-project 08)

```sql
CREATE TABLE holiday_countries (
  country_code TEXT PRIMARY KEY,
  name_en TEXT NOT NULL,
  name_ru TEXT,
  supported INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE holidays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  country_code TEXT NOT NULL,
  year INTEGER NOT NULL,
  date TEXT NOT NULL,                          -- YYYY-MM-DD
  name_en TEXT NOT NULL,
  name_ru TEXT,
  local_name TEXT,
  type TEXT NOT NULL,                          -- 'public' | 'bank' | 'school' | 'optional' | 'observance'
  is_substitute INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(country_code, date, name_en)
);

CREATE INDEX idx_holidays_date ON holidays(date);
CREATE INDEX idx_holidays_country_year ON holidays(country_code, year);

CREATE TABLE holiday_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,                   -- telegram_id
  country_code TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0,
  notify_eve INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, country_code),
  FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE,
  FOREIGN KEY (country_code) REFERENCES holiday_countries(country_code)
);

CREATE INDEX idx_holiday_subs_user ON holiday_subscriptions(user_id);

CREATE TABLE holiday_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,                   -- telegram_id
  date TEXT NOT NULL,
  is_working INTEGER NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, date),
  FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
);

CREATE INDEX idx_holiday_overrides_user_date ON holiday_overrides(user_id, date);
```

### Tables: Notifications (sub-project 04)

```sql
CREATE TABLE notification_preferences (
  user_id INTEGER PRIMARY KEY,               -- telegram_id
  morning_agenda_enabled INTEGER NOT NULL DEFAULT 1,
  morning_agenda_time TEXT NOT NULL DEFAULT '08:00',
  morning_agenda_utc TEXT,                    -- pre-computed for fast lookups
  morning_agenda_format TEXT NOT NULL DEFAULT 'text',
  default_reminder_intervals TEXT NOT NULL DEFAULT '[15]',
  evening_review_enabled INTEGER NOT NULL DEFAULT 0,
  evening_review_time TEXT NOT NULL DEFAULT '21:00',
  evening_review_utc TEXT,
  evening_review_format TEXT NOT NULL DEFAULT 'text',
  quiet_hours_enabled INTEGER NOT NULL DEFAULT 0,
  quiet_hours_start TEXT,
  quiet_hours_end TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
);

CREATE TABLE event_reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,                   -- telegram_id
  remind_at_utc TEXT NOT NULL,
  interval_minutes INTEGER NOT NULL,
  interval_label TEXT NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
);

CREATE INDEX idx_event_reminders_due
  ON event_reminders(remind_at_utc, sent) WHERE sent = 0;
CREATE INDEX idx_event_reminders_event ON event_reminders(event_id);

CREATE TABLE notification_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,                   -- telegram_id
  type TEXT NOT NULL,
  reference_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  channel TEXT NOT NULL DEFAULT 'telegram_text',
  payload TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_notification_log_dedup ON notification_log(reference_key);
CREATE INDEX idx_notification_log_status ON notification_log(status, created_at);
```

### Tables: Sharing & Social (sub-project 06)

```sql
CREATE TABLE invitations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  inviter_id INTEGER NOT NULL,                -- telegram_id
  invitee_id INTEGER NOT NULL,                -- telegram_id
  status TEXT NOT NULL DEFAULT 'pending',
  message_id INTEGER,
  chat_id INTEGER,
  deep_link_code TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  responded_at TEXT,
  UNIQUE(event_id, invitee_id, created_at),
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);

CREATE INDEX idx_invitations_invitee ON invitations(invitee_id, status);
CREATE INDEX idx_invitations_event ON invitations(event_id);
CREATE INDEX idx_invitations_status ON invitations(status) WHERE status IN ('pending', 'maybe');

CREATE TABLE shared_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  shared_by INTEGER NOT NULL,                 -- telegram_id
  shared_to_type TEXT NOT NULL,
  shared_to_id INTEGER NOT NULL,
  share_type TEXT NOT NULL,
  message_id INTEGER,
  deep_link_code TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);

CREATE INDEX idx_shared_events_event ON shared_events(event_id);
CREATE INDEX idx_shared_events_target ON shared_events(shared_to_type, shared_to_id);

CREATE TABLE sharing_settings (
  user_id INTEGER PRIMARY KEY,                -- telegram_id
  default_visibility TEXT NOT NULL DEFAULT 'private',
  inline_mode_enabled INTEGER NOT NULL DEFAULT 1,
  allow_invitations INTEGER NOT NULL DEFAULT 1,
  share_location INTEGER NOT NULL DEFAULT 0,
  share_description INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
);

CREATE TABLE event_visibility (
  event_id INTEGER PRIMARY KEY,
  visibility TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);

CREATE TABLE group_chats (
  chat_id INTEGER PRIMARY KEY,
  title TEXT,
  added_by INTEGER NOT NULL,                  -- telegram_id
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE group_shared_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  event_id INTEGER NOT NULL,
  shared_by INTEGER NOT NULL,                 -- telegram_id
  message_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(chat_id, event_id),
  FOREIGN KEY (chat_id) REFERENCES group_chats(chat_id),
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);

CREATE INDEX idx_group_shared_chat ON group_shared_events(chat_id);

CREATE TABLE deep_links (
  code TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_by INTEGER NOT NULL,                -- telegram_id
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  used_count INTEGER NOT NULL DEFAULT 0
);
```

### Tables: Voice Calls (sub-project 07)

```sql
CREATE TABLE user_call_settings (
  user_id INTEGER PRIMARY KEY,               -- telegram_id
  calls_enabled INTEGER NOT NULL DEFAULT 0,
  call_tier TEXT NOT NULL DEFAULT 'voice_message',
  max_calls_day INTEGER NOT NULL DEFAULT 5,
  quiet_start TEXT NOT NULL DEFAULT '23:00',
  quiet_end TEXT NOT NULL DEFAULT '07:00',
  call_language TEXT NOT NULL DEFAULT 'ru',
  important_only INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
);

CREATE TABLE call_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,                  -- telegram_id
  event_id INTEGER NOT NULL,
  call_type TEXT NOT NULL,
  state TEXT NOT NULL,
  tts_engine TEXT NOT NULL,
  tts_latency_ms INTEGER,
  stt_provider TEXT,
  stt_latency_ms INTEGER,
  cold_start_ms INTEGER,
  call_duration_ms INTEGER,
  user_response TEXT,
  action_taken TEXT,
  snooze_minutes INTEGER,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
);

CREATE TABLE call_daily_count (
  user_id INTEGER NOT NULL,                  -- telegram_id
  date TEXT NOT NULL,
  call_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, date)
);

CREATE TABLE cold_start_analytics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  provider TEXT NOT NULL DEFAULT 'runpod',
  cold_start_ms INTEGER NOT NULL,
  was_pre_warmed INTEGER NOT NULL DEFAULT 0,
  inference_ms INTEGER NOT NULL,
  audio_length_ms INTEGER,
  success INTEGER NOT NULL DEFAULT 1,
  error TEXT
);

CREATE TABLE tts_cache (
  cache_key TEXT PRIMARY KEY,
  voice TEXT NOT NULL,
  language TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  audio_size INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT NOT NULL DEFAULT (datetime('now')),
  use_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE call_sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,                  -- telegram_id
  event_id INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'created',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  connected_at TEXT,
  ended_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
);
```

---

## 9. Environment Variables (Full List)

```env
# Required
BOT_TOKEN=                        # Telegram bot token
ENCRYPTION_KEY=                   # 64-char hex (32 bytes) for AES-256-GCM

# Database
DATABASE_PATH=./data/calendar.db

# Redis (for BullMQ)
REDIS_URL=redis://localhost:6379

# Google OAuth (sub-project 03)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:3311/callback
OAUTH_SERVER_PORT=3311

# AI (sub-project 02)
ANTHROPIC_API_KEY=
AI_BASE_URL=https://api.z.ai/api/anthropic
AI_MODEL=glm-5

# Voice Calls (sub-project 07)
RUNPOD_API_KEY=
RUNPOD_ENDPOINT=
HF_API_KEY=                       # HuggingFace fallback

# Environment
NODE_ENV=development
```

---

## 10. Error Handling

### Layers (all sub-projects)

1. **Command/tool handlers** — try/catch, user-friendly message
2. **Middleware** — graceful fallback
3. **Bot-level** — `bot.onError()`, generic "Something went wrong"
4. **Process-level** — log and continue (no crash on transient errors)

### User-facing errors

- Never expose internals
- Validation errors: specific message with example
- Rate limit: one message, then silence for 60s
- Format: `"Something went wrong. Try again or use /help."`

### Logging

Use **pino** for structured JSON logging. Fast, low-overhead, works with Bun.

```typescript
// src/utils/logger.ts
import pino from 'pino';

export const logger = pino({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
});

// Child loggers per module
export const botLogger = logger.child({ module: 'bot' });
export const dbLogger = logger.child({ module: 'db' });
export const notifyLogger = logger.child({ module: 'notify' });
export const voiceLogger = logger.child({ module: 'voice' });
export const aiLogger = logger.child({ module: 'ai' });
```

Usage:

```typescript
botLogger.info('Starting...');
dbLogger.info({ migration: '001_create_users' }, 'Migration applied');
botLogger.info({ userId: 12345, event: 'Dentist' }, 'Event created');
botLogger.error({ userId: 12345, input: 'not a date' }, 'Failed to parse date');
notifyLogger.info({ count: 42 }, 'Morning agenda sent');
voiceLogger.info({ userId: 12345, eventId: 789 }, 'Call initiated');
```

Dependencies: `pino` + `pino-pretty` (devDependency for local dev).

---

## 11. Voice Calls — Monetization & Abuse Prevention

Voice call reminders (sub-project 07) are a premium feature gated behind **Telegram Stars** payment.

- Users must pay Stars to enable voice call reminders.
- This naturally limits adoption and prevents abuse/spam.
- Keeps virtual user account safe from Telegram bans (low volume = less suspicious).
- Pricing TBD — enough to discourage mass use, low enough to be useful for power users.
- Free tier: voice message reminders (text + TTS audio as Telegram voice note). No Stars required.
- Paid tier: WebRTC Mini App calls with STT + AI agent response.

### Reference Implementation

The WebRTC server-side implementation is proven and exists at `/Users/ultra/xp/voice-ai-agent-ios/server/src/`. Key components:

- `simple-webrtc.js` — WebSocket signaling + `@roamhq/wrtc` peer connection
- `webrtc-loader.js` — graceful wrtc loading
- `ai/whisper.js`, `ai/whisper-hf.js` — STT pipeline
- `ai/elevenlabs.js` — TTS (we use Edge TTS instead, but architecture is the same)

This is NOT "impossible in JS/TS" — it's already working.
