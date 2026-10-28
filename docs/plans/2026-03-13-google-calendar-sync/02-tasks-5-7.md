> Part 2 of 5 of [Google Calendar Sync Implementation Plan](../2026-03-13-google-calendar-sync.md) — previous: [01-overview-tasks-1-4.md](01-overview-tasks-1-4.md) · next: [03-tasks-8-11.md](03-tasks-8-11.md)

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

