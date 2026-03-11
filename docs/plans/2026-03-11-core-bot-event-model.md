# Core Bot + Event Model Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the foundation layer for HyperCalendarBot — GramIO bot with middleware pipeline, SQLite schema for users/events/recurrence, full CRUD via Telegram commands, onboarding with timezone detection.

**Architecture:** GramIO bot with middleware chain (user resolver → timezone context → rate limiter). SQLite via bun:sqlite (WAL mode) for storage. Event service handles CRUD + recurrence expansion via rrule. All dates stored as ISO 8601 UTC, converted to user timezone at display time via @date-fns/tz. Commands in separate files, registered via bot method chaining.

**Tech Stack:** Bun, TypeScript (strict), GramIO, bun:sqlite, date-fns v4 + @date-fns/tz, rrule, geo-tz, pino + pino-pretty

**Specs:** `docs/specs/00-common-architecture.md`, `docs/specs/01-core-bot-event-model.md`

---

## File Structure

```
src/
├── config/
│   ├── env.ts                          # Validated env config
│   └── constants.ts                    # Bot messages (i18n), limits, defaults
├── database/
│   ├── index.ts                        # DatabaseService singleton
│   ├── schema.ts                       # Migration runner + migrations array
│   ├── types.ts                        # All DB model interfaces
│   └── repositories/
│       ├── user.repository.ts          # User CRUD
│       ├── event.repository.ts         # Event CRUD + range queries
│       └── reminder.repository.ts      # Reminder CRUD
├── services/
│   ├── event/
│   │   ├── event-service.ts            # Business logic: create/update/delete/query
│   │   ├── recurrence.ts              # RRULE expansion
│   │   └── formatters.ts             # Format events for Telegram display
│   ├── timezone/
│   │   └── timezone-service.ts        # Resolve tz from coords, list popular
│   └── ics/
│       ├── parser.ts                  # Parse .ics files
│       └── generator.ts              # Generate .ics export
├── bot/
│   ├── index.ts                       # createBot() factory
│   ├── types.ts                       # Context type aliases, session types
│   ├── keyboards.ts                   # Inline/reply keyboard builders
│   ├── middleware/
│   │   ├── user-resolver.ts           # Lookup/create user per update
│   │   ├── timezone-context.ts        # Attach tz helpers to context
│   │   └── rate-limiter.ts            # Per-user rate limiting
│   ├── commands/
│   │   ├── start.ts                   # /start — onboarding
│   │   ├── today.ts                   # /today
│   │   ├── tomorrow.ts               # /tomorrow
│   │   ├── week.ts                   # /week
│   │   ├── month.ts                  # /month
│   │   ├── add.ts                    # /add — create event
│   │   ├── edit.ts                   # /edit — modify event
│   │   ├── delete.ts                 # /delete — remove event
│   │   ├── search.ts                 # /search
│   │   ├── free.ts                   # /free — find free slots
│   │   ├── timezone.ts              # /timezone
│   │   ├── settings.ts             # /settings
│   │   ├── import.ts               # /import
│   │   ├── export.ts               # /export
│   │   ├── help.ts                 # /help
│   │   └── ping.ts                 # /ping
│   └── handlers/
│       ├── callback.handler.ts      # Inline keyboard callbacks router
│       └── message.handler.ts       # Free-text fallback
├── utils/
│   ├── date.ts                      # date-fns helpers, simple date parser
│   ├── logger.ts                    # pino logger setup
│   └── telegram.ts                  # HTML escape, message truncation
└── index.ts                          # Entry point (moved from root)
```

```
test/
├── database/
│   ├── schema.test.ts
│   └── repositories/
│       ├── user.repository.test.ts
│       ├── event.repository.test.ts
│       └── reminder.repository.test.ts
├── services/
│   ├── event/
│   │   ├── event-service.test.ts
│   │   ├── recurrence.test.ts
│   │   └── formatters.test.ts
│   ├── timezone/
│   │   └── timezone-service.test.ts
│   └── ics/
│       ├── parser.test.ts
│       └── generator.test.ts
├── bot/
│   └── middleware/
│       └── rate-limiter.test.ts
└── utils/
    └── date.test.ts
```

---

## Chunk 1: Project Setup & Config

### Task 1: Install dependencies & scaffold directories

**Files:**
- Modify: `package.json`
- Modify: `.gitignore`
- Create: `src/` directory tree
- Create: `test/` directory tree

- [ ] **Step 1: Install production dependencies (pinned to latest verified versions)**

```bash
bun add gramio@0.7.0 date-fns@4.1.0 @date-fns/tz@1.4.1 rrule@2.8.1 geo-tz@8.1.6 pino@10.3.1
```

- [ ] **Step 2: Install dev dependencies**

```bash
bun add -d pino-pretty@13.1.3
```

- [ ] **Step 3: Create directory structure**

```bash
mkdir -p src/{config,database/repositories,services/{event,timezone,ics},bot/{middleware,commands,handlers},utils}
mkdir -p test/{database/repositories,services/{event,timezone,ics},bot/middleware,utils}
```

- [ ] **Step 4: Add `data/` to .gitignore**

Append to `.gitignore`:
```
# SQLite database
data/
```

- [ ] **Step 5: Create .env.example**

```env
# Required
BOT_TOKEN=your_telegram_bot_token

# Database
DATABASE_PATH=./data/calendar.db

# Environment
NODE_ENV=development
```

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "chore: scaffold project structure and install dependencies"
```

---

### Task 2: Logger setup

**Files:**
- Create: `src/utils/logger.ts`

- [ ] **Step 1: Write logger module**

```typescript
// src/utils/logger.ts
import pino from 'pino';

export const logger = pino({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
});

export const botLogger = logger.child({ module: 'bot' });
export const dbLogger = logger.child({ module: 'db' });
export const cmdLogger = logger.child({ module: 'cmd' });
```

- [ ] **Step 2: Verify it runs**

```bash
bun -e "import { botLogger } from './src/utils/logger.ts'; botLogger.info('test')"
```

Expected: colored log line with `module: 'bot'`

- [ ] **Step 3: Commit**

```bash
git add src/utils/logger.ts && git commit -m "feat: add pino logger with child loggers"
```

---

### Task 3: Environment config

**Files:**
- Create: `src/config/env.ts`
- Create: `test/config/env.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// test/config/env.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { loadConfig } from '../../src/config/env.ts';

describe('loadConfig', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('throws if BOT_TOKEN is missing', () => {
    delete process.env.BOT_TOKEN;
    expect(() => loadConfig()).toThrow('BOT_TOKEN');
  });

  test('returns config with defaults when BOT_TOKEN is set', () => {
    process.env.BOT_TOKEN = 'test-token';
    const config = loadConfig();
    expect(config.BOT_TOKEN).toBe('test-token');
    expect(config.DATABASE_PATH).toBe('./data/calendar.db');
    expect(config.NODE_ENV).toBe('development');
  });

  test('respects DATABASE_PATH override', () => {
    process.env.BOT_TOKEN = 'test-token';
    process.env.DATABASE_PATH = '/tmp/test.db';
    const config = loadConfig();
    expect(config.DATABASE_PATH).toBe('/tmp/test.db');
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

```bash
bun test test/config/env.test.ts
```

Expected: FAIL — `loadConfig` not found

- [ ] **Step 3: Write implementation**

```typescript
// src/config/env.ts
export interface EnvConfig {
  BOT_TOKEN: string;
  DATABASE_PATH: string;
  NODE_ENV: 'development' | 'production';
}

export function loadConfig(): EnvConfig {
  const BOT_TOKEN = process.env.BOT_TOKEN;
  if (!BOT_TOKEN) {
    throw new Error('BOT_TOKEN environment variable is required');
  }

  return {
    BOT_TOKEN,
    DATABASE_PATH: process.env.DATABASE_PATH || './data/calendar.db',
    NODE_ENV: (process.env.NODE_ENV as EnvConfig['NODE_ENV']) || 'development',
  };
}
```

- [ ] **Step 4: Run test — verify it passes**

```bash
bun test test/config/env.test.ts
```

Expected: 3 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/config/env.ts test/config/env.test.ts && git commit -m "feat: add env config with validation"
```

---

### Task 4: Constants module

**Files:**
- Create: `src/config/constants.ts`

- [ ] **Step 1: Write constants**

```typescript
// src/config/constants.ts

// Rate limits
export const RATE_LIMIT = {
  MESSAGES_PER_MINUTE: 30,
  MESSAGES_PER_HOUR: 200,
  ADD_PER_HOUR: 20,
  EXPORT_PER_HOUR: 5,
  COOLDOWN_MS: 60_000,
} as const;

// Defaults
export const DEFAULTS = {
  LANGUAGE: 'en' as const,
  TIMEZONE: 'UTC',
  REMINDER_MINUTES: 15,
  WEEK_STARTS_ON: 1 as const, // Monday
} as const;

// Callback data prefixes
export const CB = {
  EVENT_VIEW: 'ev',
  EVENT_EDIT: 'ee',
  EVENT_DELETE: 'ed',
  EVENT_DELETE_CONFIRM: 'edc',
  EVENT_RECURRENCE: 'er',
  EVENT_REMINDER: 'erm',
  ONBOARD_LANG: 'ol',
  ONBOARD_TZ_REGION: 'otr',
  ONBOARD_TZ: 'ot',
  ONBOARD_COUNTRY: 'oc',
  ONBOARD_AGENDA: 'oa',
  MONTH_NAV: 'mn',
  SETTINGS: 'st',
  EDIT_FIELD: 'ef',
  ADD_STEP: 'as',
} as const;

// i18n messages
export const MSG = {
  en: {
    welcome: '🌍 Choose your language / Выберите язык:',
    tz_prompt: "Now let's set your timezone. The most accurate way is to share your location.",
    tz_detected: (tz: string, offset: string) => `Got it! Your timezone is ${tz} (${offset}).\nIs this correct?`,
    tz_confirm_yes: 'Yes ✓',
    tz_confirm_no: 'No, choose manually',
    share_location: '📍 Share Location',
    choose_manually: '⌨️ Choose Manually',
    country_prompt: 'Want to see public holidays in your calendar?',
    country_skip: 'Skip',
    agenda_prompt: 'I can send you a morning summary of your day\'s events.\n\nEnable morning agenda at 08:00?',
    onboard_done: '✅ All set! Here\'s what you can do:\n\n/add — create your first event\n/today — view today\'s schedule\n/help — see all commands',
    no_events_today: (date: string) => `📅 ${date}\n\nNo events today. Use /add to create one.`,
    no_events: 'No events in this range.',
    event_created: (title: string) => `✅ Created: "${title}"`,
    event_deleted: (title: string) => `🗑 Deleted: "${title}"`,
    event_updated: (title: string) => `✏️ Updated: "${title}"`,
    confirm_delete: (title: string) => `Delete "${title}"?`,
    search_no_results: 'No events found.',
    something_wrong: 'Something went wrong. Try again or use /help.',
    rate_limited: 'Slow down, too many messages.',
    add_title_prompt: "Let's create an event. What's the title?",
    add_time_prompt: 'When? (e.g., "tomorrow 18:00", "Mar 15 19:30")',
    add_duration_prompt: 'How long? (e.g., "1h", "30m", "2h30m") or skip for no end time.',
    edit_pick: 'Which event to edit? Pick from upcoming:',
    delete_pick: 'Which event to delete?',
    free_header: (date: string) => `📋 Free slots ${date}:`,
    pong: (ms: number) => `pong (${ms}ms)`,
    welcome_back: "Welcome back! Use /help for commands.",
  },
  ru: {
    welcome: '🌍 Choose your language / Выберите язык:',
    tz_prompt: 'Установим часовой пояс. Самый точный способ — поделиться геолокацией.',
    tz_detected: (tz: string, offset: string) => `Ваш часовой пояс: ${tz} (${offset}).\nВсё верно?`,
    tz_confirm_yes: 'Да ✓',
    tz_confirm_no: 'Нет, выбрать вручную',
    share_location: '📍 Отправить геолокацию',
    choose_manually: '⌨️ Выбрать вручную',
    country_prompt: 'Показывать государственные праздники в календаре?',
    country_skip: 'Пропустить',
    agenda_prompt: 'Могу отправлять утреннюю сводку событий на день.\n\nВключить утреннюю сводку в 08:00?',
    onboard_done: '✅ Всё готово! Вот что можно сделать:\n\n/add — создать событие\n/today — расписание на сегодня\n/help — список команд',
    no_events_today: (date: string) => `📅 ${date}\n\nНет событий. Используйте /add для создания.`,
    no_events: 'Нет событий за этот период.',
    event_created: (title: string) => `✅ Создано: "${title}"`,
    event_deleted: (title: string) => `🗑 Удалено: "${title}"`,
    event_updated: (title: string) => `✏️ Обновлено: "${title}"`,
    confirm_delete: (title: string) => `Удалить "${title}"?`,
    search_no_results: 'Ничего не найдено.',
    something_wrong: 'Что-то пошло не так. Попробуйте ещё раз или /help.',
    rate_limited: 'Слишком много сообщений, подождите.',
    add_title_prompt: 'Создаём событие. Как назовём?',
    add_time_prompt: 'Когда? (например, "завтра 18:00", "15 мар 19:30")',
    add_duration_prompt: 'Сколько длится? (например, "1ч", "30м") или пропустите.',
    edit_pick: 'Какое событие редактировать?',
    delete_pick: 'Какое событие удалить?',
    free_header: (date: string) => `📋 Свободные слоты ${date}:`,
    pong: (ms: number) => `понг (${ms}мс)`,
    welcome_back: 'С возвращением! /help для списка команд.',
  },
} as const;

export type Lang = keyof typeof MSG;
export type Messages = typeof MSG[Lang];

export function t(lang: Lang): Messages {
  return MSG[lang] || MSG.en;
}

// Popular timezone regions for manual selection
export const TZ_REGIONS: Record<string, string[]> = {
  Europe: [
    'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Moscow',
    'Europe/Istanbul', 'Europe/Kiev', 'Europe/Warsaw', 'Europe/Rome',
    'Europe/Madrid', 'Europe/Amsterdam', 'Europe/Belgrade', 'Europe/Helsinki',
  ],
  Asia: [
    'Asia/Dubai', 'Asia/Kolkata', 'Asia/Bangkok', 'Asia/Singapore',
    'Asia/Tokyo', 'Asia/Seoul', 'Asia/Shanghai', 'Asia/Hong_Kong',
    'Asia/Almaty', 'Asia/Tbilisi', 'Asia/Yerevan', 'Asia/Tashkent',
  ],
  Americas: [
    'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
    'America/Toronto', 'America/Sao_Paulo', 'America/Mexico_City', 'America/Buenos_Aires',
  ],
  Africa: [
    'Africa/Cairo', 'Africa/Lagos', 'Africa/Johannesburg', 'Africa/Nairobi',
  ],
  Oceania: [
    'Australia/Sydney', 'Australia/Melbourne', 'Pacific/Auckland',
  ],
};
```

- [ ] **Step 2: Commit**

```bash
git add src/config/constants.ts && git commit -m "feat: add constants, i18n messages, callback prefixes"
```

---

## Chunk 2: Database Foundation

### Task 5: Database types

**Files:**
- Create: `src/database/types.ts`

- [ ] **Step 1: Write all DB model interfaces**

```typescript
// src/database/types.ts

// ── Row types (match SQLite columns exactly) ──

export interface User {
  telegram_id: number;
  username: string | null;
  first_name: string | null;
  language: 'en' | 'ru';
  timezone: string;
  country_code: string | null;
  google_refresh_token_enc: string | null;
  google_calendar_id: string | null;
  onboarding_completed: number; // 0 | 1
  created_at: string;
  updated_at: string;
}

export interface CalendarEvent {
  id: number;
  user_id: number;
  title: string;
  description: string | null;
  category: string | null;
  start_at: string;
  end_at: string | null;
  all_day: number; // 0 | 1
  timezone: string;
  location: string | null;
  recurrence_rule: string | null;
  recurrence_end_at: string | null;
  parent_event_id: number | null;
  original_start_at: string | null;
  is_cancelled: number; // 0 | 1
  reminder_overrides: string | null; // JSON array "[5, 30]"
  google_event_id: string | null;
  google_calendar_id: string | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Reminder {
  id: number;
  event_id: number;
  minutes_before: number;
  created_at: string;
}

// ── Input types ──

export interface CreateUserData {
  telegram_id: number;
  username?: string;
  first_name?: string;
  language?: 'en' | 'ru';
  timezone?: string;
  country_code?: string;
}

export interface UpdateUserData {
  username?: string;
  first_name?: string;
  language?: 'en' | 'ru';
  timezone?: string;
  country_code?: string;
  onboarding_completed?: number;
}

export interface CreateEventData {
  user_id: number;
  title: string;
  description?: string;
  category?: string;
  start_at: string; // ISO 8601 UTC
  end_at?: string;
  all_day?: boolean;
  timezone: string;
  location?: string;
  recurrence_rule?: string;
  recurrence_end_at?: string;
  reminder_minutes?: number[];
}

export interface UpdateEventData {
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
  reminder_overrides?: string | null;
}

// ── Computed types ──

export interface EventOccurrence {
  event: CalendarEvent;
  occurrence_start: string;
  occurrence_end: string | null;
  is_exception: boolean;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/database/types.ts && git commit -m "feat: add database model types"
```

---

### Task 6: Migration runner + test

**Files:**
- Create: `src/database/schema.ts`
- Create: `test/database/schema.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// test/database/schema.test.ts
import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { runMigrations } from '../../src/database/schema.ts';
import type { Migration } from '../../src/database/schema.ts';

describe('runMigrations', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  test('creates migrations table and applies migrations', () => {
    const migrations: Migration[] = [
      {
        name: '001_test',
        up: (db) => {
          db.exec('CREATE TABLE test_table (id INTEGER PRIMARY KEY)');
        },
      },
    ];

    runMigrations(db, migrations);

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as { name: string }[];
    const tableNames = tables.map(t => t.name);

    expect(tableNames).toContain('migrations');
    expect(tableNames).toContain('test_table');
  });

  test('skips already applied migrations', () => {
    let callCount = 0;
    const migrations: Migration[] = [
      {
        name: '001_test',
        up: () => { callCount++; },
      },
    ];

    runMigrations(db, migrations);
    runMigrations(db, migrations);

    expect(callCount).toBe(1);
  });

  test('applies migrations in order', () => {
    const order: string[] = [];
    const migrations: Migration[] = [
      { name: '001_first', up: () => { order.push('first'); } },
      { name: '002_second', up: () => { order.push('second'); } },
    ];

    runMigrations(db, migrations);

    expect(order).toEqual(['first', 'second']);
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

```bash
bun test test/database/schema.test.ts
```

- [ ] **Step 3: Write implementation**

```typescript
// src/database/schema.ts
import type { Database } from 'bun:sqlite';
import { dbLogger } from '../utils/logger.ts';

export interface Migration {
  name: string;
  up: (db: Database) => void;
}

export function runMigrations(db: Database, migrations: Migration[]): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const applied = new Set(
    (db.prepare('SELECT name FROM migrations').all() as { name: string }[])
      .map(r => r.name)
  );

  for (const migration of migrations) {
    if (applied.has(migration.name)) continue;

    dbLogger.info({ migration: migration.name }, 'Applying migration');
    db.transaction(() => {
      migration.up(db);
      db.prepare('INSERT INTO migrations (name) VALUES (?)').run(migration.name);
    })();
    dbLogger.info({ migration: migration.name }, 'Migration applied');
  }
}
```

- [ ] **Step 4: Run test — verify it passes**

```bash
bun test test/database/schema.test.ts
```

Expected: 3 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/database/schema.ts test/database/schema.test.ts && git commit -m "feat: add migration runner"
```

---

### Task 7: Migrations 001–003

**Files:**
- Create: `src/database/migrations.ts`

- [ ] **Step 1: Write migrations**

```typescript
// src/database/migrations.ts
import type { Migration } from './schema.ts';

export const migrations: Migration[] = [
  {
    name: '001_create_users',
    up: (db) => {
      db.exec(`
        CREATE TABLE users (
          telegram_id INTEGER PRIMARY KEY,
          username TEXT,
          first_name TEXT,
          language TEXT NOT NULL DEFAULT 'en',
          timezone TEXT NOT NULL DEFAULT 'UTC',
          country_code TEXT,
          google_refresh_token_enc TEXT,
          google_calendar_id TEXT,
          onboarding_completed INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
    },
  },
  {
    name: '002_create_events',
    up: (db) => {
      db.exec(`
        CREATE TABLE events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          title TEXT NOT NULL,
          description TEXT,
          category TEXT,
          start_at TEXT NOT NULL,
          end_at TEXT,
          all_day INTEGER NOT NULL DEFAULT 0,
          timezone TEXT NOT NULL,
          location TEXT,
          recurrence_rule TEXT,
          recurrence_end_at TEXT,
          parent_event_id INTEGER,
          original_start_at TEXT,
          is_cancelled INTEGER NOT NULL DEFAULT 0,
          reminder_overrides TEXT,
          google_event_id TEXT,
          google_calendar_id TEXT,
          last_synced_at TEXT,
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
      `);
    },
  },
  {
    name: '003_create_reminders',
    up: (db) => {
      db.exec(`
        CREATE TABLE reminders (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id INTEGER NOT NULL,
          minutes_before INTEGER NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
        );
        CREATE INDEX idx_reminders_event_id ON reminders(event_id);
      `);
    },
  },
];
```

- [ ] **Step 2: Verify migrations apply cleanly on in-memory DB**

```bash
bun -e "
import { Database } from 'bun:sqlite';
import { runMigrations } from './src/database/schema.ts';
import { migrations } from './src/database/migrations.ts';
const db = new Database(':memory:');
db.exec('PRAGMA foreign_keys = ON');
runMigrations(db, migrations);
const tables = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table'\").all();
console.log('Tables:', tables.map((t: any) => t.name));
"
```

Expected: `Tables: [ 'migrations', 'users', 'events', 'reminders' ]`

- [ ] **Step 3: Commit**

```bash
git add src/database/migrations.ts && git commit -m "feat: add migrations 001-003 (users, events, reminders)"
```

---

### Task 8: DatabaseService singleton

**Files:**
- Create: `src/database/index.ts`

- [ ] **Step 1: Write DatabaseService**

```typescript
// src/database/index.ts
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { runMigrations } from './schema.ts';
import { migrations } from './migrations.ts';
import { UserRepository } from './repositories/user.repository.ts';
import { EventRepository } from './repositories/event.repository.ts';
import { ReminderRepository } from './repositories/reminder.repository.ts';
import { dbLogger } from '../utils/logger.ts';

export class DatabaseService {
  readonly db: Database;
  readonly users: UserRepository;
  readonly events: EventRepository;
  readonly reminders: ReminderRepository;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });

    this.db = new Database(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');

    dbLogger.info({ path: dbPath }, 'Database opened');

    runMigrations(this.db, migrations);

    this.users = new UserRepository(this.db);
    this.events = new EventRepository(this.db);
    this.reminders = new ReminderRepository(this.db);
  }

  close(): void {
    this.db.close();
    dbLogger.info('Database closed');
  }
}

export function createDatabase(dbPath: string): DatabaseService {
  return new DatabaseService(dbPath);
}
```

> **Note:** Repositories are created in the next chunk. This file will fail to import until they exist. That's expected — create placeholder files if needed for incremental verification, or just proceed to Task 9–11.

- [ ] **Step 2: Commit**

```bash
git add src/database/index.ts && git commit -m "feat: add DatabaseService singleton"
```

---

## Chunk 3: Repositories

### Task 9: User repository + tests

**Files:**
- Create: `src/database/repositories/user.repository.ts`
- Create: `test/database/repositories/user.repository.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// test/database/repositories/user.repository.test.ts
import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { runMigrations } from '../../../src/database/schema.ts';
import { migrations } from '../../../src/database/migrations.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

describe('UserRepository', () => {
  let db: Database;
  let repo: UserRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new UserRepository(db);
  });

  test('findByTelegramId returns null for non-existent user', () => {
    expect(repo.findByTelegramId(999)).toBeNull();
  });

  test('create inserts a new user and returns it', () => {
    const user = repo.create({ telegram_id: 123, username: 'alex', first_name: 'Alex' });
    expect(user.telegram_id).toBe(123);
    expect(user.username).toBe('alex');
    expect(user.language).toBe('en');
    expect(user.timezone).toBe('UTC');
    expect(user.onboarding_completed).toBe(0);
  });

  test('findByTelegramId returns existing user', () => {
    repo.create({ telegram_id: 123 });
    const user = repo.findByTelegramId(123);
    expect(user).not.toBeNull();
    expect(user!.telegram_id).toBe(123);
  });

  test('findOrCreate creates user if not found', () => {
    const user = repo.findOrCreate({ telegram_id: 456, username: 'bob' });
    expect(user.telegram_id).toBe(456);
    expect(user.username).toBe('bob');
  });

  test('findOrCreate returns existing user and updates cached fields', () => {
    repo.create({ telegram_id: 456, username: 'bob' });
    const user = repo.findOrCreate({ telegram_id: 456, username: 'bob_new' });
    expect(user.telegram_id).toBe(456);
    expect(user.username).toBe('bob_new');
  });

  test('update modifies user fields', () => {
    repo.create({ telegram_id: 123 });
    const updated = repo.update(123, { timezone: 'Europe/Moscow', language: 'ru' });
    expect(updated!.timezone).toBe('Europe/Moscow');
    expect(updated!.language).toBe('ru');
  });

  test('update returns null for non-existent user', () => {
    expect(repo.update(999, { language: 'ru' })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

```bash
bun test test/database/repositories/user.repository.test.ts
```

- [ ] **Step 3: Write implementation**

```typescript
// src/database/repositories/user.repository.ts
import type { Database } from 'bun:sqlite';
import type { User, CreateUserData, UpdateUserData } from '../types.ts';

export class UserRepository {
  constructor(private db: Database) {}

  findByTelegramId(telegramId: number): User | null {
    return this.db.prepare('SELECT * FROM users WHERE telegram_id = ?')
      .get(telegramId) as User | null;
  }

  create(data: CreateUserData): User {
    this.db.prepare(`
      INSERT INTO users (telegram_id, username, first_name, language, timezone, country_code)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      data.telegram_id,
      data.username ?? null,
      data.first_name ?? null,
      data.language ?? 'en',
      data.timezone ?? 'UTC',
      data.country_code ?? null,
    );
    return this.findByTelegramId(data.telegram_id)!;
  }

  findOrCreate(data: CreateUserData): User {
    const existing = this.findByTelegramId(data.telegram_id);
    if (existing) {
      // Update cached Telegram fields if changed
      if (data.username !== undefined || data.first_name !== undefined) {
        const updates: UpdateUserData = {};
        if (data.username !== undefined && data.username !== existing.username) {
          updates.username = data.username;
        }
        if (data.first_name !== undefined && data.first_name !== existing.first_name) {
          updates.first_name = data.first_name;
        }
        if (Object.keys(updates).length > 0) {
          return this.update(data.telegram_id, updates)!;
        }
      }
      return existing;
    }
    return this.create(data);
  }

  update(telegramId: number, data: UpdateUserData): User | null {
    const existing = this.findByTelegramId(telegramId);
    if (!existing) return null;

    const fields: string[] = [];
    const values: unknown[] = [];

    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined) {
        fields.push(`${key} = ?`);
        values.push(value);
      }
    }

    if (fields.length === 0) return existing;

    fields.push("updated_at = datetime('now')");
    values.push(telegramId);

    this.db.prepare(
      `UPDATE users SET ${fields.join(', ')} WHERE telegram_id = ?`
    ).run(...values);

    return this.findByTelegramId(telegramId)!;
  }
}
```

- [ ] **Step 4: Run test — verify it passes**

```bash
bun test test/database/repositories/user.repository.test.ts
```

Expected: 7 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/database/repositories/user.repository.ts test/database/repositories/user.repository.test.ts && git commit -m "feat: add user repository with tests"
```

---

### Task 10: Event repository + tests

**Files:**
- Create: `src/database/repositories/event.repository.ts`
- Create: `test/database/repositories/event.repository.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// test/database/repositories/event.repository.test.ts
import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { runMigrations } from '../../../src/database/schema.ts';
import { migrations } from '../../../src/database/migrations.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

describe('EventRepository', () => {
  let db: Database;
  let events: EventRepository;
  const USER_ID = 123;

  beforeEach(() => {
    db = createTestDb();
    events = new EventRepository(db);
    // Create test user (FK requirement)
    new UserRepository(db).create({ telegram_id: USER_ID });
  });

  test('create inserts event and returns it with id', () => {
    const event = events.create({
      user_id: USER_ID,
      title: 'Dentist',
      start_at: '2026-03-12T12:00:00Z',
      timezone: 'Europe/Moscow',
    });
    expect(event.id).toBeGreaterThan(0);
    expect(event.title).toBe('Dentist');
    expect(event.user_id).toBe(USER_ID);
  });

  test('findById returns event', () => {
    const created = events.create({
      user_id: USER_ID,
      title: 'Test',
      start_at: '2026-03-12T12:00:00Z',
      timezone: 'UTC',
    });
    const found = events.findById(created.id, USER_ID);
    expect(found).not.toBeNull();
    expect(found!.title).toBe('Test');
  });

  test('findById returns null for wrong user', () => {
    const created = events.create({
      user_id: USER_ID,
      title: 'Test',
      start_at: '2026-03-12T12:00:00Z',
      timezone: 'UTC',
    });
    expect(events.findById(created.id, 999)).toBeNull();
  });

  test('getInRange returns events within date range', () => {
    events.create({ user_id: USER_ID, title: 'E1', start_at: '2026-03-11T10:00:00Z', timezone: 'UTC' });
    events.create({ user_id: USER_ID, title: 'E2', start_at: '2026-03-12T10:00:00Z', timezone: 'UTC' });
    events.create({ user_id: USER_ID, title: 'E3', start_at: '2026-03-13T10:00:00Z', timezone: 'UTC' });

    const result = events.getInRange(USER_ID, '2026-03-11T00:00:00Z', '2026-03-12T23:59:59Z');
    expect(result.length).toBe(2);
    expect(result.map(e => e.title)).toEqual(['E1', 'E2']);
  });

  test('getRecurringTemplates returns events with recurrence_rule', () => {
    events.create({ user_id: USER_ID, title: 'Daily', start_at: '2026-01-01T09:00:00Z', timezone: 'UTC', recurrence_rule: 'FREQ=DAILY' });
    events.create({ user_id: USER_ID, title: 'OneOff', start_at: '2026-03-11T09:00:00Z', timezone: 'UTC' });

    const templates = events.getRecurringTemplates(USER_ID);
    expect(templates.length).toBe(1);
    expect(templates[0]!.title).toBe('Daily');
  });

  test('update modifies event fields', () => {
    const created = events.create({ user_id: USER_ID, title: 'Old', start_at: '2026-03-11T10:00:00Z', timezone: 'UTC' });
    const updated = events.update(created.id, USER_ID, { title: 'New' });
    expect(updated!.title).toBe('New');
  });

  test('remove deletes event', () => {
    const created = events.create({ user_id: USER_ID, title: 'Del', start_at: '2026-03-11T10:00:00Z', timezone: 'UTC' });
    const removed = events.remove(created.id, USER_ID);
    expect(removed).toBe(true);
    expect(events.findById(created.id, USER_ID)).toBeNull();
  });

  test('search finds events by title substring', () => {
    events.create({ user_id: USER_ID, title: 'Dentist appointment', start_at: '2026-03-12T12:00:00Z', timezone: 'UTC' });
    events.create({ user_id: USER_ID, title: 'Team lunch', start_at: '2026-03-12T12:00:00Z', timezone: 'UTC' });

    const results = events.search(USER_ID, 'dent');
    expect(results.length).toBe(1);
    expect(results[0]!.title).toBe('Dentist appointment');
  });

  test('getUpcoming returns future events sorted by start_at', () => {
    events.create({ user_id: USER_ID, title: 'Past', start_at: '2020-01-01T10:00:00Z', timezone: 'UTC' });
    events.create({ user_id: USER_ID, title: 'Future2', start_at: '2099-03-12T10:00:00Z', timezone: 'UTC' });
    events.create({ user_id: USER_ID, title: 'Future1', start_at: '2099-03-11T10:00:00Z', timezone: 'UTC' });

    const upcoming = events.getUpcoming(USER_ID, 5);
    expect(upcoming.length).toBe(2);
    expect(upcoming[0]!.title).toBe('Future1');
  });

  test('getUpcoming includes recurring templates regardless of start_at', () => {
    events.create({
      user_id: USER_ID, title: 'Old recurring', start_at: '2020-01-01T10:00:00Z',
      timezone: 'UTC', recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO',
    });
    events.create({ user_id: USER_ID, title: 'Future one-off', start_at: '2099-06-01T10:00:00Z', timezone: 'UTC' });

    const upcoming = events.getUpcoming(USER_ID, 10);
    expect(upcoming.length).toBe(2);
    const titles = upcoming.map(e => e.title);
    expect(titles).toContain('Old recurring');
    expect(titles).toContain('Future one-off');
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

```bash
bun test test/database/repositories/event.repository.test.ts
```

- [ ] **Step 3: Write implementation**

```typescript
// src/database/repositories/event.repository.ts
import type { Database } from 'bun:sqlite';
import type { CalendarEvent, CreateEventData, UpdateEventData } from '../types.ts';

export class EventRepository {
  constructor(private db: Database) {}

  create(data: CreateEventData): CalendarEvent {
    const result = this.db.prepare(`
      INSERT INTO events (user_id, title, description, category, start_at, end_at, all_day, timezone, location, recurrence_rule, recurrence_end_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
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
    );
    return this.findById(Number(result.lastInsertRowid), data.user_id)!;
  }

  findById(id: number, userId: number): CalendarEvent | null {
    return this.db.prepare(
      'SELECT * FROM events WHERE id = ? AND user_id = ? AND is_cancelled = 0'
    ).get(id, userId) as CalendarEvent | null;
  }

  getInRange(userId: number, startUtc: string, endUtc: string): CalendarEvent[] {
    return this.db.prepare(`
      SELECT * FROM events
      WHERE user_id = ? AND start_at >= ? AND start_at <= ?
        AND is_cancelled = 0 AND recurrence_rule IS NULL AND parent_event_id IS NULL
      ORDER BY start_at
    `).all(userId, startUtc, endUtc) as CalendarEvent[];
  }

  getRecurringTemplates(userId: number): CalendarEvent[] {
    return this.db.prepare(`
      SELECT * FROM events
      WHERE user_id = ? AND recurrence_rule IS NOT NULL AND parent_event_id IS NULL AND is_cancelled = 0
    `).all(userId) as CalendarEvent[];
  }

  getExceptions(parentEventId: number): CalendarEvent[] {
    return this.db.prepare(
      'SELECT * FROM events WHERE parent_event_id = ?'
    ).all(parentEventId) as CalendarEvent[];
  }

  update(id: number, userId: number, data: UpdateEventData): CalendarEvent | null {
    const existing = this.findById(id, userId);
    if (!existing) return null;

    const fields: string[] = [];
    const values: unknown[] = [];

    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined) {
        fields.push(`${key} = ?`);
        values.push(key === 'all_day' ? (value ? 1 : 0) : value);
      }
    }

    if (fields.length === 0) return existing;

    fields.push("updated_at = datetime('now')");
    values.push(id, userId);

    this.db.prepare(
      `UPDATE events SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`
    ).run(...values);

    return this.findById(id, userId)!;
  }

  remove(id: number, userId: number): boolean {
    const result = this.db.prepare(
      'DELETE FROM events WHERE id = ? AND user_id = ?'
    ).run(id, userId);
    return result.changes > 0;
  }

  search(userId: number, query: string, limit = 20): CalendarEvent[] {
    return this.db.prepare(`
      SELECT * FROM events
      WHERE user_id = ? AND title LIKE ? AND is_cancelled = 0
      ORDER BY start_at ASC
      LIMIT ?
    `).all(userId, `%${query}%`, limit) as CalendarEvent[];
  }

  getUpcoming(userId: number, limit = 10, now?: Date): CalendarEvent[] {
    const nowIso = (now ?? new Date()).toISOString();
    return this.db.prepare(`
      SELECT * FROM events
      WHERE user_id = ? AND is_cancelled = 0 AND parent_event_id IS NULL
        AND (start_at > ? OR recurrence_rule IS NOT NULL)
      ORDER BY start_at
      LIMIT ?
    `).all(userId, nowIso, limit) as CalendarEvent[];
  }

  createException(parentId: number, data: CreateEventData & { original_start_at: string; is_cancelled?: boolean }): CalendarEvent {
    const result = this.db.prepare(`
      INSERT INTO events (user_id, title, description, category, start_at, end_at, all_day, timezone, location,
        parent_event_id, original_start_at, is_cancelled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.user_id, data.title, data.description ?? null, data.category ?? null,
      data.start_at, data.end_at ?? null, data.all_day ? 1 : 0, data.timezone,
      data.location ?? null, parentId, data.original_start_at, data.is_cancelled ? 1 : 0,
    );
    // Use raw query — findById filters out is_cancelled=1
    return this.db.prepare('SELECT * FROM events WHERE id = ?')
      .get(Number(result.lastInsertRowid)) as CalendarEvent;
  }

  countInRange(userId: number, startUtc: string, endUtc: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) as count FROM events
      WHERE user_id = ? AND start_at >= ? AND start_at <= ? AND is_cancelled = 0
    `).get(userId, startUtc, endUtc) as { count: number };
    return row.count;
  }
}
```

- [ ] **Step 4: Run test — verify it passes**

```bash
bun test test/database/repositories/event.repository.test.ts
```

Expected: 9 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/database/repositories/event.repository.ts test/database/repositories/event.repository.test.ts && git commit -m "feat: add event repository with tests"
```

---

### Task 11: Reminder repository + tests

**Files:**
- Create: `src/database/repositories/reminder.repository.ts`
- Create: `test/database/repositories/reminder.repository.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// test/database/repositories/reminder.repository.test.ts
import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { runMigrations } from '../../../src/database/schema.ts';
import { migrations } from '../../../src/database/migrations.ts';
import { ReminderRepository } from '../../../src/database/repositories/reminder.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

describe('ReminderRepository', () => {
  let db: Database;
  let reminders: ReminderRepository;
  let eventId: number;
  const USER_ID = 123;

  beforeEach(() => {
    db = createTestDb();
    reminders = new ReminderRepository(db);
    new UserRepository(db).create({ telegram_id: USER_ID });
    const event = new EventRepository(db).create({
      user_id: USER_ID, title: 'Test', start_at: '2026-03-12T12:00:00Z', timezone: 'UTC',
    });
    eventId = event.id;
  });

  test('create adds reminder and returns it', () => {
    const r = reminders.create(eventId, 15);
    expect(r.event_id).toBe(eventId);
    expect(r.minutes_before).toBe(15);
  });

  test('getByEventId returns all reminders for event', () => {
    reminders.create(eventId, 5);
    reminders.create(eventId, 15);
    reminders.create(eventId, 60);
    const list = reminders.getByEventId(eventId);
    expect(list.length).toBe(3);
    expect(list.map(r => r.minutes_before)).toEqual([5, 15, 60]);
  });

  test('removeByEventId deletes all reminders for event', () => {
    reminders.create(eventId, 5);
    reminders.create(eventId, 15);
    reminders.removeByEventId(eventId);
    expect(reminders.getByEventId(eventId).length).toBe(0);
  });

  test('setForEvent replaces existing reminders', () => {
    reminders.create(eventId, 5);
    reminders.setForEvent(eventId, [10, 30]);
    const list = reminders.getByEventId(eventId);
    expect(list.map(r => r.minutes_before)).toEqual([10, 30]);
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

```bash
bun test test/database/repositories/reminder.repository.test.ts
```

- [ ] **Step 3: Write implementation**

```typescript
// src/database/repositories/reminder.repository.ts
import type { Database } from 'bun:sqlite';
import type { Reminder } from '../types.ts';

export class ReminderRepository {
  constructor(private db: Database) {}

  create(eventId: number, minutesBefore: number): Reminder {
    const result = this.db.prepare(
      'INSERT INTO reminders (event_id, minutes_before) VALUES (?, ?)'
    ).run(eventId, minutesBefore);
    return this.db.prepare('SELECT * FROM reminders WHERE id = ?')
      .get(Number(result.lastInsertRowid)) as Reminder;
  }

  getByEventId(eventId: number): Reminder[] {
    return this.db.prepare(
      'SELECT * FROM reminders WHERE event_id = ? ORDER BY minutes_before'
    ).all(eventId) as Reminder[];
  }

  removeByEventId(eventId: number): void {
    this.db.prepare('DELETE FROM reminders WHERE event_id = ?').run(eventId);
  }

  setForEvent(eventId: number, minutesBefore: number[]): Reminder[] {
    this.db.transaction(() => {
      this.removeByEventId(eventId);
      for (const mins of minutesBefore) {
        this.create(eventId, mins);
      }
    })();
    return this.getByEventId(eventId);
  }
}
```

- [ ] **Step 4: Run test — verify it passes**

```bash
bun test test/database/repositories/reminder.repository.test.ts
```

Expected: 4 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/database/repositories/reminder.repository.ts test/database/repositories/reminder.repository.test.ts && git commit -m "feat: add reminder repository with tests"
```

---

## Chunk 4: Core Services

### Task 12: Date utils + tests

**Files:**
- Create: `src/utils/date.ts`
- Create: `test/utils/date.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// test/utils/date.test.ts
import { describe, test, expect } from 'bun:test';
import {
  toUserTime,
  getDayRangeUtc,
  getWeekRangeUtc,
  parseSimpleDate,
  parseDuration,
  formatTime,
  formatDateHeader,
} from '../../src/utils/date.ts';

describe('toUserTime', () => {
  test('formats UTC to user timezone', () => {
    const result = toUserTime('2026-03-11T12:00:00Z', 'Europe/Moscow');
    expect(result).toBe('15:00');
  });

  test('handles UTC timezone', () => {
    const result = toUserTime('2026-03-11T12:00:00Z', 'UTC');
    expect(result).toBe('12:00');
  });
});

describe('getDayRangeUtc', () => {
  test('returns start/end of day in UTC for given timezone', () => {
    const { start, end } = getDayRangeUtc(new Date('2026-03-11T15:00:00Z'), 'Europe/Moscow');
    // Moscow is UTC+3, so day starts at 21:00 UTC prev day
    expect(start).toBe('2026-03-10T21:00:00.000Z');
    expect(end).toBe('2026-03-11T20:59:59.999Z');
  });

  test('handles UTC timezone', () => {
    const { start, end } = getDayRangeUtc(new Date('2026-03-11T15:00:00Z'), 'UTC');
    expect(start).toBe('2026-03-11T00:00:00.000Z');
    expect(end).toBe('2026-03-11T23:59:59.999Z');
  });
});

describe('getWeekRangeUtc', () => {
  test('returns Monday-Sunday range in UTC', () => {
    // March 11, 2026 is Wednesday
    const { start, end } = getWeekRangeUtc(new Date('2026-03-11T12:00:00Z'), 'UTC');
    expect(start).toContain('2026-03-09'); // Monday
    expect(end).toContain('2026-03-15');   // Sunday
  });
});

describe('parseSimpleDate', () => {
  test('parses "tomorrow HH:MM"', () => {
    const ref = new Date('2026-03-11T12:00:00Z');
    const result = parseSimpleDate('tomorrow 15:00', 'UTC', ref);
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toContain('2026-03-12T15:00');
  });

  test('parses "today HH:MM"', () => {
    const ref = new Date('2026-03-11T12:00:00Z');
    const result = parseSimpleDate('today 18:00', 'UTC', ref);
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toContain('2026-03-11T18:00');
  });

  test('returns null for unparseable input', () => {
    const result = parseSimpleDate('gibberish', 'UTC');
    expect(result).toBeNull();
  });
});

describe('parseDuration', () => {
  test('parses "1h"', () => expect(parseDuration('1h')).toBe(60));
  test('parses "30m"', () => expect(parseDuration('30m')).toBe(30));
  test('parses "2h30m"', () => expect(parseDuration('2h30m')).toBe(150));
  test('returns null for invalid', () => expect(parseDuration('abc')).toBeNull());
});

describe('formatTime', () => {
  test('formats ISO to HH:MM in timezone', () => {
    expect(formatTime('2026-03-11T12:00:00Z', 'UTC')).toBe('12:00');
  });
});

describe('formatDateHeader', () => {
  test('formats date with weekday', () => {
    const result = formatDateHeader('2026-03-11T12:00:00Z', 'UTC', 'en');
    expect(result).toContain('Wednesday');
    expect(result).toContain('March');
    expect(result).toContain('11');
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

```bash
bun test test/utils/date.test.ts
```

- [ ] **Step 3: Write implementation**

```typescript
// src/utils/date.ts
import { TZDate } from '@date-fns/tz';
import { format, startOfDay, endOfDay, startOfWeek, endOfWeek, addDays, addMinutes, parse } from 'date-fns';
import { enUS, ru } from 'date-fns/locale';

/**
 * Format UTC ISO string to HH:MM in user's timezone
 */
export function toUserTime(isoUtc: string, timezone: string): string {
  const d = new TZDate(isoUtc, timezone);
  return format(d, 'HH:mm');
}

/**
 * Format UTC ISO string to HH:MM in timezone (alias)
 */
export function formatTime(isoUtc: string, timezone: string): string {
  return toUserTime(isoUtc, timezone);
}

/**
 * Format UTC ISO string to full date header like "Wednesday, March 11"
 */
export function formatDateHeader(isoUtc: string, timezone: string, lang: string): string {
  const d = new TZDate(isoUtc, timezone);
  const locale = lang === 'ru' ? ru : enUS;
  return format(d, 'EEEE, MMMM d', { locale });
}

/**
 * Format UTC ISO string to short date like "Wed 11"
 */
export function formatDateShort(isoUtc: string, timezone: string, lang: string): string {
  const d = new TZDate(isoUtc, timezone);
  const locale = lang === 'ru' ? ru : enUS;
  return format(d, 'EEE d', { locale });
}

/**
 * Format time range "HH:MM – HH:MM" or just "HH:MM" if no end
 */
export function formatTimeRange(startUtc: string, endUtc: string | null, timezone: string): string {
  const start = toUserTime(startUtc, timezone);
  if (!endUtc) return start;
  return `${start}–${toUserTime(endUtc, timezone)}`;
}

/**
 * Get start/end of day in user's timezone, returned as UTC ISO strings
 */
export function getDayRangeUtc(date: Date, timezone: string): { start: string; end: string } {
  const localDate = new TZDate(date.getTime(), timezone);
  const start = startOfDay(localDate);
  const end = endOfDay(localDate);
  return { start: start.toISOString(), end: end.toISOString() };
}

/**
 * Get start/end of week (Mon–Sun) in user's timezone, returned as UTC ISO strings
 */
export function getWeekRangeUtc(date: Date, timezone: string): { start: string; end: string } {
  const localDate = new TZDate(date.getTime(), timezone);
  const start = startOfWeek(localDate, { weekStartsOn: 1 });
  const end = endOfWeek(localDate, { weekStartsOn: 1 });
  return { start: startOfDay(start).toISOString(), end: endOfDay(end).toISOString() };
}

/**
 * Get N-day range from a date
 */
export function getNDayRangeUtc(date: Date, days: number, timezone: string): { start: string; end: string } {
  const localDate = new TZDate(date.getTime(), timezone);
  const start = startOfDay(localDate);
  const end = endOfDay(addDays(localDate, days - 1));
  return { start: start.toISOString(), end: end.toISOString() };
}

/**
 * Parse simple date expressions: "today 15:00", "tomorrow 18:00", "Mar 15 19:30"
 * Returns Date in UTC or null if can't parse
 */
export function parseSimpleDate(input: string, timezone: string, refDate?: Date): Date | null {
  const ref = refDate ? new TZDate(refDate.getTime(), timezone) : TZDate.tz(timezone);
  const trimmed = input.trim().toLowerCase();

  // "today HH:MM" or "tomorrow HH:MM"
  const todayMatch = trimmed.match(/^(today|сегодня)\s+(\d{1,2}):(\d{2})$/);
  if (todayMatch) {
    const [, , h, m] = todayMatch;
    const d = startOfDay(ref);
    const result = addMinutes(d, Number(h) * 60 + Number(m));
    return new Date(result.toISOString());
  }

  const tomorrowMatch = trimmed.match(/^(tomorrow|завтра)\s+(\d{1,2}):(\d{2})$/);
  if (tomorrowMatch) {
    const [, , h, m] = tomorrowMatch;
    const d = startOfDay(addDays(ref, 1));
    const result = addMinutes(d, Number(h) * 60 + Number(m));
    return new Date(result.toISOString());
  }

  // "Mon 15:00", "Friday 18:00" etc.
  const dayNames: Record<string, number> = {
    mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 0,
    monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 0,
    пн: 1, вт: 2, ср: 3, чт: 4, пт: 5, сб: 6, вс: 0,
  };

  const nextDayMatch = trimmed.match(/^(?:next\s+)?(\w+)\s+(\d{1,2}):(\d{2})$/);
  if (nextDayMatch) {
    const [, dayStr, h, m] = nextDayMatch;
    const targetDay = dayNames[dayStr!];
    if (targetDay !== undefined) {
      const currentDay = ref.getDay();
      let daysToAdd = targetDay - currentDay;
      if (daysToAdd <= 0) daysToAdd += 7;
      const d = startOfDay(addDays(ref, daysToAdd));
      const result = addMinutes(d, Number(h) * 60 + Number(m));
      return new Date(result.toISOString());
    }
  }

  // "Mar 15 19:30" or "March 15 19:30" or "15 Mar 19:30"
  const monthDateMatch = trimmed.match(
    /^(\w+)\s+(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/
  );
  if (monthDateMatch) {
    const [, part1, part2, h, m] = monthDateMatch;
    const months: Record<string, number> = {
      jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
      jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
      january: 0, february: 1, march: 2, april: 3, june: 5,
      july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
      янв: 0, фев: 1, мар: 2, апр: 3, май: 4, июн: 5,
      июл: 6, авг: 7, сен: 8, окт: 9, ноя: 10, дек: 11,
    };
    const monthNum = months[part1!];
    if (monthNum !== undefined) {
      const year = ref.getFullYear();
      const day = Number(part2);
      const hour = h ? Number(h) : 0;
      const min = m ? Number(m) : 0;
      const d = new TZDate(year, monthNum, day, hour, min, 0, 0, timezone);
      return new Date(d.toISOString());
    }
  }

  return null;
}

/**
 * Parse duration string like "1h", "30m", "2h30m"
 * Returns total minutes or null
 */
export function parseDuration(input: string): number | null {
  const match = input.trim().toLowerCase().match(/^(?:(\d+)\s*[hч])?\s*(?:(\d+)\s*[mм])?$/);
  if (!match || (!match[1] && !match[2])) return null;
  const hours = match[1] ? Number(match[1]) : 0;
  const mins = match[2] ? Number(match[2]) : 0;
  return hours * 60 + mins;
}
```

- [ ] **Step 4: Run test — verify it passes**

```bash
bun test test/utils/date.test.ts
```

Expected: all tests pass

- [ ] **Step 5: Commit**

```bash
git add src/utils/date.ts test/utils/date.test.ts && git commit -m "feat: add date utils with timezone conversions and simple parser"
```

---

### Task 13: Telegram utils

**Files:**
- Create: `src/utils/telegram.ts`

- [ ] **Step 1: Write implementation**

```typescript
// src/utils/telegram.ts

/**
 * Escape HTML special characters for Telegram HTML parse mode
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Truncate text to fit Telegram message limits (4096 chars)
 */
export function truncateMessage(text: string, maxLen = 4000): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

/**
 * Format UTC offset string like "UTC+3" from IANA timezone
 */
export function formatUtcOffset(timezone: string): string {
  const d = new Date();
  const formatter = new Intl.DateTimeFormat('en', { timeZone: timezone, timeZoneName: 'shortOffset' });
  const parts = formatter.formatToParts(d);
  const tzPart = parts.find(p => p.type === 'timeZoneName');
  return tzPart?.value ?? timezone;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/utils/telegram.ts && git commit -m "feat: add telegram formatting utils"
```

---

### Task 14: Timezone service + tests

**Files:**
- Create: `src/services/timezone/timezone-service.ts`
- Create: `test/services/timezone/timezone-service.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// test/services/timezone/timezone-service.test.ts
import { describe, test, expect } from 'bun:test';
import { resolveTimezone, getTimezoneDisplay } from '../../../src/services/timezone/timezone-service.ts';

describe('resolveTimezone', () => {
  test('resolves Moscow coordinates to Europe/Moscow', () => {
    const tz = resolveTimezone(55.7558, 37.6173);
    expect(tz).toBe('Europe/Moscow');
  });

  test('resolves New York coordinates', () => {
    const tz = resolveTimezone(40.7128, -74.006);
    expect(tz).toBe('America/New_York');
  });
});

describe('getTimezoneDisplay', () => {
  test('returns timezone with offset', () => {
    const display = getTimezoneDisplay('Europe/Moscow');
    expect(display).toContain('Europe/Moscow');
    expect(display).toContain('UTC');
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

```bash
bun test test/services/timezone/timezone-service.test.ts
```

- [ ] **Step 3: Write implementation**

```typescript
// src/services/timezone/timezone-service.ts
import { find } from 'geo-tz';
import { formatUtcOffset } from '../../utils/telegram.ts';

/**
 * Resolve lat/lng to IANA timezone string
 */
export function resolveTimezone(latitude: number, longitude: number): string {
  const results = find(latitude, longitude);
  return results[0] ?? 'UTC';
}

/**
 * Get display string like "Europe/Moscow (UTC+3)"
 */
export function getTimezoneDisplay(timezone: string): string {
  const offset = formatUtcOffset(timezone);
  return `${timezone} (${offset})`;
}

/**
 * Extract country code from coordinates (approximate — uses timezone region)
 * For accurate country detection, geo-tz doesn't provide this directly.
 * We use a simple mapping for common cases.
 */
export function guessCountryFromTimezone(timezone: string): string | null {
  const tzToCountry: Record<string, string> = {
    'Europe/Moscow': 'RU', 'Europe/Kiev': 'UA', 'Europe/London': 'GB',
    'Europe/Paris': 'FR', 'Europe/Berlin': 'DE', 'Europe/Istanbul': 'TR',
    'Europe/Warsaw': 'PL', 'Europe/Rome': 'IT', 'Europe/Madrid': 'ES',
    'Europe/Belgrade': 'RS', 'Europe/Helsinki': 'FI', 'Europe/Amsterdam': 'NL',
    'Asia/Dubai': 'AE', 'Asia/Kolkata': 'IN', 'Asia/Bangkok': 'TH',
    'Asia/Singapore': 'SG', 'Asia/Tokyo': 'JP', 'Asia/Seoul': 'KR',
    'Asia/Shanghai': 'CN', 'Asia/Hong_Kong': 'HK', 'Asia/Almaty': 'KZ',
    'Asia/Tbilisi': 'GE', 'Asia/Yerevan': 'AM', 'Asia/Tashkent': 'UZ',
    'America/New_York': 'US', 'America/Chicago': 'US', 'America/Denver': 'US',
    'America/Los_Angeles': 'US', 'America/Toronto': 'CA', 'America/Sao_Paulo': 'BR',
    'America/Mexico_City': 'MX', 'America/Buenos_Aires': 'AR',
    'Africa/Cairo': 'EG', 'Africa/Lagos': 'NG', 'Africa/Johannesburg': 'ZA',
    'Africa/Nairobi': 'KE', 'Australia/Sydney': 'AU', 'Pacific/Auckland': 'NZ',
  };
  return tzToCountry[timezone] ?? null;
}
```

- [ ] **Step 4: Run test — verify it passes**

```bash
bun test test/services/timezone/timezone-service.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/services/timezone/timezone-service.ts test/services/timezone/timezone-service.test.ts && git commit -m "feat: add timezone service with geo-tz resolution"
```

---

### Task 15: Recurrence service + tests

**Files:**
- Create: `src/services/event/recurrence.ts`
- Create: `test/services/event/recurrence.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// test/services/event/recurrence.test.ts
import { describe, test, expect } from 'bun:test';
import { expandRecurrence } from '../../../src/services/event/recurrence.ts';
import type { CalendarEvent } from '../../../src/database/types.ts';

function makeTemplate(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 1, user_id: 123, title: 'Daily standup',
    description: null, category: null,
    start_at: '2026-03-01T09:00:00Z', end_at: '2026-03-01T09:30:00Z',
    all_day: 0, timezone: 'UTC', location: null,
    recurrence_rule: 'FREQ=DAILY', recurrence_end_at: null,
    parent_event_id: null, original_start_at: null,
    is_cancelled: 0, reminder_overrides: null,
    google_event_id: null, google_calendar_id: null, last_synced_at: null,
    created_at: '2026-03-01T00:00:00Z', updated_at: '2026-03-01T00:00:00Z',
    ...overrides,
  };
}

describe('expandRecurrence', () => {
  test('expands daily rule within range', () => {
    const template = makeTemplate({ recurrence_rule: 'FREQ=DAILY' });
    const occurrences = expandRecurrence(
      template, [], '2026-03-10T00:00:00Z', '2026-03-12T23:59:59Z'
    );
    expect(occurrences.length).toBe(3); // Mar 10, 11, 12
    expect(occurrences[0]!.occurrence_start).toContain('2026-03-10T09:00');
    expect(occurrences[0]!.is_exception).toBe(false);
  });

  test('expands weekly rule with BYDAY', () => {
    const template = makeTemplate({
      start_at: '2026-03-02T09:00:00Z', // Monday
      recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR',
    });
    const occurrences = expandRecurrence(
      template, [], '2026-03-09T00:00:00Z', '2026-03-15T23:59:59Z'
    );
    expect(occurrences.length).toBe(3); // Mon, Wed, Fri
  });

  test('respects COUNT limit', () => {
    const template = makeTemplate({ recurrence_rule: 'FREQ=DAILY;COUNT=5' });
    const occurrences = expandRecurrence(
      template, [], '2026-03-01T00:00:00Z', '2026-12-31T23:59:59Z'
    );
    expect(occurrences.length).toBe(5);
  });

  test('applies exception (modified occurrence)', () => {
    const template = makeTemplate({ recurrence_rule: 'FREQ=DAILY' });
    const exceptions: CalendarEvent[] = [{
      ...makeTemplate({ id: 2, title: 'Modified standup' }),
      parent_event_id: 1,
      original_start_at: '2026-03-11T09:00:00Z',
      start_at: '2026-03-11T10:00:00Z',
      recurrence_rule: null,
    }];
    const occurrences = expandRecurrence(
      template, exceptions, '2026-03-10T00:00:00Z', '2026-03-12T23:59:59Z'
    );
    const mar11 = occurrences.find(o => o.occurrence_start.includes('2026-03-11'));
    expect(mar11).toBeDefined();
    expect(mar11!.event.title).toBe('Modified standup');
    expect(mar11!.is_exception).toBe(true);
  });

  test('applies cancelled exception', () => {
    const template = makeTemplate({ recurrence_rule: 'FREQ=DAILY' });
    const exceptions: CalendarEvent[] = [{
      ...makeTemplate({ id: 2, is_cancelled: 1 }),
      parent_event_id: 1,
      original_start_at: '2026-03-11T09:00:00Z',
      recurrence_rule: null,
    }];
    const occurrences = expandRecurrence(
      template, exceptions, '2026-03-10T00:00:00Z', '2026-03-12T23:59:59Z'
    );
    expect(occurrences.length).toBe(2); // Mar 10, 12 (11 cancelled)
  });

  test('computes occurrence_end from template duration', () => {
    const template = makeTemplate({
      recurrence_rule: 'FREQ=DAILY',
      end_at: '2026-03-01T09:30:00Z', // 30min duration
    });
    const occurrences = expandRecurrence(
      template, [], '2026-03-10T00:00:00Z', '2026-03-10T23:59:59Z'
    );
    expect(occurrences[0]!.occurrence_end).toContain('2026-03-10T09:30');
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

```bash
bun test test/services/event/recurrence.test.ts
```

- [ ] **Step 3: Write implementation**

```typescript
// src/services/event/recurrence.ts
import { RRule, rrulestr } from 'rrule';
import type { CalendarEvent, EventOccurrence } from '../../database/types.ts';

/**
 * Expand a recurring event template into concrete occurrences within a date range.
 * Applies exceptions (modified/cancelled occurrences).
 */
export function expandRecurrence(
  template: CalendarEvent,
  exceptions: CalendarEvent[],
  rangeStartUtc: string,
  rangeEndUtc: string,
): EventOccurrence[] {
  if (!template.recurrence_rule) return [];

  // Build RRULE with DTSTART
  const dtstart = new Date(template.start_at);
  const rruleString = `DTSTART:${formatRRuleDate(dtstart)}\nRRULE:${template.recurrence_rule}`;
  const rule = rrulestr(rruleString);

  // Compute template duration in ms (for occurrence_end)
  const durationMs = template.end_at
    ? new Date(template.end_at).getTime() - new Date(template.start_at).getTime()
    : 0;

  // Build exception map: original_start_at ISO -> exception event
  const exceptionMap = new Map<string, CalendarEvent>();
  for (const exc of exceptions) {
    if (exc.original_start_at) {
      // Normalize to same format for matching
      const key = new Date(exc.original_start_at).toISOString();
      exceptionMap.set(key, exc);
    }
  }

  // Expand occurrences in range
  const rangeStart = new Date(rangeStartUtc);
  const rangeEnd = new Date(rangeEndUtc);
  const dates = rule.between(rangeStart, rangeEnd, true);

  const occurrences: EventOccurrence[] = [];

  for (const date of dates) {
    const occStart = date.toISOString();
    const occKey = occStart;
    const exception = exceptionMap.get(occKey);

    if (exception) {
      if (exception.is_cancelled) {
        continue; // Skip cancelled occurrence
      }
      // Use modified exception
      const occEnd = exception.end_at ?? (durationMs
        ? new Date(new Date(exception.start_at).getTime() + durationMs).toISOString()
        : null);
      occurrences.push({
        event: exception,
        occurrence_start: exception.start_at,
        occurrence_end: occEnd,
        is_exception: true,
      });
    } else {
      // Normal occurrence from template
      const occEnd = durationMs
        ? new Date(date.getTime() + durationMs).toISOString()
        : null;
      occurrences.push({
        event: template,
        occurrence_start: occStart,
        occurrence_end: occEnd,
        is_exception: false,
      });
    }
  }

  return occurrences.sort((a, b) =>
    a.occurrence_start.localeCompare(b.occurrence_start)
  );
}

function formatRRuleDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
```

- [ ] **Step 4: Run test — verify it passes**

```bash
bun test test/services/event/recurrence.test.ts
```

Expected: 6 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/services/event/recurrence.ts test/services/event/recurrence.test.ts && git commit -m "feat: add recurrence expansion service with rrule"
```

---

### Task 16: Event service + tests

**Files:**
- Create: `src/services/event/event-service.ts`
- Create: `test/services/event/event-service.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// test/services/event/event-service.test.ts
import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { runMigrations } from '../../../src/database/schema.ts';
import { migrations } from '../../../src/database/migrations.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { ReminderRepository } from '../../../src/database/repositories/reminder.repository.ts';
import { EventService } from '../../../src/services/event/event-service.ts';

function createTestDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

describe('EventService', () => {
  let db: Database;
  let service: EventService;
  const USER_ID = 123;
  const TZ = 'UTC';

  beforeEach(() => {
    db = createTestDb();
    const eventRepo = new EventRepository(db);
    const reminderRepo = new ReminderRepository(db);
    new UserRepository(db).create({ telegram_id: USER_ID });
    service = new EventService(eventRepo, reminderRepo);
  });

  test('createEvent creates event with default reminder', () => {
    const event = service.createEvent({
      user_id: USER_ID,
      title: 'Test',
      start_at: '2026-03-12T12:00:00Z',
      timezone: TZ,
    });
    expect(event.title).toBe('Test');
  });

  test('createEvent creates reminders from reminder_minutes', () => {
    const event = service.createEvent({
      user_id: USER_ID,
      title: 'Test',
      start_at: '2026-03-12T12:00:00Z',
      timezone: TZ,
      reminder_minutes: [5, 15],
    });
    // Verify via DB directly
    const reminders = db.prepare('SELECT * FROM reminders WHERE event_id = ?').all(event.id);
    expect(reminders.length).toBe(2);
  });

  test('getEventsForDay returns events and recurring occurrences', () => {
    service.createEvent({
      user_id: USER_ID,
      title: 'OneOff',
      start_at: '2026-03-11T10:00:00Z',
      timezone: TZ,
    });
    service.createEvent({
      user_id: USER_ID,
      title: 'Daily',
      start_at: '2026-03-01T09:00:00Z',
      timezone: TZ,
      recurrence_rule: 'FREQ=DAILY',
    });

    const occurrences = service.getEventsForDay(USER_ID, new Date('2026-03-11T12:00:00Z'), TZ);
    expect(occurrences.length).toBe(2);
    const titles = occurrences.map(o => o.event.title).sort();
    expect(titles).toEqual(['Daily', 'OneOff']);
  });

  test('deleteEvent removes event', () => {
    const event = service.createEvent({
      user_id: USER_ID,
      title: 'Del',
      start_at: '2026-03-12T12:00:00Z',
      timezone: TZ,
    });
    const result = service.deleteEvent(event.id, USER_ID);
    expect(result).toBe(true);
  });

  test('getFreeSlots finds gaps between events', () => {
    service.createEvent({
      user_id: USER_ID, title: 'A',
      start_at: '2026-03-11T09:00:00Z', end_at: '2026-03-11T10:00:00Z', timezone: TZ,
    });
    service.createEvent({
      user_id: USER_ID, title: 'B',
      start_at: '2026-03-11T12:00:00Z', end_at: '2026-03-11T13:00:00Z', timezone: TZ,
    });

    const slots = service.getFreeSlots(USER_ID, new Date('2026-03-11T12:00:00Z'), TZ);
    // Should find gaps: 00:00-09:00, 10:00-12:00, 13:00-23:59
    expect(slots.length).toBe(3);
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

```bash
bun test test/services/event/event-service.test.ts
```

- [ ] **Step 3: Write implementation**

```typescript
// src/services/event/event-service.ts
import type { EventRepository } from '../../database/repositories/event.repository.ts';
import type { ReminderRepository } from '../../database/repositories/reminder.repository.ts';
import type { CalendarEvent, CreateEventData, UpdateEventData, EventOccurrence } from '../../database/types.ts';
import { expandRecurrence } from './recurrence.ts';
import { getDayRangeUtc, getWeekRangeUtc, getNDayRangeUtc } from '../../utils/date.ts';
import { DEFAULTS } from '../../config/constants.ts';

export interface FreeSlot {
  start: string;
  end: string;
  durationMinutes: number;
}

export class EventService {
  constructor(
    private eventRepo: EventRepository,
    private reminderRepo: ReminderRepository,
  ) {}

  createEvent(data: CreateEventData): CalendarEvent {
    const event = this.eventRepo.create(data);

    // Create reminders
    const reminderMinutes = data.reminder_minutes ?? [DEFAULTS.REMINDER_MINUTES];
    for (const mins of reminderMinutes) {
      this.reminderRepo.create(event.id, mins);
    }

    return event;
  }

  updateEvent(id: number, userId: number, data: UpdateEventData): CalendarEvent | null {
    return this.eventRepo.update(id, userId, data);
  }

  deleteEvent(id: number, userId: number): boolean {
    return this.eventRepo.remove(id, userId);
  }

  getEvent(id: number, userId: number): CalendarEvent | null {
    return this.eventRepo.findById(id, userId);
  }

  /**
   * Get all events (including recurring occurrences) for a specific day
   */
  getEventsForDay(userId: number, date: Date, timezone: string): EventOccurrence[] {
    const { start, end } = getDayRangeUtc(date, timezone);
    return this.getEventsInRange(userId, start, end);
  }

  /**
   * Get events for a 7-day week
   */
  getEventsForWeek(userId: number, date: Date, timezone: string): EventOccurrence[] {
    const { start, end } = getWeekRangeUtc(date, timezone);
    return this.getEventsInRange(userId, start, end);
  }

  /**
   * Get events for N days starting from date
   */
  getEventsForNDays(userId: number, date: Date, days: number, timezone: string): EventOccurrence[] {
    const { start, end } = getNDayRangeUtc(date, days, timezone);
    return this.getEventsInRange(userId, start, end);
  }

  /**
   * Core: get all events (one-off + expanded recurring) in a UTC range
   */
  getEventsInRange(userId: number, startUtc: string, endUtc: string): EventOccurrence[] {
    // 1. Non-recurring events in range
    const oneOff = this.eventRepo.getInRange(userId, startUtc, endUtc)
      .map(event => ({
        event,
        occurrence_start: event.start_at,
        occurrence_end: event.end_at,
        is_exception: false,
      } satisfies EventOccurrence));

    // 2. Recurring templates
    const templates = this.eventRepo.getRecurringTemplates(userId);
    const recurring: EventOccurrence[] = [];
    for (const template of templates) {
      const exceptions = this.eventRepo.getExceptions(template.id);
      const expanded = expandRecurrence(template, exceptions, startUtc, endUtc);
      recurring.push(...expanded);
    }

    // 3. Merge and sort
    return [...oneOff, ...recurring].sort((a, b) =>
      a.occurrence_start.localeCompare(b.occurrence_start)
    );
  }

  /**
   * Find free time slots in a day
   */
  getFreeSlots(userId: number, date: Date, timezone: string): FreeSlot[] {
    const { start: dayStart, end: dayEnd } = getDayRangeUtc(date, timezone);
    const events = this.getEventsInRange(userId, dayStart, dayEnd);

    // Build busy intervals (only events with end time)
    const busy = events
      .filter(o => o.occurrence_end)
      .map(o => ({
        start: new Date(o.occurrence_start).getTime(),
        end: new Date(o.occurrence_end!).getTime(),
      }))
      .sort((a, b) => a.start - b.start);

    // Find gaps
    const slots: FreeSlot[] = [];
    let cursor = new Date(dayStart).getTime();
    const dayEndMs = new Date(dayEnd).getTime();

    for (const interval of busy) {
      if (interval.start > cursor) {
        const durationMinutes = Math.round((interval.start - cursor) / 60000);
        if (durationMinutes > 0) {
          slots.push({
            start: new Date(cursor).toISOString(),
            end: new Date(interval.start).toISOString(),
            durationMinutes,
          });
        }
      }
      cursor = Math.max(cursor, interval.end);
    }

    // Gap after last event
    if (cursor < dayEndMs) {
      const durationMinutes = Math.round((dayEndMs - cursor) / 60000);
      slots.push({
        start: new Date(cursor).toISOString(),
        end: new Date(dayEndMs).toISOString(),
        durationMinutes,
      });
    }

    return slots;
  }

  /**
   * Search events by title
   */
  searchEvents(userId: number, query: string): CalendarEvent[] {
    return this.eventRepo.search(userId, query);
  }

  /**
   * Get upcoming events: future one-off events + recurring templates (for edit/delete pickers)
   */
  getUpcoming(userId: number, limit = 10): CalendarEvent[] {
    return this.eventRepo.getUpcoming(userId, limit);
  }

  /**
   * Cancel a single occurrence of a recurring event
   */
  cancelOccurrence(templateId: number, userId: number, originalStartAt: string): CalendarEvent | null {
    const template = this.eventRepo.findById(templateId, userId);
    if (!template || !template.recurrence_rule) return null;

    return this.eventRepo.createException(templateId, {
      user_id: userId,
      title: template.title,
      start_at: originalStartAt,
      timezone: template.timezone,
      original_start_at: originalStartAt,
      is_cancelled: true,
    });
  }
}
```

- [ ] **Step 4: Run test — verify it passes**

```bash
bun test test/services/event/event-service.test.ts
```

Expected: 5 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/services/event/event-service.ts test/services/event/event-service.test.ts && git commit -m "feat: add event service with recurrence expansion and free slots"
```

---

### Task 17: Event formatters + tests

**Files:**
- Create: `src/services/event/formatters.ts`
- Create: `test/services/event/formatters.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// test/services/event/formatters.test.ts
import { describe, test, expect } from 'bun:test';
import { formatDayAgenda, formatWeekAgenda, formatEventDetail } from '../../../src/services/event/formatters.ts';
import type { EventOccurrence, CalendarEvent } from '../../../src/database/types.ts';

function makeOccurrence(title: string, startUtc: string, endUtc: string | null = null): EventOccurrence {
  return {
    event: {
      id: 1, user_id: 123, title, description: null, category: null,
      start_at: startUtc, end_at: endUtc, all_day: 0, timezone: 'UTC',
      location: null, recurrence_rule: null, recurrence_end_at: null,
      parent_event_id: null, original_start_at: null, is_cancelled: 0,
      reminder_overrides: null, google_event_id: null, google_calendar_id: null,
      last_synced_at: null, created_at: '', updated_at: '',
    },
    occurrence_start: startUtc,
    occurrence_end: endUtc,
    is_exception: false,
  };
}

describe('formatDayAgenda', () => {
  test('formats empty day', () => {
    const result = formatDayAgenda([], '2026-03-11T12:00:00Z', 'UTC', 'en');
    expect(result).toContain('No events');
  });

  test('formats day with events', () => {
    const events = [
      makeOccurrence('Standup', '2026-03-11T09:00:00Z', '2026-03-11T09:30:00Z'),
      makeOccurrence('Lunch', '2026-03-11T12:00:00Z', '2026-03-11T13:00:00Z'),
    ];
    const result = formatDayAgenda(events, '2026-03-11T12:00:00Z', 'UTC', 'en');
    expect(result).toContain('Standup');
    expect(result).toContain('09:00');
    expect(result).toContain('Lunch');
  });
});

describe('formatEventDetail', () => {
  test('includes title and time', () => {
    const event: CalendarEvent = {
      id: 1, user_id: 123, title: 'Dentist', description: 'Cleaning',
      category: 'health', start_at: '2026-03-12T12:00:00Z',
      end_at: '2026-03-12T13:00:00Z', all_day: 0, timezone: 'UTC',
      location: 'Clinic', recurrence_rule: null, recurrence_end_at: null,
      parent_event_id: null, original_start_at: null, is_cancelled: 0,
      reminder_overrides: null, google_event_id: null, google_calendar_id: null,
      last_synced_at: null, created_at: '', updated_at: '',
    };
    const result = formatEventDetail(event, 'UTC', 'en');
    expect(result).toContain('Dentist');
    expect(result).toContain('12:00');
    expect(result).toContain('Clinic');
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

```bash
bun test test/services/event/formatters.test.ts
```

- [ ] **Step 3: Write implementation**

```typescript
// src/services/event/formatters.ts
import type { CalendarEvent, EventOccurrence } from '../../database/types.ts';
import { formatTime, formatTimeRange, formatDateHeader, formatDateShort } from '../../utils/date.ts';
import { escapeHtml } from '../../utils/telegram.ts';

/**
 * Format a day's events for Telegram message
 */
export function formatDayAgenda(
  occurrences: EventOccurrence[],
  dateIso: string,
  timezone: string,
  lang: string,
): string {
  const header = `📅 ${formatDateHeader(dateIso, timezone, lang)}`;

  if (occurrences.length === 0) {
    const noEvents = lang === 'ru' ? 'Нет событий. /add для создания.' : 'No events. Use /add to create one.';
    return `${header}\n\n${noEvents}`;
  }

  const lines = occurrences.map(occ => {
    const time = formatTimeRange(occ.occurrence_start, occ.occurrence_end, timezone);
    const title = escapeHtml(occ.event.title);
    const recur = occ.event.recurrence_rule ? ' 🔁' : '';
    return `  ${time}  ${title}${recur}`;
  });

  return `${header}\n\n${lines.join('\n')}`;
}

/**
 * Format a week's events for Telegram message, grouped by day
 */
export function formatWeekAgenda(
  occurrences: EventOccurrence[],
  startDateIso: string,
  endDateIso: string,
  timezone: string,
  lang: string,
): string {
  // Group by date
  const byDay = new Map<string, EventOccurrence[]>();
  for (const occ of occurrences) {
    const dayKey = occ.occurrence_start.slice(0, 10); // YYYY-MM-DD
    const arr = byDay.get(dayKey) ?? [];
    arr.push(occ);
    byDay.set(dayKey, arr);
  }

  // Build 7 days
  const start = new Date(startDateIso);
  const lines: string[] = [];

  for (let i = 0; i < 7; i++) {
    const d = new Date(start.getTime() + i * 86400000);
    const dayKey = d.toISOString().slice(0, 10);
    const dayLabel = formatDateShort(d.toISOString(), timezone, lang);
    const dayEvents = byDay.get(dayKey) ?? [];

    if (dayEvents.length === 0) {
      const noEvents = lang === 'ru' ? '— нет событий' : '— no events';
      lines.push(`${dayLabel}  ${noEvents}`);
    } else {
      lines.push(`${dayLabel}  ▪ ${dayEvents.length} ${dayEvents.length === 1 ? (lang === 'ru' ? 'событие' : 'event') : (lang === 'ru' ? 'событий' : 'events')}`);
      for (const occ of dayEvents) {
        const time = formatTime(occ.occurrence_start, timezone);
        lines.push(`  ${time} ${escapeHtml(occ.event.title)}`);
      }
    }
    lines.push('');
  }

  const headerStart = formatDateShort(startDateIso, timezone, lang);
  const headerEnd = formatDateShort(endDateIso, timezone, lang);
  return `📅 ${lang === 'ru' ? 'Неделя' : 'Week'} ${headerStart}–${headerEnd}\n\n${lines.join('\n').trim()}`;
}

/**
 * Format single event detail
 */
export function formatEventDetail(event: CalendarEvent, timezone: string, lang: string): string {
  const lines: string[] = [];
  lines.push(`📌 <b>${escapeHtml(event.title)}</b>`);

  if (event.all_day) {
    lines.push(`📅 ${lang === 'ru' ? 'Весь день' : 'All day'}`);
  } else {
    const time = formatTimeRange(event.start_at, event.end_at, timezone);
    lines.push(`🕐 ${time}`);
  }

  if (event.description) {
    lines.push(`📝 ${escapeHtml(event.description)}`);
  }
  if (event.location) {
    lines.push(`📍 ${escapeHtml(event.location)}`);
  }
  if (event.category) {
    lines.push(`🏷 ${escapeHtml(event.category)}`);
  }
  if (event.recurrence_rule) {
    lines.push(`🔁 ${formatRecurrenceHuman(event.recurrence_rule, lang)}`);
  }

  return lines.join('\n');
}

/**
 * Format event for list view (compact one-liner)
 */
export function formatEventListItem(event: CalendarEvent, timezone: string, index: number): string {
  const time = formatTime(event.start_at, timezone);
  return `${index + 1}. ${time} — ${escapeHtml(event.title)}`;
}

function formatRecurrenceHuman(rrule: string, lang: string): string {
  if (rrule.includes('FREQ=DAILY')) return lang === 'ru' ? 'Ежедневно' : 'Daily';
  if (rrule.includes('FREQ=WEEKLY')) return lang === 'ru' ? 'Еженедельно' : 'Weekly';
  if (rrule.includes('FREQ=MONTHLY')) return lang === 'ru' ? 'Ежемесячно' : 'Monthly';
  if (rrule.includes('FREQ=YEARLY')) return lang === 'ru' ? 'Ежегодно' : 'Yearly';
  return rrule;
}
```

- [ ] **Step 4: Run test — verify it passes**

```bash
bun test test/services/event/formatters.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/services/event/formatters.ts test/services/event/formatters.test.ts && git commit -m "feat: add event formatters for telegram display"
```

---

## Chunk 5: Bot Infrastructure

### Task 18: Bot types & session store

**Files:**
- Create: `src/bot/types.ts`

- [ ] **Step 1: Write bot types**

```typescript
// src/bot/types.ts
import type { User } from '../database/types.ts';

/**
 * Properties derived into GramIO context by middleware
 */
export interface BotDerived {
  dbUser: User;
  userTimezone: string;
  lang: 'en' | 'ru';
}

/**
 * Session state for multi-step interactions (onboarding, /add wizard, /edit wizard)
 */
export interface UserSession {
  step: string;
  data: Record<string, unknown>;
  expiresAt: number;
}

/** In-memory session store. Resets on process restart — that's fine. */
export const sessions = new Map<number, UserSession>();

export function getSession(userId: number): UserSession | null {
  const session = sessions.get(userId);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    sessions.delete(userId);
    return null;
  }
  return session;
}

export function setSession(userId: number, step: string, data: Record<string, unknown> = {}): void {
  sessions.set(userId, {
    step,
    data,
    expiresAt: Date.now() + 5 * 60 * 1000, // 5 min TTL
  });
}

export function clearSession(userId: number): void {
  sessions.delete(userId);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/bot/types.ts && git commit -m "feat: add bot types and session store"
```

---

### Task 19: User resolver middleware

**Files:**
- Create: `src/bot/middleware/user-resolver.ts`

- [ ] **Step 1: Write middleware**

```typescript
// src/bot/middleware/user-resolver.ts
import type { DatabaseService } from '../../database/index.ts';

/**
 * Returns a derive function that resolves/creates user from Telegram update.
 * Attaches dbUser, userTimezone, and lang to context.
 */
export function createUserResolver(db: DatabaseService) {
  return async (context: { from?: { id: number; username?: string; firstName?: string } }) => {
    if (!context.from) return {};

    const dbUser = db.users.findOrCreate({
      telegram_id: context.from.id,
      username: context.from.username,
      first_name: context.from.firstName,
    });

    return {
      dbUser,
      userTimezone: dbUser.timezone,
      lang: dbUser.language as 'en' | 'ru',
    };
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/bot/middleware/user-resolver.ts && git commit -m "feat: add user resolver middleware"
```

---

### Task 20: Rate limiter middleware + test

**Files:**
- Create: `src/bot/middleware/rate-limiter.ts`
- Create: `test/bot/middleware/rate-limiter.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// test/bot/middleware/rate-limiter.test.ts
import { describe, test, expect, beforeEach } from 'bun:test';
import { RateLimiter } from '../../../src/bot/middleware/rate-limiter.ts';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter({ perMinute: 5, cooldownMs: 1000 });
  });

  test('allows requests under limit', () => {
    for (let i = 0; i < 5; i++) {
      expect(limiter.check(123)).toBe(true);
    }
  });

  test('blocks requests over limit', () => {
    for (let i = 0; i < 5; i++) limiter.check(123);
    expect(limiter.check(123)).toBe(false);
  });

  test('different users have independent limits', () => {
    for (let i = 0; i < 5; i++) limiter.check(123);
    expect(limiter.check(456)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

```bash
bun test test/bot/middleware/rate-limiter.test.ts
```

- [ ] **Step 3: Write implementation**

```typescript
// src/bot/middleware/rate-limiter.ts
import { cmdLogger } from '../../utils/logger.ts';

interface RateLimiterConfig {
  perMinute: number;
  cooldownMs: number;
}

interface UserBucket {
  timestamps: number[];
  silencedUntil: number;
}

export class RateLimiter {
  private buckets = new Map<number, UserBucket>();
  private config: RateLimiterConfig;

  constructor(config: RateLimiterConfig) {
    this.config = config;
  }

  check(userId: number): boolean {
    const now = Date.now();
    let bucket = this.buckets.get(userId);

    if (!bucket) {
      bucket = { timestamps: [], silencedUntil: 0 };
      this.buckets.set(userId, bucket);
    }

    // In cooldown period — silently drop
    if (now < bucket.silencedUntil) return false;

    // Prune old timestamps (older than 1 minute)
    const windowStart = now - 60_000;
    bucket.timestamps = bucket.timestamps.filter(t => t > windowStart);

    if (bucket.timestamps.length >= this.config.perMinute) {
      bucket.silencedUntil = now + this.config.cooldownMs;
      cmdLogger.warn({ userId }, 'Rate limit exceeded');
      return false; // Caller should send one warning, then silence
    }

    bucket.timestamps.push(now);
    return true;
  }

  /** Returns true if this is the FIRST block (caller should send warning) */
  checkWithWarning(userId: number): { allowed: boolean; firstBlock: boolean } {
    const wasSilenced = (this.buckets.get(userId)?.silencedUntil ?? 0) > Date.now();
    const allowed = this.check(userId);
    return { allowed, firstBlock: !allowed && !wasSilenced };
  }
}
```

- [ ] **Step 4: Run test — verify it passes**

```bash
bun test test/bot/middleware/rate-limiter.test.ts
```

Expected: 3 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/bot/middleware/rate-limiter.ts test/bot/middleware/rate-limiter.test.ts && git commit -m "feat: add rate limiter middleware with tests"
```

---

### Task 21: Bot factory

**Files:**
- Create: `src/bot/index.ts`
- Create: `src/bot/middleware/timezone-context.ts`

- [ ] **Step 1: Write timezone context middleware**

```typescript
// src/bot/middleware/timezone-context.ts
// Note: timezone is already attached by user-resolver as `userTimezone`.
// This file provides a helper derive for toUserTime on context if needed later.
// For now, it's a no-op — timezone data comes from user-resolver derive.
```

- [ ] **Step 2: Write bot factory**

```typescript
// src/bot/index.ts
import { Bot } from 'gramio';
import type { DatabaseService } from '../database/index.ts';
import { EventService } from '../services/event/event-service.ts';
import { createUserResolver } from './middleware/user-resolver.ts';
import { RateLimiter } from './middleware/rate-limiter.ts';
import { RATE_LIMIT } from '../config/constants.ts';
import { t } from '../config/constants.ts';
import { botLogger } from '../utils/logger.ts';

// Commands — imported as they are created in later tasks
// import { handlePing } from './commands/ping.ts';
// import { handleHelp } from './commands/help.ts';
// ... etc

export function createBot(token: string, db: DatabaseService) {
  const eventService = new EventService(db.events, db.reminders);
  const rateLimiter = new RateLimiter({
    perMinute: RATE_LIMIT.MESSAGES_PER_MINUTE,
    cooldownMs: RATE_LIMIT.COOLDOWN_MS,
  });

  const bot = new Bot(token)
    // Derive user data
    .derive(createUserResolver(db))
    // Rate limiting middleware
    .use(async (context, next) => {
      const userId = context.from?.id;
      if (!userId) return next();

      const { allowed, firstBlock } = rateLimiter.checkWithWarning(userId);
      if (!allowed) {
        if (firstBlock && 'send' in context) {
          const lang = ((context as any).dbUser?.language ?? 'en') as 'en' | 'ru';
          await (context as any).send(t(lang).rate_limited);
        }
        return; // Drop silently
      }
      return next();
    })
    // Error handler
    .onError(({ context, kind, error }) => {
      botLogger.error({ kind, error: String(error) }, 'Unhandled bot error');
      if (context && 'send' in context) {
        try {
          const errLang = ((context as any).dbUser?.language ?? 'en') as 'en' | 'ru';
          (context as any).send(t(errLang).something_wrong);
        } catch {}
      }
    });

  // Register commands here as they are implemented.
  // Pattern: bot.command('name', (ctx) => handleName(ctx, db, eventService));

  return { bot, eventService, db };
}
```

> **Note:** Command registrations will be uncommented/added in Tasks 22+. The bot factory compiles and runs, but has no command handlers yet.

- [ ] **Step 3: Commit**

```bash
git add src/bot/index.ts src/bot/middleware/timezone-context.ts && git commit -m "feat: add bot factory with middleware pipeline"
```

---

## Chunk 6: Keyboards & Simple Commands

### Task 22: Keyboards module

**Files:**
- Create: `src/bot/keyboards.ts`

- [ ] **Step 1: Write keyboard builders**

```typescript
// src/bot/keyboards.ts
import { InlineKeyboard, Keyboard } from 'gramio';
import { CB, TZ_REGIONS } from '../config/constants.ts';
import type { CalendarEvent } from '../database/types.ts';
import { formatTime } from '../utils/date.ts';

// ── Onboarding ──

export function languageKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('English', `${CB.ONBOARD_LANG}:en`)
    .text('Русский', `${CB.ONBOARD_LANG}:ru`);
}

export function timezoneMethodKeyboard(lang: 'en' | 'ru'): Keyboard {
  const locationText = lang === 'ru' ? '📍 Отправить геолокацию' : '📍 Share Location';
  return new Keyboard()
    .requestLocation(locationText)
    .resized()
    .oneTime();
}

export function timezoneManualKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  const regions = Object.keys(TZ_REGIONS);
  for (const region of regions) {
    kb.text(region, `${CB.ONBOARD_TZ_REGION}:${region}`);
  }
  return kb;
}

export function timezoneCitiesKeyboard(region: string): InlineKeyboard {
  const cities = TZ_REGIONS[region] ?? [];
  const kb = new InlineKeyboard();
  for (let i = 0; i < cities.length; i++) {
    const tz = cities[i]!;
    const city = tz.split('/').pop()!.replace(/_/g, ' ');
    kb.text(city, `${CB.ONBOARD_TZ}:${tz}`);
    if (i % 2 === 1) kb.row();
  }
  return kb;
}

export function timezoneConfirmKeyboard(lang: 'en' | 'ru'): InlineKeyboard {
  return new InlineKeyboard()
    .text(lang === 'ru' ? 'Да ✓' : 'Yes ✓', `${CB.ONBOARD_TZ}:confirm`)
    .text(lang === 'ru' ? 'Нет, вручную' : 'No, choose manually', `${CB.ONBOARD_TZ}:manual`);
}

export function countryKeyboard(countryCode: string | null, lang: 'en' | 'ru'): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (countryCode) {
    const label = lang === 'ru' ? `Да, ${countryCode}` : `Yes, ${countryCode}`;
    kb.text(label, `${CB.ONBOARD_COUNTRY}:${countryCode}`);
  }
  kb.text(lang === 'ru' ? 'Пропустить' : 'Skip', `${CB.ONBOARD_COUNTRY}:skip`);
  return kb;
}

// ── Event actions ──

export function eventActionsKeyboard(eventId: number, lang: 'en' | 'ru'): InlineKeyboard {
  return new InlineKeyboard()
    .text(lang === 'ru' ? '✏️ Редактировать' : '✏️ Edit', `${CB.EVENT_EDIT}:${eventId}`)
    .text(lang === 'ru' ? '🗑 Удалить' : '🗑 Delete', `${CB.EVENT_DELETE}:${eventId}`);
}

export function deleteConfirmKeyboard(eventId: number, lang: 'en' | 'ru'): InlineKeyboard {
  return new InlineKeyboard()
    .text(lang === 'ru' ? 'Да, удалить' : 'Yes, delete', `${CB.EVENT_DELETE_CONFIRM}:${eventId}`)
    .text(lang === 'ru' ? 'Отмена' : 'Cancel', `${CB.EVENT_DELETE}:cancel`);
}

export function eventPickerKeyboard(events: CalendarEvent[], timezone: string, prefix: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (let i = 0; i < events.length && i < 10; i++) {
    const e = events[i]!;
    const time = formatTime(e.start_at, timezone);
    kb.text(`${i + 1}. ${time} ${e.title.slice(0, 20)}`, `${prefix}:${e.id}`).row();
  }
  kb.text('Cancel', `${prefix}:cancel`);
  return kb;
}

export function editFieldKeyboard(eventId: number, lang: 'en' | 'ru'): InlineKeyboard {
  return new InlineKeyboard()
    .text(lang === 'ru' ? 'Название' : 'Title', `${CB.EDIT_FIELD}:${eventId}:title`)
    .text(lang === 'ru' ? 'Время' : 'Time', `${CB.EDIT_FIELD}:${eventId}:time`)
    .row()
    .text(lang === 'ru' ? 'Описание' : 'Description', `${CB.EDIT_FIELD}:${eventId}:description`)
    .text(lang === 'ru' ? 'Место' : 'Location', `${CB.EDIT_FIELD}:${eventId}:location`)
    .row()
    .text(lang === 'ru' ? 'Отмена' : 'Cancel', `${CB.EDIT_FIELD}:cancel`);
}

export function recurringEditKeyboard(eventId: number, lang: 'en' | 'ru'): InlineKeyboard {
  return new InlineKeyboard()
    .text(lang === 'ru' ? 'Только это' : 'This only', `${CB.EVENT_RECURRENCE}:${eventId}:this`)
    .row()
    .text(lang === 'ru' ? 'Все будущие' : 'All future', `${CB.EVENT_RECURRENCE}:${eventId}:future`)
    .row()
    .text(lang === 'ru' ? 'Все вхождения' : 'All occurrences', `${CB.EVENT_RECURRENCE}:${eventId}:all`);
}

export function monthNavKeyboard(yearMonth: string): InlineKeyboard {
  const [y, m] = yearMonth.split('-').map(Number) as [number, number];
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return new InlineKeyboard()
    .text('◀️', `${CB.MONTH_NAV}:${prev}`)
    .text('▶️', `${CB.MONTH_NAV}:${next}`);
}

// ── Remove keyboard helper ──
export function removeKeyboard(): { reply_markup: { remove_keyboard: true } } {
  return { reply_markup: { remove_keyboard: true } };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/bot/keyboards.ts && git commit -m "feat: add keyboard builders for all bot interactions"
```

---

### Task 23: /ping command

**Files:**
- Create: `src/bot/commands/ping.ts`

- [ ] **Step 1: Write handler**

```typescript
// src/bot/commands/ping.ts
import { t } from '../../config/constants.ts';
import type { User } from '../../database/types.ts';

export async function handlePing(ctx: any): Promise<void> {
  const start = Date.now();
  const lang = (ctx.dbUser as User)?.language ?? 'en';
  const ms = Date.now() - start;
  await ctx.send(t(lang as 'en' | 'ru').pong(ms));
}
```

- [ ] **Step 2: Register in bot factory**

In `src/bot/index.ts`, add import and `.command('ping', handlePing)` to the bot chain.

- [ ] **Step 3: Commit**

```bash
git add src/bot/commands/ping.ts && git commit -m "feat: add /ping command"
```

---

### Task 24: /help command

**Files:**
- Create: `src/bot/commands/help.ts`

- [ ] **Step 1: Write handler**

```typescript
// src/bot/commands/help.ts
const HELP_EN = `📖 <b>HyperCalendar Commands</b>

📅 <b>Schedule Views</b>
  /today — today's events
  /tomorrow — tomorrow's events
  /week — 7-day overview
  /month — monthly calendar

✏️ <b>Manage Events</b>
  /add — create event
  /edit — modify event
  /delete — remove event
  /search — find events

⚙️ <b>Settings</b>
  /timezone — change timezone
  /settings — all preferences

📤 <b>Import/Export</b>
  /import — import .ics file
  /export — export events

🔧 <b>Other</b>
  /free — find free time slots
  /ping — check bot status
  /help — this message`;

const HELP_RU = `📖 <b>Команды HyperCalendar</b>

📅 <b>Расписание</b>
  /today — события сегодня
  /tomorrow — события завтра
  /week — обзор на 7 дней
  /month — месячный календарь

✏️ <b>Управление</b>
  /add — создать событие
  /edit — редактировать
  /delete — удалить
  /search — поиск событий

⚙️ <b>Настройки</b>
  /timezone — часовой пояс
  /settings — все настройки

📤 <b>Импорт/Экспорт</b>
  /import — импорт .ics
  /export — экспорт событий

🔧 <b>Другое</b>
  /free — свободные слоты
  /ping — проверка бота
  /help — это сообщение`;

export async function handleHelp(ctx: any): Promise<void> {
  const lang = ctx.dbUser?.language ?? 'en';
  await ctx.send(lang === 'ru' ? HELP_RU : HELP_EN, { parse_mode: 'HTML' });
}
```

- [ ] **Step 2: Register in bot factory**

- [ ] **Step 3: Commit**

```bash
git add src/bot/commands/help.ts && git commit -m "feat: add /help command"
```

---

## Chunk 7: Onboarding & View Commands

### Task 25: /start command + onboarding flow

**Files:**
- Create: `src/bot/commands/start.ts`

- [ ] **Step 1: Write handler**

```typescript
// src/bot/commands/start.ts
import { InlineKeyboard } from 'gramio';
import type { DatabaseService } from '../../database/index.ts';
import type { User } from '../../database/types.ts';
import { t, CB } from '../../config/constants.ts';
import { setSession, getSession, clearSession } from '../types.ts';
import {
  languageKeyboard, timezoneMethodKeyboard, timezoneManualKeyboard,
  timezoneCitiesKeyboard, timezoneConfirmKeyboard, countryKeyboard,
  removeKeyboard,
} from '../keyboards.ts';
import { resolveTimezone, getTimezoneDisplay, guessCountryFromTimezone } from '../../services/timezone/timezone-service.ts';

export async function handleStart(ctx: any, db: DatabaseService): Promise<void> {
  const user = ctx.dbUser as User;

  if (user.onboarding_completed) {
    const lang = user.language as 'en' | 'ru';
    await ctx.send(t(lang).welcome_back);
    return;
  }

  // Step 1: Language selection
  setSession(user.telegram_id, 'onboard:lang');
  await ctx.send(t('en').welcome, { reply_markup: languageKeyboard() });
}

/**
 * Handle onboarding callback queries.
 * Called from the callback handler router.
 */
export async function handleOnboardingCallback(
  ctx: any,
  db: DatabaseService,
  action: string,
  payload: string,
): Promise<void> {
  const user = ctx.dbUser as User;
  const userId = user.telegram_id;

  if (action === 'ol') {
    // Language selected
    const lang = payload as 'en' | 'ru';
    db.users.update(userId, { language: lang });
    setSession(userId, 'onboard:tz', { lang });
    await ctx.editText(t(lang).tz_prompt, {
      reply_markup: timezoneManualKeyboard(),
    });
    // Also send reply keyboard for location
    await ctx.send(t(lang).tz_prompt, {
      reply_markup: timezoneMethodKeyboard(lang),
    });
  }

  if (action === 'otr') {
    // Timezone region selected
    const session = getSession(userId);
    const lang = (session?.data.lang as 'en' | 'ru') ?? user.language as 'en' | 'ru';
    await ctx.editText(`Select city:`, {
      reply_markup: timezoneCitiesKeyboard(payload),
    });
  }

  if (action === 'ot') {
    const session = getSession(userId);
    const lang = (session?.data.lang as 'en' | 'ru') ?? user.language as 'en' | 'ru';

    if (payload === 'confirm') {
      // Timezone already set in session data, proceed to country
      const tz = session?.data.detectedTz as string ?? user.timezone;
      db.users.update(userId, { timezone: tz });
      const country = guessCountryFromTimezone(tz);
      setSession(userId, 'onboard:country', { ...session?.data, tz });
      await ctx.send(t(lang).country_prompt, {
        ...removeKeyboard(),
      });
      await ctx.send(t(lang).country_prompt, {
        reply_markup: countryKeyboard(country, lang),
      });
    } else if (payload === 'manual') {
      // Show region selection
      await ctx.editText('Select region:', {
        reply_markup: timezoneManualKeyboard(),
      });
    } else {
      // Timezone city selected directly
      db.users.update(userId, { timezone: payload });
      const country = guessCountryFromTimezone(payload);
      setSession(userId, 'onboard:country', { ...session?.data, tz: payload });
      await ctx.send(`✅ ${getTimezoneDisplay(payload)}`, removeKeyboard());
      await ctx.send(t(lang).country_prompt, {
        reply_markup: countryKeyboard(country, lang),
      });
    }
  }

  if (action === 'oc') {
    // Country selected or skipped
    const session = getSession(userId);
    const lang = (session?.data.lang as 'en' | 'ru') ?? user.language as 'en' | 'ru';

    if (payload !== 'skip') {
      db.users.update(userId, { country_code: payload });
    }

    // Step 4: Morning agenda prompt
    setSession(userId, 'onboard:agenda', { ...session?.data });
    const agendaKb = new InlineKeyboard()
      .text(lang === 'ru' ? 'Да, 08:00' : 'Yes, 08:00', `${CB.ONBOARD_AGENDA}:yes`)
      .text(lang === 'ru' ? 'Нет' : 'No thanks', `${CB.ONBOARD_AGENDA}:no`);
    await ctx.send(t(lang).agenda_prompt, { reply_markup: agendaKb });
  }

  if (action === 'oa') {
    // Morning agenda response — complete onboarding
    // Note: actual notification preferences are set in sub-project 04.
    // Here we just acknowledge the choice and finish.
    const session = getSession(userId);
    const lang = (session?.data.lang as 'en' | 'ru') ?? user.language as 'en' | 'ru';

    db.users.update(userId, { onboarding_completed: 1 });
    clearSession(userId);
    await ctx.send(t(lang).onboard_done);
  }
}

/**
 * Handle location message during onboarding
 */
export async function handleOnboardingLocation(
  ctx: any,
  db: DatabaseService,
  latitude: number,
  longitude: number,
): Promise<void> {
  const user = ctx.dbUser as User;
  const session = getSession(user.telegram_id);
  if (!session || !session.step.startsWith('onboard:tz')) return;

  const lang = (session.data.lang as 'en' | 'ru') ?? user.language as 'en' | 'ru';
  const tz = resolveTimezone(latitude, longitude);
  const display = getTimezoneDisplay(tz);

  setSession(user.telegram_id, 'onboard:tz', { ...session.data, detectedTz: tz });

  await ctx.send(t(lang).tz_detected(tz, display), {
    ...removeKeyboard(),
    reply_markup: timezoneConfirmKeyboard(lang),
  });
}
```

- [ ] **Step 2: Register in bot factory**

In `src/bot/index.ts`:
- Import `handleStart` and add `.command('start', (ctx) => handleStart(ctx, db))`
- Location handling goes in message handler (Task 41)

- [ ] **Step 3: Commit**

```bash
git add src/bot/commands/start.ts && git commit -m "feat: add /start command with onboarding flow"
```

---

### Task 26: /today command

**Files:**
- Create: `src/bot/commands/today.ts`

- [ ] **Step 1: Write handler**

```typescript
// src/bot/commands/today.ts
import type { EventService } from '../../services/event/event-service.ts';
import type { User } from '../../database/types.ts';
import { formatDayAgenda } from '../../services/event/formatters.ts';

export async function handleToday(ctx: any, eventService: EventService): Promise<void> {
  const user = ctx.dbUser as User;
  const now = new Date();
  const occurrences = eventService.getEventsForDay(user.telegram_id, now, user.timezone);
  const text = formatDayAgenda(occurrences, now.toISOString(), user.timezone, user.language);
  await ctx.send(text, { parse_mode: 'HTML' });
}
```

- [ ] **Step 2: Register in bot factory**

- [ ] **Step 3: Commit**

```bash
git add src/bot/commands/today.ts && git commit -m "feat: add /today command"
```

---

### Task 27: /tomorrow command

**Files:**
- Create: `src/bot/commands/tomorrow.ts`

- [ ] **Step 1: Write handler**

```typescript
// src/bot/commands/tomorrow.ts
import type { EventService } from '../../services/event/event-service.ts';
import type { User } from '../../database/types.ts';
import { formatDayAgenda } from '../../services/event/formatters.ts';
import { addDays } from 'date-fns';

export async function handleTomorrow(ctx: any, eventService: EventService): Promise<void> {
  const user = ctx.dbUser as User;
  const tomorrow = addDays(new Date(), 1);
  const occurrences = eventService.getEventsForDay(user.telegram_id, tomorrow, user.timezone);
  const text = formatDayAgenda(occurrences, tomorrow.toISOString(), user.timezone, user.language);
  await ctx.send(text, { parse_mode: 'HTML' });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/bot/commands/tomorrow.ts && git commit -m "feat: add /tomorrow command"
```

---

### Task 28: /week command

**Files:**
- Create: `src/bot/commands/week.ts`

- [ ] **Step 1: Write handler**

```typescript
// src/bot/commands/week.ts
import type { EventService } from '../../services/event/event-service.ts';
import type { User } from '../../database/types.ts';
import { formatWeekAgenda } from '../../services/event/formatters.ts';
import { getWeekRangeUtc } from '../../utils/date.ts';

export async function handleWeek(ctx: any, eventService: EventService): Promise<void> {
  const user = ctx.dbUser as User;
  const now = new Date();
  const { start, end } = getWeekRangeUtc(now, user.timezone);
  const occurrences = eventService.getEventsInRange(user.telegram_id, start, end);
  const text = formatWeekAgenda(occurrences, start, end, user.timezone, user.language);
  await ctx.send(text, { parse_mode: 'HTML' });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/bot/commands/week.ts && git commit -m "feat: add /week command"
```

---

### Task 29: /month command

**Files:**
- Create: `src/bot/commands/month.ts`

- [ ] **Step 1: Write handler**

```typescript
// src/bot/commands/month.ts
import type { EventService } from '../../services/event/event-service.ts';
import type { DatabaseService } from '../../database/index.ts';
import type { User } from '../../database/types.ts';
import { TZDate } from '@date-fns/tz';
import { format, startOfMonth, endOfMonth, startOfWeek, endOfWeek, addDays, getDaysInMonth, getDay } from 'date-fns';
import { monthNavKeyboard } from '../keyboards.ts';

export async function handleMonth(ctx: any, eventService: EventService, yearMonth?: string): Promise<void> {
  const user = ctx.dbUser as User;
  const lang = user.language as 'en' | 'ru';

  let refDate: Date;
  if (yearMonth) {
    const [y, m] = yearMonth.split('-').map(Number) as [number, number];
    refDate = new TZDate(y, m - 1, 1, 0, 0, 0, 0, user.timezone);
  } else {
    refDate = TZDate.tz(user.timezone);
  }

  const monthStart = startOfMonth(refDate);
  const monthEnd = endOfMonth(refDate);
  const monthLabel = format(monthStart, lang === 'ru' ? 'LLLL yyyy' : 'MMMM yyyy');
  const daysInMonth = getDaysInMonth(monthStart);

  // Count events per day — single range query for the whole month, then bucket
  const monthStartUtc = new TZDate(monthStart.getFullYear(), monthStart.getMonth(), 1, 0, 0, 0, 0, user.timezone).toISOString();
  const monthEndUtc = new TZDate(monthEnd.getFullYear(), monthEnd.getMonth(), daysInMonth, 23, 59, 59, 999, user.timezone).toISOString();
  const allOccurrences = eventService.getEventsInRange(user.telegram_id, monthStartUtc, monthEndUtc);

  const eventCounts: Record<number, number> = {};
  for (const occ of allOccurrences) {
    const localDate = new TZDate(occ.occurrence_start, user.timezone);
    const day = localDate.getDate();
    eventCounts[day] = (eventCounts[day] ?? 0) + 1;
  }

  // Build calendar grid
  const header = 'Mo Tu We Th Fr Sa Su';
  const firstDayOfWeek = (getDay(monthStart) + 6) % 7; // 0=Mon
  let grid = '';
  let dayNum = 1;

  // Pad first week
  for (let i = 0; i < firstDayOfWeek; i++) grid += '   ';

  for (let d = 1; d <= daysInMonth; d++) {
    const dayStr = String(d).padStart(2, ' ');
    grid += dayStr + ' ';
    if ((firstDayOfWeek + d) % 7 === 0) grid += '\n';
  }

  // Event counts summary
  const countLines = Object.entries(eventCounts)
    .map(([d, c]) => `${d}·${c}`)
    .join('  ');

  const ym = format(monthStart, 'yyyy-MM');
  const text = `📅 ${monthLabel}\n\n<code>${header}\n${grid.trimEnd()}</code>\n\n${countLines ? `Events: ${countLines}` : 'No events this month.'}`;

  await ctx.send(text, {
    parse_mode: 'HTML',
    reply_markup: monthNavKeyboard(ym),
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/bot/commands/month.ts && git commit -m "feat: add /month command with calendar grid"
```

---

## Chunk 8: Event CRUD Commands

### Task 30: /add command

**Files:**
- Create: `src/bot/commands/add.ts`

- [ ] **Step 1: Write handler**

```typescript
// src/bot/commands/add.ts
import type { EventService } from '../../services/event/event-service.ts';
import type { User } from '../../database/types.ts';
import { t } from '../../config/constants.ts';
import { setSession, getSession, clearSession } from '../types.ts';
import { parseSimpleDate, parseDuration } from '../../utils/date.ts';
import { formatEventDetail } from '../../services/event/formatters.ts';
import { eventActionsKeyboard } from '../keyboards.ts';
import { addMinutes } from 'date-fns';

export async function handleAdd(ctx: any, eventService: EventService): Promise<void> {
  const user = ctx.dbUser as User;
  const lang = user.language as 'en' | 'ru';
  const args = ctx.args as string | undefined;

  if (args && args.trim().length > 0) {
    // Quick format: /add Title tomorrow at 15:00
    return handleQuickAdd(ctx, eventService, user, args.trim());
  }

  // Start wizard
  setSession(user.telegram_id, 'add:title');
  await ctx.send(t(lang).add_title_prompt);
}

async function handleQuickAdd(ctx: any, eventService: EventService, user: User, input: string): Promise<void> {
  const lang = user.language as 'en' | 'ru';

  // Try to parse "Title <date expression>"
  // Strategy: last part matching a date pattern is the date, rest is title
  const words = input.split(' ');
  let title = '';
  let dateStr = '';

  // Try progressively: last 3 words as date, then last 2, then last 1
  for (let dateWords = 3; dateWords >= 1; dateWords--) {
    if (words.length <= dateWords) continue;
    const candidate = words.slice(-dateWords).join(' ');
    const parsed = parseSimpleDate(candidate, user.timezone);
    if (parsed) {
      title = words.slice(0, -dateWords).join(' ');
      dateStr = candidate;
      break;
    }
  }

  if (!title || !dateStr) {
    // Couldn't parse — fall back to wizard
    setSession(user.telegram_id, 'add:title');
    await ctx.send(t(lang).add_title_prompt);
    return;
  }

  const startDate = parseSimpleDate(dateStr, user.timezone)!;
  const event = eventService.createEvent({
    user_id: user.telegram_id,
    title,
    start_at: startDate.toISOString(),
    timezone: user.timezone,
  });

  const detail = formatEventDetail(event, user.timezone, lang);
  await ctx.send(`${t(lang).event_created(title)}\n\n${detail}`, {
    parse_mode: 'HTML',
    reply_markup: eventActionsKeyboard(event.id, lang),
  });
}

/**
 * Handle wizard steps for /add (called from message handler)
 */
export async function handleAddWizardStep(
  ctx: any,
  eventService: EventService,
  user: User,
  text: string,
): Promise<boolean> {
  const session = getSession(user.telegram_id);
  if (!session || !session.step.startsWith('add:')) return false;
  const lang = user.language as 'en' | 'ru';

  if (session.step === 'add:title') {
    setSession(user.telegram_id, 'add:time', { ...session.data, title: text });
    await ctx.send(t(lang).add_time_prompt);
    return true;
  }

  if (session.step === 'add:time') {
    const parsed = parseSimpleDate(text, user.timezone);
    if (!parsed) {
      await ctx.send(lang === 'ru' ? 'Не могу разобрать дату. Попробуйте: "завтра 15:00"' : 'Can\'t parse that date. Try: "tomorrow 15:00"');
      return true;
    }
    setSession(user.telegram_id, 'add:duration', { ...session.data, start_at: parsed.toISOString() });
    await ctx.send(t(lang).add_duration_prompt);
    return true;
  }

  if (session.step === 'add:duration') {
    const title = session.data.title as string;
    const startAt = session.data.start_at as string;
    let endAt: string | undefined;

    if (text.toLowerCase() !== 'skip' && text.toLowerCase() !== 'пропустить') {
      const mins = parseDuration(text);
      if (mins) {
        endAt = addMinutes(new Date(startAt), mins).toISOString();
      }
    }

    const event = eventService.createEvent({
      user_id: user.telegram_id,
      title,
      start_at: startAt,
      end_at: endAt,
      timezone: user.timezone,
    });

    clearSession(user.telegram_id);
    const detail = formatEventDetail(event, user.timezone, lang);
    await ctx.send(`${t(lang).event_created(title)}\n\n${detail}`, {
      parse_mode: 'HTML',
      reply_markup: eventActionsKeyboard(event.id, lang),
    });
    return true;
  }

  return false;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/bot/commands/add.ts && git commit -m "feat: add /add command with quick format and wizard"
```

---

### Task 31: /edit command

**Files:**
- Create: `src/bot/commands/edit.ts`

- [ ] **Step 1: Write handler**

```typescript
// src/bot/commands/edit.ts
import type { EventService } from '../../services/event/event-service.ts';
import type { User } from '../../database/types.ts';
import { t } from '../../config/constants.ts';
import { CB } from '../../config/constants.ts';
import { setSession, getSession, clearSession } from '../types.ts';
import { eventPickerKeyboard, editFieldKeyboard, recurringEditKeyboard } from '../keyboards.ts';
import { formatEventDetail } from '../../services/event/formatters.ts';
import { parseSimpleDate } from '../../utils/date.ts';

export async function handleEdit(ctx: any, eventService: EventService): Promise<void> {
  const user = ctx.dbUser as User;
  const lang = user.language as 'en' | 'ru';
  const upcoming = eventService.getUpcoming(user.telegram_id, 10);

  if (upcoming.length === 0) {
    await ctx.send(t(lang).no_events);
    return;
  }

  await ctx.send(t(lang).edit_pick, {
    reply_markup: eventPickerKeyboard(upcoming, user.timezone, CB.EVENT_EDIT),
  });
}

/**
 * Handle edit callbacks (called from callback handler)
 */
export async function handleEditCallback(
  ctx: any,
  eventService: EventService,
  user: User,
  eventId: number,
): Promise<void> {
  const lang = user.language as 'en' | 'ru';
  const event = eventService.getEvent(eventId, user.telegram_id);
  if (!event) {
    await ctx.answer({ text: 'Event not found' });
    return;
  }

  if (event.recurrence_rule) {
    await ctx.editText(formatEventDetail(event, user.timezone, lang), {
      parse_mode: 'HTML',
      reply_markup: recurringEditKeyboard(eventId, lang),
    });
    return;
  }

  await ctx.editText(formatEventDetail(event, user.timezone, lang), {
    parse_mode: 'HTML',
    reply_markup: editFieldKeyboard(eventId, lang),
  });
}

/**
 * Handle field edit callback
 */
export async function handleEditFieldCallback(
  ctx: any,
  eventService: EventService,
  user: User,
  eventId: number,
  field: string,
): Promise<void> {
  const lang = user.language as 'en' | 'ru';

  if (field === 'cancel') {
    await ctx.editText(lang === 'ru' ? 'Отменено.' : 'Cancelled.');
    return;
  }

  setSession(user.telegram_id, `edit:${field}`, { eventId });

  const prompts: Record<string, Record<string, string>> = {
    title: { en: 'Send new title:', ru: 'Отправьте новое название:' },
    time: { en: 'Send new date/time (e.g., "tomorrow 15:00"):', ru: 'Отправьте новую дату/время:' },
    description: { en: 'Send new description (or "clear" to remove):', ru: 'Отправьте описание (или "clear" для удаления):' },
    location: { en: 'Send new location (or "clear" to remove):', ru: 'Отправьте место (или "clear" для удаления):' },
  };

  const prompt = prompts[field]?.[lang] ?? 'Send new value:';
  await ctx.answer();
  await ctx.send(prompt);
}

/**
 * Handle edit wizard step (called from message handler)
 */
export async function handleEditWizardStep(
  ctx: any,
  eventService: EventService,
  user: User,
  text: string,
): Promise<boolean> {
  const session = getSession(user.telegram_id);
  if (!session || !session.step.startsWith('edit:')) return false;
  const lang = user.language as 'en' | 'ru';
  const eventId = session.data.eventId as number;
  const field = session.step.replace('edit:', '');

  let updateData: Record<string, unknown> = {};

  if (field === 'title') {
    updateData.title = text;
  } else if (field === 'time') {
    const parsed = parseSimpleDate(text, user.timezone);
    if (!parsed) {
      await ctx.send(lang === 'ru' ? 'Не могу разобрать дату.' : "Can't parse that date.");
      return true;
    }
    updateData.start_at = parsed.toISOString();
  } else if (field === 'description') {
    updateData.description = text.toLowerCase() === 'clear' ? null : text;
  } else if (field === 'location') {
    updateData.location = text.toLowerCase() === 'clear' ? null : text;
  }

  const updated = eventService.updateEvent(eventId, user.telegram_id, updateData);
  clearSession(user.telegram_id);

  if (updated) {
    const detail = formatEventDetail(updated, user.timezone, lang);
    await ctx.send(`${t(lang).event_updated(updated.title)}\n\n${detail}`, { parse_mode: 'HTML' });
  } else {
    await ctx.send(t(lang).something_wrong);
  }

  return true;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/bot/commands/edit.ts && git commit -m "feat: add /edit command with field selection and wizard"
```

---

### Task 32: /delete command

**Files:**
- Create: `src/bot/commands/delete.ts`

- [ ] **Step 1: Write handler**

```typescript
// src/bot/commands/delete.ts
import type { EventService } from '../../services/event/event-service.ts';
import type { User } from '../../database/types.ts';
import { t, CB } from '../../config/constants.ts';
import { eventPickerKeyboard, deleteConfirmKeyboard } from '../keyboards.ts';

export async function handleDelete(ctx: any, eventService: EventService): Promise<void> {
  const user = ctx.dbUser as User;
  const lang = user.language as 'en' | 'ru';
  const upcoming = eventService.getUpcoming(user.telegram_id, 10);

  if (upcoming.length === 0) {
    await ctx.send(t(lang).no_events);
    return;
  }

  await ctx.send(t(lang).delete_pick, {
    reply_markup: eventPickerKeyboard(upcoming, user.timezone, CB.EVENT_DELETE),
  });
}

export async function handleDeleteCallback(
  ctx: any,
  eventService: EventService,
  user: User,
  eventId: number,
): Promise<void> {
  const lang = user.language as 'en' | 'ru';

  if (eventId === 0) {
    // Cancel
    await ctx.editText(lang === 'ru' ? 'Отменено.' : 'Cancelled.');
    return;
  }

  const event = eventService.getEvent(eventId, user.telegram_id);
  if (!event) {
    await ctx.answer({ text: 'Event not found' });
    return;
  }

  await ctx.editText(t(lang).confirm_delete(event.title), {
    reply_markup: deleteConfirmKeyboard(eventId, lang),
  });
}

export async function handleDeleteConfirmCallback(
  ctx: any,
  eventService: EventService,
  user: User,
  eventId: number,
): Promise<void> {
  const lang = user.language as 'en' | 'ru';
  const event = eventService.getEvent(eventId, user.telegram_id);
  const title = event?.title ?? '?';
  const deleted = eventService.deleteEvent(eventId, user.telegram_id);

  if (deleted) {
    await ctx.editText(t(lang).event_deleted(title));
  } else {
    await ctx.editText(t(lang).something_wrong);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/bot/commands/delete.ts && git commit -m "feat: add /delete command with confirmation"
```

---

## Chunk 9: Search & Utility Commands

### Task 33: /search command

**Files:**
- Create: `src/bot/commands/search.ts`

- [ ] **Step 1: Write handler**

```typescript
// src/bot/commands/search.ts
import type { EventService } from '../../services/event/event-service.ts';
import type { User } from '../../database/types.ts';
import { t, CB } from '../../config/constants.ts';
import { formatEventListItem } from '../../services/event/formatters.ts';
import { eventPickerKeyboard } from '../keyboards.ts';

export async function handleSearch(ctx: any, eventService: EventService): Promise<void> {
  const user = ctx.dbUser as User;
  const lang = user.language as 'en' | 'ru';
  const query = (ctx.args as string)?.trim();

  if (!query) {
    await ctx.send(lang === 'ru' ? 'Укажите текст для поиска: /search <запрос>' : 'Provide search text: /search <query>');
    return;
  }

  const results = eventService.searchEvents(user.telegram_id, query);

  if (results.length === 0) {
    await ctx.send(t(lang).search_no_results);
    return;
  }

  const lines = results.slice(0, 10).map((e, i) =>
    formatEventListItem(e, user.timezone, i)
  );

  await ctx.send(
    `🔍 ${lang === 'ru' ? `Найдено ${results.length}:` : `Found ${results.length}:`}\n\n${lines.join('\n')}`,
    { reply_markup: eventPickerKeyboard(results.slice(0, 10), user.timezone, CB.EVENT_VIEW) },
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/bot/commands/search.ts && git commit -m "feat: add /search command"
```

---

### Task 34: /free command

**Files:**
- Create: `src/bot/commands/free.ts`

- [ ] **Step 1: Write handler**

```typescript
// src/bot/commands/free.ts
import type { EventService } from '../../services/event/event-service.ts';
import type { User } from '../../database/types.ts';
import { t } from '../../config/constants.ts';
import { parseSimpleDate, formatTime, formatDateHeader } from '../../utils/date.ts';

export async function handleFree(ctx: any, eventService: EventService): Promise<void> {
  const user = ctx.dbUser as User;
  const lang = user.language as 'en' | 'ru';
  const args = (ctx.args as string)?.trim();

  let date = new Date();
  if (args) {
    const parsed = parseSimpleDate(args + ' 00:00', user.timezone);
    if (parsed) date = parsed;
  }

  const slots = eventService.getFreeSlots(user.telegram_id, date, user.timezone);

  if (slots.length === 0) {
    await ctx.send(lang === 'ru' ? 'Весь день занят!' : 'Full day busy!');
    return;
  }

  const dateLabel = formatDateHeader(date.toISOString(), user.timezone, lang);
  const lines = slots.map(s => {
    const start = formatTime(s.start, user.timezone);
    const end = formatTime(s.end, user.timezone);
    const hours = Math.floor(s.durationMinutes / 60);
    const mins = s.durationMinutes % 60;
    const duration = hours > 0
      ? (mins > 0 ? `${hours}h${mins}m` : `${hours}h`)
      : `${mins}m`;
    return `  ${start}–${end}  (${duration})`;
  });

  await ctx.send(`${t(lang).free_header(dateLabel)}\n\n${lines.join('\n')}`);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/bot/commands/free.ts && git commit -m "feat: add /free command"
```

---

### Task 35: /timezone command

**Files:**
- Create: `src/bot/commands/timezone.ts`

- [ ] **Step 1: Write handler**

```typescript
// src/bot/commands/timezone.ts
import type { DatabaseService } from '../../database/index.ts';
import type { User } from '../../database/types.ts';
import { getTimezoneDisplay } from '../../services/timezone/timezone-service.ts';
import { timezoneMethodKeyboard, timezoneManualKeyboard } from '../keyboards.ts';
import { setSession } from '../types.ts';

export async function handleTimezone(ctx: any, db: DatabaseService): Promise<void> {
  const user = ctx.dbUser as User;
  const lang = user.language as 'en' | 'ru';
  const display = getTimezoneDisplay(user.timezone);

  const text = lang === 'ru'
    ? `🌍 Текущий часовой пояс: ${display}\n\nИзменить?`
    : `🌍 Current timezone: ${display}\n\nChange it?`;

  setSession(user.telegram_id, 'tz:select', { returnTo: 'settings' });

  await ctx.send(text, { reply_markup: timezoneManualKeyboard() });
  await ctx.send(
    lang === 'ru' ? 'Или отправьте геолокацию:' : 'Or share your location:',
    { reply_markup: timezoneMethodKeyboard(lang) },
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/bot/commands/timezone.ts && git commit -m "feat: add /timezone command"
```

---

### Task 36: /settings command

**Files:**
- Create: `src/bot/commands/settings.ts`

- [ ] **Step 1: Write handler**

```typescript
// src/bot/commands/settings.ts
import type { User } from '../../database/types.ts';
import { getTimezoneDisplay } from '../../services/timezone/timezone-service.ts';

export async function handleSettings(ctx: any): Promise<void> {
  const user = ctx.dbUser as User;
  const lang = user.language as 'en' | 'ru';
  const tzDisplay = getTimezoneDisplay(user.timezone);
  const country = user.country_code ?? (lang === 'ru' ? 'не задана' : 'not set');

  const text = lang === 'ru'
    ? `⚙️ <b>Настройки</b>\n\n🌍 Часовой пояс: ${tzDisplay}\n🗣 Язык: Русский\n🏳️ Страна: ${country}\n\n/timezone — изменить пояс\n/help — все команды`
    : `⚙️ <b>Settings</b>\n\n🌍 Timezone: ${tzDisplay}\n🗣 Language: English\n🏳️ Country: ${country}\n\n/timezone — change timezone\n/help — all commands`;

  await ctx.send(text, { parse_mode: 'HTML' });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/bot/commands/settings.ts && git commit -m "feat: add /settings command"
```

---

## Chunk 10: Import/Export

### Task 37: ICS parser + tests

**Files:**
- Create: `src/services/ics/parser.ts`
- Create: `test/services/ics/parser.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// test/services/ics/parser.test.ts
import { describe, test, expect } from 'bun:test';
import { parseIcs } from '../../../src/services/ics/parser.ts';

const SAMPLE_ICS = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
DTSTART:20260312T150000Z
DTEND:20260312T160000Z
SUMMARY:Dentist
DESCRIPTION:Annual checkup
LOCATION:Clinic
END:VEVENT
BEGIN:VEVENT
DTSTART:20260315T090000Z
SUMMARY:Meeting
END:VEVENT
END:VCALENDAR`;

describe('parseIcs', () => {
  test('parses events from ICS string', () => {
    const events = parseIcs(SAMPLE_ICS);
    expect(events.length).toBe(2);
  });

  test('extracts event fields correctly', () => {
    const events = parseIcs(SAMPLE_ICS);
    expect(events[0]!.title).toBe('Dentist');
    expect(events[0]!.start_at).toContain('2026-03-12T15:00:00');
    expect(events[0]!.end_at).toContain('2026-03-12T16:00:00');
    expect(events[0]!.description).toBe('Annual checkup');
    expect(events[0]!.location).toBe('Clinic');
  });

  test('handles events without end time', () => {
    const events = parseIcs(SAMPLE_ICS);
    expect(events[1]!.title).toBe('Meeting');
    expect(events[1]!.end_at).toBeUndefined();
  });

  test('returns empty array for invalid ICS', () => {
    expect(parseIcs('not an ics file')).toEqual([]);
  });

  test('converts TZID timestamps to UTC', () => {
    const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
DTSTART;TZID=Europe/Berlin:20260312T150000
DTEND;TZID=Europe/Berlin:20260312T160000
SUMMARY:Berlin Meeting
END:VEVENT
END:VCALENDAR`;
    const events = parseIcs(ics);
    expect(events.length).toBe(1);
    // Berlin is UTC+1 in March → 15:00 Berlin = 14:00 UTC
    expect(events[0]!.start_at).toContain('2026-03-12T14:00:00');
    expect(events[0]!.end_at).toContain('2026-03-12T15:00:00');
  });

  test('handles non-Z timestamps without TZID as UTC', () => {
    const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
DTSTART:20260312T150000
SUMMARY:Floating time
END:VEVENT
END:VCALENDAR`;
    const events = parseIcs(ics);
    expect(events[0]!.start_at).toBe('2026-03-12T15:00:00Z');
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

```bash
bun test test/services/ics/parser.test.ts
```

- [ ] **Step 3: Write implementation**

```typescript
// src/services/ics/parser.ts
import { TZDate } from '@date-fns/tz';

export interface IcsEvent {
  title: string;
  start_at: string;
  end_at?: string;
  description?: string;
  location?: string;
  recurrence_rule?: string;
}

/**
 * Parse ICS (iCalendar) string into event objects.
 * Minimal parser — handles VEVENT blocks with basic properties.
 */
export function parseIcs(icsContent: string): IcsEvent[] {
  const events: IcsEvent[] = [];
  const lines = unfoldIcsLines(icsContent);

  let inEvent = false;
  let current: Partial<IcsEvent> = {};

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      inEvent = true;
      current = {};
      continue;
    }
    if (line === 'END:VEVENT') {
      inEvent = false;
      if (current.title && current.start_at) {
        events.push(current as IcsEvent);
      }
      continue;
    }
    if (!inEvent) continue;

    const [key, ...valueParts] = line.split(':');
    const value = valueParts.join(':'); // Re-join in case value contains ':'
    const keyParts = key!.split(';');
    const propName = keyParts[0];

    // Extract TZID parameter if present (e.g. DTSTART;TZID=Europe/Berlin:20260312T150000)
    const tzidParam = keyParts.find(p => p.startsWith('TZID='));
    const tzid = tzidParam ? tzidParam.slice(5) : undefined;

    switch (propName) {
      case 'SUMMARY':
        current.title = unescapeIcs(value);
        break;
      case 'DTSTART':
        current.start_at = icsDateToIso(value, tzid);
        break;
      case 'DTEND':
        current.end_at = icsDateToIso(value, tzid);
        break;
      case 'DESCRIPTION':
        current.description = unescapeIcs(value);
        break;
      case 'LOCATION':
        current.location = unescapeIcs(value);
        break;
      case 'RRULE':
        current.recurrence_rule = value;
        break;
    }
  }

  return events;
}

/** Unfold ICS line continuations (lines starting with space/tab) */
function unfoldIcsLines(content: string): string[] {
  return content
    .replace(/\r\n/g, '\n')
    .replace(/\n[ \t]/g, '') // Unfold continued lines
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0);
}

/**
 * Convert ICS date format to ISO 8601 UTC.
 * Handles: 20260312T150000Z (UTC), 20260312T150000 (with optional TZID), 20260312 (date-only)
 */
function icsDateToIso(icsDate: string, tzid?: string): string {
  const clean = icsDate.trim();
  if (clean.length === 8) {
    // Date only: YYYYMMDD — no timezone conversion needed
    return `${clean.slice(0, 4)}-${clean.slice(4, 6)}-${clean.slice(6, 8)}T00:00:00Z`;
  }
  if (clean.length >= 15) {
    const d = `${clean.slice(0, 4)}-${clean.slice(4, 6)}-${clean.slice(6, 8)}T${clean.slice(9, 11)}:${clean.slice(11, 13)}:${clean.slice(13, 15)}`;
    if (clean.endsWith('Z')) return `${d}Z`; // Already UTC
    if (tzid) {
      // Convert from local timezone to UTC using TZDate
      const localDate = new TZDate(d, tzid);
      return localDate.toISOString();
    }
    return `${d}Z`; // No timezone info — assume UTC as fallback
  }
  return clean;
}

function unescapeIcs(value: string): string {
  return value
    .replace(/\\n/g, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\\\/g, '\\');
}
```

- [ ] **Step 4: Run test — verify it passes**

```bash
bun test test/services/ics/parser.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/services/ics/parser.ts test/services/ics/parser.test.ts && git commit -m "feat: add ICS parser"
```

---

### Task 38: ICS generator + tests

**Files:**
- Create: `src/services/ics/generator.ts`
- Create: `test/services/ics/generator.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// test/services/ics/generator.test.ts
import { describe, test, expect } from 'bun:test';
import { generateIcs } from '../../../src/services/ics/generator.ts';
import type { CalendarEvent } from '../../../src/database/types.ts';

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 1, user_id: 123, title: 'Test Event', description: null, category: null,
    start_at: '2026-03-12T15:00:00Z', end_at: '2026-03-12T16:00:00Z',
    all_day: 0, timezone: 'UTC', location: null, recurrence_rule: null,
    recurrence_end_at: null, parent_event_id: null, original_start_at: null,
    is_cancelled: 0, reminder_overrides: null, google_event_id: null,
    google_calendar_id: null, last_synced_at: null, created_at: '', updated_at: '',
    ...overrides,
  };
}

describe('generateIcs', () => {
  test('generates valid ICS with VCALENDAR wrapper', () => {
    const ics = generateIcs([makeEvent()]);
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('END:VCALENDAR');
    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics).toContain('END:VEVENT');
  });

  test('includes event fields', () => {
    const ics = generateIcs([makeEvent({
      title: 'Dentist',
      description: 'Checkup',
      location: 'Clinic',
    })]);
    expect(ics).toContain('SUMMARY:Dentist');
    expect(ics).toContain('DESCRIPTION:Checkup');
    expect(ics).toContain('LOCATION:Clinic');
    expect(ics).toContain('DTSTART:20260312T150000Z');
    expect(ics).toContain('DTEND:20260312T160000Z');
  });

  test('includes RRULE if present', () => {
    const ics = generateIcs([makeEvent({ recurrence_rule: 'FREQ=DAILY' })]);
    expect(ics).toContain('RRULE:FREQ=DAILY');
  });

  test('handles multiple events', () => {
    const ics = generateIcs([makeEvent(), makeEvent({ id: 2, title: 'Other' })]);
    const count = (ics.match(/BEGIN:VEVENT/g) || []).length;
    expect(count).toBe(2);
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

```bash
bun test test/services/ics/generator.test.ts
```

- [ ] **Step 3: Write implementation**

```typescript
// src/services/ics/generator.ts
import type { CalendarEvent } from '../../database/types.ts';

/**
 * Generate ICS (iCalendar) string from events
 */
export function generateIcs(events: CalendarEvent[]): string {
  const vevents = events.map(eventToVevent).join('\n');
  return `BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//HyperCalendarBot//EN\nCALSCALE:GREGORIAN\n${vevents}\nEND:VCALENDAR`;
}

function eventToVevent(event: CalendarEvent): string {
  const lines: string[] = ['BEGIN:VEVENT'];
  // Include start_at in UID to make expanded recurring occurrences unique
  const uidDate = event.start_at.replace(/[-:T.Z]/g, '').slice(0, 14);
  lines.push(`UID:${event.id}-${uidDate}@hypercalendarbot`);
  lines.push(`DTSTART:${isoToIcsDate(event.start_at)}`);
  if (event.end_at) lines.push(`DTEND:${isoToIcsDate(event.end_at)}`);
  lines.push(`SUMMARY:${escapeIcs(event.title)}`);
  if (event.description) lines.push(`DESCRIPTION:${escapeIcs(event.description)}`);
  if (event.location) lines.push(`LOCATION:${escapeIcs(event.location)}`);
  if (event.recurrence_rule) lines.push(`RRULE:${event.recurrence_rule}`);
  lines.push(`CREATED:${isoToIcsDate(event.created_at)}`);
  lines.push('END:VEVENT');
  return lines.join('\n');
}

function isoToIcsDate(iso: string): string {
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function escapeIcs(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}
```

- [ ] **Step 4: Run test — verify it passes**

```bash
bun test test/services/ics/generator.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/services/ics/generator.ts test/services/ics/generator.test.ts && git commit -m "feat: add ICS generator"
```

---

### Task 39: /import command

**Files:**
- Create: `src/bot/commands/import.ts`

- [ ] **Step 1: Write handler**

```typescript
// src/bot/commands/import.ts
import type { EventService } from '../../services/event/event-service.ts';
import type { User } from '../../database/types.ts';
import { parseIcs } from '../../services/ics/parser.ts';
import { t } from '../../config/constants.ts';
import { setSession } from '../types.ts';

export async function handleImport(ctx: any, eventService: EventService): Promise<void> {
  const user = ctx.dbUser as User;
  const lang = user.language as 'en' | 'ru';
  setSession(user.telegram_id, 'import:waiting');
  await ctx.send(lang === 'ru'
    ? 'Отправьте .ics файл.'
    : 'Send an .ics file.');
}

/**
 * Handle received document for import (called from message handler)
 */
export async function handleImportFile(
  ctx: any,
  eventService: EventService,
  user: User,
  fileContent: string,
): Promise<void> {
  const lang = user.language as 'en' | 'ru';
  const parsed = parseIcs(fileContent);

  if (parsed.length === 0) {
    await ctx.send(lang === 'ru' ? 'Не найдено событий в файле.' : 'No events found in file.');
    return;
  }

  let imported = 0;
  for (const icsEvent of parsed) {
    eventService.createEvent({
      user_id: user.telegram_id,
      title: icsEvent.title,
      start_at: icsEvent.start_at,
      end_at: icsEvent.end_at,
      description: icsEvent.description,
      location: icsEvent.location,
      timezone: user.timezone,
      recurrence_rule: icsEvent.recurrence_rule,
    });
    imported++;
  }

  await ctx.send(lang === 'ru'
    ? `✅ Импортировано ${imported} событий.`
    : `✅ Imported ${imported} events.`);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/bot/commands/import.ts && git commit -m "feat: add /import command"
```

---

### Task 40: /export command

**Files:**
- Create: `src/bot/commands/export.ts`

- [ ] **Step 1: Write handler**

```typescript
// src/bot/commands/export.ts
import type { EventService } from '../../services/event/event-service.ts';
import type { User, CalendarEvent } from '../../database/types.ts';
import { generateIcs } from '../../services/ics/generator.ts';
import { getNDayRangeUtc } from '../../utils/date.ts';

export async function handleExport(ctx: any, eventService: EventService): Promise<void> {
  const user = ctx.dbUser as User;
  const lang = user.language as 'en' | 'ru';

  // Export next 365 days of events — use occurrence dates, not template dates
  const { start, end } = getNDayRangeUtc(new Date(), 365, user.timezone);
  const occurrences = eventService.getEventsInRange(user.telegram_id, start, end);
  const events: CalendarEvent[] = occurrences.map(o => ({
    ...o.event,
    // Override with concrete occurrence dates (critical for recurring events)
    start_at: o.occurrence_start,
    end_at: o.occurrence_end ?? o.event.end_at,
    // Strip recurrence_rule — we export expanded occurrences, not templates
    recurrence_rule: null,
    recurrence_end_at: null,
  }));

  if (events.length === 0) {
    await ctx.send(lang === 'ru' ? 'Нет событий для экспорта.' : 'No events to export.');
    return;
  }

  const ics = generateIcs(events);
  const buffer = Buffer.from(ics, 'utf-8');

  await ctx.sendDocument({
    document: { filename: 'calendar.ics', value: buffer },
    caption: lang === 'ru'
      ? `📤 Экспортировано ${events.length} событий.`
      : `📤 Exported ${events.length} events.`,
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/bot/commands/export.ts && git commit -m "feat: add /export command"
```

---

## Chunk 11: Handlers & Entry Point

### Task 41: Callback handler

**Files:**
- Create: `src/bot/handlers/callback.handler.ts`

- [ ] **Step 1: Write callback router**

```typescript
// src/bot/handlers/callback.handler.ts
import type { DatabaseService } from '../../database/index.ts';
import type { EventService } from '../../services/event/event-service.ts';
import type { User } from '../../database/types.ts';
import { CB } from '../../config/constants.ts';
import { handleOnboardingCallback } from '../commands/start.ts';
import { handleEditCallback, handleEditFieldCallback } from '../commands/edit.ts';
import { handleDeleteCallback, handleDeleteConfirmCallback } from '../commands/delete.ts';
import { handleMonth } from '../commands/month.ts';
import { formatEventDetail } from '../../services/event/formatters.ts';
import { eventActionsKeyboard, editFieldKeyboard } from '../keyboards.ts';
import { cmdLogger } from '../../utils/logger.ts';

/**
 * Route all inline keyboard callbacks.
 * Callback data format: "prefix:payload" or "prefix:p1:p2"
 */
export function createCallbackHandler(db: DatabaseService, eventService: EventService) {
  return async (ctx: any) => {
    const data = ctx.data as string;
    if (!data) return;

    const user = ctx.dbUser as User;
    const parts = data.split(':');
    const action = parts[0]!;
    const payload = parts.slice(1).join(':');

    try {
      // Onboarding actions
      if ([CB.ONBOARD_LANG, CB.ONBOARD_TZ_REGION, CB.ONBOARD_TZ, CB.ONBOARD_COUNTRY, CB.ONBOARD_AGENDA].includes(action)) {
        return handleOnboardingCallback(ctx, db, action, payload);
      }

      // Event view
      if (action === CB.EVENT_VIEW) {
        if (payload === 'cancel') return ctx.editText('OK');
        const eventId = Number(payload);
        const event = eventService.getEvent(eventId, user.telegram_id);
        if (!event) return ctx.answer({ text: 'Not found' });
        const detail = formatEventDetail(event, user.timezone, user.language);
        return ctx.editText(detail, {
          parse_mode: 'HTML',
          reply_markup: eventActionsKeyboard(eventId, user.language as 'en' | 'ru'),
        });
      }

      // Event edit
      if (action === CB.EVENT_EDIT) {
        if (payload === 'cancel') return ctx.editText('OK');
        return handleEditCallback(ctx, eventService, user, Number(payload));
      }

      // Edit field
      if (action === CB.EDIT_FIELD) {
        const [eidStr, field] = payload.split(':');
        if (field === 'cancel' || eidStr === 'cancel') return ctx.editText('OK');
        return handleEditFieldCallback(ctx, eventService, user, Number(eidStr), field!);
      }

      // Event delete
      if (action === CB.EVENT_DELETE) {
        if (payload === 'cancel') return ctx.editText('OK');
        return handleDeleteCallback(ctx, eventService, user, Number(payload));
      }

      // Delete confirm
      if (action === CB.EVENT_DELETE_CONFIRM) {
        return handleDeleteConfirmCallback(ctx, eventService, user, Number(payload));
      }

      // Recurring event edit/delete choice (this / future / all)
      if (action === CB.EVENT_RECURRENCE) {
        const [eidStr, mode] = payload.split(':');
        const eventId = Number(eidStr);
        const lang = (user.language ?? 'en') as 'en' | 'ru';

        if (mode === 'all') {
          // Edit the template (all occurrences)
          return ctx.editText(
            lang === 'ru' ? 'Что изменить?' : 'What to edit?',
            { reply_markup: editFieldKeyboard(eventId, lang) },
          );
        }

        // 'this' and 'future' require occurrence-level context — not yet implemented
        await ctx.answer({
          text: lang === 'ru' ? 'Будет в следующей версии' : 'Coming in next version',
        });
        return;
      }

      // Month navigation
      if (action === CB.MONTH_NAV) {
        return handleMonth(ctx, eventService, payload);
      }

      cmdLogger.warn({ action, payload }, 'Unknown callback action');
      await ctx.answer();
    } catch (error) {
      cmdLogger.error({ error: String(error), action }, 'Callback handler error');
      await ctx.answer({ text: 'Error' });
    }
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/bot/handlers/callback.handler.ts && git commit -m "feat: add callback handler router"
```

---

### Task 42: Message handler

**Files:**
- Create: `src/bot/handlers/message.handler.ts`

- [ ] **Step 1: Write message handler**

```typescript
// src/bot/handlers/message.handler.ts
import type { DatabaseService } from '../../database/index.ts';
import type { EventService } from '../../services/event/event-service.ts';
import type { User } from '../../database/types.ts';
import { getSession } from '../types.ts';
import { handleAddWizardStep } from '../commands/add.ts';
import { handleEditWizardStep } from '../commands/edit.ts';
import { handleOnboardingLocation } from '../commands/start.ts';
import { handleImportFile } from '../commands/import.ts';
import { resolveTimezone, getTimezoneDisplay } from '../../services/timezone/timezone-service.ts';
import { setSession, clearSession } from '../types.ts';

/**
 * Handle free-text messages and file uploads.
 * Routes to active wizard sessions or falls back to "use /help".
 */
export function createMessageHandler(db: DatabaseService, eventService: EventService) {
  return async (ctx: any) => {
    const user = ctx.dbUser as User | undefined;
    if (!user) return;

    // Handle location (for onboarding or /timezone)
    if (ctx.location) {
      const { latitude, longitude } = ctx.location;
      const session = getSession(user.telegram_id);

      if (session?.step.startsWith('onboard:tz')) {
        return handleOnboardingLocation(ctx, db, latitude, longitude);
      }

      if (session?.step === 'tz:select') {
        const tz = resolveTimezone(latitude, longitude);
        db.users.update(user.telegram_id, { timezone: tz });
        clearSession(user.telegram_id);
        const lang = user.language as 'en' | 'ru';
        await ctx.send(
          `✅ ${getTimezoneDisplay(tz)}`,
          { reply_markup: { remove_keyboard: true } },
        );
        return;
      }

      return; // Ignore unsolicited location
    }

    // Handle document (for /import)
    if (ctx.document) {
      const session = getSession(user.telegram_id);
      if (session?.step === 'import:waiting') {
        clearSession(user.telegram_id);
        try {
          const file = await ctx.getFile();
          const response = await fetch(`https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`);
          const content = await response.text();
          return handleImportFile(ctx, eventService, user, content);
        } catch {
          const lang = user.language as 'en' | 'ru';
          await ctx.send(lang === 'ru' ? 'Не удалось прочитать файл.' : 'Failed to read file.');
        }
        return;
      }
    }

    const text = ctx.text as string | undefined;
    if (!text) return;

    // Route to active wizard sessions
    if (await handleAddWizardStep(ctx, eventService, user, text)) return;
    if (await handleEditWizardStep(ctx, eventService, user, text)) return;

    // No active session, no command — hint
    const lang = user.language as 'en' | 'ru';
    await ctx.send(lang === 'ru'
      ? 'Не понимаю. Используйте /help для списка команд.'
      : "I don't understand. Use /help for commands.");
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/bot/handlers/message.handler.ts && git commit -m "feat: add message handler with wizard routing"
```

---

### Task 43: Wire up bot factory with all commands

**Files:**
- Modify: `src/bot/index.ts`

- [ ] **Step 1: Update bot factory to register all commands and handlers**

Replace `src/bot/index.ts` with the full version:

```typescript
// src/bot/index.ts
import { Bot } from 'gramio';
import type { DatabaseService } from '../database/index.ts';
import { EventService } from '../services/event/event-service.ts';
import { createUserResolver } from './middleware/user-resolver.ts';
import { RateLimiter } from './middleware/rate-limiter.ts';
import { RATE_LIMIT, t } from '../config/constants.ts';
import { botLogger } from '../utils/logger.ts';

import { handlePing } from './commands/ping.ts';
import { handleHelp } from './commands/help.ts';
import { handleStart } from './commands/start.ts';
import { handleToday } from './commands/today.ts';
import { handleTomorrow } from './commands/tomorrow.ts';
import { handleWeek } from './commands/week.ts';
import { handleMonth } from './commands/month.ts';
import { handleAdd } from './commands/add.ts';
import { handleEdit } from './commands/edit.ts';
import { handleDelete } from './commands/delete.ts';
import { handleSearch } from './commands/search.ts';
import { handleFree } from './commands/free.ts';
import { handleTimezone } from './commands/timezone.ts';
import { handleSettings } from './commands/settings.ts';
import { handleImport } from './commands/import.ts';
import { handleExport } from './commands/export.ts';
import { createCallbackHandler } from './handlers/callback.handler.ts';
import { createMessageHandler } from './handlers/message.handler.ts';

export function createBot(token: string, db: DatabaseService) {
  const eventService = new EventService(db.events, db.reminders);
  const rateLimiter = new RateLimiter({
    perMinute: RATE_LIMIT.MESSAGES_PER_MINUTE,
    cooldownMs: RATE_LIMIT.COOLDOWN_MS,
  });

  const bot = new Bot(token)
    .derive(createUserResolver(db))
    .use(async (context, next) => {
      const userId = context.from?.id;
      if (!userId) return next();
      const { allowed, firstBlock } = rateLimiter.checkWithWarning(userId);
      if (!allowed) {
        if (firstBlock && 'send' in context) {
          const lang = ((context as any).dbUser?.language ?? 'en') as 'en' | 'ru';
          await (context as any).send(t(lang).rate_limited);
        }
        return;
      }
      return next();
    })
    // Commands
    .command('start', (ctx) => handleStart(ctx, db))
    .command('ping', (ctx) => handlePing(ctx))
    .command('help', (ctx) => handleHelp(ctx))
    .command('today', (ctx) => handleToday(ctx, eventService))
    .command('tomorrow', (ctx) => handleTomorrow(ctx, eventService))
    .command('week', (ctx) => handleWeek(ctx, eventService))
    .command('month', (ctx) => handleMonth(ctx, eventService))
    .command('add', (ctx) => handleAdd(ctx, eventService))
    .command('edit', (ctx) => handleEdit(ctx, eventService))
    .command('delete', (ctx) => handleDelete(ctx, eventService))
    .command('search', (ctx) => handleSearch(ctx, eventService))
    .command('free', (ctx) => handleFree(ctx, eventService))
    .command('timezone', (ctx) => handleTimezone(ctx, db))
    .command('settings', (ctx) => handleSettings(ctx))
    .command('import', (ctx) => handleImport(ctx, eventService))
    .command('export', (ctx) => handleExport(ctx, eventService))
    // Callback queries
    .on('callback_query', createCallbackHandler(db, eventService))
    // Free-text messages
    .on('message', createMessageHandler(db, eventService))
    // Error handler
    .onError(({ context, kind, error }) => {
      botLogger.error({ kind, error: String(error) }, 'Bot error');
      try {
        if (context && 'send' in context) {
          const errLang = ((context as any).dbUser?.language ?? 'en') as 'en' | 'ru';
          (context as any).send(t(errLang).something_wrong);
        }
      } catch {}
    });

  return { bot, eventService, db };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/bot/index.ts && git commit -m "feat: wire up all commands and handlers in bot factory"
```

---

### Task 44: Entry point

**Files:**
- Modify: `index.ts` (root) — move to `src/index.ts`

- [ ] **Step 1: Write entry point**

```typescript
// src/index.ts
import { loadConfig } from './config/env.ts';
import { createDatabase } from './database/index.ts';
import { createBot } from './bot/index.ts';
import { botLogger } from './utils/logger.ts';

const config = loadConfig();
const db = createDatabase(config.DATABASE_PATH);
const { bot } = createBot(config.BOT_TOKEN, db);

// Register bot commands in Telegram menu — both languages
const COMMANDS_EN = [
  { command: 'today', description: "Today's events" },
  { command: 'tomorrow', description: "Tomorrow's events" },
  { command: 'week', description: '7-day overview' },
  { command: 'month', description: 'Monthly calendar' },
  { command: 'add', description: 'Create event' },
  { command: 'edit', description: 'Edit event' },
  { command: 'delete', description: 'Delete event' },
  { command: 'search', description: 'Search events' },
  { command: 'free', description: 'Find free slots' },
  { command: 'timezone', description: 'Change timezone' },
  { command: 'settings', description: 'Settings' },
  { command: 'import', description: 'Import .ics' },
  { command: 'export', description: 'Export .ics' },
  { command: 'help', description: 'Help' },
];

const COMMANDS_RU = [
  { command: 'today', description: 'События сегодня' },
  { command: 'tomorrow', description: 'События завтра' },
  { command: 'week', description: 'Обзор на 7 дней' },
  { command: 'month', description: 'Месячный календарь' },
  { command: 'add', description: 'Создать событие' },
  { command: 'edit', description: 'Редактировать событие' },
  { command: 'delete', description: 'Удалить событие' },
  { command: 'search', description: 'Поиск событий' },
  { command: 'free', description: 'Свободные слоты' },
  { command: 'timezone', description: 'Часовой пояс' },
  { command: 'settings', description: 'Настройки' },
  { command: 'import', description: 'Импорт .ics' },
  { command: 'export', description: 'Экспорт .ics' },
  { command: 'help', description: 'Справка' },
];

bot.onStart(async ({ info }) => {
  // Default (English)
  await bot.api.setMyCommands({ commands: COMMANDS_EN });
  // Russian language scope
  await bot.api.setMyCommands({
    commands: COMMANDS_RU,
    language_code: 'ru',
  });
  botLogger.info({ username: info.username }, 'Bot started');
});

// Graceful shutdown
process.on('SIGINT', async () => {
  botLogger.info('Shutting down...');
  await bot.stop();
  db.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await bot.stop();
  db.close();
  process.exit(0);
});

// Start polling
bot.start({ dropPendingUpdates: true });
```

- [ ] **Step 2: Update package.json module field**

In `package.json`, change `"module": "index.ts"` to `"module": "src/index.ts"`.

- [ ] **Step 3: Remove old root index.ts**

```bash
rm index.ts
```

- [ ] **Step 4: Commit**

```bash
git add src/index.ts package.json && git rm index.ts && git commit -m "feat: add entry point with bot startup and graceful shutdown"
```

---

## Chunk 12: Smoke Test & Verification

### Task 45: Run all tests

- [ ] **Step 1: Run full test suite**

```bash
bun test
```

Expected: all tests pass (config, schema, repositories, services, formatters, ICS)

- [ ] **Step 2: Fix any import/type errors**

If tests fail due to import paths or missing types, fix them.

- [ ] **Step 3: Start bot and verify basic flow**

```bash
bun --hot src/index.ts
```

In Telegram:
1. Send `/start` — should show language selection
2. Send `/ping` — should respond with "pong (Xms)"
3. Send `/help` — should show command list
4. Send `/add Test tomorrow 15:00` — should create event
5. Send `/today` — should show today's events (or empty)
6. Send `/week` — should show 7-day overview
7. Send `/settings` — should show current settings

- [ ] **Step 4: Final commit**

```bash
git add -A && git commit -m "chore: fix any remaining issues from smoke test"
```

---

## Summary

| Chunk | Tasks | What it builds |
|-------|-------|----------------|
| 1 | 1–4 | Project setup, config, logger, constants |
| 2 | 5–8 | Database types, migrations, DatabaseService |
| 3 | 9–11 | User, Event, Reminder repositories |
| 4 | 12–17 | Date utils, timezone, recurrence, event service, formatters |
| 5 | 18–21 | Bot types, middleware, bot factory |
| 6 | 22–24 | Keyboards, /ping, /help |
| 7 | 25–29 | Onboarding, /today, /tomorrow, /week, /month |
| 8 | 30–32 | /add, /edit, /delete |
| 9 | 33–36 | /search, /free, /timezone, /settings |
| 10 | 37–40 | ICS parser/generator, /import, /export |
| 11 | 41–44 | Callback handler, message handler, entry point |
| 12 | 45 | Smoke test & verification |

**Total:** 45 tasks, 12 chunks. Chunks 1–4 are parallelizable (no bot dependency). Chunks 5–11 are sequential (bot infrastructure → commands → handlers → entry point).
