# Group Chat Interaction & Group Calendar

## Overview

Enable bot interaction in Telegram group chats with a dedicated group calendar model.
Two major subsystems:

1. **Group interaction model** — activation, conversation sessions, AI relevance filtering
2. **Group calendar** — events owned by groups, managed by all members, reminders to all

Additionally: inline mode moves to a separate bot to eliminate the `@mention` vs inline query conflict.

---

## 1. Activation Model

### Triggers (heuristic, no AI call)

The bot processes a group message when ANY of these match:

| Trigger | Example |
|---------|---------|
| `/cal` command (registered via `bot.command()`) | `/cal что завтра?` |
| `календарь` keyword in text (matched via existing `KEYWORD_PATTERN` with `(?:^|\\s|[,.!?])` boundaries, not JS `\b` — Cyrillic-safe) | `открой календарь` |
| `@botusername` anywhere in text | `@HyperCalendarBot покажи неделю` or `покажи неделю @HyperCalendarBot` |
| Reply to bot's message | (reply checked by comparing `reply.from.id` against bot's own ID, fetched via `bot.api.getMe()` at startup) |
| Active session (see below) | (within conversation window) |
| Existing `CALENDAR_KEYWORDS` | `встреча`, `напомни`, `event`, `schedule`, etc. |

`@botusername` mention works as a regular message (not inline query) because inline mode is disabled on the main bot.

**Note on `/cal`:** Must be registered as a real GramIO command via `bot.command('cal', ...)`, not handled in the message handler. The message handler returns early on `text.startsWith('/')` (line 199), so command-like text would be silently dropped otherwise. The `/cal` handler extracts `ctx.args` as the user's message and routes it to the AI agent.

### Conversation Sessions

After the bot responds in a group, a **session** is created for that chat:

```typescript
interface GroupSession {
  chatId: number;          // group chat_id
  activatedBy: number;     // telegram_id of the user who started the conversation
  remainingMessages: number; // starts at 10, decrements on each message
  lastBotMessageId: number;
  expiresAt: number;       // timestamp, 5 days from last bot response
}
```

**Storage:** In-memory `Map<number, GroupSession>` (keyed by `chatId`). Lost on restart — acceptable.

**Lifecycle:**
1. Bot responds in group → session created (or refreshed) with `remainingMessages = 10`, `expiresAt = now + 5 days`
2. Every message in the group (from anyone) → `remainingMessages--`
3. While session is active (`remainingMessages > 0` and not expired), ALL messages are forwarded to the AI agent
4. AI agent decides: respond or `[SKIP]`
5. If AI responds → `remainingMessages` resets to 10, `expiresAt` refreshes to now + 5 days
6. If `remainingMessages` reaches 0 (10 messages with no bot response) → session closes
7. If 5 days pass with no messages at all → session expires

`remainingMessages` is the single counter — it tracks how many messages remain before the session auto-closes. AI responding resets it. There is no separate "consecutive skips" counter; `remainingMessages` serves that purpose.

**Edge cases:**
- Reply to bot always works, even without an active session
- `/cal` and other keyword triggers always work, even without a session
- Multiple groups: each has its own independent session
- `ask_user` buttons in groups: callback queries are restricted to the user who triggered the bot (check `callback_query.from.id` against the original sender). Other group members pressing buttons get a "Not your question" toast.

### AI Skip Mechanism

System prompt instructs the agent:

> "If the message in the group is clearly not addressed to you (casual conversation, off-topic banter unrelated to calendar/scheduling), respond ONLY with the exact text `[SKIP]`. Do not call any tools, do not create events."

The message handler checks the agent's response:
- If response text is exactly `[SKIP]` → do not send anything to the chat
- Otherwise → send as normal, refresh session

This means every message in the session window costs one AI API call. Acceptable — AI is on a subscription plan.

---

## 2. Group Calendar Data Model

### Schema Changes

#### Events table extension

```sql
ALTER TABLE events ADD COLUMN owner_type TEXT NOT NULL DEFAULT 'user';
  -- 'user' | 'group'

ALTER TABLE events ADD COLUMN group_id INTEGER;
  -- chat_id of the owning group (NULL for personal events)

ALTER TABLE events ADD COLUMN created_by INTEGER;
  -- telegram_id of whoever created this event (for audit)
  -- For personal events: same as user_id
  -- For group events: the person who asked the bot to create it
```

**Indexes:**
```sql
CREATE INDEX idx_events_group ON events (group_id, start_at)
  WHERE owner_type = 'group';
```

#### Chat history extension

```sql
ALTER TABLE chat_history ADD COLUMN chat_id INTEGER;
```

**Changed methods:**
- `save(userId, role, content, chatId?)` — gains optional `chatId` parameter. In groups, caller passes `chatId`; in DMs, omitted (NULL).
- `getRecentByChat(chatId: number, limit = 10)` — new method, returns last N messages from the group chat (from all users).

In groups, messages are saved with both `user_id` (who sent) and `chat_id` (which group). `agent.saveUserMessage()`, `saveAssistantTurn()`, `saveToolResults()` must pass `ctx.groupChatId` when in group context.

When building AI context in groups, use `getRecentByChat(chatId)` instead of `getRecent(userId)`.

### Event Ownership

| Field | Personal event | Group event |
|-------|---------------|-------------|
| `owner_type` | `'user'` | `'group'` |
| `user_id` | owner's telegram_id | creator's telegram_id |
| `group_id` | `NULL` | group's chat_id |
| `created_by` | same as user_id | creator's telegram_id |

### Type Changes

`CalendarEvent` gains:
```typescript
owner_type: 'user' | 'group';
group_id: number | null;
created_by: number | null;
```

`CreateEventData` gains:
```typescript
owner_type?: 'user' | 'group';
group_id?: number;
created_by?: number;
```

### Repository Changes

`EventRepository` gains group-aware methods:
- `findByIdInGroup(id: number, groupId: number)` — finds event by id WHERE `owner_type='group' AND group_id=?` (no user_id check — any group member can access)
- `getByDateRangeForGroup(groupId: number, start: string, end: string)` — replaces user-scoped range query for group context
- `searchForGroup(groupId: number, query: string)` — group-scoped search
- `create()` INSERT statement updated to include `owner_type`, `group_id`, `created_by` columns

Existing user-scoped methods remain unchanged — personal calendar continues to work as before.

### Permissions

Any member of the group can CRUD group events. Permission check: the user sent a message in the group (verified by the fact that the handler is running in a group context with that `chat_id`). No ACL, no roles — all members are equal.

### Reminders

Group event reminders are sent to **all group members** in private messages (DMs).

**Member list retrieval:** Via Pyrogram subprocess — `scripts/get-chat-members.py` accepts `chat_id`, returns JSON array of user objects. Called via `Bun.spawn()`. Requires `data/voice_caller.session` (same Pyrogram session used for voice calls).

**Graceful fallback:** If Pyrogram session is unavailable, fall back to sending reminders only to users who have been seen sending messages in the group (tracked opportunistically via upsert on each group message into `group_members` table). This ensures reminders work even without MTProto.

#### Group members tracking (fallback)

```sql
CREATE TABLE IF NOT EXISTS group_members (
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (chat_id, user_id)
);
```

Populated on every group message: `INSERT OR REPLACE INTO group_members (chat_id, user_id, last_seen_at) VALUES (?, ?, datetime('now'))`. Used as fallback when Pyrogram is unavailable.

**Reminder delivery:** Fetch members via Pyrogram (or fallback) → intersect with `users` table (only users registered with the bot) → send reminder to each via DM.

**Note:** The existing `group_chats` table (from sharing sub-project, migration 008) is reused — no need to create a new one. The `GroupChatRepository` already handles upsert/deactivate.

---

## 3. Tool Scope Parameter

### Modified tools

All event-related tools gain a `scope` parameter:

```typescript
scope: {
  type: 'string',
  enum: ['personal', 'group'],
  description: 'Calendar scope. In groups defaults to "group", in DMs defaults to "personal".'
}
```

**Affected tools:** `get_events`, `create_event`, `update_event`, `delete_event`, `get_free_slots`, `search_events`, `get_upcoming`, `snooze_event`, `get_event`, `set_reminder`, `get_reminders`, `render_day_image`, `render_week_image`.

### Routing

```
scope = "group"    → WHERE owner_type='group' AND group_id=ctx.groupChatId
scope = "personal" → WHERE owner_type='user'  AND user_id=ctx.user.telegram_id
```

For `create_event` with `scope = "group"`:
- `owner_type = 'group'`
- `group_id = ctx.groupChatId`
- `user_id = ctx.user.telegram_id` (creator)
- `created_by = ctx.user.telegram_id`

### Tools that do NOT get scope

Personal settings: `get_user_settings`, `update_user_settings`, `get_notification_settings`, `update_notification_settings`, `get_call_settings`, `update_call_settings` — always personal.

Sharing/invitation tools: `share_event`, `send_invitation`, etc. — unchanged for now.

### AgentContext extension

```typescript
interface AgentContext {
  // ...existing fields
  isGroup: boolean;
  groupChatId?: number;
  groupTitle?: string;
}
```

---

## 4. System Prompt — Group Context

When `isGroup` is true, the system prompt includes an additional block:

```
## Group Context
You are in group "{title}" (chat_id: {chatId}).
Default scope for all event tools is "group" — you manage the GROUP calendar.
The user can explicitly ask about their personal calendar — then use scope "personal".

Available scopes:
- "group" — group calendar, events visible to all members, reminders sent to everyone
- "personal" — the sender's private calendar

Rules for groups:
- Be brief. Multiple people are reading.
- The [From: name] prefix tells you who is speaking. Address them by name.
- If the message is clearly not addressed to you (casual conversation, off-topic),
  respond ONLY with [SKIP]. Do not call any tools.
- Do NOT [SKIP] if there's any calendar-related intent, even indirect.
- When creating events, they go to the group calendar by default.
- When showing events, show the group calendar by default.
```

### Group chat history

In group context, `buildMessages()` loads `getRecentByChat(chatId, 10)` instead of `getRecent(userId, 50)`. Each message carries its `[From: name]` prefix so the agent sees who said what.

---

## 5. Inline Mode Split

### Main bot

Inline mode disabled via BotFather. Code changes:
- Remove `inline_query` handler registration from `src/bot/index.ts`
- `src/bot/handlers/inline.handler.ts` moves to the inline bot

### Inline bot

A separate Telegram bot (`@InlineCalBot`) dedicated to inline queries.
Runs in the **same process** as the main bot — second GramIO instance.

Same process, same `DatabaseService` instance — no concurrency considerations.

### Configuration

```
INLINE_BOT_TOKEN=...        # token for @InlineCalBot
INLINE_BOT_USERNAME=...     # "InlineCalBot"
```

Both bots initialized in `src/index.ts`:
```typescript
const mainBot = new Bot(BOT_TOKEN);     // commands, messages, callbacks
const inlineBot = new Bot(INLINE_BOT_TOKEN); // inline queries only
```

---

## 6. Dead Code Removal

- **Delete `src/services/voice/mtproto-client.ts`** — unused mtcute client, superseded by Pyrogram Python bridge

---

## 7. File Changes Summary

### New files
- `scripts/get-chat-members.py` — Pyrogram subprocess for fetching group members
- `src/services/group/group-session.ts` — in-memory GroupSession manager

### Deleted files
- `src/services/voice/mtproto-client.ts`

### Modified files
- `src/bot/handlers/message.handler.ts` — session logic, group detection, `[SKIP]` detection, fix `isReplyToBot` check
- `src/bot/index.ts` — `/cal` command, inline bot instance, remove inline handler from main bot
- `src/services/ai/tools.ts` — `scope` parameter on event tools
- `src/services/ai/tool-executor.ts` — routing by scope
- `src/services/ai/tool-handlers/events.ts` — scope-aware queries (group vs personal)
- `src/services/ai/system-prompt.ts` — group context block
- `src/services/ai/agent.ts` — `[SKIP]` detection, per-chat history, pass chatId to save methods
- `src/services/ai/types.ts` — `isGroup`, `groupChatId`, `groupTitle` in AgentContext
- `src/database/types.ts` — `owner_type`, `group_id`, `created_by` on CalendarEvent/CreateEventData
- `src/database/repositories/event.repository.ts` — group-aware query methods
- `src/database/repositories/chat-history.repository.ts` — `save()` gains `chatId`, `getRecentByChat()`
- `src/database/migrations.ts` — new migration for events + chat_history columns + group_members table
- `src/services/event/event-service.ts` — pass new fields on create, group-aware lookups
- `src/config/env.ts` — `INLINE_BOT_TOKEN`, `INLINE_BOT_USERNAME`
- `.env.example` — inline bot env vars

### Unchanged
- Personal calendar — works as before
- Notification system core — extended for group events but unchanged at core
- Voice calls — separate pipeline

## 8. Google Calendar Sync for Group Events

Group events sync to Google Calendar of the **event creator** (if they have Google connected).

When a group event is created:
1. Check if `created_by` user has Google Calendar connected
2. If yes → push event to their Google Calendar (same sync pipeline as personal events)
3. If no → event stays local only

When a group event is updated/deleted by any group member:
- Push the change to the original creator's Google Calendar

This reuses the existing sync pipeline — no new Google API integration needed.

**Implementation detail:** The existing `pushSync(userId, eventId, action)` callback receives the acting user's ID. For group events, the sync service must read the event's `created_by` field from the DB and use THAT user's Google credentials, not the acting user's. This is the key change — the sync service reads the event row to determine whose Google Calendar to push to.
