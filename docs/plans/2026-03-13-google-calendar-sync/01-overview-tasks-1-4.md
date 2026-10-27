> Part 1 of 5 of [Google Calendar Sync Implementation Plan](../2026-03-13-google-calendar-sync.md) — next: [02-tasks-5-7.md](02-tasks-5-7.md)

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

