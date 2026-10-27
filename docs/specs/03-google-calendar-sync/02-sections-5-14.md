> Part 2 of 2 of [Sub-Project #3: Google Calendar Sync](../03-google-calendar-sync.md) — previous: [01-overview-sections-1-4.md](01-overview-sections-1-4.md)

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

#### Participant copy gone (404/410 on an invitee's copy)

When an organizer's change is pushed to a participant's linked Google copy and `events.update` answers 404 or 410, the push resolves the link the way the pull reads the same copy (`SyncService.resolveGoneParticipantCopy`). Any other status and any timeout fail the job so BullMQ retries it.

| Situation | Result | `sync_log` `details.outcome` |
| --- | --- | --- |
| The participant's RSVP is already `declined` | Link row removed; nothing else changes | `unlinked` (`probe: skipped`) |
| `events.get` returns the copy with `status: cancelled` (the participant deleted it) | `handleParticipantDelete`, exactly as on pull: RSVP and invitation declined, pending edit proposal rejected, link row removed, organizer told | `declined` |
| `events.get` answers 404/410 too (purged, or another Google account is connected) | A fresh copy is inserted and the link row points at it | `recreated` (with `new_google_event_id`) |
| `events.get` returns a live copy, or fails otherwise | The job fails and is retried | none |

The row is written with `direction = 'push'`, `action` `delete` or `create`, and `details` JSON `{ reason: 'participant_copy_gone', http_status, probe, outcome, stale_google_event_id, new_google_event_id? }`. A create or update push for a participant who has declined and has no linked copy inserts nothing, so a push queued before the decline cannot put the copy back.

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
