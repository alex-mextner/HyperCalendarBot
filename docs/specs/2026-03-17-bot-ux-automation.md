# Bot UX & Automation System

**Date:** 2026-03-17
**Status:** Draft
**Scope:** Pipeline architecture, intent automation, unified settings, feedback system, UX improvements

---

## 1. Overview

This spec covers a set of interconnected features that improve bot responsiveness, reduce AI token usage, and enhance user experience:

1. **Pipeline architecture** — layered message routing replacing monolithic handler
2. **Intent automation system** — deterministic handling of known phrases without AI
3. **Unified settings** — single tool + single command replacing fragmented settings
4. **Feedback system** — two-way threaded communication between users and admin
5. **Bot info tool** — non-obvious capabilities discovery
6. **Voice response prompt** — one-time opt-in for voice replies
7. **Timezone in invitations** — recipient timezone display
8. **Auto-pin images** — silent pin of calendar images with group admin hint
9. **BOT_ADMIN_ID** — admin identification for feedback and intent verification

---

## 2. Pipeline Architecture

### Current State

`message.handler.ts` (~300 lines) handles everything: voice transcription, group filtering, scene checking, AI routing. Adding more routing logic here would create an unmaintainable monolith.

### Design

Refactor message handling into a sequential pipeline. Each layer is a function `(ctx, messageText) => { handled: boolean }`. If `handled: true`, pipeline stops.

```
Incoming message
    ↓
VoiceTranscription (existing, extract text from voice)
    ↓
IntentMatcher (new — check phrase_map / trigger_index)
    ↓
FeedbackRouter (new — check active feedback thread)
    ↓
AIAgent (existing — full AI processing)
    ↓ async, after AI response
IntentLearner (new — background agent generates intent candidates)
```

### Layer Contracts

Each layer receives `(ctx: BotContext, messageText: string)` and returns `{ handled: boolean }`.

- **IntentMatcher**: SQLite lookup for approved intents → execute workflow → respond. Only `status = 'approved'` intents participate.
- **FeedbackRouter**: Check `feedback_threads` for open thread for this user → forward to admin → stop. AI determines whether a reply continues the thread or starts a new topic (via system prompt context).
- **AIAgent**: Existing logic, unchanged. New tools added: `manage_settings`, `send_feedback`, `get_bot_info`.
- **IntentLearner**: Async post-processing. Analyzes what tools AI called and generates intent candidates for admin verification.

---

## 3. Intent Automation System

### Concept

AI processes each free-text request, but many requests map to deterministic tool calls. The intent system caches these mappings so future identical/similar requests execute instantly without AI.

### Matching Algorithm

Two-tier matching, all data loaded in memory on startup:

**Tier 1 — Exact phrase match (O(1)):**
- `phrase_map: Map<normalized_phrase, intent_id>`
- Input normalized: lowercase, trim, strip punctuation
- Covers ~70% of recurring queries ("что сегодня", "расписание", "today")

**Tier 2 — Regex with trigger word filtering:**
- Each regex pattern has `trigger_words` — words that MUST be present
- `trigger_index: Map<trigger_word, Intent[]>` — quick filter
- Algorithm:
  1. Tokenize message → `Set<string>` of words
  2. Look up `trigger_index` — collect candidate intents that share at least one word
  3. Test only those regexes (typically 2-5, not hundreds)
- Captures parameterized intents: `"события 25 марта"` → `$1 = "25 марта"`

**On match:** Load `workflow` from SQLite by `intent_id` (not kept in memory — saves RAM). Execute via IntentExecutor.

**Memory refresh:** Reload on admin approve/reject action.

### Workflow Format

**Level 1 — Single tool call (JSON template):**
```json
{
  "tools": [
    { "name": "get_events", "input": { "start_date": "{{today}}", "end_date": "{{today}}" } }
  ],
  "format": "events_list"
}
```

**Level 2 — Multi-step workflow (JSON workflow):**
```json
{
  "steps": [
    { "call": "search_events", "input": { "query": "{{$1}}" }, "as": "results" },
    { "when": "results.length == 0", "respond": "Ничего не найдено", "stop": true },
    { "when": "results.length > 1", "call": "ask_user", "input": { "question": "Какое событие?", "options": "{{results}}" }, "as": "choice" },
    { "call": "update_event", "input": { "event_id": "{{choice.id}}", "start_at": "{{$2}}" } }
  ]
}
```

**Built-in variables:**
- `{{today}}`, `{{tomorrow}}`, `{{week_start}}`, `{{week_end}}`, `{{month_start}}`, `{{month_end}}` — computed dates in user timezone
- `{{$1}}`, `{{$2}}`, ... — regex capture groups
- `{{step_name.field}}` — results from previous steps (`as` keyword)
- `{{user.timezone}}`, `{{user.language}}` — user context

**`when` conditions:** Simple expressions evaluated by a safe interpreter (no eval). Supports: `==`, `!=`, `>`, `<`, `>=`, `<=`, `.length`, boolean literals.

**`format` types:**
- `events_list` — standard event list formatting
- `free_slots` — free time slots formatting
- `text` — plain text response
- `settings` — settings display formatting

### Database Schema

**Table `intents`:**

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PRIMARY KEY | Auto-increment |
| `canonical_name` | TEXT UNIQUE NOT NULL | e.g. `show_today`, `search_events` |
| `phrases` | TEXT NOT NULL | JSON array of exact phrases |
| `trigger_words` | TEXT | JSON array of trigger words for regex filtering |
| `pattern` | TEXT | Regex pattern (nullable — null means exact-only) |
| `workflow` | TEXT NOT NULL | JSON workflow definition |
| `format` | TEXT NOT NULL DEFAULT 'text' | Response format template name |
| `status` | TEXT NOT NULL DEFAULT 'pending' | `pending` / `approved` / `rejected` |
| `source_message` | TEXT | Original user message that triggered learning |
| `created_at` | TEXT NOT NULL DEFAULT (datetime('now')) | ISO 8601 |

### IntentLearner — Background Agent

**Trigger:** After every successful AI response, asynchronously (does not block user response).

**Input:**
- Original user message
- Tool calls AI made (names + parameters)
- Tool results (success/error)

**Process:**
1. Analyze whether the request can be reduced to a deterministic workflow
2. If yes — generate intent record: canonical_name, phrases (variations), trigger_words, pattern (if parameterized), workflow, format
3. Check for existing approved intent with similar canonical_name → if found, may append phrases to existing intent instead of creating duplicate
4. Save with `status: pending` → send to admin for verification

**When NOT to generate intent:**
- AI used `ask_user` tool (needs dialogue — not automatable without workflow complexity)
- AI responded from general knowledge without tool calls (chat/conversation)
- Request depends on conversation history (contextual)
- Request was ambiguous and AI needed clarification

**Model:** Haiku or Sonnet — cheap, fast. Separate API call with a short prompt specialized for intent generation.

### Admin Verification Flow

Notification sent to `BOT_ADMIN_ID`:

```
💡 New intent: show_today_events
Phrases: "что сегодня", "расписание на сегодня", "today"
Pattern: none (exact match only)
Workflow: get_events(start_date={{today}}, end_date={{today}})
Format: events_list
Source: "что у меня сегодня?"

[✅ Accept]  [✏️ Edit]  [❌ Reject]
```

- **Accept** → `status = 'approved'`, reload memory index
- **Reject** → `status = 'rejected'`
- **Edit** → Admin writes text instructions → AI modifies the intent → sends updated version with buttons again. Multiple rounds until Accept/Reject.

Edit conversation happens in admin's bot chat. AI routes admin messages: if there's a pending intent edit session → process as edit instruction; otherwise → normal bot interaction.

---

## 4. Unified Settings

### Current State (to be replaced)

6 AI tools: `get_user_settings`, `update_user_settings`, `get_notification_settings`, `update_notification_settings`, `get_call_settings`, `update_call_settings`

4 commands: `/settings` (read-only), `/notify`, `/callsettings`, `/privacy`

### Design

**Single AI tool: `manage_settings`**

```json
{
  "name": "manage_settings",
  "description": "Get or update user settings. Categories: general (timezone, language), notifications (morning agenda, evening review, quiet hours, reminders), calls (enabled, language, quiet hours), privacy (default visibility, inline mode, invitations), voice (voice response enabled/disabled).",
  "input_schema": {
    "type": "object",
    "properties": {
      "action": { "type": "string", "enum": ["get", "update"] },
      "category": { "type": "string", "enum": ["general", "notifications", "calls", "privacy", "voice"] },
      "updates": { "type": "object" }
    },
    "required": ["action"]
  }
}
```

- `action: "get"` without `category` → returns all settings across all categories
- `action: "get"` with `category` → returns only that section
- `action: "update"` → requires `category` + `updates` object with changed fields only

**Single command: `/settings`**

Displays category picker with inline keyboard:

```
⚙️ Настройки
[🌍 Основные]     [🔔 Уведомления]
[📞 Звонки]       [🔒 Приватность]
[🎤 Голос]
```

Each button opens the category detail view with current values and toggle/edit buttons.

**Removed commands:** `/notify`, `/callsettings`, `/privacy` — removed entirely, not aliased.

### New Setting: voice_response_enabled

Added to `users` table:

```sql
ALTER TABLE users ADD COLUMN voice_response_enabled INTEGER DEFAULT NULL;
```

- `NULL` — not yet asked (show prompt after first voice message)
- `1` — voice responses enabled
- `0` — voice responses disabled

---

## 5. Feedback System

### Database Schema

**Table `feedback_threads`:**

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PRIMARY KEY | |
| `user_id` | INTEGER NOT NULL | telegram_id |
| `status` | TEXT NOT NULL DEFAULT 'open' | `open` / `closed` |
| `type` | TEXT NOT NULL | `bug` / `feature` / `question` / `other` |
| `subject` | TEXT NOT NULL | AI-extracted topic summary |
| `created_at` | TEXT NOT NULL | ISO 8601 |
| `closed_at` | TEXT | ISO 8601, nullable |

**Table `feedback_messages`:**

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PRIMARY KEY | |
| `thread_id` | INTEGER NOT NULL | FK → feedback_threads.id |
| `sender` | TEXT NOT NULL | `user` / `admin` |
| `text` | TEXT NOT NULL | Message content |
| `telegram_message_id` | INTEGER | For Telegram reply threading |
| `created_at` | TEXT NOT NULL | ISO 8601 |

### AI Tool

```json
{
  "name": "send_feedback",
  "description": "Send feedback to the bot developer. Creates a feedback thread for two-way communication.",
  "input_schema": {
    "type": "object",
    "properties": {
      "type": { "type": "string", "enum": ["bug", "feature", "question", "other"] },
      "message": { "type": "string", "description": "Feedback message text" }
    },
    "required": ["type", "message"]
  }
}
```

### Flow

**User → Admin:**
1. User says something like "нашёл баг" or "хочу предложить фичу"
2. AI calls `send_feedback` tool
3. System creates thread + first message
4. Admin receives:
   ```
   💬 Feedback #42 (bug) от @username
   «бот глючит когда добавляю событие»
   [Reply] [Close]
   ```

**Admin → User:**
1. Admin clicks Reply → writes response
2. Bot delivers to user as a regular message
3. Message saved to `feedback_messages`

**User continues:**
1. User replies → FeedbackRouter checks: is there an open thread?
2. If yes → message goes to AI with feedback thread context in system prompt
3. AI decides: continuation of feedback thread → forward to admin; or new topic → close thread, process normally
4. If forwarded → admin sees the message in the thread context

**Thread closure:**
- Admin clicks Close → `status = 'closed'`
- AI determines user switched topics → auto-close
- No TTL/auto-expiry — threads stay open until explicitly closed

---

## 6. Bot Info Tool

```json
{
  "name": "get_bot_info",
  "description": "Get information about non-obvious bot capabilities that are not derivable from other tools. Call when user asks what the bot can do, asks for help, or wants to know about features.",
  "input_schema": {
    "type": "object",
    "properties": {},
    "required": []
  }
}
```

**Returns static text block (AI formulates response from this):**

```
Non-obvious capabilities:
- Voice messages: send a voice message and the bot will transcribe and understand it
- Voice responses: enable in settings to receive voice replies (useful while driving, cooking, or on the go)
- Group chats: add the bot to a group with friends to create shared calendars
- Feedback: say "found a bug" or "want to suggest a feature" to start a conversation with the developer
- Developer: @mxtnr
```

AI does NOT list tools or commands — it uses this block plus its own knowledge of available tools to compose a helpful answer. No duplication.

---

## 7. Voice Response Prompt

### Trigger

After the first voice message from a user whose `voice_response_enabled IS NULL`.

### Sequence

1. Voice message received → transcription → AI processes → text response sent
2. After AI response, bot sends a separate non-AI message:
   ```
   🎤 Хочешь получать голосовые ответы?
   Удобно за рулём, на кухне или на ходу.
   [Да, хочу]  [Нет, только текстом]
   ```
3. User taps button → `voice_response_enabled` set to `1` or `0`
4. Never asked again

### Behavior After Choice

- `voice_response_enabled = 1`: All voice message responses include both text AND voice reply
- `voice_response_enabled = 0`: Voice messages get text-only responses (same as today)
- Changeable via `/settings` → Voice or via AI ("turn off voice responses")

---

## 8. Timezone in Invitations

### Rule

All invitation messages that display event times MUST include the recipient's timezone in parentheses.

### Cases

**Recipient has completed onboarding (timezone known):**
```
📅 Встреча с Петей
🕐 25 марта, 15:00 (Europe/Moscow)
```

**Sender and recipient have different timezones:**
```
📅 Встреча с Петей
🕐 25 марта, 15:00 (Europe/Moscow) / 14:00 (Europe/Kyiv)
```

**Recipient has NOT completed onboarding (no timezone):**
Show only sender's timezone. Do NOT show UTC or any default:
```
📅 Встреча с Петей
🕐 25 марта, 15:00 (Europe/Moscow)
```

No default timezone assumption — if the user hasn't set it, their local time is unknown.

---

## 9. Auto-Pin Calendar Images

### Rule

Every calendar image (day/week/month) sent by the bot is automatically pinned with `disable_notification: true`.

### Sources

- AI tools: `render_day_image`, `render_week_image`
- Commands: `/today`, `/tomorrow`, `/week`, `/month`

### Implementation

After `sendPhoto()` → take returned `message_id` → `pinChatMessage(messageId, { disable_notification: true })`.

### Group Chat: Admin Rights Hint

When pin fails in a group chat (bot lacks admin rights), and `group_chats.pin_hint_shown = 0`:

> Если дать мне права админа, я буду закреплять актуальный календарь автоматически 📌

Set `pin_hint_shown = 1` — never repeat.

If pin fails and hint already shown — silently skip.

In private chats, pin should always succeed — no hint needed.

### Schema Change

```sql
ALTER TABLE group_chats ADD COLUMN pin_hint_shown INTEGER NOT NULL DEFAULT 0;
```

---

## 10. BOT_ADMIN_ID

### Configuration

Added to `.env` and `.env.example`:

```
BOT_ADMIN_ID=<telegram_user_id>
```

Used by:
- Feedback system — forward messages to admin
- IntentLearner — send verification requests to admin
- Intent edit flow — route admin messages for pending edits

### Access

Available via `config.botAdminId` (parsed as number from env).

If not set, feedback and intent verification features are disabled (tools return error, IntentLearner skips sending).
