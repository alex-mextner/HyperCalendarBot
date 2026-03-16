# Sub-Project #3: Google Calendar Sync

## Overview

Google Calendar is an **optional** bidirectional sync layer. The bot has its own event model in SQLite. Users who opt in get their local events mirrored to/from Google Calendar. Users who don't connect Google still have a fully functional calendar bot.

Key constraint: all sync operations run in the **worker process** via BullMQ, never in the bot process.

### Implementation Decisions

- **Google API client**: `googleapis` npm package (not raw HTTP)
- **Two-mode architecture**:
  - **Webhook mode** (`PUBLIC_DOMAIN` is set): Bun.serve handles OAuth callback + Google Calendar webhooks; bot uses webhooks too
  - **Polling mode** (`PUBLIC_DOMAIN` is not set): no HTTP server for webhooks, cron-based incremental pull every 15 min; OAuth callback still served via Bun.serve on localhost
- **Redis**: `REDIS_URL` env variable (required), used for BullMQ job queues and OAuth state parameter storage (5min TTL, one-time use)
- **GOOGLE_* env vars are optional**: if not set, Google sync features are disabled but the bot works normally

---

## 1. OAuth 2.0 Flow

### 1.1. Environment Variables

```
REDIS_URL=redis://localhost:6379          # Required — BullMQ + OAuth state storage
GOOGLE_CLIENT_ID=...                      # Optional — Google sync disabled if not set
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=https://<domain>/oauth/google/callback
OAUTH_SERVER_PORT=3311
ENCRYPTION_KEY=<64-char hex string = 32 bytes for AES-256-GCM>
PUBLIC_DOMAIN=example.com                 # Optional — enables webhook mode (HTTPS required)
```

### 1.2. Scopes

```ts
const GOOGLE_CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
];
```

- `calendar.readonly` -- read all calendars and events (needed for pull sync and listing calendars)
- `calendar.events` -- create/update/delete events in calendars the user owns or has write access to

### 1.3. Flow Step by Step

```
User                     Bot                      Bun.serve              Google
  |                       |                          |                     |
  |-- /connect_google --->|                          |                     |
  |                       |-- generate auth URL ---->|                     |
  |                       |   (state = random UUID,  |                     |
  |                       |    stored in Redis with  |                     |
  |                       |    telegram_user_id,     |                     |
  |                       |    ttl=5min)             |                     |
  |<-- inline button -----|                          |                     |
  |   "Connect Google"    |                          |                     |
  |                       |                          |                     |
  |-- clicks button ------+------------------------->|                     |
  |                       |                          |-- redirect -------->|
  |                       |                          |                     |
  |                       |                          |<-- callback --------|
  |                       |                          |   ?code=...&state=..|
  |                       |                          |                     |
  |                       |                          |-- exchange code --->|
  |                       |                          |<-- tokens ----------|
  |                       |                          |                     |
  |                       |<-- resolve promise ------|                     |
  |                       |   (or write to DB        |                     |
  |                       |    + notify via Redis)   |                     |
  |                       |                          |                     |
  |<-- "Connected!" ------|                          |                     |
  |   + calendar picker   |                          |                     |
```

### 1.4. State Parameter Security

Unlike ExpenseSyncBot (which passes `groupId` directly in `state`), we use a random UUID:

```ts
// On auth URL generation:
const stateId = crypto.randomUUID();
await redis.set(`oauth:state:${stateId}`, JSON.stringify({
  telegram_user_id: userId,
  created_at: Date.now(),
}), 'EX', 300); // 5 min TTL

// On callback:
const payload = await redis.get(`oauth:state:${state}`);
if (!payload) return new Response('State expired or invalid', { status: 400 });
await redis.del(`oauth:state:${state}`); // one-time use
```

This prevents state injection and replay attacks.

### 1.5. Token Exchange and Storage

```ts
import { encrypt } from '../../utils/crypto';

const { tokens } = await oauth2Client.getToken(code);

// Encrypt refresh token before storing (AES-256-GCM via src/utils/crypto.ts)
const encryptedRefreshToken = encrypt(tokens.refresh_token, env.ENCRYPTION_KEY);

// Store encrypted refresh token on users table (canonical schema)
db.run(`
  UPDATE users SET
    google_refresh_token_enc = ?,
    updated_at = datetime('now')
  WHERE telegram_id = ?
`, [encryptedRefreshToken, userId]);

// Store additional OAuth metadata in google_sync_state
db.run(`
  INSERT INTO google_sync_state (user_id, status, scopes)
  VALUES (?, 'active', ?)
  ON CONFLICT (user_id) DO UPDATE SET
    status = 'active',
    scopes = excluded.scopes,
    updated_at = datetime('now')
`, [userId, GOOGLE_CALENDAR_SCOPES.join(' ')]);
```

### 1.6. Token Refresh

The `googleapis` library handles refresh automatically when you set `refresh_token` on the client. But we also need to:

1. Catch `invalid_grant` errors (token revoked) and mark the connection as broken
2. Update stored `access_token` / `expires_at` after each refresh to reduce unnecessary refreshes
3. Handle concurrent refresh attempts with a Redis lock:

```ts
import { decrypt } from '../../utils/crypto';

async function getAuthClient(userId: number): Promise<OAuth2Client> {
  const user = db.get(
    'SELECT google_refresh_token_enc FROM users WHERE telegram_id = ?',
    userId,
  );
  if (!user?.google_refresh_token_enc) throw new GoogleNotConnectedError(userId);

  // Decrypt refresh token using canonical crypto utility (src/utils/crypto.ts)
  const refreshToken = decrypt(user.google_refresh_token_enc, env.ENCRYPTION_KEY);

  const client = new google.auth.OAuth2(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    env.GOOGLE_REDIRECT_URI,
  );

  client.setCredentials({ refresh_token: refreshToken });

  // Listen for token refresh (access tokens are short-lived, no encryption needed)
  client.on('tokens', (newTokens) => {
    db.run(`
      UPDATE google_sync_state
      SET access_token = ?, expires_at = ?, updated_at = datetime('now')
      WHERE user_id = ?
    `, [newTokens.access_token, newTokens.expiry_date, userId]);
  });

  return client;
}
```

### 1.7. Revoked Access Handling

When Google returns `invalid_grant`:

1. Mark `google_sync_state.status = 'revoked'`
2. Send Telegram notification: "Your Google Calendar connection was lost. Use /connect_google to reconnect."
3. Pause all sync jobs for this user
4. Local events are untouched -- they remain in SQLite

---

## 2. SQLite Schema Additions

### 2.1. Token Storage (on `users` table) + `google_sync_state`

Per the canonical architecture (00), the encrypted refresh token is stored directly on the `users` table as `google_refresh_token_enc` (AES-256-GCM via `src/utils/crypto.ts`). There is no separate `google_oauth_tokens` table.

The `users` table columns relevant to Google Sync (from migration 007):

```sql
-- These columns already exist on the canonical users table:
--   google_refresh_token_enc TEXT    -- AES-256-GCM encrypted refresh token
--   google_calendar_id TEXT          -- primary calendar ID to sync
```

Additional sync metadata is stored in `google_sync_state`:

```sql
CREATE TABLE google_sync_state (
  user_id INTEGER PRIMARY KEY,                -- telegram_id
  access_token TEXT,                           -- short-lived, unencrypted (acceptable tradeoff)
  expires_at TEXT,                             -- ISO 8601 UTC
  scopes TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked', 'expired')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
);
```

### 2.2. google_calendars

```sql
CREATE TABLE google_calendars (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,               -- telegram_id
  google_calendar_id TEXT NOT NULL,       -- e.g. 'primary', 'abc123@group.calendar.google.com'
  calendar_name TEXT NOT NULL,
  color TEXT,                             -- hex color from Google
  is_primary INTEGER NOT NULL DEFAULT 0,
  sync_enabled INTEGER NOT NULL DEFAULT 1,
  access_role TEXT NOT NULL DEFAULT 'owner'
    CHECK (access_role IN ('owner', 'writer', 'reader', 'freeBusyReader')),
  sync_token TEXT,                        -- incremental sync token from Google
  last_synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE,
  UNIQUE (user_id, google_calendar_id)
);

CREATE INDEX idx_google_calendars_user_id ON google_calendars(user_id);
```

### 2.3. google_watch_channels

```sql
CREATE TABLE google_watch_channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  google_calendar_row_id INTEGER NOT NULL,
  channel_id TEXT NOT NULL UNIQUE,        -- UUID we generate
  resource_id TEXT NOT NULL,              -- Google returns this
  expiration TEXT NOT NULL,               -- ISO 8601 UTC
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (google_calendar_row_id) REFERENCES google_calendars(id) ON DELETE CASCADE
);

CREATE INDEX idx_watch_channels_expiration ON google_watch_channels(expiration);
```

### 2.4. Event Sync Fields (additions to existing events table)

```sql
ALTER TABLE events ADD COLUMN google_calendar_id TEXT;      -- FK to google_calendars.google_calendar_id
ALTER TABLE events ADD COLUMN google_event_id TEXT;          -- Google's event ID
ALTER TABLE events ADD COLUMN google_etag TEXT;              -- for conflict detection
ALTER TABLE events ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'local_only'
  CHECK (sync_status IN (
    'local_only',       -- never synced (user has no Google connected, or new event)
    'synced',           -- in sync with Google
    'pending_push',     -- local change not yet pushed
    'pending_pull',     -- Google change not yet applied locally
    'conflict',         -- both sides changed
    'push_failed'       -- push attempt failed
  ));
ALTER TABLE events ADD COLUMN sync_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE events ADD COLUMN last_synced_at TEXT;

CREATE UNIQUE INDEX idx_events_google_event
  ON events(google_calendar_id, google_event_id)
  WHERE google_event_id IS NOT NULL;
```

### 2.5. sync_log (for debugging and conflict resolution audit)

```sql
CREATE TABLE sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,               -- telegram_id
  event_id INTEGER,
  google_event_id TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('push', 'pull')),
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete', 'conflict_resolve')),
  details TEXT,                           -- JSON with before/after state
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
);

CREATE INDEX idx_sync_log_user_created ON sync_log(user_id, created_at);
```

---

## 3. Event Field Mapping

### 3.1. Field Mapping Table

| Local Event Field     | Google Calendar Field        | Notes                                          |
| --------------------- | ---------------------------- | ---------------------------------------------- |
| `title`               | `summary`                    | Direct map                                     |
| `description`         | `description`                | Direct map                                     |
| `start_at`          | `start.dateTime`             | ISO 8601 with timezone offset                  |
| `end_at`            | `end.dateTime`               | ISO 8601 with timezone offset                  |
| `all_day`             | `start.date` / `end.date`    | All-day events use `date` instead of `dateTime` |
| `timezone`            | `start.timeZone`             | IANA timezone (e.g. `Europe/Belgrade`)          |
| `location`            | `location`                   | Free-text string                               |
| `recurrence_rule`     | `recurrence`                 | RRULE strings (RFC 5545), array in Google       |
| `color`               | `colorId`                    | Google uses numeric IDs 1-11, map to hex        |
| `reminders`           | `reminders.overrides`        | Array of `{method, minutes}`                   |
| `attendees`           | `attendees`                  | Not synced in v1 (privacy + complexity)         |
| `created_at`          | `created`                    | Read-only from Google                          |
| `updated_at`          | `updated`                    | Used for conflict detection                    |
| `google_event_id`     | `id`                         | Google's unique event ID                       |
| `google_etag`         | `etag`                       | Opaque version string from Google              |
| `google_calendar_id`  | (parent calendar)            | Which calendar this event belongs to           |

### 3.2. Mapping Implementation

```ts
interface LocalEvent {
  id: number;
  user_id: number;
  title: string;
  description: string | null;
  start_at: string;         // ISO 8601
  end_at: string;            // ISO 8601
  all_day: boolean;
  timezone: string;
  location: string | null;
  recurrence_rule: string | null;
  color: string | null;
  reminders: string | null;   // JSON: [{method: 'popup', minutes: 15}]
  google_calendar_id: string | null;
  google_event_id: string | null;
  google_etag: string | null;
  sync_status: SyncStatus;
  sync_version: number;
  last_synced_at: string | null;
}

function localToGoogleEvent(local: LocalEvent): calendar_v3.Schema$Event {
  const event: calendar_v3.Schema$Event = {
    summary: local.title,
    description: local.description ?? undefined,
    location: local.location ?? undefined,
  };

  if (local.all_day) {
    event.start = { date: local.start_at.split('T')[0] };
    event.end = { date: local.end_at.split('T')[0] };
  } else {
    event.start = { dateTime: local.start_at, timeZone: local.timezone };
    event.end = { dateTime: local.end_at, timeZone: local.timezone };
  }

  if (local.recurrence_rule) {
    event.recurrence = [local.recurrence_rule];
  }

  if (local.reminders) {
    const overrides = JSON.parse(local.reminders);
    event.reminders = { useDefault: false, overrides };
  }

  return event;
}

function googleToLocalEvent(
  gEvent: calendar_v3.Schema$Event,
  userId: number,
  googleCalendarId: string,
): Partial<LocalEvent> {
  const isAllDay = !!gEvent.start?.date;

  return {
    user_id: userId,
    title: gEvent.summary ?? 'Untitled',
    description: gEvent.description ?? null,
    start_at: isAllDay
      ? gEvent.start!.date!
      : gEvent.start!.dateTime!,
    end_at: isAllDay
      ? gEvent.end!.date!
      : gEvent.end!.dateTime!,
    all_day: isAllDay,
    timezone: gEvent.start?.timeZone ?? 'UTC',
    location: gEvent.location ?? null,
    recurrence_rule: gEvent.recurrence?.[0] ?? null,
    google_calendar_id: googleCalendarId,
    google_event_id: gEvent.id!,
    google_etag: gEvent.etag ?? null,
    reminders: gEvent.reminders?.overrides
      ? JSON.stringify(gEvent.reminders.overrides)
      : null,
  };
}
```

### 3.3. Fields NOT Synced (v1)

- **Attendees** -- privacy implications, needs separate consent model
- **Attachments** -- complexity, low value for a Telegram bot
- **Conference data** (Meet links) -- read-only, we can display but not create
- **Extended properties** -- we'll use these later for tagging events as "created by HyperCalendarBot"

### 3.4. HyperCalendarBot Identifier

When pushing events to Google, set an extended property to mark provenance:

```ts
event.extendedProperties = {
  private: {
    hypercalendarbot_event_id: String(localEvent.id),
    hypercalendarbot_version: String(localEvent.sync_version),
  },
};
```

This prevents us from re-importing our own pushes during pull sync.

---

## 4. Sync Architecture

### 4.1. High-Level Architecture

```
                                    ┌─────────────────────┐
                                    │   Google Calendar    │
                                    │        API           │
                                    └──────┬──────┬───────┘
                                           │      │
                              push events  │      │ pull events / webhooks
                                           │      │
┌──────────┐    BullMQ     ┌───────────────▼──────▼───────────────┐
│   Bot    │ ─────────────>│          Worker Process              │
│ Process  │  enqueue jobs │                                      │
│ (GramIO) │<──────────────│  ┌─────────┐  ┌────────┐  ┌───────┐ │
│          │  notify user  │  │  Push    │  │  Pull  │  │ Watch │ │
└──────────┘               │  │  Sync   │  │  Sync  │  │ Renew │ │
                           │  └─────────┘  └────────┘  └───────┘ │
                           └──────────────────┬───────────────────┘
                                              │
                                    ┌─────────▼─────────┐
                                    │  SQLite + Redis    │
                                    └────────────────────┘
```

### 4.2. BullMQ Job Types

| Queue                     | Job Type              | Trigger                                    | Description                                       |
| ------------------------- | --------------------- | ------------------------------------------ | ------------------------------------------------- |
| `google-sync`             | `initial-sync`        | User connects Google                       | Fetch all events from all enabled calendars        |
| `google-sync`             | `pull-sync`           | Cron (every 15 min) or webhook             | Incremental pull using syncToken                   |
| `google-sync`             | `push-event`          | Local event created/updated/deleted        | Push single event change to Google                 |
| `google-sync`             | `resolve-conflict`    | Conflict detected during pull              | Apply conflict resolution strategy                 |
| `google-sync`             | `refresh-calendars`   | User requests / periodic                   | Re-fetch calendar list                             |
| `google-watch`            | `setup-watch`         | After initial sync                         | Create watch channel for calendar                  |
| `google-watch`            | `renew-watch`         | Cron (check expiring channels)             | Renew channels expiring within 24h                 |
| `google-watch`            | `stop-watch`          | User disconnects Google                    | Stop watch channel                                 |

### 4.3. Pull Sync (Google -> Local)

#### Initial Full Sync

On first connection, after user selects calendars:

```ts
async function initialSync(userId: number, calendarId: string): Promise<void> {
  const auth = await getAuthClient(userId);
  const calendar = google.calendar({ version: 'v3', auth });

  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;
  const allEvents: calendar_v3.Schema$Event[] = [];

  do {
    const res = await calendar.events.list({
      calendarId,
      maxResults: 250,
      singleEvents: false,   // keep recurring event masters
      pageToken,
      timeMin: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(), // last 90 days
    });

    allEvents.push(...(res.data.items ?? []));
    pageToken = res.data.nextPageToken ?? undefined;
    nextSyncToken = res.data.nextSyncToken ?? undefined;
  } while (pageToken);

  // Batch insert events
  const insertStmt = db.prepare(`
    INSERT INTO events (user_id, title, description, start_at, end_at, all_day,
      timezone, location, recurrence_rule, google_calendar_id, google_event_id,
      google_etag, sync_status, sync_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced', 0)
  `);

  const insertMany = db.transaction((events: calendar_v3.Schema$Event[]) => {
    for (const gEvent of events) {
      const local = googleToLocalEvent(gEvent, userId, calendarId);
      insertStmt.run(
        local.user_id, local.title, local.description,
        local.start_at, local.end_at, local.all_day ? 1 : 0,
        local.timezone, local.location, local.recurrence_rule,
        local.google_calendar_id, local.google_event_id, local.google_etag,
      );
    }
  });
  insertMany(allEvents);

  // Save sync token
  db.run(`
    UPDATE google_calendars SET sync_token = ?, last_synced_at = datetime('now')
    WHERE user_id = ? AND google_calendar_id = ?
  `, [nextSyncToken, userId, calendarId]);
}
```

#### Incremental Sync

```ts
async function incrementalPull(userId: number, calendarId: string): Promise<void> {
  const cal = db.get(
    'SELECT * FROM google_calendars WHERE user_id = ? AND google_calendar_id = ?',
    [userId, calendarId]
  );

  if (!cal?.sync_token) {
    // Fallback to full sync
    return initialSync(userId, calendarId);
  }

  const auth = await getAuthClient(userId);
  const calendar = google.calendar({ version: 'v3', auth });

  try {
    const res = await calendar.events.list({
      calendarId,
      syncToken: cal.sync_token,
    });

    for (const gEvent of res.data.items ?? []) {
      if (gEvent.status === 'cancelled') {
        handleDeletedEvent(userId, calendarId, gEvent.id!);
      } else {
        handleUpdatedOrNewEvent(userId, calendarId, gEvent);
      }
    }

    // Save new sync token
    db.run(`
      UPDATE google_calendars SET sync_token = ?, last_synced_at = datetime('now')
      WHERE user_id = ? AND google_calendar_id = ?
    `, [res.data.nextSyncToken, userId, calendarId]);

  } catch (err: any) {
    if (err.code === 410) {
      // Sync token expired, do full sync
      db.run(`UPDATE google_calendars SET sync_token = NULL WHERE id = ?`, cal.id);
      return initialSync(userId, calendarId);
    }
    throw err;
  }
}
```

### 4.4. Push Sync (Local -> Google)

When a local event is created/updated/deleted:

1. Bot marks `sync_status = 'pending_push'` and increments `sync_version`
2. Bot enqueues `push-event` job to BullMQ
3. Worker picks up the job:

```ts
async function pushEvent(job: Job<PushEventData>): Promise<void> {
  const { userId, eventId, action } = job.data;

  const event = db.get('SELECT * FROM events WHERE id = ?', eventId);
  if (!event || event.sync_status !== 'pending_push') return;

  const auth = await getAuthClient(userId);
  const calendarApi = google.calendar({ version: 'v3', auth });
  const calendarId = event.google_calendar_id ?? 'primary';

  try {
    switch (action) {
      case 'create': {
        const gEvent = localToGoogleEvent(event);
        gEvent.extendedProperties = {
          private: {
            hypercalendarbot_event_id: String(event.id),
            hypercalendarbot_version: String(event.sync_version),
          },
        };
        const res = await calendarApi.events.insert({
          calendarId,
          requestBody: gEvent,
        });
        db.run(`
          UPDATE events SET
            google_event_id = ?, google_etag = ?,
            sync_status = 'synced', last_synced_at = datetime('now')
          WHERE id = ?
        `, [res.data.id, res.data.etag, eventId]);
        break;
      }

      case 'update': {
        const gEvent = localToGoogleEvent(event);
        const res = await calendarApi.events.update({
          calendarId,
          eventId: event.google_event_id!,
          requestBody: gEvent,
        });
        db.run(`
          UPDATE events SET
            google_etag = ?, sync_status = 'synced',
            last_synced_at = datetime('now')
          WHERE id = ?
        `, [res.data.etag, eventId]);
        break;
      }

      case 'delete': {
        await calendarApi.events.delete({
          calendarId,
          eventId: event.google_event_id!,
        });
        db.run('DELETE FROM events WHERE id = ?', eventId);
        break;
      }
    }

    // Log sync action
    db.run(`
      INSERT INTO sync_log (user_id, event_id, google_event_id, direction, action)
      VALUES (?, ?, ?, 'push', ?)
    `, [userId, eventId, event.google_event_id, action]);

  } catch (err: any) {
    if (err.code === 401 || err.code === 403) {
      await handleRevokedAccess(userId);
    } else if (err.code === 409) {
      // Conflict -- someone else changed it on Google side
      db.run(`UPDATE events SET sync_status = 'conflict' WHERE id = ?`, eventId);
      await notifyConflict(userId, eventId);
    } else {
      db.run(`UPDATE events SET sync_status = 'push_failed' WHERE id = ?`, eventId);
      throw err; // Let BullMQ retry
    }
  }
}
```

### 4.5. Sync Frequency

| Mechanism                | Frequency            | Purpose                               |
| ------------------------ | -------------------- | ------------------------------------- |
| Push on local change     | Immediate            | User creates/edits/deletes event      |
| Webhook callback         | Real-time            | Google notifies us of changes         |
| Cron incremental pull    | Every 15 minutes     | Catch missed webhooks                 |
| Watch channel renewal    | Every 6 hours        | Renew channels expiring within 24h    |
| Full re-sync             | Weekly / on demand   | Safety net, reset sync tokens         |

---

## 5. Conflict Resolution

### 5.1. Strategy: Last-Write-Wins with User Notification

We don't silently merge. The last write wins, but the user is told about it.

### 5.2. Conflict Detection

A conflict occurs when:

- Pull sync finds an event that was modified on Google (`updated` field > our `last_synced_at`)
- AND the same event has `sync_status = 'pending_push'` locally (local modifications not yet pushed)

### 5.3. Resolution Algorithm

```ts
function resolveConflict(localEvent: LocalEvent, googleEvent: GoogleEvent): 'keep_local' | 'keep_google' {
  const localModifiedAt = new Date(localEvent.updated_at).getTime();
  const googleModifiedAt = new Date(googleEvent.updated).getTime();

  // Last-write-wins
  if (googleModifiedAt > localModifiedAt) {
    return 'keep_google';
  }
  return 'keep_local';
}
```

### 5.4. Conflict Notification to User

```
⚠️ Sync conflict on event "Team Meeting"

Your local version (edited 5 min ago):
  📅 Mar 12, 14:00-15:00

Google Calendar version (edited 2 min ago):
  📅 Mar 12, 15:00-16:00

Google version was applied (more recent).
Use /event_123 to view or edit.
```

### 5.5. Conflict Log

Every conflict resolution is recorded in `sync_log` with `action = 'conflict_resolve'` and `details` JSON containing both versions. This allows investigation if users report issues.

---

## 6. Google Calendar Webhooks (Push Notifications)

### 6.1. How It Works

Google sends a POST to our webhook URL when a calendar changes. We don't get the actual event data in the webhook -- just a notification that _something_ changed. We then do an incremental sync.

### 6.2. Watch Channel Setup

```ts
async function setupWatchChannel(
  userId: number,
  googleCalendarRowId: number,
  calendarId: string,
): Promise<void> {
  const auth = await getAuthClient(userId);
  const calendarApi = google.calendar({ version: 'v3', auth });

  const channelId = crypto.randomUUID();

  const res = await calendarApi.events.watch({
    calendarId,
    requestBody: {
      id: channelId,
      type: 'web_hook',
      address: `${env.WEBHOOK_BASE_URL}/webhooks/google-calendar`,
      // Max expiration: ~30 days, but Google often gives less
      expiration: String(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });

  db.run(`
    INSERT INTO google_watch_channels (google_calendar_row_id, channel_id, resource_id, expiration)
    VALUES (?, ?, ?, ?)
  `, [googleCalendarRowId, channelId, res.data.resourceId,
      new Date(Number(res.data.expiration)).toISOString()]);
}
```

### 6.3. Webhook Handler

```ts
// In Bun.serve route handler:
if (req.method === 'POST' && url.pathname === '/webhooks/google-calendar') {
  const channelId = req.headers.get('x-goog-channel-id');
  const resourceId = req.headers.get('x-goog-resource-id');
  const resourceState = req.headers.get('x-goog-resource-state');

  // Verify the channel belongs to us
  const channel = db.get(
    'SELECT * FROM google_watch_channels WHERE channel_id = ? AND resource_id = ?',
    [channelId, resourceId]
  );

  if (!channel) {
    return new Response('Unknown channel', { status: 404 });
  }

  // Respond immediately (Google expects quick response)
  // Then enqueue sync job
  if (resourceState === 'exists' || resourceState === 'sync') {
    const cal = db.get('SELECT * FROM google_calendars WHERE id = ?', channel.google_calendar_row_id);
    if (cal) {
      await syncQueue.add('pull-sync', {
        userId: cal.user_id,
        calendarId: cal.google_calendar_id,
        trigger: 'webhook',
      }, {
        // Debounce: if multiple webhook calls arrive within 5s, only run once
        jobId: `pull-${cal.user_id}-${cal.google_calendar_id}`,
        delay: 2000,
      });
    }
  }

  return new Response('OK', { status: 200 });
}
```

### 6.4. Channel Renewal

Channels expire (typically 7 days, Google decides). A BullMQ repeatable job checks every 6 hours:

```ts
async function renewExpiringChannels(): Promise<void> {
  const threshold = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // expiring within 24h

  const expiringChannels = db.all(`
    SELECT wc.*, gc.user_id, gc.google_calendar_id
    FROM google_watch_channels wc
    JOIN google_calendars gc ON gc.id = wc.google_calendar_row_id
    JOIN google_sync_state gs ON gs.user_id = gc.user_id AND gs.status = 'active'
    WHERE wc.expiration < ?
  `, [threshold]);

  for (const channel of expiringChannels) {
    try {
      // Stop old channel
      const auth = await getAuthClient(channel.user_id);
      const calendarApi = google.calendar({ version: 'v3', auth });
      await calendarApi.channels.stop({
        requestBody: {
          id: channel.channel_id,
          resourceId: channel.resource_id,
        },
      });

      // Delete old channel record
      db.run('DELETE FROM google_watch_channels WHERE id = ?', channel.id);

      // Create new channel
      await setupWatchChannel(
        channel.user_id,
        channel.google_calendar_row_id,
        channel.google_calendar_id,
      );
    } catch (err) {
      console.error(`Failed to renew watch channel ${channel.channel_id}:`, err);
      // Will retry on next cron run
    }
  }
}
```

### 6.5. Webhook URL Requirements

- Must be HTTPS (Google requirement)
- Must be a publicly reachable URL
- Must respond within ~10 seconds
- Domain must be verified in Google Search Console

For development: use a tunnel (e.g. ngrok, Cloudflare Tunnel).

### 6.6. Polling Mode (no PUBLIC_DOMAIN)

When `PUBLIC_DOMAIN` is not set, webhooks are not available. The system falls back to:
- **Cron-based incremental pull** every 15 minutes for all active users/calendars
- No watch channel setup, renewal, or webhook handler
- All other features (OAuth, push sync, conflict resolution) work identically

This mode is suitable for development and deployments without a public domain.

---

## 7. Multi-Calendar Support

### 7.1. Calendar Discovery

After OAuth, fetch the user's calendar list:

```ts
async function fetchCalendarList(userId: number): Promise<CalendarInfo[]> {
  const auth = await getAuthClient(userId);
  const calendarApi = google.calendar({ version: 'v3', auth });

  const res = await calendarApi.calendarList.list();

  return (res.data.items ?? []).map(cal => ({
    google_calendar_id: cal.id!,
    calendar_name: cal.summary ?? 'Untitled',
    color: cal.backgroundColor ?? null,
    is_primary: cal.primary ?? false,
    access_role: cal.accessRole as AccessRole,
  }));
}
```

### 7.2. Calendar Selection UX

After connection, show the user their calendars with inline keyboard:

```
Found 3 calendars:

[x] Personal (primary)
[ ] Work
[ ] Birthdays (read-only)

Select which calendars to sync.
Tap to toggle, then press Done.
```

- Read-only calendars (`freeBusyReader`, `reader`) are displayed but clearly marked. We can pull events from them but never push.
- By default, only the primary calendar is selected.

### 7.3. Default Calendar for New Events

When user creates a local event without specifying a calendar, it goes to their default calendar. The default is:

1. The primary Google calendar if connected
2. Or whichever calendar they explicitly set as default
3. Or `null` (local-only, no Google sync)

---

## 8. Disconnect Flow

### 8.1. /disconnect_google Command

```ts
async function handleDisconnectGoogle(userId: number): Promise<void> {
  // 1. Stop all watch channels
  const calendars = db.all(
    'SELECT id FROM google_calendars WHERE user_id = ?', userId
  );
  for (const cal of calendars) {
    const channels = db.all(
      'SELECT * FROM google_watch_channels WHERE google_calendar_row_id = ?', cal.id
    );
    for (const ch of channels) {
      try {
        const auth = await getAuthClient(userId);
        await google.calendar({ version: 'v3', auth }).channels.stop({
          requestBody: { id: ch.channel_id, resourceId: ch.resource_id },
        });
      } catch { /* channel may already be expired */ }
    }
  }

  // 2. Revoke Google token
  const user = db.get('SELECT google_refresh_token_enc FROM users WHERE telegram_id = ?', userId);
  if (user?.google_refresh_token_enc) {
    try {
      const refreshToken = decrypt(user.google_refresh_token_enc, env.ENCRYPTION_KEY);
      await revokeToken(refreshToken);
    } catch { /* token may already be revoked */ }
  }

  // 3. Clean up DB
  db.run(`
    DELETE FROM google_watch_channels
    WHERE google_calendar_row_id IN (SELECT id FROM google_calendars WHERE user_id = ?)
  `, userId);
  db.run('DELETE FROM google_calendars WHERE user_id = ?', userId);
  db.run('DELETE FROM google_sync_state WHERE user_id = ?', userId);

  // Clear encrypted token from users table
  db.run(`
    UPDATE users SET
      google_refresh_token_enc = NULL,
      google_calendar_id = NULL,
      updated_at = datetime('now')
    WHERE telegram_id = ?
  `, userId);

  // 4. Reset sync fields on events (events stay, just lose Google linkage)
  db.run(`
    UPDATE events SET
      google_calendar_id = NULL,
      google_event_id = NULL,
      google_etag = NULL,
      sync_status = 'local_only',
      last_synced_at = NULL
    WHERE user_id = ?
  `, userId);

  // 5. Cancel any pending sync jobs in BullMQ
  // (done via job naming convention: jobs are prefixed with userId)
}
```

### 8.2. What Happens to Events

- **Local events stay.** They just lose their Google linkage.
- **Events that were only on Google** (pulled in, never edited locally) also stay as local events.
- User can reconnect later and re-sync. Events with matching `google_event_id` won't be duplicated on re-connect.

---

## 9. Onboarding Prompt

### 9.1. Trigger

After user creates their bot account (during `/start` flow or after first event creation):

```
Want to sync with Google Calendar?

Your events will stay in the bot either way. Google Calendar sync
is optional but gives you:
- See bot events in your phone calendar
- Changes in Google Calendar auto-sync to the bot
- Two-way sync keeps everything up to date

iPhone/iPad/Mac tip: you can add your Google Calendar to
the built-in Calendar app (Settings > Calendar > Accounts > Google).
Then your bot events show up in Apple Calendar too.

[Connect Google Calendar]  [Maybe Later]
```

### 9.2. "Maybe Later" Behavior

- Dismiss the prompt, don't show again until:
  - User manually triggers `/connect_google`
  - Or 7 days pass (show once more, then never again)
- Store `onboarding_gcal_dismissed_at` and `onboarding_gcal_dismiss_count` on the user record.

---

## 10. Error Handling and Retry Strategy

### 10.1. BullMQ Retry Configuration

```ts
const syncQueue = new Queue('google-sync', {
  connection: redis,
  defaultJobOptions: {
    attempts: 5,
    backoff: {
      type: 'exponential',
      delay: 5000, // 5s, 10s, 20s, 40s, 80s
    },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
});
```

### 10.2. Error Categories and Handling

| Error                           | HTTP Code | Action                                        | Retry? |
| ------------------------------- | --------- | --------------------------------------------- | ------ |
| Rate limit exceeded             | 403/429   | Respect `Retry-After` header, exponential backoff | Yes  |
| Invalid grant (token revoked)   | 401       | Mark token as `revoked`, notify user          | No     |
| Not found (event deleted)       | 404       | Delete local event or mark as deleted         | No     |
| Conflict (etag mismatch)        | 409       | Re-fetch event, apply conflict resolution     | No*    |
| Quota exceeded                  | 403       | Back off for 1 hour                           | Yes    |
| Internal server error           | 500       | Standard retry                                | Yes    |
| Service unavailable             | 503       | Standard retry with backoff                   | Yes    |
| Network error                   | -         | Standard retry                                | Yes    |
| Sync token expired              | 410       | Clear sync token, do full sync                | Yes**  |

\* Conflict errors trigger a separate `resolve-conflict` job instead of retrying the original.
\** Full sync is re-enqueued as a new job, not retried on the same job.

### 10.3. Rate Limit Handling

Google Calendar API has a per-user limit of ~10 requests/second and a per-project limit.

```ts
async function withRateLimit<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err: any) {
    if (err.code === 429 || (err.code === 403 && err.message?.includes('Rate Limit'))) {
      const retryAfter = parseInt(err.headers?.['retry-after'] ?? '60', 10);
      throw new RateLimitError(retryAfter);
    }
    throw err;
  }
}
```

For batch operations (initial sync), use sequential requests with a delay between them rather than parallel requests.

### 10.4. Dead Letter Handling

Jobs that fail all 5 attempts go to a failed state. A daily BullMQ repeatable job checks for patterns:

- If multiple push jobs fail for the same user -> might be a token issue, check token validity
- If pull sync repeatedly fails for a calendar -> calendar might be deleted, notify user

---

## 11. Security Considerations

### 11.1. Token Encryption

Refresh tokens are encrypted at rest with AES-256-GCM using the canonical encryption utilities from `src/utils/crypto.ts` (defined in 00-common-architecture.md). The stored column is `users.google_refresh_token_enc`.

```ts
// All encrypt/decrypt calls use the shared utility:
import { encrypt, decrypt } from '../../utils/crypto';

// Encrypting before storage:
const encryptedToken = encrypt(refreshToken, env.ENCRYPTION_KEY);

// Decrypting for use:
const refreshToken = decrypt(user.google_refresh_token_enc, env.ENCRYPTION_KEY);
```

Format: `iv:authTag:ciphertext` (all base64-encoded). IV is 12 bytes (GCM standard). See `src/utils/crypto.ts` for the full implementation.

The `ENCRYPTION_KEY` environment variable (64-char hex = 32 bytes) is **required** for this sub-project.

### 11.2. OAuth State Protection

- State parameter: random UUID, stored in Redis with 5-minute TTL
- One-time use: deleted from Redis immediately after callback
- No user-identifiable info in the state parameter itself

### 11.3. Webhook Validation

- Verify `x-goog-channel-id` and `x-goog-resource-id` match a known channel in our DB
- Reject requests with unknown channel IDs
- Consider additionally verifying the request origin IP (Google publishes their IP ranges, but this is fragile)

### 11.4. Scope Minimization

- We request `calendar.readonly` + `calendar.events` instead of full `calendar` scope
- `calendar.events` allows write access only to events, not calendar settings
- `calendar.readonly` is needed to list calendars and read events from calendars we can't write to

### 11.5. Data at Rest

- SQLite database should be on an encrypted filesystem in production
- Refresh tokens are encrypted with a key from environment variables
- Access tokens are short-lived (1 hour) and stored unencrypted (acceptable tradeoff: they're useless after expiry)
- `ENCRYPTION_KEY` must never be committed to version control

### 11.6. Minimal Data Retention

- `sync_log` entries are pruned after 30 days
- Expired watch channel records are deleted during renewal
- Access tokens are overwritten on each refresh, not accumulated

---

## 12. File Structure

```
src/
  services/
    google/
      oauth.ts                    # OAuth client, URL generation, token exchange
      calendar-api.ts             # Google Calendar API wrapper
      event-mapper.ts             # Local <-> Google event conversion
  utils/
    crypto.ts                     # AES-256-GCM encrypt/decrypt (shared, defined in 00)
  worker/
    jobs/
      google-sync/
        initial-sync.ts           # Full sync on first connect
        pull-sync.ts              # Incremental pull
        push-event.ts             # Push local changes to Google
        resolve-conflict.ts       # Conflict resolution
        refresh-calendars.ts      # Re-fetch calendar list
      google-watch/
        setup-watch.ts            # Create watch channel
        renew-watch.ts            # Renew expiring channels
        stop-watch.ts             # Stop channel on disconnect
    cron/
      sync-cron.ts                # Periodic incremental pull trigger
      watch-renewal-cron.ts       # Check and renew expiring channels
      cleanup-cron.ts             # Prune sync_log, dead channels
  web/
    oauth-callback.ts             # Handle /oauth/google/callback
    webhook-handler.ts            # Handle /webhooks/google-calendar
  bot/
    commands/
      connect-google.ts           # /connect_google command
      disconnect-google.ts        # /disconnect_google command
      calendars.ts                # Calendar list/select UI
  database/
    migrations/
      007_google_sync_state.ts
      007_google_calendars.ts
      007_google_watch_channels.ts
      007_events_sync_fields.ts
      007_sync_log.ts
```

---

## 13. Implementation Order

1. **OAuth flow** -- `/connect_google`, callback, token storage, encryption
2. **Calendar discovery** -- list calendars, calendar selection UI
3. **Initial pull sync** -- fetch events from Google, store locally
4. **Incremental pull sync** -- using syncToken
5. **Push sync** -- local event create/update/delete -> Google
6. **Conflict resolution** -- detect + resolve + notify
7. **Webhooks** -- watch channel setup, handler, renewal
8. **Disconnect flow** -- cleanup, token revocation
9. **Onboarding prompt** -- post-registration suggestion
10. **Cron jobs** -- periodic sync, channel renewal, cleanup
11. **Error handling hardening** -- rate limits, dead letters, monitoring

---

## 14. Open Questions

1. **Recurring events:** Do we store the master event and expand instances on-the-fly, or store individual instances? Storing the master is more correct but more complex. Recommendation: store masters, expand for display only.

2. **Which calendars to write to?** When user has multiple writable calendars, which one do we create new events in? Recommendation: let user pick a "default write calendar" during setup.

3. **Event deletion semantics:** If user deletes a synced event locally, do we delete it from Google Calendar too? Recommendation: yes, with a confirmation prompt ("Also delete from Google Calendar?").

4. **Timezone handling:** What if user's local timezone and Google Calendar timezone differ? Recommendation: always store in UTC internally, convert for display using user's configured timezone.

5. **Webhook domain verification:** Requires Google Search Console access. Document this in deployment guide.
