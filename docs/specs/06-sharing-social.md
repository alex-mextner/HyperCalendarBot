# Sub-Project #6: Sharing & Social

## Overview

Social layer for HyperCalendarBot: sharing agenda images, event cards, invitations with accept/decline flow, inline mode for quick sharing from any chat, and group chat support. All with a privacy model that defaults to "share nothing unless explicitly told."

---

## 1. Sharing Flows

### 1.1 Share Agenda Image

User generates a daily/weekly agenda image (sub-project #5) and sends it to a friend or group.

```
User                        Bot                         Recipient
  |                          |                              |
  |-- /share today ---------->                              |
  |   (or AI: "share my      |                              |
  |    agenda with @friend")  |                              |
  |                          |                              |
  |                  [apply privacy filter]                  |
  |                  [generate image via SP#5]               |
  |                          |                              |
  |<-- preview + confirm ----|                              |
  |                          |                              |
  |-- confirm send --------->|                              |
  |                          |--- image + caption --------->|
  |                          |                              |
  |<-- "sent" confirmation --|                              |
```

**Trigger methods:**

- `/share today` / `/share week` / `/share tomorrow`
- AI agent tool: `share_agenda({ period, target_chat_id })`
- Inline keyboard button after `/agenda` command

**Privacy filter applied before image generation** — private events excluded, busy-only events shown as "Busy" blocks.

**Target resolution:**

- If target is a user: bot sends via `sendPhoto` to that user's DM with bot (user must have started the bot)
- If target is a group where bot is a member: bot sends to group
- If target user hasn't started the bot: bot sends the image back to the sender with a forward-friendly caption, sender forwards manually

### 1.2 Share Specific Event

User shares a single event as a formatted card.

```
User                        Bot                         Recipient
  |                          |                              |
  |-- /share event <id> ---->|                              |
  |   or select from list    |                              |
  |                          |                              |
  |              [build event card]                         |
  |              [generate deep link]                       |
  |                          |                              |
  |<-- event card preview ---|                              |
  |    [Send] [Cancel]       |                              |
  |                          |                              |
  |-- Send ----------------->|                              |
  |                          |--- event card message ------>|
  |                          |    [Add to my calendar]      |
  |                          |    (inline keyboard btn)     |
  |                          |                              |
  |                          |         Recipient clicks --->|
  |                          |                              |
  |                          |    [bot user] -> event       |
  |                          |     created in their DB      |
  |                          |                              |
  |                          |    [non-user] -> deep link   |
  |                          |     opens bot with event     |
  |                          |     pre-filled via /start    |
```

**Event card format (text):**

```
📅 Team Standup
📆 March 12, 2026 · 10:00 — 10:30
📍 Zoom (link)
📝 Daily sync with the team

[Add to my calendar]
```

**Event card format (image):** Generated via sub-project #5 renderer with single-event layout.

### 1.3 Event Invitation

Full invitation lifecycle — the core of the social feature.

```
Inviter                     Bot                         Invitee
  |                          |                              |
  |-- /invite @user          |                              |
  |   to event <id> -------->|                              |
  |                          |                              |
  |              [create invitation record]                 |
  |              [status = PENDING]                         |
  |                          |                              |
  |<-- "invitation sent" ----|                              |
  |                          |--- invitation message ------>|
  |                          |    [Accept] [Decline]        |
  |                          |    [Maybe]                   |
  |                          |                              |
  |                          |<--- Accept ------------------|
  |                          |                              |
  |              [status = ACCEPTED]                        |
  |              [create event copy in invitee's calendar]  |
  |              [if both have GCal: create GCal invite]    |
  |                          |                              |
  |<-- "@user accepted" -----|                              |
  |                          |--- "added to calendar" ----->|
```

---

## 2. Invitation State Machine

```
                    ┌──────────┐
         create     │          │
        ────────>   │ PENDING  │
                    │          │
                    └────┬─────┘
                         │
              ┌──────────┼──────────┐
              │          │          │
              v          v          v
         ┌─────────┐ ┌────────┐ ┌─────────┐
         │ACCEPTED │ │DECLINED│ │  MAYBE  │
         └────┬────┘ └────┬───┘ └────┬────┘
              │           │          │
              │           │     ┌────┴────┐
              │           │     │ can     │
              │           │     │ change  │
              │           │     │ to A/D  │
              │           │     └─────────┘
              │           │
              v           v
         ┌─────────┐ ┌────────────┐
         │CANCELLED│ │  EXPIRED   │
         │(by      │ │(event time │
         │inviter) │ │ passed)    │
         └─────────┘ └────────────┘
```

**States:**

| State | Description | Transitions |
|-------|-------------|-------------|
| `PENDING` | Invitation sent, no response yet | -> ACCEPTED, DECLINED, MAYBE, CANCELLED, EXPIRED |
| `ACCEPTED` | Invitee accepted, event in their calendar | -> CANCELLED |
| `DECLINED` | Invitee declined | Terminal (inviter can re-invite = new record) |
| `MAYBE` | Invitee tentative | -> ACCEPTED, DECLINED, EXPIRED |
| `CANCELLED` | Inviter cancelled the invitation | Terminal |
| `EXPIRED` | Event start time passed without response | Terminal (auto-transition via worker job) |

**Rules:**

- Invitee can change MAYBE to ACCEPTED or DECLINED at any time before event starts
- Invitee can change ACCEPTED to DECLINED (event removed from their calendar)
- Inviter can CANCEL any non-terminal invitation
- DECLINED is terminal — re-inviting creates a new invitation record (prevents spam: max 2 re-invites per event per invitee)
- EXPIRED is set by a BullMQ periodic job that scans PENDING/MAYBE invitations past event time

---

## 3. Deep Link Strategy

Telegram deep links format: `https://t.me/BotUsername?start=PAYLOAD`

### Payload Encoding

Use base64url-encoded JSON to keep payloads compact and avoid Telegram's 64-byte start parameter limit.

**Strategy: short codes stored in DB**

Since Telegram limits `/start` payload to 64 characters, we store payloads in a `deep_links` table and use a short code in the URL.

```
Deep link URL: https://t.me/HyperCalendarBot?start=s_abc123def
```

Prefix meanings:

- `s_` — shared event (view + add to calendar)
- `i_` — invitation (view + accept/decline)
- `g_` — group join context

### Deep Link Table

```sql
CREATE TABLE deep_links (
  code       TEXT PRIMARY KEY,           -- short random code, e.g. "abc123def"
  type       TEXT NOT NULL,              -- 'shared_event' | 'invitation' | 'group_context'
  payload    TEXT NOT NULL,              -- JSON with relevant IDs
  created_by INTEGER NOT NULL,           -- telegram_id of link creator
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,                       -- ISO 8601 UTC, NULL = no expiry
  used_count INTEGER NOT NULL DEFAULT 0  -- track usage
);
```

### Flow for Non-Users

```
Non-user clicks deep link
    |
    v
Telegram opens bot with /start s_abc123def
    |
    v
Bot resolves deep_link code -> payload
    |
    v
Bot creates user record (first interaction)
    |
    v
Bot processes payload:
  - shared_event: show event card + [Add to calendar]
  - invitation: show invitation + [Accept] [Decline]
    |
    v
User now has the bot, can continue using it
```

---

## 4. Inline Mode

### Query Parser

Inline queries are parsed into intents:

| Query | Intent | Response |
|-------|--------|----------|
| `` (empty) | `agenda_today` | Today's agenda |
| `today` | `agenda_today` | Today's agenda |
| `tomorrow` | `agenda_tomorrow` | Tomorrow's agenda |
| `week` / `this week` | `agenda_week` | This week's agenda |
| `free` / `free slots` / `free this week` | `free_slots` | Available time slots |
| `free tomorrow` | `free_slots_tomorrow` | Tomorrow's free slots |
| `event <query>` | `event_search` | Search events by title |
| `<any other text>` | `event_search` | Fuzzy search events by title |

### Query Handling Architecture

```
Inline Query arrives
    |
    v
Parse intent (regex-based, no AI — must be < 100ms)
    |
    v
Fetch data from SQLite (indexed queries)
    |
    v
Apply privacy filter (only events marked shareable)
    |
    v
Build InlineQueryResult[] (max 10 results)
    |
    v
answerInlineQuery (must complete < 2s total)
```

**Performance contract:** No AI involved in inline mode. Pure string matching + DB lookups. The 2-second budget breaks down as:

- Query parsing: < 10ms
- DB query: < 50ms
- Privacy filter: < 10ms
- Result building: < 50ms
- Image generation (if requested): < 1500ms (rendered fresh, not cached — see 00-common-architecture §6)
- Network overhead: ~200ms

### Result Types

Each inline result can be:

1. **Text message** — formatted event/agenda as Telegram HTML
2. **Photo** — agenda image rendered fresh on each request (no caching — Telegram caches on its side)
3. **Article** — event card with description

### Caching Strategy

Inline results are cached by Telegram for `cache_time` seconds. We set:

- Agenda queries: `cache_time = 300` (5 min) — reasonable staleness
- Event search: `cache_time = 60` (1 min)
- Free slots: `cache_time = 300` (5 min)

Per project convention (00-common-architecture), images are NOT cached in Redis. Telegram caches images on its servers. Render fresh on each request.

### Implementation

```typescript
// Inline query handler registration with GramIO
bot.on("inline_query", async (ctx) => {
  const userId = ctx.from.id;
  const query = ctx.inlineQuery.query.trim().toLowerCase();

  const intent = parseInlineIntent(query);
  const results = await buildInlineResults(userId, intent);

  await ctx.answerInlineQuery(results, {
    cache_time: intent.cacheTime,
    is_personal: true, // results are per-user
  });
});
```

**`is_personal: true`** is critical — without it Telegram caches results across users, leaking calendars.

---

## 5. SQLite Schema Additions

### invitations

```sql
CREATE TABLE invitations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id        INTEGER NOT NULL,              -- references events(id)
  inviter_id      INTEGER NOT NULL,              -- telegram_id of sender (no FK — user may not exist in our DB yet)
  invitee_id      INTEGER NOT NULL,              -- telegram_id of recipient (no FK — user may not exist in our DB yet)
  status          TEXT NOT NULL DEFAULT 'pending', -- pending|accepted|declined|maybe|cancelled|expired
  message_id      INTEGER,                       -- telegram message_id of the invitation message
  chat_id         INTEGER,                       -- chat where invitation was sent
  deep_link_code  TEXT,                          -- for non-user invitees
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  responded_at    TEXT,                          -- ISO 8601 UTC, when invitee responded
  UNIQUE(event_id, invitee_id, created_at),      -- allow re-invites (new timestamp)
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);

CREATE INDEX idx_invitations_invitee ON invitations(invitee_id, status);
CREATE INDEX idx_invitations_event ON invitations(event_id);
CREATE INDEX idx_invitations_status ON invitations(status) WHERE status IN ('pending', 'maybe');
```

### shared_events

```sql
CREATE TABLE shared_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id        INTEGER NOT NULL,              -- references events(id)
  shared_by       INTEGER NOT NULL,              -- telegram_id, references users(telegram_id)
  shared_to_type  TEXT NOT NULL,                 -- 'user' | 'group'
  shared_to_id    INTEGER NOT NULL,              -- telegram user_id or chat_id
  share_type      TEXT NOT NULL,                 -- 'card' | 'image' | 'agenda'
  message_id      INTEGER,                       -- sent message ID
  deep_link_code  TEXT,                          -- for trackable links
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);

CREATE INDEX idx_shared_events_event ON shared_events(event_id);
CREATE INDEX idx_shared_events_target ON shared_events(shared_to_type, shared_to_id);
```

### sharing_settings

```sql
CREATE TABLE sharing_settings (
  user_id              INTEGER PRIMARY KEY,              -- telegram_id
  default_visibility   TEXT NOT NULL DEFAULT 'private',  -- 'private' | 'free_busy' | 'full'
  inline_mode_enabled  INTEGER NOT NULL DEFAULT 1,       -- 0 or 1
  allow_invitations    INTEGER NOT NULL DEFAULT 1,       -- 0 or 1
  share_location       INTEGER NOT NULL DEFAULT 0,       -- include location in shares
  share_description    INTEGER NOT NULL DEFAULT 0,       -- include description in shares
  updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
);
```

### event_visibility (per-event override)

```sql
CREATE TABLE event_visibility (
  event_id    INTEGER PRIMARY KEY,               -- references events(id)
  visibility  TEXT NOT NULL,                      -- 'private' | 'free_busy' | 'full'
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);
```

### group_chats

```sql
CREATE TABLE group_chats (
  chat_id     INTEGER PRIMARY KEY,               -- telegram chat_id (negative for groups)
  title       TEXT,
  added_by    INTEGER NOT NULL,                  -- telegram_id, references users(telegram_id)
  added_at    TEXT NOT NULL DEFAULT (datetime('now')),
  is_active   INTEGER NOT NULL DEFAULT 1         -- bot still in group
);

CREATE TABLE group_shared_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id     INTEGER NOT NULL,                  -- references group_chats(chat_id)
  event_id    INTEGER NOT NULL,                  -- references events(id)
  shared_by   INTEGER NOT NULL,                  -- telegram_id, references users(telegram_id)
  message_id  INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(chat_id, event_id),
  FOREIGN KEY (chat_id) REFERENCES group_chats(chat_id),
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);

CREATE INDEX idx_group_shared_chat ON group_shared_events(chat_id);
```

### deep_links

(Defined in section 3 above.)

### re-invite tracking

```sql
-- Enforced at application level, but queryable:
-- SELECT COUNT(*) FROM invitations
-- WHERE event_id = ? AND invitee_id = ? AND status = 'declined'
-- Limit: max 2 declined records per (event_id, invitee_id) pair
```

---

## 6. Privacy Model

### Principles

1. **Default private.** New users have `default_visibility = 'private'`. Nothing is shared unless they explicitly opt in.
2. **Per-event override.** Users can mark specific events as `full` or `free_busy` regardless of default.
3. **Private events never leak.** Events with visibility `private` are excluded from all sharing, inline results, and group displays. No exceptions.
4. **Free/busy abstraction.** When visibility is `free_busy`, shared views show time blocks as "Busy" with no title, location, or description.
5. **Explicit sharing is always full.** When a user explicitly shares an event via `/share event <id>`, that specific event is shown in full — the user chose to share it. This does NOT change the event's stored visibility.

### Visibility Resolution

```
resolveVisibility(event, context):
  1. If context is "explicit_share" (user chose this event):
       return 'full'

  2. Check event_visibility table for per-event override:
       if found: return override.visibility

  3. Fall back to sharing_settings.default_visibility

  4. Apply result:
       'private'   -> exclude from output
       'free_busy' -> show as "Busy" block, time only
       'full'      -> show all details
```

### Privacy in Inline Mode

- `is_personal: true` on all inline query answers — Telegram won't show user A's results to user B
- Events with `private` visibility: excluded entirely
- Events with `free_busy` visibility: shown as "Busy 10:00-11:00"
- User can disable inline mode entirely via `sharing_settings.inline_mode_enabled`
- If inline mode disabled: `answerInlineQuery([])` — empty results

### Privacy in Group Chats

- Bot only shows events that were explicitly shared to the group via `/share`
- Bot never auto-publishes a user's agenda to a group
- Group agenda = only events in `group_shared_events` for that `chat_id`
- Users can remove their shared events from a group

### Invitation Privacy

- When sending an invitation, the inviter shares the full event details with the invitee (they chose to invite them)
- Invitee sees full event details in the invitation message
- Other users in a group cannot see invitation details — invitations are sent as DMs

---

## 7. Group Chat Interaction Design

### Bot Addition Flow

```
User adds bot to group
    |
    v
Bot receives "my_chat_member" update with new status
    |
    v
Bot creates group_chats record
    |
    v
Bot sends welcome message to group:
  "I can help share calendar events here.
   Use /share to share events with this group.
   Use /agenda to see events shared with this group."
```

### Group Commands

| Command | Description |
|---------|-------------|
| `/share today` | Share your today's agenda to the group (with privacy filter) |
| `/share event <id>` | Share specific event to the group |
| `/agenda` | Show all events shared with this group (group_shared_events) |
| `/unshare <id>` | Remove your event from group's shared events |

### Group Agenda

The group agenda is NOT a union of all members' calendars. It is strictly the set of events explicitly shared via `/share` to that group. This is a deliberate design choice:

- No accidental calendar exposure
- Users control exactly what the group sees
- Group agenda is a curated, opt-in view

### Bot Removal

```
Bot removed from group (or group deleted)
    |
    v
Bot receives "my_chat_member" with status "left" or "kicked"
    |
    v
Set group_chats.is_active = 0
    |
    v
Do NOT delete group_shared_events (keep history in case bot is re-added)
```

---

## 8. Callback Data Encoding

Inline keyboard buttons use callback data. Telegram limits callback data to 64 bytes.

**Format:** `{action}:{id}:{extra}`

| Callback Data | Action |
|---------------|--------|
| `inv:accept:{invitation_id}` | Accept invitation |
| `inv:decline:{invitation_id}` | Decline invitation |
| `inv:maybe:{invitation_id}` | Maybe response |
| `inv:cancel:{invitation_id}` | Cancel invitation (inviter only) |
| `evt:add:{deep_link_code}` | Add shared event to calendar |
| `share:confirm:{share_session_id}` | Confirm sending share |
| `share:cancel:{share_session_id}` | Cancel share |

**Share session:** Temporary record (Redis, TTL 5 min) created when user initiates a share and sees a preview. Stores target, content type, and generated image reference. Prevents re-generation on confirm.

---

## 9. Google Calendar Integration

When both inviter and invitee have Google Calendar sync enabled (sub-project scope TBD), the invitation flow extends:

```
Invitation ACCEPTED
    |
    v
Check: inviter has GCal sync? AND invitee has GCal sync?
    |
    ├── Both yes:
    │     Create Google Calendar event with invitee as attendee
    │     (via Google Calendar API, worker job)
    │
    ├── Only inviter:
    │     Event stays in inviter's GCal only
    │     Invitee has event in local SQLite only
    │
    └── Neither:
          Both have event in local SQLite only
```

This is a **BullMQ worker job** — Google Calendar API calls can be slow and should not block the Telegram response.

---

## 10. Edge Cases

### 10.1 User blocks the bot

- Bot cannot send messages to users who blocked it
- `sendMessage` will throw 403 Forbidden
- On 403: mark invitation as `status = 'cancelled'`, notify inviter: "Could not deliver invitation — user may have blocked the bot"
- Do not retry

### 10.2 Invitation to non-Telegram user

- Not supported. Telegram bot can only interact with Telegram users
- If user asks AI agent to "invite <john@email.com>": respond that invitations are Telegram-only, suggest sharing via Google Calendar if GCal sync is enabled

### 10.3 Invitee hasn't started the bot

- Bot cannot send DMs to users who never started it
- Flow: Bot sends the invitation as a message in the same chat where the command was issued (if it's a group), with a deep link button
- If command was in DM: bot tells inviter "This user hasn't started the bot yet. Send them this link: [deep link]"
- Inviter forwards the link manually

### 10.4 Event deleted after invitation sent

- When event is deleted, find all PENDING/MAYBE invitations for that event
- Set them to CANCELLED
- Edit invitation messages (if `message_id` stored) to show "This event was cancelled"
- If message edit fails (too old, deleted): ignore silently

### 10.5 Event time changed after invitation accepted

- Find all ACCEPTED invitations for that event
- Notify invitees: "Event time has changed: [new time]. [Keep in calendar] [Remove]"
- Update the event copy in invitee's calendar automatically (they accepted — they want to track it)

### 10.6 Duplicate invitations

- Check `invitations` table before creating: if PENDING or MAYBE invitation exists for same (event_id, invitee_id), reject with "Invitation already sent"
- If previous invitation was DECLINED: allow re-invite (new record), up to 2 declines total
- After 2 declines: "This user has declined twice. They probably don't want to come."

### 10.7 Inline mode rate limiting

- Telegram sends inline queries on every keystroke
- Bot should debounce: if a new query arrives from same user within 300ms, skip the old one
- GramIO may handle this at framework level — verify

### 10.8 Group chat: non-member queries

- If user sends inline query result to a group where bot isn't a member, bot can't do anything about it — it's just a message
- "Add to calendar" button in such messages uses deep link (works regardless of bot group membership)

### 10.9 Large groups

- Group agenda could have many shared events
- Paginate: show 10 events per page with [Next] [Previous] buttons
- Sort by event start time ascending (upcoming first)

### 10.10 Bot restarted / message_id stale

- Stored `message_id` values may become invalid if messages are deleted
- All message edits (invitation status updates, share confirmations) should catch and ignore errors
- Never crash on a failed message edit

### 10.11 Privacy race condition

- User shares agenda, then marks event as private
- Already-shared message/image is out there — cannot be recalled
- This is acceptable: user explicitly shared it at a time when it was visible
- Future shares will respect the new visibility

### 10.12 Concurrent invitation responses

- Invitee clicks Accept, then quickly clicks Decline (or vice versa)
- Use optimistic locking: `UPDATE invitations SET status = ? WHERE id = ? AND status = ?` (check current status in WHERE clause)
- If UPDATE affects 0 rows: status already changed, respond with current status

---

## 11. AI Agent Tools

The AI agent (conversational interface) should have these tools for sharing:

```typescript
// Share agenda image
share_agenda(params: {
  period: 'today' | 'tomorrow' | 'week';
  target_type: 'user' | 'group';
  target_id: number; // telegram_user_id or chat_id
}): Promise<{ success: boolean; message_id?: number }>

// Share specific event
share_event(params: {
  event_id: number;
  target_type: 'user' | 'group';
  target_id: number;
  format: 'text' | 'image';
}): Promise<{ success: boolean; message_id?: number }>

// Send invitation
send_invitation(params: {
  event_id: number;
  invitee_id: number; // telegram_user_id
}): Promise<{ success: boolean; invitation_id?: number; deep_link?: string }>

// Check invitation status
get_invitation_status(params: {
  invitation_id?: number;
  event_id?: number; // get all invitations for event
}): Promise<Invitation[]>

// Update sharing settings
update_sharing_settings(params: {
  default_visibility?: 'private' | 'free_busy' | 'full';
  inline_mode_enabled?: boolean;
  allow_invitations?: boolean;
}): Promise<{ success: boolean }>

// Set event visibility
set_event_visibility(params: {
  event_id: number;
  visibility: 'private' | 'free_busy' | 'full';
}): Promise<{ success: boolean }>
```

---

## 12. BullMQ Jobs

| Job | Queue | Trigger | Description |
|-----|-------|---------|-------------|
| `expire-invitations` | `sharing` | Cron every 15 min | Find PENDING/MAYBE invitations for past events, set to EXPIRED |
| `gcal-create-invite` | `gcal-sync` | On invitation accepted (both have GCal) | Create Google Calendar event with attendee |
| `gcal-cancel-invite` | `gcal-sync` | On invitation cancelled/declined | Remove attendee from GCal event |
| `generate-share-image` | `image-gen` | On share request | Generate agenda/event image via SP#5 |
| `cleanup-deep-links` | `sharing` | Cron daily | Delete expired deep_links records |
| `cleanup-share-sessions` | `sharing` | Cron every 10 min | Delete Redis share sessions older than TTL |

---

## 13. Command Summary

### DM Commands

| Command | Description |
|---------|-------------|
| `/share today` | Share today's agenda (choose recipient) |
| `/share tomorrow` | Share tomorrow's agenda |
| `/share week` | Share this week's agenda |
| `/share event <id>` | Share specific event |
| `/invite <@user> <event_id>` | Invite user to event |
| `/invitations` | List your pending invitations (sent & received) |
| `/privacy` | View/change sharing & privacy settings |
| `/privacy default <private\|free_busy\|full>` | Set default visibility |

### Group Commands

| Command | Description |
|---------|-------------|
| `/share today` | Share your today's agenda to the group |
| `/share event <id>` | Share event to the group |
| `/agenda` | Show events shared with this group |
| `/unshare <id>` | Remove your event from group |

---

## 14. Data Flow Diagram

```
┌──────────────────────────────────────────────────────────┐
│                    Telegram API                           │
│  (messages, inline queries, callback queries, chat        │
│   member updates, deep links via /start)                  │
└──────────┬────────────────────────────────────────────────┘
           │
           v
┌──────────────────────┐     ┌─────────────────────────────┐
│     Bot Process       │     │      Worker Process          │
│  (GramIO)             │     │  (BullMQ consumers)          │
│                       │     │                              │
│  - Command handlers   │     │  - expire-invitations        │
│  - Inline query       │◄───►│  - gcal-create-invite        │
│    handler            │Redis│  - generate-share-image      │
│  - Callback query     │     │  - cleanup-deep-links        │
│    handler            │     │                              │
│  - AI agent tools     │     │                              │
│  - Chat member        │     │                              │
│    handler            │     │                              │
└──────────┬────────────┘     └──────────────┬──────────────┘
           │                                  │
           v                                  v
┌──────────────────────────────────────────────────────────┐
│                     SQLite                                │
│  events, invitations, shared_events, sharing_settings,   │
│  event_visibility, group_chats, group_shared_events,     │
│  deep_links                                              │
└──────────────────────────────────────────────────────────┘
```

---

## 15. Open Questions

1. **Should invitations support +1 / guest count?** Probably overkill for v1. Revisit if users ask.
2. **Should group chats have a "shared calendar" concept (persistent, not just individual shares)?** Deferred — adds significant complexity. The group_shared_events model is simpler and sufficient for launch.
3. **Inline mode image generation — pre-generate or on-demand?** On-demand with caching seems right, but if image generation is consistently slow (>1.5s), consider pre-generating daily agenda images on event change.
4. **Rate limiting on shares/invitations per user?** Probably needed to prevent spam, but exact limits TBD. Suggestion: max 50 invitations per day, max 20 shares per day.
