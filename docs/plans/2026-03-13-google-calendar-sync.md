# Google Calendar Sync Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bidirectional Google Calendar sync — OAuth, pull/push, conflict resolution, webhooks (conditional on PUBLIC_DOMAIN), disconnect flow.

**Architecture:** OAuth 2.0 via `googleapis` npm package. Refresh tokens encrypted with AES-256-GCM in SQLite. Sync jobs run via BullMQ (`google-sync` queue). Two modes: webhook (PUBLIC_DOMAIN set) vs polling-only (cron every 15min). Redis for OAuth state + BullMQ.

**Tech Stack:** googleapis, bullmq, bun:sqlite, Bun.serve, AES-256-GCM (node:crypto)

### Design Decisions (spec section 14 open questions)

1. **Recurring events**: store masters, expand for display only (same as local model)
2. **Default write calendar**: primary Google calendar if connected; user can change in `/calendars`
3. **Event deletion**: local delete → also delete from Google (push-event delete job)
4. **Timezone handling**: UTC internally, convert via user's configured timezone (same as local model)
5. **Webhook domain verification**: documented in deployment guide, not automated

### Known deviations from spec

- **Single BullMQ queue** (`google-sync`) instead of two (`google-sync` + `google-watch`). Watch jobs are just different types in the same queue — no need for separate concurrency/retry config.
- **`google_calendar_id`, `google_event_id`, `last_synced_at`** already exist on events table (migration 002). Migration 007 only adds `google_etag`, `sync_status`, `sync_version`.
- **Onboarding re-prompt** (7-day "Maybe Later" timer) deferred to v2 — v1 shows prompt once, dismisses permanently.

---

## File Structure

### New Files
| File | Responsibility |
|------|----------------|
| `src/utils/crypto.ts` | AES-256-GCM encrypt/decrypt |
| `src/utils/redis.ts` | Shared `parseRedisUrl` utility |
| `src/services/google/oauth.ts` | OAuth2 client, auth URL, token exchange, getAuthClient |
| `src/services/google/calendar-api.ts` | Google Calendar API wrapper (list calendars, CRUD events, watch) |
| `src/services/google/event-mapper.ts` | localToGoogle / googleToLocal conversion |
| `src/services/google/sync-service.ts` | initialSync, incrementalPull, pushEvent, resolveConflict |
| `src/web/server.ts` | Bun.serve: OAuth callback + webhook routes |
| `src/web/oauth-callback.ts` | Handle GET /oauth/google/callback |
| `src/web/webhook-handler.ts` | Handle POST /webhooks/google-calendar |
| `src/bot/commands/connect-google.ts` | /connect_google command handler |
| `src/bot/commands/disconnect-google.ts` | /disconnect_google command handler |
| `src/bot/commands/calendars.ts` | Calendar picker inline keyboard UI |
| `src/database/repositories/google-sync.repository.ts` | google_sync_state + sync_log CRUD |
| `src/database/repositories/google-calendar.repository.ts` | google_calendars + google_watch_channels CRUD |
| `src/services/google/sync-queue.ts` | BullMQ queue + worker for google-sync jobs |
| `src/services/google/sync-cron.ts` | Periodic incremental pull (every 15min) |
| `src/services/google/watch-renewal-cron.ts` | Renew expiring watch channels (every 6h) |
| `src/services/google/cleanup-cron.ts` | Daily sync_log pruning + dead channel cleanup |
| `test/utils/crypto.test.ts` | Crypto tests |
| `test/services/google/event-mapper.test.ts` | Event mapper tests |
| `test/services/google/sync-service.test.ts` | Sync service tests |
| `test/database/repositories/google-sync.repository.test.ts` | Google sync repo tests |
| `test/database/repositories/google-calendar.repository.test.ts` | Google calendar repo tests |
| `test/web/oauth-callback.test.ts` | OAuth callback tests |
| `test/web/webhook-handler.test.ts` | Webhook handler tests |

### Modified Files
| File | Changes |
|------|---------|
| `src/config/env.ts` | Add GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI, OAUTH_SERVER_PORT, ENCRYPTION_KEY, REDIS_URL, PUBLIC_DOMAIN (optional) |
| `src/config/constants.ts` | Add CB.GCAL prefix, i18n strings for Google sync |
| `src/database/migrations.ts` | Add migration 007 (google_sync_state, google_calendars, google_watch_channels, events sync fields, sync_log) |
| `src/database/types.ts` | Add GoogleSyncState, GoogleCalendar, GoogleWatchChannel, SyncLog types; add sync fields to CalendarEvent |
| `src/database/index.ts` | Wire GoogleSyncRepository, GoogleCalendarRepository |
| `src/services/event/event-service.ts` | Trigger push sync on create/update/delete |
| `src/bot/index.ts` | Wire /connect_google, /disconnect_google, /calendars commands + calendar picker callbacks |
| `src/bot/handlers/callback.handler.ts` | Add CB.GCAL routing |
| `src/bot/commands/help.ts` | Add Google sync commands section |
| `src/index.ts` | Start web server, init google-sync queue, add commands to menu |
| `src/utils/logger.ts` | Add syncLogger, webLogger |

---

## Chunk 1: Foundation (env, crypto, migration, types, repositories)

### Task 1: Env config — add Google + Redis + web variables

**Files:**
- Modify: `src/config/env.ts`
- Test: `test/config/env.test.ts`

- [ ] **Step 1: Write failing test for new env vars**

```ts
// In test/config/env.test.ts — add tests:
test('REDIS_URL is optional (bot works without it)', () => {
  delete process.env.REDIS_URL;
  const config = loadConfig();
  expect(config.REDIS_URL).toBeUndefined();
});

test('throws when GOOGLE_CLIENT_ID set but REDIS_URL missing', () => {
  delete process.env.REDIS_URL;
  process.env.GOOGLE_CLIENT_ID = 'cid';
  expect(() => loadConfig()).toThrow('REDIS_URL is required when GOOGLE_CLIENT_ID is set');
});

test('throws when GOOGLE_CLIENT_ID set but ENCRYPTION_KEY missing', () => {
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.GOOGLE_CLIENT_ID = 'cid';
  process.env.GOOGLE_CLIENT_SECRET = 'csec';
  delete process.env.ENCRYPTION_KEY;
  expect(() => loadConfig()).toThrow('ENCRYPTION_KEY is required when GOOGLE_CLIENT_ID is set');
});

test('throws when ENCRYPTION_KEY is not 64 hex chars', () => {
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.GOOGLE_CLIENT_ID = 'cid';
  process.env.GOOGLE_CLIENT_SECRET = 'csec';
  process.env.ENCRYPTION_KEY = 'tooshort';
  expect(() => loadConfig()).toThrow('ENCRYPTION_KEY must be 64 hex characters');
});

test('loads all Google vars when present', () => {
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.GOOGLE_CLIENT_ID = 'cid';
  process.env.GOOGLE_CLIENT_SECRET = 'csec';
  process.env.ENCRYPTION_KEY = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
  process.env.OAUTH_SERVER_PORT = '3311';
  const config = loadConfig();
  expect(config.GOOGLE_CLIENT_ID).toBe('cid');
  expect(config.GOOGLE_CLIENT_SECRET).toBe('csec');
  expect(config.OAUTH_SERVER_PORT).toBe(3311);
});

test('PUBLIC_DOMAIN derives GOOGLE_REDIRECT_URI when not explicit', () => {
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.GOOGLE_CLIENT_ID = 'cid';
  process.env.GOOGLE_CLIENT_SECRET = 'csec';
  process.env.ENCRYPTION_KEY = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
  process.env.PUBLIC_DOMAIN = 'example.com';
  delete process.env.GOOGLE_REDIRECT_URI;
  const config = loadConfig();
  expect(config.GOOGLE_REDIRECT_URI).toBe('https://example.com/oauth/google/callback');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/config/env.test.ts`
Expected: FAIL — properties don't exist on EnvConfig

- [ ] **Step 3: Implement env changes**

Add to `EnvConfig` interface:
```ts
REDIS_URL?: string;
GOOGLE_CLIENT_ID?: string;
GOOGLE_CLIENT_SECRET?: string;
GOOGLE_REDIRECT_URI?: string;
OAUTH_SERVER_PORT?: number;
ENCRYPTION_KEY?: string;
PUBLIC_DOMAIN?: string;
```

Add to `loadConfig()`:
```ts
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || undefined;
const REDIS_URL = process.env.REDIS_URL || undefined;
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || undefined;
const PUBLIC_DOMAIN = process.env.PUBLIC_DOMAIN || undefined;

// Google sync requires Redis + encryption key
if (GOOGLE_CLIENT_ID) {
  if (!REDIS_URL) {
    throw new Error('REDIS_URL is required when GOOGLE_CLIENT_ID is set');
  }
  if (!ENCRYPTION_KEY) {
    throw new Error('ENCRYPTION_KEY is required when GOOGLE_CLIENT_ID is set');
  }
  if (!/^[0-9a-f]{64}$/i.test(ENCRYPTION_KEY)) {
    throw new Error('ENCRYPTION_KEY must be 64 hex characters (32 bytes for AES-256-GCM)');
  }
}

// Derive GOOGLE_REDIRECT_URI from PUBLIC_DOMAIN if not explicit
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI
  || (PUBLIC_DOMAIN ? `https://${PUBLIC_DOMAIN}/oauth/google/callback` : undefined);

return {
  // ...existing...
  REDIS_URL,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || undefined,
  GOOGLE_REDIRECT_URI,
  OAUTH_SERVER_PORT: process.env.OAUTH_SERVER_PORT ? Number(process.env.OAUTH_SERVER_PORT) : undefined,
  ENCRYPTION_KEY,
  PUBLIC_DOMAIN,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/config/env.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config/env.ts test/config/env.test.ts
git commit -m "feat: add Google, Redis, and web env config variables"
```

---

### Task 2: Crypto utility — AES-256-GCM encrypt/decrypt

**Files:**
- Create: `src/utils/crypto.ts`
- Create: `test/utils/crypto.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// test/utils/crypto.test.ts
import { describe, expect, test } from 'bun:test';
import { decrypt, encrypt } from '../../src/utils/crypto.ts';

describe('crypto', () => {
  const key = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'; // 64 hex chars

  test('encrypt returns iv:authTag:ciphertext format', () => {
    const encrypted = encrypt('hello world', key);
    const parts = encrypted.split(':');
    expect(parts.length).toBe(3);
  });

  test('decrypt reverses encrypt', () => {
    const plaintext = 'my-secret-refresh-token-12345';
    const encrypted = encrypt(plaintext, key);
    const decrypted = decrypt(encrypted, key);
    expect(decrypted).toBe(plaintext);
  });

  test('different encryptions produce different ciphertexts (random IV)', () => {
    const plaintext = 'same-text';
    const a = encrypt(plaintext, key);
    const b = encrypt(plaintext, key);
    expect(a).not.toBe(b);
  });

  test('decrypt with wrong key throws', () => {
    const encrypted = encrypt('secret', key);
    const wrongKey = 'b'.repeat(64);
    expect(() => decrypt(encrypted, wrongKey)).toThrow();
  });

  test('decrypt with tampered ciphertext throws', () => {
    const encrypted = encrypt('secret', key);
    const parts = encrypted.split(':');
    parts[2] = 'AAAA' + parts[2]!.slice(4);
    expect(() => decrypt(parts.join(':'), key)).toThrow();
  });

  test('handles empty string', () => {
    const encrypted = encrypt('', key);
    expect(decrypt(encrypted, key)).toBe('');
  });

  test('handles unicode', () => {
    const text = 'Привет мир 🌍';
    const encrypted = encrypt(text, key);
    expect(decrypt(encrypted, key)).toBe(text);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/utils/crypto.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement crypto.ts**

```ts
// src/utils/crypto.ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

export function encrypt(plaintext: string, hexKey: string): string {
  const key = Buffer.from(hexKey, 'hex');
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
}

export function decrypt(encoded: string, hexKey: string): string {
  const [ivB64, authTagB64, ciphertextB64] = encoded.split(':');
  const key = Buffer.from(hexKey, 'hex');
  const iv = Buffer.from(ivB64!, 'base64');
  const authTag = Buffer.from(authTagB64!, 'base64');
  const ciphertext = Buffer.from(ciphertextB64!, 'base64');

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/utils/crypto.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/utils/crypto.ts test/utils/crypto.test.ts
git commit -m "feat: add AES-256-GCM crypto utility for token encryption"
```

---

### Task 3: Database types — add Google sync types

**Files:**
- Modify: `src/database/types.ts`

- [ ] **Step 1: Add types**

Add to `src/database/types.ts`:
```ts
// ── Google Sync types ──

export type SyncStatus = 'local_only' | 'synced' | 'pending_push' | 'pending_pull' | 'conflict' | 'push_failed';
export type GoogleSyncStatusValue = 'active' | 'revoked' | 'expired';
export type GoogleAccessRole = 'owner' | 'writer' | 'reader' | 'freeBusyReader';

export interface GoogleSyncState {
  user_id: number;
  access_token: string | null;
  expires_at: string | null;
  scopes: string;
  status: GoogleSyncStatusValue;
  created_at: string;
  updated_at: string;
}

export interface GoogleCalendar {
  id: number;
  user_id: number;
  google_calendar_id: string;
  calendar_name: string;
  color: string | null;
  is_primary: number; // 0 | 1
  sync_enabled: number; // 0 | 1
  access_role: GoogleAccessRole;
  sync_token: string | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface GoogleWatchChannel {
  id: number;
  google_calendar_row_id: number;
  channel_id: string;
  resource_id: string;
  expiration: string;
  created_at: string;
}

export interface SyncLogEntry {
  id: number;
  user_id: number;
  event_id: number | null;
  google_event_id: string | null;
  direction: 'push' | 'pull';
  action: 'create' | 'update' | 'delete' | 'conflict_resolve';
  details: string | null;
  created_at: string;
}
```

Also add to `CalendarEvent` interface (after `last_synced_at`):
```ts
google_etag: string | null;
sync_status: SyncStatus;
sync_version: number;
```

And add to `UpdateEventData`:
```ts
google_calendar_id?: string | null;
google_event_id?: string | null;
google_etag?: string | null;
sync_status?: SyncStatus;
sync_version?: number;
last_synced_at?: string | null;
```

- [ ] **Step 2: Run existing tests to verify no regressions**

Run: `bun test`
Expected: All existing tests pass

- [ ] **Step 3: Commit**

```bash
git add src/database/types.ts
git commit -m "feat: add Google sync database types"
```

---

### Task 4: Migration 007 — Google sync tables + event sync fields

**Files:**
- Modify: `src/database/migrations.ts`
- Modify: `test/database/schema.test.ts`

- [ ] **Step 1: Write failing test**

Add to `test/database/schema.test.ts`:
```ts
test('migration 007 creates google sync tables and adds event sync fields', () => {
  // After all migrations run, check tables exist
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'google_%' OR name = 'sync_log'"
  ).all();
  const tableNames = tables.map((t: any) => t.name);
  expect(tableNames).toContain('google_sync_state');
  expect(tableNames).toContain('google_calendars');
  expect(tableNames).toContain('google_watch_channels');
  expect(tableNames).toContain('sync_log');

  // Check events table has new columns
  const cols = db.prepare("PRAGMA table_info('events')").all() as { name: string }[];
  const colNames = cols.map(c => c.name);
  expect(colNames).toContain('google_etag');
  expect(colNames).toContain('sync_status');
  expect(colNames).toContain('sync_version');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/database/schema.test.ts`
Expected: FAIL — tables don't exist

- [ ] **Step 3: Add migration 007**

```ts
// In src/database/migrations.ts, add to the array:
{
  name: '007_google_sync',
  up: (db) => {
    db.exec(`
      CREATE TABLE google_sync_state (
        user_id INTEGER PRIMARY KEY,
        access_token TEXT,
        expires_at TEXT,
        scopes TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'revoked', 'expired')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
      );

      CREATE TABLE google_calendars (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        google_calendar_id TEXT NOT NULL,
        calendar_name TEXT NOT NULL,
        color TEXT,
        is_primary INTEGER NOT NULL DEFAULT 0,
        sync_enabled INTEGER NOT NULL DEFAULT 1,
        access_role TEXT NOT NULL DEFAULT 'owner'
          CHECK (access_role IN ('owner', 'writer', 'reader', 'freeBusyReader')),
        sync_token TEXT,
        last_synced_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE,
        UNIQUE (user_id, google_calendar_id)
      );
      CREATE INDEX idx_google_calendars_user_id ON google_calendars(user_id);

      CREATE TABLE google_watch_channels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        google_calendar_row_id INTEGER NOT NULL,
        channel_id TEXT NOT NULL UNIQUE,
        resource_id TEXT NOT NULL,
        expiration TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (google_calendar_row_id) REFERENCES google_calendars(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_watch_channels_expiration ON google_watch_channels(expiration);

      CREATE TABLE sync_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        event_id INTEGER,
        google_event_id TEXT,
        direction TEXT NOT NULL CHECK (direction IN ('push', 'pull')),
        action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete', 'conflict_resolve')),
        details TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
      );
      CREATE INDEX idx_sync_log_user_created ON sync_log(user_id, created_at);
    `);

    // Add sync fields to events table
    db.exec(`ALTER TABLE events ADD COLUMN google_etag TEXT`);
    db.exec(`ALTER TABLE events ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'local_only'
      CHECK (sync_status IN ('local_only', 'synced', 'pending_push', 'pending_pull', 'conflict', 'push_failed'))`);
    db.exec(`ALTER TABLE events ADD COLUMN sync_version INTEGER NOT NULL DEFAULT 0`);

    // Unique index for google event lookup
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_events_google_cal_event
      ON events(google_calendar_id, google_event_id)
      WHERE google_event_id IS NOT NULL`);
  },
},
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/database/schema.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `bun test`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add src/database/migrations.ts test/database/schema.test.ts
git commit -m "feat: add migration 007 — Google sync tables and event sync fields"
```

---

### Task 5: GoogleSyncRepository

**Files:**
- Create: `src/database/repositories/google-sync.repository.ts`
- Create: `test/database/repositories/google-sync.repository.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// test/database/repositories/google-sync.repository.test.ts
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { GoogleSyncRepository } from '../../../src/database/repositories/google-sync.repository.ts';

describe('GoogleSyncRepository', () => {
  let db: Database;
  let repo: GoogleSyncRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.run('PRAGMA foreign_keys = ON');
    // Create minimal schema
    db.run(`CREATE TABLE users (
      telegram_id INTEGER PRIMARY KEY,
      username TEXT, first_name TEXT,
      language TEXT NOT NULL DEFAULT 'en',
      timezone TEXT NOT NULL DEFAULT 'UTC',
      country_code TEXT,
      google_refresh_token_enc TEXT,
      google_calendar_id TEXT,
      onboarding_completed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    db.run(`CREATE TABLE google_sync_state (
      user_id INTEGER PRIMARY KEY,
      access_token TEXT,
      expires_at TEXT,
      scopes TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'revoked', 'expired')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
    )`);
    db.run(`CREATE TABLE sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      event_id INTEGER,
      google_event_id TEXT,
      direction TEXT NOT NULL CHECK (direction IN ('push', 'pull')),
      action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete', 'conflict_resolve')),
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
    )`);
    db.run("INSERT INTO users (telegram_id, username) VALUES (42, 'alice')");
    repo = new GoogleSyncRepository(db);
  });

  test('upsertSyncState creates new record', () => {
    repo.upsertSyncState(42, 'calendar.readonly calendar.events');
    const state = repo.getSyncState(42);
    expect(state).not.toBeNull();
    expect(state!.status).toBe('active');
    expect(state!.scopes).toBe('calendar.readonly calendar.events');
  });

  test('upsertSyncState updates existing record', () => {
    repo.upsertSyncState(42, 'scope1');
    repo.upsertSyncState(42, 'scope1 scope2');
    const state = repo.getSyncState(42);
    expect(state!.scopes).toBe('scope1 scope2');
  });

  test('updateAccessToken stores token', () => {
    repo.upsertSyncState(42, 'scopes');
    repo.updateAccessToken(42, 'token123', '2026-03-14T00:00:00Z');
    const state = repo.getSyncState(42);
    expect(state!.access_token).toBe('token123');
    expect(state!.expires_at).toBe('2026-03-14T00:00:00Z');
  });

  test('markRevoked sets status', () => {
    repo.upsertSyncState(42, 'scopes');
    repo.markRevoked(42);
    const state = repo.getSyncState(42);
    expect(state!.status).toBe('revoked');
  });

  test('deleteSyncState removes record', () => {
    repo.upsertSyncState(42, 'scopes');
    repo.deleteSyncState(42);
    expect(repo.getSyncState(42)).toBeNull();
  });

  test('logSync creates sync log entry', () => {
    repo.logSync({ user_id: 42, event_id: 1, google_event_id: 'g1', direction: 'push', action: 'create' });
    const logs = repo.getRecentLogs(42, 10);
    expect(logs.length).toBe(1);
    expect(logs[0]!.direction).toBe('push');
    expect(logs[0]!.action).toBe('create');
  });

  test('pruneOldLogs removes entries older than N days', () => {
    repo.logSync({ user_id: 42, direction: 'push', action: 'create' });
    // Manually backdate
    db.run("UPDATE sync_log SET created_at = datetime('now', '-31 days')");
    repo.pruneOldLogs(30);
    expect(repo.getRecentLogs(42, 10).length).toBe(0);
  });

  test('getActiveUsers returns users with active status', () => {
    repo.upsertSyncState(42, 'scopes');
    const users = repo.getActiveUsers();
    expect(users.length).toBe(1);
    expect(users[0]).toBe(42);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/database/repositories/google-sync.repository.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement GoogleSyncRepository**

```ts
// src/database/repositories/google-sync.repository.ts
import type { Database } from 'bun:sqlite';
import type { GoogleSyncState, SyncLogEntry } from '../types.ts';

interface LogSyncData {
  user_id: number;
  event_id?: number;
  google_event_id?: string;
  direction: 'push' | 'pull';
  action: 'create' | 'update' | 'delete' | 'conflict_resolve';
  details?: string;
}

export class GoogleSyncRepository {
  constructor(private db: Database) {}

  getSyncState(userId: number): GoogleSyncState | null {
    return this.db.prepare('SELECT * FROM google_sync_state WHERE user_id = ?').get(userId) as GoogleSyncState | null;
  }

  upsertSyncState(userId: number, scopes: string): void {
    this.db.prepare(`
      INSERT INTO google_sync_state (user_id, scopes)
      VALUES (?, ?)
      ON CONFLICT (user_id) DO UPDATE SET
        status = 'active',
        scopes = excluded.scopes,
        updated_at = datetime('now')
    `).run(userId, scopes);
  }

  updateAccessToken(userId: number, accessToken: string, expiresAt: string): void {
    this.db.prepare(`
      UPDATE google_sync_state
      SET access_token = ?, expires_at = ?, updated_at = datetime('now')
      WHERE user_id = ?
    `).run(accessToken, expiresAt, userId);
  }

  markRevoked(userId: number): void {
    this.db.prepare(`
      UPDATE google_sync_state SET status = 'revoked', updated_at = datetime('now')
      WHERE user_id = ?
    `).run(userId);
  }

  deleteSyncState(userId: number): void {
    this.db.prepare('DELETE FROM google_sync_state WHERE user_id = ?').run(userId);
  }

  getActiveUsers(): number[] {
    const rows = this.db.prepare(
      "SELECT user_id FROM google_sync_state WHERE status = 'active'"
    ).all() as { user_id: number }[];
    return rows.map(r => r.user_id);
  }

  logSync(data: LogSyncData): void {
    this.db.prepare(`
      INSERT INTO sync_log (user_id, event_id, google_event_id, direction, action, details)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(data.user_id, data.event_id ?? null, data.google_event_id ?? null, data.direction, data.action, data.details ?? null);
  }

  getRecentLogs(userId: number, limit: number): SyncLogEntry[] {
    return this.db.prepare(
      'SELECT * FROM sync_log WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(userId, limit) as SyncLogEntry[];
  }

  pruneOldLogs(daysOld: number): void {
    this.db.prepare(
      `DELETE FROM sync_log WHERE created_at < datetime('now', '-' || ? || ' days')`
    ).run(daysOld);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/database/repositories/google-sync.repository.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/database/repositories/google-sync.repository.ts test/database/repositories/google-sync.repository.test.ts
git commit -m "feat: add GoogleSyncRepository with sync state and sync log"
```

---

### Task 6: GoogleCalendarRepository

**Files:**
- Create: `src/database/repositories/google-calendar.repository.ts`
- Create: `test/database/repositories/google-calendar.repository.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// test/database/repositories/google-calendar.repository.test.ts
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { GoogleCalendarRepository } from '../../../src/database/repositories/google-calendar.repository.ts';

describe('GoogleCalendarRepository', () => {
  let db: Database;
  let repo: GoogleCalendarRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.run('PRAGMA foreign_keys = ON');
    db.run(`CREATE TABLE users (
      telegram_id INTEGER PRIMARY KEY,
      username TEXT, first_name TEXT,
      language TEXT NOT NULL DEFAULT 'en',
      timezone TEXT NOT NULL DEFAULT 'UTC',
      country_code TEXT,
      google_refresh_token_enc TEXT,
      google_calendar_id TEXT,
      onboarding_completed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    db.run(`CREATE TABLE google_calendars (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      google_calendar_id TEXT NOT NULL,
      calendar_name TEXT NOT NULL,
      color TEXT,
      is_primary INTEGER NOT NULL DEFAULT 0,
      sync_enabled INTEGER NOT NULL DEFAULT 1,
      access_role TEXT NOT NULL DEFAULT 'owner'
        CHECK (access_role IN ('owner', 'writer', 'reader', 'freeBusyReader')),
      sync_token TEXT,
      last_synced_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE,
      UNIQUE (user_id, google_calendar_id)
    )`);
    db.run(`CREATE TABLE google_watch_channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      google_calendar_row_id INTEGER NOT NULL,
      channel_id TEXT NOT NULL UNIQUE,
      resource_id TEXT NOT NULL,
      expiration TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (google_calendar_row_id) REFERENCES google_calendars(id) ON DELETE CASCADE
    )`);
    db.run("INSERT INTO users (telegram_id, username) VALUES (42, 'alice')");
    repo = new GoogleCalendarRepository(db);
  });

  test('upsertCalendar creates calendar', () => {
    repo.upsertCalendar(42, {
      google_calendar_id: 'primary',
      calendar_name: 'My Calendar',
      color: '#4285f4',
      is_primary: true,
      access_role: 'owner',
    });
    const cals = repo.getCalendars(42);
    expect(cals.length).toBe(1);
    expect(cals[0]!.calendar_name).toBe('My Calendar');
    expect(cals[0]!.is_primary).toBe(1);
  });

  test('upsertCalendar updates on conflict', () => {
    repo.upsertCalendar(42, {
      google_calendar_id: 'primary',
      calendar_name: 'Old Name',
      is_primary: true,
      access_role: 'owner',
    });
    repo.upsertCalendar(42, {
      google_calendar_id: 'primary',
      calendar_name: 'New Name',
      is_primary: true,
      access_role: 'owner',
    });
    const cals = repo.getCalendars(42);
    expect(cals.length).toBe(1);
    expect(cals[0]!.calendar_name).toBe('New Name');
  });

  test('toggleSync flips sync_enabled', () => {
    repo.upsertCalendar(42, {
      google_calendar_id: 'cal1',
      calendar_name: 'Cal',
      is_primary: false,
      access_role: 'owner',
    });
    const cal = repo.getCalendars(42)[0]!;
    expect(cal.sync_enabled).toBe(1);
    repo.toggleSync(cal.id);
    expect(repo.getCalendars(42)[0]!.sync_enabled).toBe(0);
  });

  test('updateSyncToken stores token', () => {
    repo.upsertCalendar(42, {
      google_calendar_id: 'cal1',
      calendar_name: 'Cal',
      is_primary: false,
      access_role: 'owner',
    });
    const cal = repo.getCalendars(42)[0]!;
    repo.updateSyncToken(cal.id, 'sync-token-123');
    expect(repo.getCalendars(42)[0]!.sync_token).toBe('sync-token-123');
  });

  test('getEnabledCalendars returns only sync_enabled=1', () => {
    repo.upsertCalendar(42, { google_calendar_id: 'a', calendar_name: 'A', is_primary: true, access_role: 'owner' });
    repo.upsertCalendar(42, { google_calendar_id: 'b', calendar_name: 'B', is_primary: false, access_role: 'owner' });
    const calB = repo.getCalendars(42).find(c => c.google_calendar_id === 'b')!;
    repo.toggleSync(calB.id);
    expect(repo.getEnabledCalendars(42).length).toBe(1);
  });

  test('deleteUserCalendars removes all calendars', () => {
    repo.upsertCalendar(42, { google_calendar_id: 'a', calendar_name: 'A', is_primary: true, access_role: 'owner' });
    repo.deleteUserCalendars(42);
    expect(repo.getCalendars(42).length).toBe(0);
  });

  test('addWatchChannel creates channel', () => {
    repo.upsertCalendar(42, { google_calendar_id: 'a', calendar_name: 'A', is_primary: true, access_role: 'owner' });
    const cal = repo.getCalendars(42)[0]!;
    repo.addWatchChannel(cal.id, 'ch-uuid', 'res-123', '2026-03-20T00:00:00Z');
    const channels = repo.getWatchChannels(cal.id);
    expect(channels.length).toBe(1);
    expect(channels[0]!.channel_id).toBe('ch-uuid');
  });

  test('getExpiringChannels finds channels expiring before threshold', () => {
    repo.upsertCalendar(42, { google_calendar_id: 'a', calendar_name: 'A', is_primary: true, access_role: 'owner' });
    const cal = repo.getCalendars(42)[0]!;
    repo.addWatchChannel(cal.id, 'ch1', 'res1', '2026-03-14T00:00:00Z');
    repo.addWatchChannel(cal.id, 'ch2', 'res2', '2026-04-01T00:00:00Z');
    const expiring = repo.getExpiringChannels('2026-03-15T00:00:00Z');
    expect(expiring.length).toBe(1);
    expect(expiring[0]!.channel_id).toBe('ch1');
  });

  test('deleteWatchChannel removes channel', () => {
    repo.upsertCalendar(42, { google_calendar_id: 'a', calendar_name: 'A', is_primary: true, access_role: 'owner' });
    const cal = repo.getCalendars(42)[0]!;
    repo.addWatchChannel(cal.id, 'ch1', 'res1', '2026-03-20T00:00:00Z');
    const ch = repo.getWatchChannels(cal.id)[0]!;
    repo.deleteWatchChannel(ch.id);
    expect(repo.getWatchChannels(cal.id).length).toBe(0);
  });

  test('findChannelByIds looks up by channel_id and resource_id', () => {
    repo.upsertCalendar(42, { google_calendar_id: 'a', calendar_name: 'A', is_primary: true, access_role: 'owner' });
    const cal = repo.getCalendars(42)[0]!;
    repo.addWatchChannel(cal.id, 'ch1', 'res1', '2026-03-20T00:00:00Z');
    const found = repo.findChannelByIds('ch1', 'res1');
    expect(found).not.toBeNull();
    expect(found!.channel_id).toBe('ch1');
  });

  test('findChannelByIds returns null for unknown', () => {
    expect(repo.findChannelByIds('nope', 'nope')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/database/repositories/google-calendar.repository.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement GoogleCalendarRepository**

```ts
// src/database/repositories/google-calendar.repository.ts
import type { Database } from 'bun:sqlite';
import type { GoogleAccessRole, GoogleCalendar, GoogleWatchChannel } from '../types.ts';

interface UpsertCalendarData {
  google_calendar_id: string;
  calendar_name: string;
  color?: string;
  is_primary: boolean;
  access_role: GoogleAccessRole;
}

interface ExpiringChannel extends GoogleWatchChannel {
  user_id: number;
  google_calendar_id: string;
}

export class GoogleCalendarRepository {
  constructor(private db: Database) {}

  getCalendars(userId: number): GoogleCalendar[] {
    return this.db.prepare(
      'SELECT * FROM google_calendars WHERE user_id = ? ORDER BY is_primary DESC, calendar_name'
    ).all(userId) as GoogleCalendar[];
  }

  getEnabledCalendars(userId: number): GoogleCalendar[] {
    return this.db.prepare(
      'SELECT * FROM google_calendars WHERE user_id = ? AND sync_enabled = 1 ORDER BY is_primary DESC'
    ).all(userId) as GoogleCalendar[];
  }

  getCalendarById(id: number): GoogleCalendar | null {
    return this.db.prepare('SELECT * FROM google_calendars WHERE id = ?').get(id) as GoogleCalendar | null;
  }

  getCalendarByGoogleId(userId: number, googleCalendarId: string): GoogleCalendar | null {
    return this.db.prepare(
      'SELECT * FROM google_calendars WHERE user_id = ? AND google_calendar_id = ?'
    ).get(userId, googleCalendarId) as GoogleCalendar | null;
  }

  upsertCalendar(userId: number, data: UpsertCalendarData): void {
    this.db.prepare(`
      INSERT INTO google_calendars (user_id, google_calendar_id, calendar_name, color, is_primary, access_role)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (user_id, google_calendar_id) DO UPDATE SET
        calendar_name = excluded.calendar_name,
        color = excluded.color,
        is_primary = excluded.is_primary,
        access_role = excluded.access_role,
        updated_at = datetime('now')
    `).run(userId, data.google_calendar_id, data.calendar_name, data.color ?? null, data.is_primary ? 1 : 0, data.access_role);
  }

  toggleSync(calendarRowId: number): void {
    this.db.prepare(`
      UPDATE google_calendars SET sync_enabled = CASE WHEN sync_enabled = 1 THEN 0 ELSE 1 END,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(calendarRowId);
  }

  updateSyncToken(calendarRowId: number, syncToken: string | null): void {
    this.db.prepare(`
      UPDATE google_calendars SET sync_token = ?, last_synced_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `).run(syncToken, calendarRowId);
  }

  deleteUserCalendars(userId: number): void {
    this.db.prepare('DELETE FROM google_calendars WHERE user_id = ?').run(userId);
  }

  // Watch channels
  addWatchChannel(calendarRowId: number, channelId: string, resourceId: string, expiration: string): void {
    this.db.prepare(`
      INSERT INTO google_watch_channels (google_calendar_row_id, channel_id, resource_id, expiration)
      VALUES (?, ?, ?, ?)
    `).run(calendarRowId, channelId, resourceId, expiration);
  }

  getWatchChannels(calendarRowId: number): GoogleWatchChannel[] {
    return this.db.prepare(
      'SELECT * FROM google_watch_channels WHERE google_calendar_row_id = ?'
    ).all(calendarRowId) as GoogleWatchChannel[];
  }

  findChannelByIds(channelId: string, resourceId: string): GoogleWatchChannel | null {
    return this.db.prepare(
      'SELECT * FROM google_watch_channels WHERE channel_id = ? AND resource_id = ?'
    ).get(channelId, resourceId) as GoogleWatchChannel | null;
  }

  getExpiringChannels(beforeThreshold: string): ExpiringChannel[] {
    return this.db.prepare(`
      SELECT wc.*, gc.user_id, gc.google_calendar_id
      FROM google_watch_channels wc
      JOIN google_calendars gc ON gc.id = wc.google_calendar_row_id
      WHERE wc.expiration < ?
    `).all(beforeThreshold) as ExpiringChannel[];
  }

  deleteWatchChannel(channelRowId: number): void {
    this.db.prepare('DELETE FROM google_watch_channels WHERE id = ?').run(channelRowId);
  }

  deleteWatchChannelsForUser(userId: number): void {
    this.db.prepare(`
      DELETE FROM google_watch_channels
      WHERE google_calendar_row_id IN (SELECT id FROM google_calendars WHERE user_id = ?)
    `).run(userId);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/database/repositories/google-calendar.repository.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/database/repositories/google-calendar.repository.ts test/database/repositories/google-calendar.repository.test.ts
git commit -m "feat: add GoogleCalendarRepository with calendar and watch channel CRUD"
```

---

### Task 7: Wire repos + add repo methods for sync + loggers + shared redis util

**Files:**
- Modify: `src/database/index.ts`
- Modify: `src/database/repositories/user.repository.ts`
- Modify: `src/database/repositories/event.repository.ts`
- Modify: `src/utils/logger.ts`
- Create: `src/utils/redis.ts`

- [ ] **Step 1: Add `updateGoogleToken` and `clearGoogleToken` to UserRepository**

Add `google_refresh_token_enc` and `google_calendar_id` to `ALLOWED_COLUMNS`. Also add dedicated methods:

```ts
updateGoogleToken(telegramId: number, encRefreshToken: string): void {
  this.db.prepare(`
    UPDATE users SET google_refresh_token_enc = ?, updated_at = datetime('now')
    WHERE telegram_id = ?
  `).run(encRefreshToken, telegramId);
}

clearGoogleToken(telegramId: number): void {
  this.db.prepare(`
    UPDATE users SET
      google_refresh_token_enc = NULL,
      google_calendar_id = NULL,
      updated_at = datetime('now')
    WHERE telegram_id = ?
  `).run(telegramId);
}
```

- [ ] **Step 2: Add sync methods to EventRepository**

Add to `ALLOWED_COLUMNS`: `'google_calendar_id'`, `'google_event_id'`, `'google_etag'`, `'sync_status'`, `'sync_version'`, `'last_synced_at'`.

Add new methods:
```ts
findByGoogleEventId(userId: number, googleCalendarId: string, googleEventId: string): CalendarEvent | null {
  return this.db.prepare(
    'SELECT * FROM events WHERE user_id = ? AND google_calendar_id = ? AND google_event_id = ?'
  ).get(userId, googleCalendarId, googleEventId) as CalendarEvent | null;
}

updateSyncFields(eventId: number, data: {
  google_event_id?: string; google_etag?: string;
  sync_status?: string; last_synced_at?: string;
}): void {
  const fields: string[] = [];
  const values: (string | number)[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined) { fields.push(`${k} = ?`); values.push(v); }
  }
  if (fields.length === 0) return;
  fields.push("updated_at = datetime('now')");
  values.push(eventId);
  this.db.prepare(`UPDATE events SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

clearGoogleSync(userId: number): void {
  this.db.prepare(`
    UPDATE events SET
      google_calendar_id = NULL, google_event_id = NULL,
      google_etag = NULL, sync_status = 'local_only', last_synced_at = NULL
    WHERE user_id = ?
  `).run(userId);
}

insertSyncedEvent(data: {
  user_id: number; title: string; description: string | null;
  start_at: string; end_at: string | null; all_day: number;
  timezone: string; location: string | null; recurrence_rule: string | null;
  google_calendar_id: string; google_event_id: string;
  google_etag: string | null; is_cancelled: number;
}): void {
  this.db.prepare(`
    INSERT OR IGNORE INTO events (
      user_id, title, description, start_at, end_at, all_day,
      timezone, location, recurrence_rule, google_calendar_id, google_event_id,
      google_etag, sync_status, sync_version, is_cancelled
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced', 0, ?)
  `).run(
    data.user_id, data.title, data.description, data.start_at, data.end_at,
    data.all_day, data.timezone, data.location, data.recurrence_rule,
    data.google_calendar_id, data.google_event_id, data.google_etag, data.is_cancelled,
  );
}
```

- [ ] **Step 3: Add repos to DatabaseService**

```ts
import { GoogleCalendarRepository } from './repositories/google-calendar.repository.ts';
import { GoogleSyncRepository } from './repositories/google-sync.repository.ts';

// Add to class:
readonly googleSync: GoogleSyncRepository;
readonly googleCalendars: GoogleCalendarRepository;

// Add to constructor:
this.googleSync = new GoogleSyncRepository(this.db);
this.googleCalendars = new GoogleCalendarRepository(this.db);
```

- [ ] **Step 4: Add loggers**

Add to `src/utils/logger.ts`:
```ts
export const syncLogger = logger.child({ module: 'sync' });
export const webLogger = logger.child({ module: 'web' });
```

- [ ] **Step 5: Create shared Redis utility**

```ts
// src/utils/redis.ts
export function parseRedisUrl(url: string): { host: string; port: number } {
  const parsed = new URL(url);
  return {
    host: parsed.hostname || 'localhost',
    port: Number(parsed.port) || 6379,
  };
}
```

Update `src/services/notification/queue.ts` to import from `../../utils/redis.ts` instead of defining its own `parseRedisUrl`.

- [ ] **Step 6: Run tests**

Run: `bun test`
Expected: All pass

- [ ] **Step 7: Commit**

```bash
git add src/database/index.ts src/database/repositories/user.repository.ts src/database/repositories/event.repository.ts src/utils/logger.ts src/utils/redis.ts src/services/notification/queue.ts
git commit -m "feat: add sync repo methods, wire Google repos, extract shared redis util"
```

---

## Chunk 2: OAuth Flow + Web Server

### Task 8: OAuth service — client creation, auth URL, token exchange

**Files:**
- Create: `src/services/google/oauth.ts`

- [ ] **Step 1: Install googleapis**

Run: `bun install googleapis`

- [ ] **Step 2: Implement OAuth service**

```ts
// src/services/google/oauth.ts
import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import type { EnvConfig } from '../../config/env.ts';
import type { GoogleSyncRepository } from '../../database/repositories/google-sync.repository.ts';
import type { UserRepository } from '../../database/repositories/user.repository.ts';
import { decrypt } from '../../utils/crypto.ts';
import { syncLogger } from '../../utils/logger.ts';

export class GoogleNotConnectedError extends Error {
  constructor(public userId: number) {
    super(`Google Calendar not connected for user ${userId}`);
    this.name = 'GoogleNotConnectedError';
  }
}

export class GoogleTokenRevokedError extends Error {
  constructor(public userId: number) {
    super(`Google token revoked for user ${userId}`);
    this.name = 'GoogleTokenRevokedError';
  }
}

const GOOGLE_CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
];

export class GoogleOAuthService {
  constructor(
    private config: EnvConfig,
    private userRepo: UserRepository,
    private syncRepo: GoogleSyncRepository,
  ) {}

  private assertGoogleConfigured(): void {
    if (!this.config.GOOGLE_CLIENT_ID || !this.config.GOOGLE_CLIENT_SECRET) {
      throw new Error('Google OAuth not configured: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET required');
    }
  }

  isConfigured(): boolean {
    return !!(this.config.GOOGLE_CLIENT_ID && this.config.GOOGLE_CLIENT_SECRET);
  }

  createOAuth2Client(): OAuth2Client {
    this.assertGoogleConfigured();
    return new google.auth.OAuth2(
      this.config.GOOGLE_CLIENT_ID,
      this.config.GOOGLE_CLIENT_SECRET,
      this.config.GOOGLE_REDIRECT_URI,
    );
  }

  generateAuthUrl(stateId: string): string {
    const client = this.createOAuth2Client();
    return client.generateAuthUrl({
      access_type: 'offline',
      scope: GOOGLE_CALENDAR_SCOPES,
      state: stateId,
      prompt: 'consent',
    });
  }

  async exchangeCode(code: string): Promise<{ refreshToken: string; accessToken: string; expiresAt: number }> {
    const client = this.createOAuth2Client();
    const { tokens } = await client.getToken(code);
    if (!tokens.refresh_token) {
      throw new Error('No refresh token received — user may need to revoke and reconnect');
    }
    return {
      refreshToken: tokens.refresh_token,
      accessToken: tokens.access_token ?? '',
      expiresAt: tokens.expiry_date ?? Date.now() + 3600_000,
    };
  }

  getAuthClient(userId: number): OAuth2Client {
    const user = this.userRepo.findByTelegramId(userId);
    if (!user?.google_refresh_token_enc) {
      throw new GoogleNotConnectedError(userId);
    }

    const syncState = this.syncRepo.getSyncState(userId);
    if (syncState?.status === 'revoked') {
      throw new GoogleTokenRevokedError(userId);
    }

    if (!this.config.ENCRYPTION_KEY) {
      throw new Error('ENCRYPTION_KEY not configured');
    }

    const refreshToken = decrypt(user.google_refresh_token_enc, this.config.ENCRYPTION_KEY);
    const client = this.createOAuth2Client();
    client.setCredentials({
      refresh_token: refreshToken,
      access_token: syncState?.access_token ?? undefined,
    });

    client.on('tokens', (newTokens) => {
      if (newTokens.access_token) {
        this.syncRepo.updateAccessToken(
          userId,
          newTokens.access_token,
          newTokens.expiry_date ? new Date(newTokens.expiry_date).toISOString() : '',
        );
      }
    });

    return client;
  }

  async revokeToken(refreshToken: string): Promise<void> {
    const client = this.createOAuth2Client();
    try {
      await client.revokeToken(refreshToken);
    } catch (err) {
      syncLogger.warn({ error: String(err) }, 'Token revocation failed (may already be revoked)');
    }
  }

  get scopes(): string {
    return GOOGLE_CALENDAR_SCOPES.join(' ');
  }
}
```

- [ ] **Step 3: Run lint**

Run: `bun run lint`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/services/google/oauth.ts package.json bun.lock
git commit -m "feat: add GoogleOAuthService with auth URL, token exchange, client factory"
```

---

### Task 9: Web server — Bun.serve with OAuth callback route

**Files:**
- Create: `src/web/server.ts`
- Create: `src/web/oauth-callback.ts`

- [ ] **Step 1: Implement OAuth callback handler**

```ts
// src/web/oauth-callback.ts
import type { EnvConfig } from '../config/env.ts';
import type { GoogleCalendarRepository } from '../database/repositories/google-calendar.repository.ts';
import type { GoogleSyncRepository } from '../database/repositories/google-sync.repository.ts';
import type { UserRepository } from '../database/repositories/user.repository.ts';
import type { GoogleOAuthService } from '../services/google/oauth.ts';
import { encrypt } from '../utils/crypto.ts';
import { webLogger } from '../utils/logger.ts';

interface OAuthStateLookup {
  get(stateId: string): Promise<string | null>;
  del(stateId: string): Promise<void>;
}

interface OAuthCallbackDeps {
  config: EnvConfig;
  oauthService: GoogleOAuthService;
  userRepo: UserRepository;
  syncRepo: GoogleSyncRepository;
  calendarRepo: GoogleCalendarRepository;
  stateLookup: OAuthStateLookup;
  onConnected?: (userId: number) => Promise<void>;
}

export async function handleOAuthCallback(req: Request, deps: OAuthCallbackDeps): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) {
    webLogger.warn({ error }, 'OAuth denied by user');
    return new Response(`<html><body><h2>Authorization denied.</h2><p>You can close this tab.</p></body></html>`, {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });
  }

  if (!code || !state) {
    return new Response('Missing code or state', { status: 400 });
  }

  // Validate state
  const payload = await deps.stateLookup.get(state);
  if (!payload) {
    return new Response('State expired or invalid', { status: 400 });
  }
  await deps.stateLookup.del(state); // one-time use

  const { telegram_user_id: userId } = JSON.parse(payload) as { telegram_user_id: number };

  try {
    const tokens = await deps.oauthService.exchangeCode(code);

    if (!deps.config.ENCRYPTION_KEY) {
      throw new Error('ENCRYPTION_KEY not configured');
    }

    // Encrypt and store refresh token
    const encryptedRefreshToken = encrypt(tokens.refreshToken, deps.config.ENCRYPTION_KEY);
    deps.userRepo.updateGoogleToken(userId, encryptedRefreshToken);

    // Store sync state
    deps.syncRepo.upsertSyncState(userId, deps.oauthService.scopes);
    deps.syncRepo.updateAccessToken(
      userId,
      tokens.accessToken,
      new Date(tokens.expiresAt).toISOString(),
    );

    webLogger.info({ userId }, 'Google OAuth completed');

    // Notify bot to show calendar picker
    if (deps.onConnected) {
      await deps.onConnected(userId);
    }

    return new Response(
      `<html><body><h2>Connected!</h2><p>Return to Telegram to choose which calendars to sync.</p></body></html>`,
      { status: 200, headers: { 'Content-Type': 'text/html' } },
    );
  } catch (err) {
    webLogger.error({ error: String(err), userId }, 'OAuth token exchange failed');
    return new Response('Authorization failed. Please try again.', { status: 500 });
  }
}
```

- [ ] **Step 2: Implement web server**

```ts
// src/web/server.ts
import type { EnvConfig } from '../config/env.ts';
import type { GoogleCalendarRepository } from '../database/repositories/google-calendar.repository.ts';
import type { GoogleSyncRepository } from '../database/repositories/google-sync.repository.ts';
import type { UserRepository } from '../database/repositories/user.repository.ts';
import type { GoogleOAuthService } from '../services/google/oauth.ts';
import { webLogger } from '../utils/logger.ts';
import { handleOAuthCallback } from './oauth-callback.ts';

interface OAuthStateLookup {
  get(stateId: string): Promise<string | null>;
  del(stateId: string): Promise<void>;
}

interface WebServerDeps {
  config: EnvConfig;
  oauthService: GoogleOAuthService;
  userRepo: UserRepository;
  syncRepo: GoogleSyncRepository;
  calendarRepo: GoogleCalendarRepository;
  stateLookup: OAuthStateLookup;
  onConnected?: (userId: number) => Promise<void>;
  onWebhook?: (channelId: string, resourceId: string) => Promise<void>;
}

export function startWebServer(deps: WebServerDeps): { stop: () => void } {
  const port = deps.config.OAUTH_SERVER_PORT ?? 3311;

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      // Health check
      if (req.method === 'GET' && url.pathname === '/health') {
        return new Response('ok');
      }

      // OAuth callback
      if (req.method === 'GET' && url.pathname === '/oauth/google/callback') {
        return handleOAuthCallback(req, deps);
      }

      // Google Calendar webhook
      if (req.method === 'POST' && url.pathname === '/webhooks/google-calendar') {
        const channelId = req.headers.get('x-goog-channel-id');
        const resourceId = req.headers.get('x-goog-resource-id');
        const resourceState = req.headers.get('x-goog-resource-state');

        if (!channelId || !resourceId) {
          return new Response('Missing headers', { status: 400 });
        }

        // Verify channel exists in DB
        const channel = deps.calendarRepo.findChannelByIds(channelId, resourceId);
        if (!channel) {
          webLogger.warn({ channelId, resourceId }, 'Unknown webhook channel');
          return new Response('Unknown channel', { status: 404 });
        }

        // Respond immediately, then process async
        if ((resourceState === 'exists' || resourceState === 'sync') && deps.onWebhook) {
          deps.onWebhook(channelId, resourceId).catch((err) => {
            webLogger.error({ error: String(err), channelId }, 'Webhook processing error');
          });
        }

        return new Response('OK', { status: 200 });
      }

      return new Response('Not Found', { status: 404 });
    },
  });

  webLogger.info({ port }, 'Web server started');

  return {
    stop: () => {
      server.stop();
      webLogger.info('Web server stopped');
    },
  };
}
```

- [ ] **Step 3: Write tests for OAuth callback and webhook handler**

```ts
// test/web/oauth-callback.test.ts
import { describe, expect, mock, test } from 'bun:test';
import { handleOAuthCallback } from '../../src/web/oauth-callback.ts';

function createMockDeps(overrides: Record<string, unknown> = {}) {
  return {
    config: { ENCRYPTION_KEY: 'a'.repeat(64) },
    oauthService: {
      exchangeCode: mock(() => Promise.resolve({
        refreshToken: 'rt', accessToken: 'at', expiresAt: Date.now() + 3600000,
      })),
      scopes: 'calendar.events',
    },
    userRepo: { updateGoogleToken: mock(() => {}) },
    syncRepo: {
      upsertSyncState: mock(() => {}),
      updateAccessToken: mock(() => {}),
    },
    calendarRepo: {},
    stateLookup: {
      get: mock(() => Promise.resolve(JSON.stringify({ telegram_user_id: 42 }))),
      del: mock(() => Promise.resolve()),
    },
    onConnected: mock(() => Promise.resolve()),
    ...overrides,
  };
}

describe('handleOAuthCallback', () => {
  test('returns 400 when code or state missing', async () => {
    const req = new Request('http://localhost/oauth/google/callback');
    const res = await handleOAuthCallback(req, createMockDeps() as never);
    expect(res.status).toBe(400);
  });

  test('returns 400 when state is expired/invalid', async () => {
    const req = new Request('http://localhost/oauth/google/callback?code=abc&state=bad');
    const deps = createMockDeps({
      stateLookup: { get: mock(() => Promise.resolve(null)), del: mock(() => Promise.resolve()) },
    });
    const res = await handleOAuthCallback(req, deps as never);
    expect(res.status).toBe(400);
  });

  test('stores encrypted token on successful exchange', async () => {
    const deps = createMockDeps();
    const req = new Request('http://localhost/oauth/google/callback?code=abc&state=valid');
    const res = await handleOAuthCallback(req, deps as never);
    expect(res.status).toBe(200);
    expect(deps.userRepo.updateGoogleToken).toHaveBeenCalledTimes(1);
    expect(deps.stateLookup.del).toHaveBeenCalledTimes(1);
  });

  test('shows denial page when error param present', async () => {
    const req = new Request('http://localhost/oauth/google/callback?error=access_denied');
    const res = await handleOAuthCallback(req, createMockDeps() as never);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('denied');
  });
});
```

```ts
// test/web/webhook-handler.test.ts
import { describe, expect, mock, test } from 'bun:test';
import { startWebServer } from '../../src/web/server.ts';

describe('webhook handler', () => {
  test('returns 400 without required headers', async () => {
    const deps = createMinimalDeps();
    const { stop } = startWebServer(deps as never);
    try {
      const res = await fetch(`http://localhost:${deps.config.OAUTH_SERVER_PORT}/webhooks/google-calendar`, {
        method: 'POST',
      });
      expect(res.status).toBe(400);
    } finally {
      stop();
    }
  });

  test('returns 404 for unknown channel', async () => {
    const deps = createMinimalDeps({
      calendarRepo: { findChannelByIds: mock(() => null) },
    });
    const { stop } = startWebServer(deps as never);
    try {
      const res = await fetch(`http://localhost:${deps.config.OAUTH_SERVER_PORT}/webhooks/google-calendar`, {
        method: 'POST',
        headers: { 'x-goog-channel-id': 'ch-1', 'x-goog-resource-id': 'r-1', 'x-goog-resource-state': 'exists' },
      });
      expect(res.status).toBe(404);
    } finally {
      stop();
    }
  });

  test('returns 200 and triggers onWebhook for valid channel', async () => {
    const onWebhook = mock(() => Promise.resolve());
    const deps = createMinimalDeps({
      calendarRepo: { findChannelByIds: mock(() => ({ id: 1 })) },
      onWebhook,
    });
    const { stop } = startWebServer(deps as never);
    try {
      const res = await fetch(`http://localhost:${deps.config.OAUTH_SERVER_PORT}/webhooks/google-calendar`, {
        method: 'POST',
        headers: { 'x-goog-channel-id': 'ch-1', 'x-goog-resource-id': 'r-1', 'x-goog-resource-state': 'exists' },
      });
      expect(res.status).toBe(200);
      // onWebhook is called async, give it a tick
      await Bun.sleep(10);
      expect(onWebhook).toHaveBeenCalledTimes(1);
    } finally {
      stop();
    }
  });
});

function createMinimalDeps(overrides: Record<string, unknown> = {}) {
  return {
    config: { OAUTH_SERVER_PORT: 13311 + Math.floor(Math.random() * 1000) },
    oauthService: {},
    userRepo: {},
    syncRepo: {},
    calendarRepo: { findChannelByIds: mock(() => null) },
    stateLookup: { get: mock(() => Promise.resolve(null)), del: mock(() => Promise.resolve()) },
    ...overrides,
  };
}
```

- [ ] **Step 4: Run tests**

Run: `bun test test/web/`
Expected: All pass

- [ ] **Step 5: Run lint**

Run: `bun run lint`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/web/server.ts src/web/oauth-callback.ts test/web/oauth-callback.test.ts test/web/webhook-handler.test.ts
git commit -m "feat: add web server with OAuth callback and webhook routes"
```

---

### Task 10: /connect_google command

**Files:**
- Create: `src/bot/commands/connect-google.ts`
- Modify: `src/config/constants.ts`

- [ ] **Step 1: Add i18n strings**

Add to `MSG.en` in `src/config/constants.ts`:
```ts
gcal_not_configured: 'Google Calendar sync is not configured. Contact the admin.',
gcal_already_connected: 'Google Calendar is already connected. Use /disconnect_google first to reconnect.',
gcal_connect_prompt: '🔗 Connect Google Calendar to sync your events bidirectionally.',
gcal_connect_button: 'Connect Google Calendar',
gcal_connected: '✅ Google Calendar connected! Now pick which calendars to sync.',
gcal_disconnected: '✅ Google Calendar disconnected. Your local events are untouched.',
gcal_disconnect_confirm: 'Disconnect Google Calendar? Your events will stay in the bot.',
gcal_disconnect_yes: 'Yes, disconnect',
gcal_disconnect_no: 'Cancel',
gcal_calendar_picker: 'Select calendars to sync (tap to toggle):',
gcal_calendar_done: 'Done ✓',
gcal_calendar_readonly: '(read-only)',
gcal_calendars_saved: '✅ Calendar selection saved. Initial sync starting...',
gcal_sync_complete: '✅ Initial sync complete. Your Google events are now in the bot.',
gcal_revoked: '⚠️ Google Calendar connection lost. Use /connect_google to reconnect.',
```

Add equivalent to `MSG.ru`:
```ts
gcal_not_configured: 'Синхронизация с Google Calendar не настроена. Обратитесь к администратору.',
gcal_already_connected: 'Google Calendar уже подключён. Используйте /disconnect_google чтобы переподключить.',
gcal_connect_prompt: '🔗 Подключите Google Calendar для двусторонней синхронизации событий.',
gcal_connect_button: 'Подключить Google Calendar',
gcal_connected: '✅ Google Calendar подключён! Выберите календари для синхронизации.',
gcal_disconnected: '✅ Google Calendar отключён. Локальные события сохранены.',
gcal_disconnect_confirm: 'Отключить Google Calendar? События останутся в боте.',
gcal_disconnect_yes: 'Да, отключить',
gcal_disconnect_no: 'Отмена',
gcal_calendar_picker: 'Выберите календари для синхронизации (нажмите для переключения):',
gcal_calendar_done: 'Готово ✓',
gcal_calendar_readonly: '(только чтение)',
gcal_calendars_saved: '✅ Выбор сохранён. Начинается синхронизация...',
gcal_sync_complete: '✅ Синхронизация завершена. Ваши события из Google теперь в боте.',
gcal_revoked: '⚠️ Связь с Google Calendar потеряна. Используйте /connect_google чтобы переподключить.',
```

Add to `CB`:
```ts
GCAL: 'gc',
```

- [ ] **Step 2: Implement connect command**

```ts
// src/bot/commands/connect-google.ts
import { InlineKeyboard } from 'gramio';
import type { Queue } from 'bullmq';
import type { Lang } from '../../config/constants.ts';
import { t } from '../../config/constants.ts';
import type { GoogleOAuthService } from '../../services/google/oauth.ts';
import { cmdLogger } from '../../utils/logger.ts';
import type { BotCommandContext } from '../types.ts';

interface OAuthStateStore {
  set(stateId: string, payload: string, ttlSeconds: number): Promise<void>;
}

interface ConnectGoogleDeps {
  oauthService: GoogleOAuthService;
  stateStore: OAuthStateStore;
}

export async function handleConnectGoogle(ctx: BotCommandContext, deps: ConnectGoogleDeps): Promise<void> {
  const lang = (ctx.dbUser.language ?? 'en') as Lang;
  const userId = ctx.dbUser.telegram_id;

  if (!deps.oauthService.isConfigured()) {
    await ctx.send(t(lang).gcal_not_configured);
    return;
  }

  // Check if already connected
  if (ctx.dbUser.google_refresh_token_enc) {
    await ctx.send(t(lang).gcal_already_connected);
    return;
  }

  // Generate state and auth URL
  const stateId = crypto.randomUUID();
  await deps.stateStore.set(
    `oauth:state:${stateId}`,
    JSON.stringify({ telegram_user_id: userId, created_at: Date.now() }),
    300,
  );

  const authUrl = deps.oauthService.generateAuthUrl(stateId);

  const keyboard = new InlineKeyboard().url(t(lang).gcal_connect_button, authUrl);

  await ctx.send(t(lang).gcal_connect_prompt, { reply_markup: keyboard });
  cmdLogger.info({ userId }, '/connect_google initiated');
}
```

- [ ] **Step 3: Run lint**

Run: `bun run lint`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/bot/commands/connect-google.ts src/config/constants.ts
git commit -m "feat: add /connect_google command with OAuth URL generation"
```

---

### Task 11: /disconnect_google command

**Files:**
- Create: `src/bot/commands/disconnect-google.ts`

- [ ] **Step 1: Implement disconnect command**

```ts
// src/bot/commands/disconnect-google.ts
import { InlineKeyboard } from 'gramio';
import type { Lang } from '../../config/constants.ts';
import { CB, t } from '../../config/constants.ts';
import type { EnvConfig } from '../../config/env.ts';
import type { EventRepository } from '../../database/repositories/event.repository.ts';
import type { GoogleCalendarRepository } from '../../database/repositories/google-calendar.repository.ts';
import type { GoogleSyncRepository } from '../../database/repositories/google-sync.repository.ts';
import type { UserRepository } from '../../database/repositories/user.repository.ts';
import type { GoogleOAuthService } from '../../services/google/oauth.ts';
import { decrypt } from '../../utils/crypto.ts';
import { cmdLogger } from '../../utils/logger.ts';
import type { BotCallbackContext, BotCommandContext } from '../types.ts';

interface DisconnectDeps {
  config: EnvConfig;
  oauthService: GoogleOAuthService;
  userRepo: UserRepository;
  eventRepo: EventRepository;
  syncRepo: GoogleSyncRepository;
  calendarRepo: GoogleCalendarRepository;
  stopWatchChannels?: (userId: number) => Promise<void>;
}

export async function handleDisconnectGoogle(ctx: BotCommandContext, deps: DisconnectDeps): Promise<void> {
  const lang = (ctx.dbUser.language ?? 'en') as Lang;

  if (!ctx.dbUser.google_refresh_token_enc) {
    await ctx.send(t(lang).gcal_not_configured);
    return;
  }

  const keyboard = new InlineKeyboard()
    .text(t(lang).gcal_disconnect_yes, `${CB.GCAL}:disconnect:yes`)
    .text(t(lang).gcal_disconnect_no, `${CB.GCAL}:disconnect:no`);

  await ctx.send(t(lang).gcal_disconnect_confirm, { reply_markup: keyboard });
}

export async function executeDisconnect(userId: number, deps: DisconnectDeps): Promise<void> {
  // Stop watch channels via Google API
  if (deps.stopWatchChannels) {
    await deps.stopWatchChannels(userId);
  }

  // Revoke token
  const user = deps.userRepo.findByTelegramId(userId);
  if (user?.google_refresh_token_enc && deps.config.ENCRYPTION_KEY) {
    const refreshToken = decrypt(user.google_refresh_token_enc, deps.config.ENCRYPTION_KEY);
    await deps.oauthService.revokeToken(refreshToken);
  }

  // Clean up DB
  deps.calendarRepo.deleteWatchChannelsForUser(userId);
  deps.calendarRepo.deleteUserCalendars(userId);
  deps.syncRepo.deleteSyncState(userId);

  // Clear token from users table
  deps.userRepo.clearGoogleToken(userId);

  // Reset sync fields on events
  deps.eventRepo.clearGoogleSync(userId);

  cmdLogger.info({ userId }, 'Google Calendar disconnected');
}
```

- [ ] **Step 2: Commit**

```bash
git add src/bot/commands/disconnect-google.ts
git commit -m "feat: add /disconnect_google command with cleanup"
```

---

## Chunk 3: Event Mapper + Calendar API + Calendar Picker

### Task 12: Event mapper — local <-> Google conversion

**Files:**
- Create: `src/services/google/event-mapper.ts`
- Create: `test/services/google/event-mapper.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// test/services/google/event-mapper.test.ts
import { describe, expect, test } from 'bun:test';
import { googleToLocal, localToGoogle } from '../../../src/services/google/event-mapper.ts';

describe('event-mapper', () => {
  describe('localToGoogle', () => {
    test('maps timed event', () => {
      const result = localToGoogle({
        id: 1,
        title: 'Meeting',
        description: 'Team sync',
        start_at: '2026-03-15T10:00:00Z',
        end_at: '2026-03-15T11:00:00Z',
        all_day: 0,
        timezone: 'Europe/Kyiv',
        location: 'Office',
        recurrence_rule: null,
        reminder_overrides: null,
        sync_version: 1,
      });
      expect(result.summary).toBe('Meeting');
      expect(result.description).toBe('Team sync');
      expect(result.location).toBe('Office');
      expect(result.start?.dateTime).toBe('2026-03-15T10:00:00Z');
      expect(result.start?.timeZone).toBe('Europe/Kyiv');
      expect(result.end?.dateTime).toBe('2026-03-15T11:00:00Z');
    });

    test('maps all-day event', () => {
      const result = localToGoogle({
        id: 2,
        title: 'Holiday',
        start_at: '2026-03-15T00:00:00Z',
        end_at: '2026-03-16T00:00:00Z',
        all_day: 1,
        timezone: 'UTC',
        description: null,
        location: null,
        recurrence_rule: null,
        reminder_overrides: null,
        sync_version: 0,
      });
      expect(result.start?.date).toBe('2026-03-15');
      expect(result.end?.date).toBe('2026-03-16');
      expect(result.start?.dateTime).toBeUndefined();
    });

    test('maps recurrence rule', () => {
      const result = localToGoogle({
        id: 3,
        title: 'Weekly',
        start_at: '2026-03-15T10:00:00Z',
        end_at: '2026-03-15T11:00:00Z',
        all_day: 0,
        timezone: 'UTC',
        description: null,
        location: null,
        recurrence_rule: 'RRULE:FREQ=WEEKLY;BYDAY=MO',
        reminder_overrides: null,
        sync_version: 0,
      });
      expect(result.recurrence).toEqual(['RRULE:FREQ=WEEKLY;BYDAY=MO']);
    });

    test('sets extended properties with local event ID', () => {
      const result = localToGoogle({
        id: 42,
        title: 'Test',
        start_at: '2026-03-15T10:00:00Z',
        end_at: '2026-03-15T11:00:00Z',
        all_day: 0,
        timezone: 'UTC',
        description: null,
        location: null,
        recurrence_rule: null,
        reminder_overrides: null,
        sync_version: 3,
      });
      expect(result.extendedProperties?.private?.hypercalendarbot_event_id).toBe('42');
      expect(result.extendedProperties?.private?.hypercalendarbot_version).toBe('3');
    });

    test('maps reminder overrides', () => {
      const result = localToGoogle({
        id: 1,
        title: 'Test',
        start_at: '2026-03-15T10:00:00Z',
        end_at: '2026-03-15T11:00:00Z',
        all_day: 0,
        timezone: 'UTC',
        description: null,
        location: null,
        recurrence_rule: null,
        reminder_overrides: '[5, 30]',
        sync_version: 0,
      });
      expect(result.reminders?.useDefault).toBe(false);
      expect(result.reminders?.overrides).toEqual([
        { method: 'popup', minutes: 5 },
        { method: 'popup', minutes: 30 },
      ]);
    });
  });

  describe('googleToLocal', () => {
    test('maps timed event', () => {
      const result = googleToLocal(
        {
          id: 'g123',
          etag: '"etag1"',
          summary: 'Meeting',
          description: 'Notes',
          location: 'Room A',
          start: { dateTime: '2026-03-15T10:00:00+02:00', timeZone: 'Europe/Kyiv' },
          end: { dateTime: '2026-03-15T11:00:00+02:00', timeZone: 'Europe/Kyiv' },
          status: 'confirmed',
        },
        42,
        'primary',
      );
      expect(result.title).toBe('Meeting');
      expect(result.google_event_id).toBe('g123');
      expect(result.google_etag).toBe('"etag1"');
      expect(result.all_day).toBe(false);
      expect(result.timezone).toBe('Europe/Kyiv');
    });

    test('maps all-day event', () => {
      const result = googleToLocal(
        {
          id: 'g456',
          summary: 'Day Off',
          start: { date: '2026-03-15' },
          end: { date: '2026-03-16' },
          status: 'confirmed',
        },
        42,
        'primary',
      );
      expect(result.all_day).toBe(true);
      expect(result.start_at).toBe('2026-03-15');
      expect(result.end_at).toBe('2026-03-16');
    });

    test('defaults title to Untitled', () => {
      const result = googleToLocal(
        {
          id: 'g789',
          start: { dateTime: '2026-03-15T10:00:00Z' },
          end: { dateTime: '2026-03-15T11:00:00Z' },
          status: 'confirmed',
        },
        42,
        'primary',
      );
      expect(result.title).toBe('Untitled');
    });

    test('detects cancelled status', () => {
      const result = googleToLocal(
        {
          id: 'g000',
          status: 'cancelled',
          start: { dateTime: '2026-03-15T10:00:00Z' },
          end: { dateTime: '2026-03-15T11:00:00Z' },
        },
        42,
        'primary',
      );
      expect(result.is_cancelled).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/services/google/event-mapper.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement event mapper**

```ts
// src/services/google/event-mapper.ts
import type { calendar_v3 } from 'googleapis';

interface LocalEventForGoogle {
  id: number;
  title: string;
  description: string | null;
  start_at: string;
  end_at: string | null;
  all_day: number; // 0 | 1
  timezone: string;
  location: string | null;
  recurrence_rule: string | null;
  reminder_overrides: string | null; // JSON "[5, 30]"
  sync_version: number;
}

interface LocalEventFromGoogle {
  user_id: number;
  title: string;
  description: string | null;
  start_at: string;
  end_at: string | null;
  all_day: boolean;
  timezone: string;
  location: string | null;
  recurrence_rule: string | null;
  google_calendar_id: string;
  google_event_id: string;
  google_etag: string | null;
  is_cancelled: boolean;
}

export function localToGoogle(local: LocalEventForGoogle): calendar_v3.Schema$Event {
  const event: calendar_v3.Schema$Event = {
    summary: local.title,
    description: local.description ?? undefined,
    location: local.location ?? undefined,
    extendedProperties: {
      private: {
        hypercalendarbot_event_id: String(local.id),
        hypercalendarbot_version: String(local.sync_version),
      },
    },
  };

  if (local.all_day) {
    event.start = { date: local.start_at.split('T')[0] };
    event.end = { date: (local.end_at ?? local.start_at).split('T')[0] };
  } else {
    event.start = { dateTime: local.start_at, timeZone: local.timezone };
    event.end = local.end_at
      ? { dateTime: local.end_at, timeZone: local.timezone }
      : { dateTime: local.start_at, timeZone: local.timezone };
  }

  if (local.recurrence_rule) {
    event.recurrence = [local.recurrence_rule];
  }

  if (local.reminder_overrides) {
    const minutes: number[] = JSON.parse(local.reminder_overrides);
    event.reminders = {
      useDefault: false,
      overrides: minutes.map((m) => ({ method: 'popup', minutes: m })),
    };
  }

  return event;
}

export function googleToLocal(
  gEvent: calendar_v3.Schema$Event,
  userId: number,
  googleCalendarId: string,
): LocalEventFromGoogle {
  const isAllDay = !!gEvent.start?.date;

  return {
    user_id: userId,
    title: gEvent.summary ?? 'Untitled',
    description: gEvent.description ?? null,
    start_at: isAllDay ? gEvent.start!.date! : gEvent.start?.dateTime ?? '',
    end_at: isAllDay ? (gEvent.end?.date ?? null) : (gEvent.end?.dateTime ?? null),
    all_day: isAllDay,
    timezone: gEvent.start?.timeZone ?? 'UTC',
    location: gEvent.location ?? null,
    recurrence_rule: gEvent.recurrence?.[0] ?? null,
    google_calendar_id: googleCalendarId,
    google_event_id: gEvent.id ?? '',
    google_etag: gEvent.etag ?? null,
    is_cancelled: gEvent.status === 'cancelled',
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/services/google/event-mapper.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/google/event-mapper.ts test/services/google/event-mapper.test.ts
git commit -m "feat: add event mapper for local <-> Google Calendar conversion"
```

---

### Task 13: Google Calendar API wrapper

**Files:**
- Create: `src/services/google/calendar-api.ts`

- [ ] **Step 1: Implement Calendar API wrapper**

```ts
// src/services/google/calendar-api.ts
import { google, type calendar_v3 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { syncLogger } from '../../utils/logger.ts';

export interface CalendarInfo {
  google_calendar_id: string;
  calendar_name: string;
  color: string | null;
  is_primary: boolean;
  access_role: 'owner' | 'writer' | 'reader' | 'freeBusyReader';
}

export interface EventListResult {
  events: calendar_v3.Schema$Event[];
  nextSyncToken: string | null;
  nextPageToken: string | null;
}

export class GoogleCalendarApi {
  private api: calendar_v3.Calendar;

  constructor(auth: OAuth2Client) {
    this.api = google.calendar({ version: 'v3', auth });
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    const res = await this.api.calendarList.list();
    return (res.data.items ?? []).map((cal) => ({
      google_calendar_id: cal.id!,
      calendar_name: cal.summary ?? 'Untitled',
      color: cal.backgroundColor ?? null,
      is_primary: cal.primary ?? false,
      access_role: (cal.accessRole ?? 'reader') as CalendarInfo['access_role'],
    }));
  }

  async listEvents(
    calendarId: string,
    opts: { syncToken?: string; pageToken?: string; timeMin?: string; maxResults?: number },
  ): Promise<EventListResult> {
    const res = await this.api.events.list({
      calendarId,
      singleEvents: false,
      maxResults: opts.maxResults ?? 250,
      syncToken: opts.syncToken,
      pageToken: opts.pageToken,
      timeMin: opts.timeMin,
    });
    return {
      events: res.data.items ?? [],
      nextSyncToken: res.data.nextSyncToken ?? null,
      nextPageToken: res.data.nextPageToken ?? null,
    };
  }

  async insertEvent(calendarId: string, event: calendar_v3.Schema$Event): Promise<calendar_v3.Schema$Event> {
    const res = await this.api.events.insert({ calendarId, requestBody: event });
    return res.data;
  }

  async updateEvent(
    calendarId: string,
    eventId: string,
    event: calendar_v3.Schema$Event,
  ): Promise<calendar_v3.Schema$Event> {
    const res = await this.api.events.update({ calendarId, eventId, requestBody: event });
    return res.data;
  }

  async deleteEvent(calendarId: string, eventId: string): Promise<void> {
    await this.api.events.delete({ calendarId, eventId });
  }

  async getEvent(calendarId: string, eventId: string): Promise<calendar_v3.Schema$Event> {
    const res = await this.api.events.get({ calendarId, eventId });
    return res.data;
  }

  async watchEvents(
    calendarId: string,
    channelId: string,
    webhookUrl: string,
    expirationMs: number,
  ): Promise<{ resourceId: string; expiration: string }> {
    const res = await this.api.events.watch({
      calendarId,
      requestBody: {
        id: channelId,
        type: 'web_hook',
        address: webhookUrl,
        expiration: String(expirationMs),
      },
    });
    return {
      resourceId: res.data.resourceId!,
      expiration: new Date(Number(res.data.expiration)).toISOString(),
    };
  }

  async stopChannel(channelId: string, resourceId: string): Promise<void> {
    try {
      await this.api.channels.stop({
        requestBody: { id: channelId, resourceId },
      });
    } catch (err) {
      syncLogger.warn({ channelId, error: String(err) }, 'Failed to stop watch channel (may be expired)');
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/services/google/calendar-api.ts
git commit -m "feat: add GoogleCalendarApi wrapper for events and watch channels"
```

---

### Task 14: Calendar picker UI

**Files:**
- Create: `src/bot/commands/calendars.ts`

- [ ] **Step 1: Implement calendar picker**

```ts
// src/bot/commands/calendars.ts
import { InlineKeyboard } from 'gramio';
import type { Lang } from '../../config/constants.ts';
import { CB, t } from '../../config/constants.ts';
import type { GoogleCalendarRepository } from '../../database/repositories/google-calendar.repository.ts';
import type { GoogleCalendar } from '../../database/types.ts';
import type { BotCallbackContext } from '../types.ts';

export function buildCalendarPickerKeyboard(
  calendars: GoogleCalendar[],
  lang: Lang,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const cal of calendars) {
    const check = cal.sync_enabled ? '✅' : '⬜';
    const readonly = cal.access_role === 'reader' || cal.access_role === 'freeBusyReader'
      ? ` ${t(lang).gcal_calendar_readonly}`
      : '';
    const primary = cal.is_primary ? ' ★' : '';
    kb.text(`${check} ${cal.calendar_name}${primary}${readonly}`, `${CB.GCAL}:cal:${cal.id}`).row();
  }
  kb.text(t(lang).gcal_calendar_done, `${CB.GCAL}:cal:done`);
  return kb;
}

export async function handleCalendarPickerCallback(
  ctx: BotCallbackContext,
  calendarRepo: GoogleCalendarRepository,
  userId: number,
  payload: string,
  lang: Lang,
  onDone?: (userId: number) => Promise<void>,
): Promise<void> {
  if (payload === 'done') {
    await ctx.answer();
    await ctx.editText(t(lang).gcal_calendars_saved);
    if (onDone) {
      await onDone(userId);
    }
    return;
  }

  const calendarRowId = Number(payload);
  calendarRepo.toggleSync(calendarRowId);

  // Refresh keyboard
  const calendars = calendarRepo.getCalendars(userId);
  const keyboard = buildCalendarPickerKeyboard(calendars, lang);
  await ctx.answer();
  await ctx.editText(t(lang).gcal_calendar_picker, { reply_markup: keyboard });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/bot/commands/calendars.ts
git commit -m "feat: add calendar picker inline keyboard UI"
```

---

## Chunk 4: Sync Service (initial pull, incremental pull, push)

### Task 15: Sync service — initial sync

**Files:**
- Create: `src/services/google/sync-service.ts`
- Create: `test/services/google/sync-service.test.ts`

- [ ] **Step 1: Write failing tests for sync service**

The sync service depends on GoogleCalendarApi which calls Google. For tests, we pass a mock api object.

```ts
// test/services/google/sync-service.test.ts
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { runMigrations } from '../../../src/database/migrations.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { GoogleCalendarRepository } from '../../../src/database/repositories/google-calendar.repository.ts';
import { GoogleSyncRepository } from '../../../src/database/repositories/google-sync.repository.ts';
import { SyncService } from '../../../src/services/google/sync-service.ts';

function createMockApi(events: Array<{ id: string; summary: string; start: { dateTime: string }; end: { dateTime: string }; status?: string; updated?: string; etag?: string; extendedProperties?: Record<string, unknown> }>, nextSyncToken = 'token-1') {
  return {
    listEvents: mock(() => Promise.resolve({ events, nextSyncToken, nextPageToken: undefined })),
    insertEvent: mock((calId: string, data: Record<string, unknown>) =>
      Promise.resolve({ id: 'g-new-1', etag: '"etag-new"' })),
    updateEvent: mock((calId: string, eventId: string, data: Record<string, unknown>) =>
      Promise.resolve({ id: eventId, etag: '"etag-upd"' })),
    deleteEvent: mock(() => Promise.resolve()),
  };
}

describe('SyncService', () => {
  let db: Database;
  let eventRepo: EventRepository;
  let syncRepo: GoogleSyncRepository;
  let calendarRepo: GoogleCalendarRepository;
  let service: SyncService;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    db.run("INSERT INTO users (telegram_id, username) VALUES (1, 'test')");
    eventRepo = new EventRepository(db);
    syncRepo = new GoogleSyncRepository(db);
    calendarRepo = new GoogleCalendarRepository(db);
    service = new SyncService(eventRepo, syncRepo, calendarRepo);

    // Set up a google calendar entry
    calendarRepo.upsertCalendar(1, {
      google_calendar_id: 'cal-1',
      calendar_name: 'Primary',
      is_primary: true,
      access_role: 'owner',
    });
  });

  test('initialSync imports events and saves sync token', async () => {
    const api = createMockApi([
      { id: 'g1', summary: 'Meeting', start: { dateTime: '2026-03-15T10:00:00Z' }, end: { dateTime: '2026-03-15T11:00:00Z' }, etag: '"e1"' },
      { id: 'g2', summary: 'Lunch', start: { dateTime: '2026-03-15T12:00:00Z' }, end: { dateTime: '2026-03-15T13:00:00Z' }, etag: '"e2"' },
    ], 'sync-token-abc');

    const count = await service.initialSync(api as never, 1, 'cal-1');

    expect(count).toBe(2);
    expect(api.listEvents).toHaveBeenCalledTimes(1);
    const imported = eventRepo.findByGoogleEventId(1, 'cal-1', 'g1');
    expect(imported).not.toBeNull();
    expect(imported!.title).toBe('Meeting');
  });

  test('initialSync skips events with our extended property', async () => {
    const api = createMockApi([
      { id: 'g1', summary: 'Ours', start: { dateTime: '2026-03-15T10:00:00Z' }, end: { dateTime: '2026-03-15T11:00:00Z' }, etag: '"e1"', extendedProperties: { private: { hypercalendarbot_event_id: '42' } } },
    ]);

    const count = await service.initialSync(api as never, 1, 'cal-1');
    expect(count).toBe(0);
  });

  test('pushEvent creates event on Google and updates sync fields', async () => {
    const eventId = eventRepo.create({
      user_id: 1, title: 'New Event', start_at: '2026-03-15T10:00:00Z',
      end_at: '2026-03-15T11:00:00Z', all_day: false, timezone: 'UTC',
    });
    eventRepo.updateSyncFields(eventId, { sync_status: 'pending_push', google_calendar_id: 'cal-1' });

    const api = createMockApi([]);
    await service.pushEvent(api as never, 1, eventId, 'create');

    expect(api.insertEvent).toHaveBeenCalledTimes(1);
    const updated = eventRepo.findById(eventId, 1);
    expect(updated!.google_event_id).toBe('g-new-1');
    expect(updated!.sync_status).toBe('synced');
  });

  test('resolveConflict returns keep_google when Google is newer', () => {
    const result = service.resolveConflict(
      { updated_at: '2026-03-15T10:00:00Z' } as never,
      '2026-03-15T11:00:00Z',
    );
    expect(result).toBe('keep_google');
  });

  test('resolveConflict returns keep_local when local is newer', () => {
    const result = service.resolveConflict(
      { updated_at: '2026-03-15T12:00:00Z' } as never,
      '2026-03-15T11:00:00Z',
    );
    expect(result).toBe('keep_local');
  });
});
```

- [ ] **Step 2: Implement SyncService**

The SyncService class handles:
- `initialSync(userId, calendarId)` — paginate through all events, batch insert, save sync token
- `incrementalPull(userId, calendarId)` — use syncToken, handle 410 (fallback to full), process changes
- `pushEvent(userId, eventId, action)` — push create/update/delete to Google
- `resolveConflict(localEvent, googleEvent)` — last-write-wins with logging

```ts
// src/services/google/sync-service.ts
import type { EventRepository } from '../../database/repositories/event.repository.ts';
import type { GoogleCalendarRepository } from '../../database/repositories/google-calendar.repository.ts';
import type { GoogleSyncRepository } from '../../database/repositories/google-sync.repository.ts';
import type { CalendarEvent } from '../../database/types.ts';
import { syncLogger } from '../../utils/logger.ts';
import type { GoogleCalendarApi } from './calendar-api.ts';
import { googleToLocal, localToGoogle } from './event-mapper.ts';

export class SyncService {
  constructor(
    private eventRepo: EventRepository,
    private syncRepo: GoogleSyncRepository,
    private calendarRepo: GoogleCalendarRepository,
    private notifyUser?: (userId: number, message: string) => Promise<void>,
  ) {}

  async initialSync(api: GoogleCalendarApi, userId: number, calendarId: string): Promise<number> {
    let pageToken: string | undefined;
    let nextSyncToken: string | null = null;
    let totalImported = 0;
    const timeMin = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

    do {
      const result = await api.listEvents(calendarId, { pageToken, timeMin });

      for (const gEvent of result.events) {
        if (gEvent.extendedProperties?.private?.hypercalendarbot_event_id) continue;
        if (gEvent.status === 'cancelled') continue;

        const local = googleToLocal(gEvent, userId, calendarId);
        this.eventRepo.insertSyncedEvent({
          user_id: userId,
          title: local.title,
          description: local.description,
          start_at: local.start_at,
          end_at: local.end_at,
          all_day: local.all_day,
          timezone: local.timezone,
          location: local.location,
          recurrence_rule: local.recurrence_rule,
          google_calendar_id: calendarId,
          google_event_id: local.google_event_id!,
          google_etag: local.google_etag,
          is_cancelled: local.is_cancelled ?? false,
        });
        totalImported++;
      }

      pageToken = result.nextPageToken ?? undefined;
      nextSyncToken = result.nextSyncToken;
    } while (pageToken);

    const cal = this.calendarRepo.getCalendarByGoogleId(userId, calendarId);
    if (cal && nextSyncToken) {
      this.calendarRepo.updateSyncToken(cal.id, nextSyncToken);
    }

    syncLogger.info({ userId, calendarId, totalImported }, 'Initial sync completed');
    return totalImported;
  }

  async incrementalPull(api: GoogleCalendarApi, userId: number, calendarId: string): Promise<void> {
    const cal = this.calendarRepo.getCalendarByGoogleId(userId, calendarId);
    if (!cal?.sync_token) {
      await this.initialSync(api, userId, calendarId);
      return;
    }

    try {
      const result = await api.listEvents(calendarId, { syncToken: cal.sync_token });

      for (const gEvent of result.events) {
        if (gEvent.extendedProperties?.private?.hypercalendarbot_event_id) continue;

        if (gEvent.status === 'cancelled') {
          this.handleDeletedEvent(userId, calendarId, gEvent.id!);
        } else {
          await this.handleUpdatedOrNewEvent(userId, calendarId, gEvent);
        }
      }

      if (result.nextSyncToken) {
        this.calendarRepo.updateSyncToken(cal.id, result.nextSyncToken);
      }

      syncLogger.info({ userId, calendarId, changes: result.events.length }, 'Incremental pull completed');
    } catch (err: unknown) {
      const error = err as { code?: number };
      if (error.code === 410) {
        syncLogger.warn({ userId, calendarId }, 'Sync token expired, falling back to full sync');
        this.calendarRepo.updateSyncToken(cal.id, null);
        await this.initialSync(api, userId, calendarId);
        return;
      }
      throw err;
    }
  }

  async pushEvent(
    api: GoogleCalendarApi,
    userId: number,
    eventId: number,
    action: 'create' | 'update' | 'delete',
  ): Promise<void> {
    const event = this.eventRepo.findById(eventId, userId);
    if (!event || event.sync_status !== 'pending_push') return;

    const calendarId = event.google_calendar_id ?? 'primary';

    switch (action) {
      case 'create': {
        const gEvent = localToGoogle(event);
        const created = await api.insertEvent(calendarId, gEvent);
        this.eventRepo.updateSyncFields(eventId, {
          google_event_id: created.id,
          google_etag: created.etag,
          sync_status: 'synced',
          last_synced_at: new Date().toISOString(),
        });
        break;
      }
      case 'update': {
        const gEvent = localToGoogle(event);
        const updated = await api.updateEvent(calendarId, event.google_event_id!, gEvent);
        this.eventRepo.updateSyncFields(eventId, {
          google_etag: updated.etag,
          sync_status: 'synced',
          last_synced_at: new Date().toISOString(),
        });
        break;
      }
      case 'delete': {
        if (event.google_event_id) {
          await api.deleteEvent(calendarId, event.google_event_id);
        }
        this.eventRepo.remove(eventId, userId);
        break;
      }
    }

    this.syncRepo.logSync({
      user_id: userId,
      event_id: eventId,
      google_event_id: event.google_event_id ?? undefined,
      direction: 'push',
      action,
    });
  }

  resolveConflict(localEvent: CalendarEvent, googleUpdatedAt: string): 'keep_local' | 'keep_google' {
    const localMs = new Date(localEvent.updated_at).getTime();
    const googleMs = new Date(googleUpdatedAt).getTime();
    return googleMs > localMs ? 'keep_google' : 'keep_local';
  }

  private handleDeletedEvent(userId: number, calendarId: string, googleEventId: string): void {
    const existing = this.eventRepo.findByGoogleEventId(userId, calendarId, googleEventId);

    if (existing) {
      this.eventRepo.remove(existing.id, userId);
      this.syncRepo.logSync({
        user_id: userId,
        event_id: existing.id,
        google_event_id: googleEventId,
        direction: 'pull',
        action: 'delete',
      });
    }
  }

  private async handleUpdatedOrNewEvent(
    userId: number,
    calendarId: string,
    gEvent: import('googleapis').calendar_v3.Schema$Event,
  ): Promise<void> {
    const local = googleToLocal(gEvent, userId, calendarId);
    const existing = this.eventRepo.findByGoogleEventId(userId, calendarId, local.google_event_id!);

    if (existing) {
      if (existing.sync_status === 'pending_push') {
        const winner = this.resolveConflict(existing, gEvent.updated ?? '');
        if (winner === 'keep_local') {
          return;
        }
        this.syncRepo.logSync({
          user_id: userId,
          event_id: existing.id,
          google_event_id: local.google_event_id,
          direction: 'pull',
          action: 'conflict_resolve',
          details: JSON.stringify({ winner: 'google' }),
        });
        if (this.notifyUser) {
          await this.notifyUser(userId, `⚠️ Sync conflict on "${local.title}"\n\nGoogle Calendar version was applied (more recent).`);
        }
      }

      this.eventRepo.updateSyncFields(existing.id, {
        google_etag: local.google_etag,
        sync_status: 'synced',
        last_synced_at: new Date().toISOString(),
      });
      // Also update event content fields
      this.eventRepo.update(existing.id, userId, {
        title: local.title,
        description: local.description,
        start_at: local.start_at,
        end_at: local.end_at,
        all_day: local.all_day,
        timezone: local.timezone,
        location: local.location,
        recurrence_rule: local.recurrence_rule,
      });
      this.syncRepo.logSync({
        user_id: userId, event_id: existing.id,
        google_event_id: local.google_event_id,
        direction: 'pull', action: 'update',
      });
    } else {
      this.eventRepo.insertSyncedEvent({
        user_id: userId,
        title: local.title,
        description: local.description,
        start_at: local.start_at,
        end_at: local.end_at,
        all_day: local.all_day,
        timezone: local.timezone,
        location: local.location,
        recurrence_rule: local.recurrence_rule,
        google_calendar_id: calendarId,
        google_event_id: local.google_event_id!,
        google_etag: local.google_etag,
        is_cancelled: local.is_cancelled ?? false,
      });
      this.syncRepo.logSync({
        user_id: userId, google_event_id: local.google_event_id,
        direction: 'pull', action: 'create',
      });
    }
  }
}
```

- [ ] **Step 3: Run lint**

Run: `bun run lint`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/services/google/sync-service.ts
git commit -m "feat: add SyncService — initial sync, incremental pull, push, conflict resolution"
```

---

## Chunk 5: BullMQ Queue + Workers + Crons

### Task 16: Google sync BullMQ queue and workers

**Files:**
- Create: `src/services/google/sync-queue.ts`

- [ ] **Step 1: Implement queue and workers**

```ts
// src/services/google/sync-queue.ts
import { Queue, Worker } from 'bullmq';
import type { EnvConfig } from '../../config/env.ts';
import type { EventRepository } from '../../database/repositories/event.repository.ts';
import type { GoogleCalendarRepository } from '../../database/repositories/google-calendar.repository.ts';
import type { GoogleSyncRepository } from '../../database/repositories/google-sync.repository.ts';
import { GoogleCalendarApi } from './calendar-api.ts';
import type { GoogleOAuthService } from './oauth.ts';
import { SyncService } from './sync-service.ts';
import { parseRedisUrl } from '../../utils/redis.ts';
import { syncLogger } from '../../utils/logger.ts';

export type GoogleSyncJobType =
  | 'initial-sync' | 'pull-sync' | 'push-event' | 'refresh-calendars'
  | 'setup-watch' | 'stop-watch'
  | 'cron-sync-tick' | 'cron-watch-renewal-tick' | 'cron-cleanup-tick';

export interface GoogleSyncJobData {
  type: GoogleSyncJobType;
  userId: number;
  calendarId?: string;
  eventId?: number;
  action?: 'create' | 'update' | 'delete';
  trigger?: 'cron' | 'webhook' | 'manual';
}

interface GoogleSyncQueueDeps {
  config: EnvConfig;
  redisUrl: string;
  oauthService: GoogleOAuthService;
  eventRepo: EventRepository;
  syncRepo: GoogleSyncRepository;
  calendarRepo: GoogleCalendarRepository;
  onSyncComplete?: (userId: number, calendarId: string) => Promise<void>;
  onCronSyncTick?: (queue: Queue<GoogleSyncJobData>) => Promise<void>;
  onWatchRenewalTick?: () => Promise<void>;
  onCleanupTick?: () => void;
  sendMessage: (telegramId: number, text: string) => Promise<void>;
}

export function createGoogleSyncQueue(deps: GoogleSyncQueueDeps) {
  const connection = parseRedisUrl(deps.redisUrl);

  const queue = new Queue<GoogleSyncJobData>('google-sync', {
    connection,
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 5000 },
    },
  });

  const syncService = new SyncService(
    deps.eventRepo, deps.syncRepo, deps.calendarRepo, deps.sendMessage,
  );

  const worker = new Worker<GoogleSyncJobData>(
    'google-sync',
    async (job) => {
      const { type, userId, calendarId, eventId, action } = job.data;

      // Handle cron tick jobs — these dispatch real work
      if (type === 'cron-sync-tick') {
        if (deps.onCronSyncTick) await deps.onCronSyncTick(queue);
        return;
      }
      if (type === 'cron-watch-renewal-tick') {
        if (deps.onWatchRenewalTick) await deps.onWatchRenewalTick();
        return;
      }
      if (type === 'cron-cleanup-tick') {
        if (deps.onCleanupTick) deps.onCleanupTick();
        return;
      }

      syncLogger.info({ type, userId, calendarId, jobId: job.id }, 'Processing sync job');

      let authClient;
      try {
        authClient = deps.oauthService.getAuthClient(userId);
      } catch (err) {
        if ((err as { name?: string }).name === 'GoogleNotConnectedError' ||
            (err as { name?: string }).name === 'GoogleTokenRevokedError') {
          syncLogger.warn({ userId, type }, 'Skipping sync — user not connected or token revoked');
          return;
        }
        throw err;
      }

      const api = new GoogleCalendarApi(authClient);

      switch (type) {
        case 'initial-sync': {
          if (!calendarId) throw new Error('calendarId required for initial-sync');
          await syncService.initialSync(api, userId, calendarId);
          if (deps.onSyncComplete) {
            await deps.onSyncComplete(userId, calendarId);
          }
          break;
        }
        case 'pull-sync': {
          if (calendarId) {
            await syncService.incrementalPull(api, userId, calendarId);
          } else {
            const calendars = deps.calendarRepo.getEnabledCalendars(userId);
            for (const cal of calendars) {
              await syncService.incrementalPull(api, userId, cal.google_calendar_id);
            }
          }
          break;
        }
        case 'push-event': {
          if (!eventId || !action) throw new Error('eventId and action required for push-event');
          await syncService.pushEvent(api, userId, eventId, action);
          break;
        }
        case 'refresh-calendars': {
          const calendars = await api.listCalendars();
          for (const cal of calendars) {
            deps.calendarRepo.upsertCalendar(userId, {
              google_calendar_id: cal.google_calendar_id,
              calendar_name: cal.calendar_name,
              color: cal.color ?? undefined,
              is_primary: cal.is_primary,
              access_role: cal.access_role,
            });
          }
          break;
        }
        case 'setup-watch': {
          if (!calendarId || !deps.config.PUBLIC_DOMAIN) return;
          const cal = deps.calendarRepo.getCalendarByGoogleId(userId, calendarId);
          if (!cal) return;
          await syncService.setupWatchChannel(api, cal.id, calendarId, deps.config.PUBLIC_DOMAIN);
          break;
        }
        case 'stop-watch': {
          const calendars = deps.calendarRepo.getCalendars(userId);
          for (const cal of calendars) {
            const channels = deps.calendarRepo.getWatchChannels(cal.id);
            for (const ch of channels) {
              await api.stopChannel(ch.channel_id, ch.resource_id);
              deps.calendarRepo.deleteWatchChannel(ch.id);
            }
          }
          break;
        }
      }
    },
    { connection, concurrency: 3 },
  );

  worker.on('failed', (job, err) => {
    if (!job) return;
    syncLogger.error(
      { jobId: job.id, type: job.data.type, userId: job.data.userId, error: err.message, attempts: job.attemptsMade },
      'Google sync job failed',
    );

    // Handle auth errors — mark as revoked, notify user
    const errorStr = String(err);
    if (errorStr.includes('invalid_grant') || errorStr.includes('Token has been expired or revoked')) {
      deps.syncRepo.markRevoked(job.data.userId);
      deps.sendMessage(job.data.userId, '⚠️ Google Calendar connection lost. Use /connect_google to reconnect.').catch(() => {});
    }

    // Handle rate limit (429) — re-queue with Retry-After delay
    if (errorStr.includes('Rate Limit Exceeded') || (err as { code?: number }).code === 429) {
      const retryAfterMs = parseRetryAfter(err) ?? 60_000;
      queue.add(job.name, job.data, { delay: retryAfterMs }).catch(() => {});
      syncLogger.warn({ userId: job.data.userId, retryAfterMs }, 'Rate limited by Google, re-queued with delay');
    }
  });

  return { queue, worker, syncService };
}

function parseRetryAfter(err: unknown): number | undefined {
  const headers = (err as { response?: { headers?: Record<string, string> } }).response?.headers;
  const retryAfter = headers?.['retry-after'];
  if (retryAfter) return Number(retryAfter) * 1000;
  return undefined;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/services/google/sync-queue.ts
git commit -m "feat: add Google sync BullMQ queue with worker for all job types"
```

---

### Task 17: Sync cron + watch renewal cron

**Files:**
- Create: `src/services/google/sync-cron.ts`
- Create: `src/services/google/watch-renewal-cron.ts`

- [ ] **Step 1: Implement sync cron**

```ts
// src/services/google/sync-cron.ts
import type { Queue } from 'bullmq';
import type { GoogleSyncRepository } from '../../database/repositories/google-sync.repository.ts';
import type { GoogleCalendarRepository } from '../../database/repositories/google-calendar.repository.ts';
import type { GoogleSyncJobData } from './sync-queue.ts';
import { syncLogger } from '../../utils/logger.ts';

export async function setupSyncCron(queue: Queue<GoogleSyncJobData>): Promise<void> {
  await queue.add('sync-cron-tick', {
    type: 'cron-sync-tick',
    userId: 0,
  }, {
    repeat: { every: 15 * 60_000 },
    removeOnComplete: true,
    jobId: 'sync-cron-tick',
  });

  syncLogger.info('Sync cron scheduled (every 15min)');
}

export async function executeSyncCronTick(
  queue: Queue<GoogleSyncJobData>,
  syncRepo: GoogleSyncRepository,
  calendarRepo: GoogleCalendarRepository,
): Promise<void> {
  const activeUsers = syncRepo.getActiveUsers();

  for (const userId of activeUsers) {
    const calendars = calendarRepo.getEnabledCalendars(userId);
    for (const cal of calendars) {
      await queue.add('pull-sync', {
        type: 'pull-sync',
        userId,
        calendarId: cal.google_calendar_id,
        trigger: 'cron',
      }, {
        jobId: `pull-${userId}-${cal.google_calendar_id}-${Date.now()}`,
      });
    }
  }
}
```

- [ ] **Step 2: Implement watch renewal cron**

```ts
// src/services/google/watch-renewal-cron.ts
import type { Queue } from 'bullmq';
import type { EnvConfig } from '../../config/env.ts';
import type { GoogleCalendarRepository } from '../../database/repositories/google-calendar.repository.ts';
import { GoogleCalendarApi } from './calendar-api.ts';
import type { GoogleOAuthService } from './oauth.ts';
import type { GoogleSyncJobData } from './sync-queue.ts';
import { syncLogger } from '../../utils/logger.ts';

export async function setupWatchRenewalCron(queue: Queue<GoogleSyncJobData>): Promise<void> {
  await queue.add('watch-renewal-tick', {
    type: 'cron-watch-renewal-tick',
    userId: 0,
  }, {
    repeat: { every: 6 * 60 * 60_000 },
    removeOnComplete: true,
    jobId: 'watch-renewal-tick',
  });
  syncLogger.info('Watch renewal cron scheduled (every 6h)');
}

export async function renewExpiringChannels(
  config: EnvConfig,
  oauthService: GoogleOAuthService,
  calendarRepo: GoogleCalendarRepository,
): Promise<void> {
  if (!config.PUBLIC_DOMAIN) return;

  const threshold = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const expiring = calendarRepo.getExpiringChannels(threshold);

  for (const channel of expiring) {
    try {
      const authClient = oauthService.getAuthClient(channel.user_id);
      const api = new GoogleCalendarApi(authClient);

      await api.stopChannel(channel.channel_id, channel.resource_id);
      calendarRepo.deleteWatchChannel(channel.id);

      const newChannelId = crypto.randomUUID();
      const webhookUrl = `https://${config.PUBLIC_DOMAIN}/webhooks/google-calendar`;
      const expMs = Date.now() + 7 * 24 * 60 * 60 * 1000;
      const result = await api.watchEvents(channel.google_calendar_id, newChannelId, webhookUrl, expMs);

      calendarRepo.addWatchChannel(
        channel.google_calendar_row_id,
        newChannelId,
        result.resourceId,
        result.expiration,
      );

      syncLogger.info({ userId: channel.user_id, calendarId: channel.google_calendar_id }, 'Watch channel renewed');
    } catch (err) {
      syncLogger.error({ error: String(err), channelId: channel.channel_id }, 'Watch channel renewal failed');
    }
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/services/google/sync-cron.ts src/services/google/watch-renewal-cron.ts
git commit -m "feat: add sync cron (15min) and watch channel renewal cron (6h)"
```

---

## Chunk 6: Bot Integration + Wiring

### Task 18: Update EventService to trigger push sync

**Files:**
- Modify: `src/services/event/event-service.ts`

- [ ] **Step 1: Add push sync trigger**

Add an optional `pushSync` callback to EventService constructor:
```ts
constructor(
  private eventRepo: EventRepository,
  private reminderRepo: ReminderRepository,
  private materializer?: ReminderMaterializer,
  private pushSync?: (userId: number, eventId: number, action: 'create' | 'update' | 'delete') => void,
) {}
```

In `createEvent`, after existing logic:
```ts
if (this.pushSync && event.google_calendar_id) {
  this.pushSync(event.user_id, event.id, 'create');
}
```

In `updateEvent`, after existing logic:
```ts
if (this.pushSync && updated?.google_calendar_id) {
  this.pushSync(updated.user_id, updated.id, 'update');
}
```

In `deleteEvent`, before `this.eventRepo.remove`:
```ts
if (this.pushSync) {
  const event = this.eventRepo.findById(id, userId);
  if (event?.google_calendar_id) {
    this.pushSync(userId, id, 'delete');
  }
}
```

- [ ] **Step 2: Run existing tests**

Run: `bun test test/services/event/event-service.test.ts`
Expected: PASS (new param is optional)

- [ ] **Step 3: Commit**

```bash
git add src/services/event/event-service.ts
git commit -m "feat: trigger push sync from EventService on event CUD"
```

---

### Task 19: Wire everything into bot + main entrypoint

**Files:**
- Modify: `src/bot/index.ts`
- Modify: `src/bot/handlers/callback.handler.ts`
- Modify: `src/bot/commands/help.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Add GCAL callback routing to callback handler**

In `src/bot/handlers/callback.handler.ts`, add to imports:
```ts
import { handleCalendarPickerCallback } from '../commands/calendars.ts';
```

Add `calendarRepo` and `onCalendarsDone` params to `createCallbackHandler`. Add routing:
```ts
if (action === CB.GCAL) {
  const [subAction, ...subPayload] = payload.split(':');
  if (subAction === 'cal') {
    return handleCalendarPickerCallback(ctx, calendarRepo, user.telegram_id, subPayload.join(':'), lang, onCalendarsDone);
  }
  if (subAction === 'disconnect') {
    // handle disconnect confirm/cancel
    if (subPayload[0] === 'yes') {
      await executeDisconnect(user.telegram_id, disconnectDeps);
      await ctx.answer();
      return ctx.editText(t(lang).gcal_disconnected);
    }
    await ctx.answer();
    return ctx.editText('OK');
  }
  return;
}
```

- [ ] **Step 2: Add Google commands to bot/index.ts**

Import and wire `/connect_google`, `/disconnect_google`. Add google-specific services.

- [ ] **Step 3: Add Google commands to help.ts**

Add to both EN and RU help strings:
```
📡 Google Calendar
/connect_google — Connect Google Calendar
/disconnect_google — Disconnect Google Calendar
```

- [ ] **Step 4: Wire main entrypoint**

In `src/index.ts`:
- Create `GoogleOAuthService`
- Start web server (if GOOGLE_CLIENT_ID configured)
- Create google-sync BullMQ queue
- Set up crons
- Add new commands to COMMANDS_EN / COMMANDS_RU
- Add proper shutdown handling

- [ ] **Step 5: Run lint + tests**

Run: `bun run lint && bun test`
Expected: All pass, no warnings

- [ ] **Step 6: Commit**

```bash
git add src/bot/index.ts src/bot/handlers/callback.handler.ts src/bot/commands/help.ts src/index.ts
git commit -m "feat: wire Google Calendar sync into bot — commands, callbacks, entrypoint"
```

---

## Chunk 7: Watch Channel Setup + Conflict Notification + Onboarding + Cleanup

### Task 20: Watch channel setup after initial sync (conditional on PUBLIC_DOMAIN)

**Files:**
- Modify: `src/services/google/sync-service.ts` (add setupWatchChannel method)
- Already handled in Task 16: `src/services/google/sync-queue.ts` includes setup-watch + stop-watch job types

- [ ] **Step 1: Add setupWatchChannel to SyncService**

```ts
async setupWatchChannel(
  api: GoogleCalendarApi,
  calendarRowId: number,
  calendarId: string,
  publicDomain: string,
): Promise<void> {
  const channelId = crypto.randomUUID();
  const webhookUrl = `https://${publicDomain}/webhooks/google-calendar`;
  const expirationMs = Date.now() + 7 * 24 * 60 * 60 * 1000;

  const result = await api.watchEvents(calendarId, channelId, webhookUrl, expirationMs);
  this.calendarRepo.addWatchChannel(calendarRowId, channelId, result.resourceId, result.expiration);

  syncLogger.info({ calendarId, channelId }, 'Watch channel created');
}
```

- [ ] **Step 2: Enqueue setup-watch after initial sync completes (only if PUBLIC_DOMAIN)**

Note: `setup-watch` and `stop-watch` cases are already included in Task 16's queue worker.

In `onSyncComplete` callback, enqueue `setup-watch` job:
```ts
if (deps.config.PUBLIC_DOMAIN) {
  await queue.add('setup-watch', {
    type: 'setup-watch',
    userId,
    calendarId,
  });
}
```

- [ ] **Step 4: Run lint + tests**

Run: `bun run lint && bun test`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add src/services/google/sync-service.ts
git commit -m "feat: add watch channel setup/stop (conditional on PUBLIC_DOMAIN)"
```

---

### Task 21: Conflict notification to user

**Files:**
- Modify: `src/services/google/sync-service.ts`
- Modify: `src/config/constants.ts`

- [ ] **Step 1: Add conflict notification i18n strings**

Add to `MSG.en`:
```ts
gcal_conflict: (title: string, winner: string) =>
  `⚠️ Sync conflict on "${title}"\n\n${winner === 'google' ? 'Google Calendar' : 'Local'} version was applied (more recent).`,
```

Add to `MSG.ru`:
```ts
gcal_conflict: (title: string, winner: string) =>
  `⚠️ Конфликт синхронизации "${title}"\n\n${winner === 'google' ? 'Google Calendar' : 'Локальная'} версия применена (более новая).`,
```

- [ ] **Step 2: Verify conflict notification is wired**

The `notifyUser` callback is already part of SyncService constructor (Task 15) and called in `handleUpdatedOrNewEvent` when Google wins a conflict. Verify the `sendMessage` callback is passed through from sync-queue deps → SyncService constructor in Task 16.

- [ ] **Step 3: Run lint + tests**

Run: `bun run lint && bun test`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add src/services/google/sync-service.ts src/config/constants.ts
git commit -m "feat: add conflict notification to user on sync conflicts"
```

---

### Task 22: Cleanup cron — sync_log pruning, dead channels

**Files:**
- Create: `src/services/google/cleanup-cron.ts`

- [ ] **Step 1: Implement cleanup cron**

```ts
// src/services/google/cleanup-cron.ts
import type { Queue } from 'bullmq';
import type { GoogleCalendarRepository } from '../../database/repositories/google-calendar.repository.ts';
import type { GoogleSyncRepository } from '../../database/repositories/google-sync.repository.ts';
import type { GoogleSyncJobData } from './sync-queue.ts';
import { syncLogger } from '../../utils/logger.ts';

const SYNC_LOG_RETENTION_DAYS = 30;

export async function setupCleanupCron(queue: Queue<GoogleSyncJobData>): Promise<void> {
  await queue.add('cleanup-tick', {
    type: 'cron-cleanup-tick',
    userId: 0,
  }, {
    repeat: { every: 24 * 60 * 60_000 },
    removeOnComplete: true,
    jobId: 'cleanup-tick',
  });
  syncLogger.info('Cleanup cron scheduled (daily)');
}

export function executeCleanup(
  syncRepo: GoogleSyncRepository,
  calendarRepo: GoogleCalendarRepository,
): void {
  syncRepo.pruneOldLogs(SYNC_LOG_RETENTION_DAYS);

  const nowIso = new Date().toISOString();
  const expired = calendarRepo.getExpiringChannels(nowIso);
  for (const ch of expired) {
    if (new Date(ch.expiration) < new Date()) {
      calendarRepo.deleteWatchChannel(ch.id);
    }
  }

  syncLogger.info('Cleanup completed');
}
```

- [ ] **Step 2: Commit**

```bash
git add src/services/google/cleanup-cron.ts
git commit -m "feat: add daily cleanup cron — prune sync_log, remove expired watch channels"
```

---

### Task 23: Google Calendar onboarding prompt

**Files:**
- Modify: `src/config/constants.ts` (i18n)
- Modify: `src/bot/commands/start.ts` or onboarding scene

- [ ] **Step 1: Add onboarding i18n strings**

Add to `MSG.en`:
```ts
gcal_onboarding: 'Want to sync with Google Calendar?\n\nYour events will stay in the bot either way. Google Calendar sync is optional but gives you:\n- See bot events in your phone calendar\n- Changes in Google Calendar auto-sync to the bot\n- Two-way sync keeps everything up to date',
gcal_onboarding_maybe_later: 'Maybe Later',
```

Add equivalent to `MSG.ru`:
```ts
gcal_onboarding: 'Хотите синхронизировать с Google Calendar?\n\nСобытия останутся в боте в любом случае. Синхронизация даёт:\n- Просмотр событий бота в Google Calendar\n- Изменения в Google Calendar авто-синхронизируются\n- Двусторонняя синхронизация',
gcal_onboarding_maybe_later: 'Позже',
```

- [ ] **Step 2: Show onboarding prompt after /start completes (if Google configured)**

After onboarding completes, check if `oauthService.isConfigured()` and user has no `google_refresh_token_enc`. If so, show the prompt with "Connect Google Calendar" (URL button) and "Maybe Later" (callback button).

The "Maybe Later" behavior: dismiss for now. Implementation note: `onboarding_gcal_dismissed_at` and `onboarding_gcal_dismiss_count` fields can be stored in notification_preferences or a simple key-value approach. For v1, just dismiss — re-prompt logic is low priority.

- [ ] **Step 3: Commit**

```bash
git add src/config/constants.ts src/bot/commands/start.ts
git commit -m "feat: add Google Calendar onboarding prompt after /start"
```

---

### Task 24: Final integration — install googleapis, verify build

- [ ] **Step 1: Verify googleapis is installed**

Run: `bun install googleapis`

- [ ] **Step 2: Run full test suite**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 3: Run lint**

Run: `bun run lint`
Expected: Zero warnings

- [ ] **Step 4: Run тайпчекер**

Run: `bunx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Final commit (if any uncommitted changes remain)**

```bash
git add package.json bun.lock
git commit -m "chore: add googleapis dependency"
```
