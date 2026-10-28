> Part 1 of 2 of [Sub-Project #3: Google Calendar Sync](../03-google-calendar-sync.md) — next: [02-sections-5-14.md](02-sections-5-14.md)

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
| `location`            | `location`                   | Free text Google geocodes: the verified place (`Venue — Address`) once `location_verified = 1`, else exactly the typed text. Pull skips copies carrying `hypercalendarbot_event_id`, so this never comes back as a user edit |
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
    location: formatLocationPlain(local) || undefined, // verified place, else the typed text
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

#### Deletions made in Google (#844)

The sketch above is the shape; the implementation (`SyncService.incrementalPull`) differs in these ways, each fixed because a deletion made in Google did not reach the bot:

- **Every page of a delta is read** with the same sync token; the next token is stored only after the last page was applied. A failure on any page keeps the old token and the retry reads the delta again.
- **A tombstone (`status = cancelled`) is applied before anything else.** Google keeps the whole body of a deleted event, including `extendedProperties.private.hypercalendarbot_event_id` of a copy the bot pushed, so the "skip copies the bot pushed" rule applies to live events only.
- **The event is found through the primary-calendar alias.** The bot pushes what it creates to `primary` and stores no `google_calendar_id` for it (NULL, or `primary`); reading the user's primary calendar therefore also matches those rows (`EventRepository.findByGoogleEventId(..., { primaryCalendar })`). A secondary calendar never matches them.
- **A cancelled occurrence of a series** (`recurringEventId` + `originalStartTime`) becomes a cancelled recurrence exception of the series, the row `EventService.cancelOccurrence` writes; it is idempotent. A timed occurrence is identified by its instant, an all-day one by the day written (an occurrence stored at UTC midnight is that UTC day; one stored at local midnight is its day in the series' time zone), and an occurrence that matches no day is not cancelled. A row the bot holds under the occurrence's own Google id (a moved occurrence imported as an event, or an exception row) is removed or kept as the cancelled exception, so the series stops listing the occurrence either way. A cancelled series removes the series and its exceptions.
- **A moved event is gone from its calendar.** An event moved to another calendar is no longer listed in the calendar it left (a delta may report it there as cancelled), so the bot removes its copy and does not follow the event into the other calendar unless that calendar is synced. Neither a tombstone nor a missing id says whether an event was deleted or moved.
- **Same semantics as a deletion in the bot.** The event is soft-deleted, its reminders and sharing rows are cleaned, open invitations are cancelled, invitation cards are edited, participants' Google copies are removed. Participants get the "event cancelled" message only when the event has not ended (or is a series); a deletion of an event that is over, or found by a reconcile (unknown age), sends no message.
- **Receipts.** Each applied deletion writes a `sync_log` row (`direction = pull`, `action = delete`, `details` JSON `{ reason, ... }` with `reason` one of `cancelled_in_google`, `absent_in_full_list`, `occurrence_cancelled_in_google`; `notified_participants` for a removed event, `original_start_at` for a cancelled occurrence). The row is written in the same transaction as the removal. The notifier reads the participants at once but sends, edits and queues nothing until that transaction committed (`onEventDeleted({ committed })`), and abandons the announcement if it failed: a retried pull finds no live row and changes nothing (nothing is sent twice) or finds a live row nobody was told about.
- **Counters.** Every pull ends with one log line `Google pull applied` (`pages`, `items`, `deleted`, `occurrencesCancelled`, `participantCopiesDeleted`, `unmatchedTombstones`, `botCopiesSkipped`); a failed pull logs `Google pull failed` with the counters reached and rethrows (the token is not advanced).
- **A lost delta is repaired by a full read.** After 410 Gone `initialSync({ removeAbsent: true })` runs and removes the events it no longer lists; the new sync token is stored only after that, so a failed read or repair hits the 410 again and repeats (a first read after connecting never removes anything). The startup job id is one per user, so restarts do not queue a second listing. The same removal runs once per start as the `reconcile-sync` job (`SyncService.reconcileDeletions`). Both log `Google reconcile applied` with `source` (`token_reset` or `startup`) and `tracked`, `listed`, `removed`, `skippedPending`, `skippedFresh`, `refused`. It keeps an event with a local edit still waiting to be pushed and one synced after the read began (both checked again on the current row right before each removal, together with its Google id), and it refuses (`Google reconcile refused`, error level) when the read lists nothing while events are linked, or when at least three events and more than half of the calendar's linked events would go at once: a real clear-out arrives as tombstones, so such a read is a wrong read.

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
| Push on place answer     | Immediate            | The creator confirms a place (candidate tap, pin), keeps the typed text after a place was shown, or a new location verification drops a confirmed place (also when the editor, e.g. a secretary, cannot see the event and gets no question): the owner copy of a personal event and every participant copy except declined ones are re-pushed, only when the location Google shows (§3.1) changes |
| Webhook callback         | Real-time            | Google notifies us of changes         |
| Cron incremental pull    | Every 15 minutes     | Catch missed webhooks                 |
| Watch channel renewal    | Every 6 hours        | Renew channels expiring within 24h    |
| Full re-sync             | Weekly / on demand   | Safety net, reset sync tokens         |

---

