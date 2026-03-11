# Sub-Project #2: AI Agent

Design spec for the conversational AI interface of HyperCalendarBot.

## 1. Architecture Overview

### Agent Loop

The agent follows the same proven pattern as ExpenseSyncBot: a streaming agentic loop with tool-calling via Anthropic SDK against `api.z.ai`.

```
User message
    |
    v
+-------------------+
| Build messages[]  |  <-- conversation history + system prompt + user message
+-------------------+
    |
    v
+-----------------------------+
| anthropic.messages.stream() |  <-- GLM-5 via api.z.ai
+-----------------------------+
    |
    +---> text_delta --> TelegramStreamWriter.onTextDelta()
    |                      |
    |                      v
    |                  Edit Telegram message (throttled)
    |
    +---> tool_use --> accumulate input JSON
    |        |
    |        v
    |   content_block_stop
    |        |
    |        v
    |   executeTool(name, input, ctx)
    |        |
    |        v
    |   Push tool_result to messages[]
    |        |
    |        v
    |   Continue loop (next round)
    |
    +---> end_turn (no tool_use)
             |
             v
         TelegramStreamWriter.finalize()
             |
             v
         Return final text for chat history
```

### Constraints

| Parameter          | Value      |
|--------------------|------------|
| Max tool rounds    | 15         |
| Interaction timeout| 90 seconds |
| Max tokens         | 4096       |
| Model              | `glm-5` (via `AI_MODEL` env) |
| Base URL           | `https://api.z.ai/api/anthropic` |

### Key Files (planned)

```
src/services/ai/
  agent.ts              -- CalendarBotAgent class (agentic loop)
  tools.ts              -- TOOL_DEFINITIONS array (Anthropic tool schemas)
  tool-executor.ts      -- executeTool() switch/router
  tool-handlers/        -- one file per tool or logical group
    events.ts           -- get_events, create_event, update_event, delete_event, search_events
    agenda.ts           -- get_free_slots, generate_agenda_image
    social.ts           -- share_event, send_invitation
    reminders.ts        -- set_reminder
    meta.ts             -- get_holidays, get_user_settings
  telegram-stream.ts    -- TelegramStreamWriter (port from ExpenseSyncBot)
  system-prompt.ts      -- buildSystemPrompt() with context injection
  types.ts              -- ToolResult, AgentContext, etc.
```

## 2. Agent Context

```ts
interface AgentContext {
  // User identity
  telegramId: number;      // telegram_id — primary user identifier (see 00-common-architecture §3)
  chatId: number;          // Telegram chat ID for responses
  userName: string;        // @username
  userFullName: string;    // first_name + last_name

  // User settings
  timezone: string;        // e.g. "Europe/Moscow", from user profile
  locale: string;          // "ru" | "en", detected or stored
  country: string;         // for holidays, e.g. "RU"

  // Calendar context (injected into system prompt)
  todayEvents: CalendarEvent[];    // today's upcoming events
  tomorrowEvents: CalendarEvent[]; // tomorrow's events
  upcomingCount: number;           // total events in next 7 days
}
```

Context is assembled before each agent invocation. `todayEvents` and `tomorrowEvents` are fetched from SQLite with a simple date filter -- cheap enough to do on every call.

## 3. System Prompt

```ts
function buildSystemPrompt(ctx: AgentContext): string {
  const now = new Date();
  const userNow = formatInTimeZone(now, ctx.timezone, 'yyyy-MM-dd HH:mm');
  const userToday = formatInTimeZone(now, ctx.timezone, 'yyyy-MM-dd');
  const userWeekday = formatInTimeZone(now, ctx.timezone, 'EEEE');

  let prompt = `You are a calendar assistant in a Telegram bot.

CURRENT DATE/TIME: ${userNow} (${userWeekday})
TIMEZONE: ${ctx.timezone}
USER: @${ctx.userName} (${ctx.userFullName})
COUNTRY: ${ctx.country}

TODAY'S SCHEDULE:
${formatEventsForPrompt(ctx.todayEvents) || 'No events today.'}

TOMORROW'S SCHEDULE:
${formatEventsForPrompt(ctx.tomorrowEvents) || 'No events tomorrow.'}

UPCOMING: ${ctx.upcomingCount} events in the next 7 days.

RULES:
1. Use tools for ALL data operations. Never invent event data.
2. When the user describes an event in natural language, parse it and call create_event.
3. Always confirm destructive actions (delete, update) by showing what will change.
4. For ambiguous times: prefer the next occurrence (e.g. "Monday" = next Monday).
5. For ambiguous dates without year: assume current year, or next year if the date has passed.
6. When showing events, always include date, time, and title.
7. Be concise. No unnecessary preamble.
8. Respond in the same language the user writes in.

FORMATTING (Telegram HTML only):
- <b>bold</b> for event titles and important info
- <i>italic</i> for secondary details
- <code>code</code> for dates/times
- Do NOT use Markdown. Escape < > & as &lt; &gt; &amp;

NATURAL LANGUAGE PARSING:
- "tomorrow at 3pm" -> next day, 15:00 in user's timezone
- "next Monday" -> the coming Monday
- "through Friday" -> multi-day event ending Friday
- "every Tuesday" -> recurring weekly event
- "in 2 hours" -> relative to current time
- Russian: "послезавтра в 10" -> day after tomorrow, 10:00
- Russian: "через час" -> in 1 hour from now`;

  return prompt;
}
```

### Context Injection Strategy

The system prompt includes today's and tomorrow's events directly -- this gives the agent immediate context without a tool call, saving one round-trip for the most common queries ("what's my schedule?").

For anything beyond today/tomorrow, the agent must call `get_events` with a date range. This is deliberate: we avoid stuffing hundreds of events into the prompt but give enough context that simple "what's today?" questions resolve instantly.

The `upcomingCount` hint tells the agent there are more events to discover, nudging it to call `get_events` when the user asks about "this week" or "next week".

## 4. Tool Catalog

### 4.1 `get_events` -- Query events with filters

```ts
{
  name: 'get_events',
  description: 'Get calendar events with optional filters. Returns events sorted by start time ascending.',
  input_schema: {
    type: 'object',
    properties: {
      start_date: {
        type: 'string',
        description: 'Start of date range, YYYY-MM-DD. Default: today.'
      },
      end_date: {
        type: 'string',
        description: 'End of date range, YYYY-MM-DD. Default: same as start_date.'
      },
      category: {
        type: 'string',
        description: 'Filter by category (case-insensitive).'
      },
      search: {
        type: 'string',
        description: 'Full-text search in title, description, location.'
      },
      limit: {
        type: 'number',
        description: 'Max results (default: 50, max: 200).'
      }
    }
  }
}
```

**Returns:** List of events with id, title, start_time, end_time, location, category, description, reminders, is_recurring.

### 4.2 `create_event` -- Create a new event

```ts
{
  name: 'create_event',
  description: 'Create a new calendar event. Parse natural language input into structured fields before calling.',
  input_schema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Event title.'
      },
      start_time: {
        type: 'string',
        description: 'Start datetime in ISO 8601 format (YYYY-MM-DDTHH:mm). In user timezone.'
      },
      end_time: {
        type: 'string',
        description: 'End datetime in ISO 8601 (YYYY-MM-DDTHH:mm). Default: start_time + 1 hour.'
      },
      location: {
        type: 'string',
        description: 'Event location (address, place name, or URL for online meetings).'
      },
      description: {
        type: 'string',
        description: 'Additional details.'
      },
      category: {
        type: 'string',
        description: 'Event category (work, personal, health, social, etc.). Maps to events.category in DB. Colors are derived from category at the rendering level.'
      },
      all_day: {
        type: 'boolean',
        description: 'If true, this is an all-day event (no specific time).'
      },
      recurrence: {
        type: 'object',
        description: 'Recurrence rule.',
        properties: {
          frequency: {
            type: 'string',
            enum: ['daily', 'weekly', 'monthly', 'yearly'],
            description: 'How often the event repeats.'
          },
          interval: {
            type: 'number',
            description: 'Repeat every N frequency units. Default: 1.'
          },
          days_of_week: {
            type: 'array',
            items: { type: 'string', enum: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] },
            description: 'For weekly: which days. E.g. ["mon", "wed", "fri"].'
          },
          until: {
            type: 'string',
            description: 'Recurrence end date, YYYY-MM-DD.'
          },
          count: {
            type: 'number',
            description: 'Max number of occurrences.'
          }
        }
      },
      reminder_minutes: {
        type: 'number',
        description: 'Reminder N minutes before event. Default: 15.'
      }
    },
    required: ['title', 'start_time']
  }
}
```

**Returns:** Created event with ID and computed fields (next reminder time, recurrence description).

### 4.3 `update_event` -- Modify an existing event

```ts
{
  name: 'update_event',
  description: 'Update one or more fields of an existing event. Only pass fields that need changing.',
  input_schema: {
    type: 'object',
    properties: {
      event_id: {
        type: 'number',
        description: 'ID of the event to update. Get from get_events.'
      },
      title: { type: 'string' },
      start_time: { type: 'string', description: 'ISO 8601 (YYYY-MM-DDTHH:mm).' },
      end_time: { type: 'string', description: 'ISO 8601 (YYYY-MM-DDTHH:mm).' },
      location: { type: 'string' },
      description: { type: 'string' },
      category: { type: 'string' },
      all_day: { type: 'boolean' },
      recurrence: {
        type: 'object',
        description: 'New recurrence rule. Pass null to remove recurrence.',
        properties: {
          frequency: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'yearly'] },
          interval: { type: 'number' },
          days_of_week: { type: 'array', items: { type: 'string' } },
          until: { type: 'string' },
          count: { type: 'number' }
        }
      },
      update_scope: {
        type: 'string',
        enum: ['this', 'this_and_future', 'all'],
        description: 'For recurring events: update this occurrence, this + future, or all. Default: this.'
      }
    },
    required: ['event_id']
  }
}
```

**Returns:** Updated event. For recurring events with `this` scope, creates an exception instance.

### 4.4 `delete_event` -- Remove an event

```ts
{
  name: 'delete_event',
  description: 'Delete a calendar event. ALWAYS show event details and ask for confirmation before calling this.',
  input_schema: {
    type: 'object',
    properties: {
      event_id: {
        type: 'number',
        description: 'ID of the event to delete.'
      },
      delete_scope: {
        type: 'string',
        enum: ['this', 'this_and_future', 'all'],
        description: 'For recurring events: delete this occurrence, this + future, or all. Default: this.'
      }
    },
    required: ['event_id']
  }
}
```

**Returns:** Confirmation of deletion with event summary.

### 4.5 `get_free_slots` -- Find available time

```ts
{
  name: 'get_free_slots',
  description: 'Find free time slots in a date range. Useful for scheduling new events.',
  input_schema: {
    type: 'object',
    properties: {
      start_date: {
        type: 'string',
        description: 'Start date, YYYY-MM-DD. Default: today.'
      },
      end_date: {
        type: 'string',
        description: 'End date, YYYY-MM-DD. Default: same as start_date.'
      },
      min_duration_minutes: {
        type: 'number',
        description: 'Minimum slot duration in minutes. Default: 30.'
      },
      working_hours_only: {
        type: 'boolean',
        description: 'Only show slots within working hours (09:00-18:00). Default: true.'
      }
    }
  }
}
```

**Returns:** List of free time slots `{ date, start, end, duration_minutes }`.

### 4.6 `search_events` -- Full-text search

```ts
{
  name: 'search_events',
  description: 'Search events by text across title, description, and location. Returns results across all dates.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query.'
      },
      limit: {
        type: 'number',
        description: 'Max results. Default: 20.'
      }
    },
    required: ['query']
  }
}
```

**Returns:** Matching events sorted by relevance (SQLite FTS5 or LIKE fallback).

### 4.7 `set_reminder` -- Set custom reminder

```ts
{
  name: 'set_reminder',
  description: 'Set or update a reminder for an event. Multiple reminders per event are supported.',
  input_schema: {
    type: 'object',
    properties: {
      event_id: {
        type: 'number',
        description: 'Event ID.'
      },
      minutes_before: {
        type: 'number',
        description: 'Remind N minutes before event start. Common values: 5, 10, 15, 30, 60, 1440 (1 day).'
      },
      custom_message: {
        type: 'string',
        description: 'Optional custom reminder text (instead of default).'
      }
    },
    required: ['event_id', 'minutes_before']
  }
}
```

**Returns:** Confirmation with computed reminder time.

### 4.8 `share_event` -- Share with a contact

```ts
{
  name: 'share_event',
  description: 'Share an event with another Telegram user. Creates a read-only copy in their calendar.',
  input_schema: {
    type: 'object',
    properties: {
      event_id: {
        type: 'number',
        description: 'Event ID to share.'
      },
      target_username: {
        type: 'string',
        description: 'Telegram @username of the recipient (without @).'
      },
      target_telegram_id: {
        type: 'number',
        description: 'Telegram user ID of the recipient (alternative to username).'
      },
      message: {
        type: 'string',
        description: 'Optional personal message to include with the share.'
      }
    },
    required: ['event_id']
  }
}
```

**Returns:** Share status. If recipient is not a bot user, returns a shareable deep link.

### 4.9 `send_invitation` -- Invite someone to an event

```ts
{
  name: 'send_invitation',
  description: 'Send a calendar invitation to a Telegram user. Unlike share, this adds them as a participant.',
  input_schema: {
    type: 'object',
    properties: {
      event_id: {
        type: 'number',
        description: 'Event ID.'
      },
      target_username: {
        type: 'string',
        description: 'Telegram @username (without @).'
      },
      target_telegram_id: {
        type: 'number',
        description: 'Telegram user ID (alternative to username).'
      }
    },
    required: ['event_id']
  }
}
```

**Returns:** Invitation status. The bot sends an inline-keyboard message to the recipient with Accept/Decline buttons. The invitation state is tracked in DB.

### 4.10 `generate_agenda_image` -- Visual agenda

```ts
{
  name: 'generate_agenda_image',
  description: 'Generate a visual image of the agenda for a date range. Dispatches to the worker queue -- the image will be sent as a separate message.',
  input_schema: {
    type: 'object',
    properties: {
      start_date: {
        type: 'string',
        description: 'Start date, YYYY-MM-DD. Default: today.'
      },
      end_date: {
        type: 'string',
        description: 'End date, YYYY-MM-DD. Default: end of current week.'
      },
      style: {
        type: 'string',
        enum: ['timeline', 'calendar', 'list'],
        description: 'Visual style. Default: timeline.'
      }
    }
  }
}
```

**Returns:** Confirmation that the image generation job was queued. The tool adds a BullMQ job; the worker process renders the image and sends it to the chat.

### 4.11 `get_holidays` -- Public holidays

```ts
{
  name: 'get_holidays',
  description: "Get public holidays for a country and year. Useful for planning around days off.",
  input_schema: {
    type: 'object',
    properties: {
      country: {
        type: 'string',
        description: "ISO 3166-1 alpha-2 country code. Default: user's country."
      },
      year: {
        type: 'number',
        description: 'Year. Default: current year.'
      },
      month: {
        type: 'number',
        description: 'Optional: filter to a specific month (1-12).'
      }
    }
  }
}
```

**Returns:** List of holidays `{ date, name, name_local }`. Data source: bundled JSON files for major countries (RU, US, GB, DE, etc.) -- no external API dependency.

### 4.12 `get_user_settings` -- Read user preferences

```ts
{
  name: 'get_user_settings',
  description: 'Get current user settings: timezone, language, country code.',
  input_schema: {
    type: 'object',
    properties: {}
  }
}
```

**Returns:** User settings object.

### 4.13 `update_user_settings` -- Change user preferences

```ts
{
  name: 'update_user_settings',
  description: 'Update user settings. Only pass fields that need changing.',
  input_schema: {
    type: 'object',
    properties: {
      timezone: {
        type: 'string',
        description: 'IANA timezone (e.g. "Europe/Moscow").'
      },
      language: {
        type: 'string',
        enum: ['en', 'ru'],
        description: 'User language. Maps to users.language in DB.'
      },
      country: {
        type: 'string',
        description: 'ISO country code for holidays. Maps to users.country_code in DB.'
      }
    }
  }
}
```

**Returns:** Updated settings.

### Tool Summary Table

| # | Tool | Type | Rounds | Notes |
|---|------|------|--------|-------|
| 1 | `get_events` | read | 1 | Main query tool |
| 2 | `create_event` | write | 1 | Parses NL into struct |
| 3 | `update_event` | write | 1 | Partial updates, recurring scope |
| 4 | `delete_event` | write | 1 | Confirmation required |
| 5 | `get_free_slots` | read | 1 | For scheduling |
| 6 | `search_events` | read | 1 | FTS across all dates |
| 7 | `set_reminder` | write | 1 | Multiple per event |
| 8 | `share_event` | write | 1 | Read-only copy or deep link |
| 9 | `send_invitation` | write | 1 | Accept/Decline flow |
| 10 | `generate_agenda_image` | async | 1 | BullMQ job, worker renders |
| 11 | `get_holidays` | read | 1 | Bundled data, no API |
| 12 | `get_user_settings` | read | 1 | User preferences |
| 13 | `update_user_settings` | write | 1 | Timezone, language, country |

## 5. Streaming Implementation

Ported from ExpenseSyncBot's `TelegramStreamWriter` with calendar-specific adaptations.

### Flow

1. On agent invocation, send a placeholder message ("...") and start `typing` action interval.
2. As `text_delta` events arrive, accumulate text and flush to Telegram via `editMessageText` (throttled to 1 update per 3 seconds, minimum 20 chars delta).
3. On `tool_use`, show an italic indicator line (e.g., _Ищу свободные слоты..._). Replace with a checkmark/cross on tool completion.
4. On finalize, collapse tool indicators into an expandable blockquote at the top, clean up HTML, send final version.
5. For long responses (>4000 chars), split into chunks by paragraph boundaries and send as separate messages.

### Tool Labels (Russian)

```ts
const TOOL_LABELS: Record<string, string> = {
  get_events: 'Загружаю события',
  create_event: 'Создаю событие',
  update_event: 'Обновляю событие',
  delete_event: 'Удаляю событие',
  get_free_slots: 'Ищу свободные слоты',
  search_events: 'Ищу события',
  set_reminder: 'Устанавливаю напоминание',
  share_event: 'Делюсь событием',
  send_invitation: 'Отправляю приглашение',
  generate_agenda_image: 'Генерирую картинку',
  get_holidays: 'Проверяю праздники',
  get_user_settings: 'Читаю настройки',
  update_user_settings: 'Обновляю настройки',
};
```

### Telegram Rate Limit Handling

- On 429 from Telegram: back off for 10 seconds (no updates during cooldown).
- On "message is not modified": silently ignore, update internal state.
- On other errors: log and continue.

## 6. Conversation History

### What Gets Saved

Only the final text response is saved to `chat_history` table, not intermediate tool_use rounds. This matches ExpenseSyncBot.

```sql
CREATE TABLE chat_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,                   -- telegram_id
  role TEXT NOT NULL,                          -- 'user' | 'assistant'
  content TEXT NOT NULL,                       -- plain text or JSON array of content blocks
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
);

CREATE INDEX idx_chat_history_user ON chat_history(user_id, created_at);
```

### History Window

Load last **20 messages** (10 user + 10 assistant) for context. This gives enough conversational memory without blowing the token budget.

Older messages are in the DB for analytics but not sent to the model.

### History Message Format

```ts
function buildHistoryMessages(history: ChatMessage[]): Anthropic.MessageParam[] {
  return history.map(msg => ({
    role: msg.role as 'user' | 'assistant',
    content: tryParseJsonArray(msg.content) || msg.content,
  }));
}
```

## 7. Example Conversations

### Scenario 1: Natural language event creation (Russian)

```
User: Встреча с Колей завтра в 15:00 в кафе на Арбате

Agent: [calls create_event with:
  title: "Встреча с Колей"
  start_time: "2026-03-12T15:00"
  end_time: "2026-03-12T16:00"
  location: "кафе на Арбате"
  category: "social"
  reminder_minutes: 15
]

Agent response (HTML):

  <b>Встреча с Колей</b> создана:
  <code>12 марта, 15:00-16:00</code>
  Место: кафе на Арбате
  Напоминание за 15 минут.
```

### Scenario 2: What's today + reschedule

```
User: What's on my plate today?

Agent: [uses today's events from system prompt context -- no tool call needed]

Agent response:

  Today's schedule:

  <code>09:00-09:30</code> <b>Daily standup</b> (Zoom)
  <code>11:00-12:00</code> <b>Design review</b> (Room 4)
  <code>14:00-15:00</code> <b>Lunch with Maria</b> (Кофемания)
  <code>17:00-17:30</code> <b>1:1 with Alex</b> (Zoom)

  4 events, ~3 hours busy.

User: Move the design review to 2pm

Agent: [calls get_events to find the design review event ID]
Agent: [calls update_event with event_id, start_time: "2026-03-11T14:00", end_time: "2026-03-11T15:00"]

Agent response:

  Moved <b>Design review</b> to <code>14:00-15:00</code>.

  Note: this now overlaps with <b>Lunch with Maria</b> (<code>14:00-15:00</code>).
  Want me to move the lunch?
```

### Scenario 3: Finding free time

```
User: Когда я свободен на этой неделе для часовой встречи?

Agent: [calls get_free_slots with:
  start_date: "2026-03-11"
  end_date: "2026-03-15"
  min_duration_minutes: 60
  working_hours_only: true
]

Agent response:

  Свободные слоты (от 1 часа) на этой неделе:

  <b>Среда, 11 марта:</b>
  <code>12:00-14:00</code> (2 ч)
  <code>15:30-17:00</code> (1.5 ч)

  <b>Четверг, 12 марта:</b>
  <code>09:00-11:00</code> (2 ч)
  <code>16:00-18:00</code> (2 ч)

  <b>Пятница, 13 марта:</b>
  <code>09:00-18:00</code> (весь день свободен)

  Создать встречу на один из этих слотов?
```

### Scenario 4: Invitation flow

```
User: Invite @maria_dev to the design review tomorrow

Agent: [calls get_events to find "design review" tomorrow]
Agent: [calls send_invitation with event_id, target_username: "maria_dev"]

Agent response:

  Приглашение отправлено @maria_dev на <b>Design review</b>
  (<code>12 марта, 14:00-15:00</code>).

  Она получит сообщение с кнопками принять/отклонить.
```

### Scenario 5: Recurring event + holidays

```
User: Create a weekly team sync every Tuesday at 10am, skip holidays

Agent: [calls get_holidays with country: "RU", year: 2026]
Agent: [calls create_event with:
  title: "Team sync"
  start_time: "2026-03-17T10:00"  (next Tuesday)
  end_time: "2026-03-17T11:00"
  recurrence: { frequency: "weekly", days_of_week: ["tue"] }
  category: "work"
]

Agent response:

  <b>Team sync</b> -- еженедельно по вторникам в <code>10:00-11:00</code>.

  Ближайшие праздничные вторники в 2026:
  - <code>03 ноября</code> -- День народного единства (перенос)

  Хочешь, чтобы я автоматически пропустил этот день?
```

## 8. Error Handling

### Agent-Level Errors

| Error | Handling |
|-------|----------|
| Timeout (90s) | Abort stream, send "Time's up" message |
| API 429 (rate limit) | Send "Too many requests, wait a minute" |
| API 529 (overloaded) | Send "Server overloaded, try later" |
| API other errors | Log, send generic error |
| Max rounds exceeded (15) | Finalize with whatever text is accumulated |

### Tool-Level Errors

Every tool returns `{ success: boolean, output?: string, error?: string }`. On `success: false`, the error message is fed back to the model as the tool_result, and the agent decides how to communicate it to the user (retry, explain, suggest alternative).

| Error | Handling |
|-------|----------|
| Event not found | Agent tells user, suggests search |
| Permission denied (not owner) | Agent explains, no retry |
| Invalid date/time | Agent asks user to clarify |
| Overlapping events | Agent warns, asks if user wants to proceed |
| Recipient not found (share/invite) | Agent explains, offers deep link alternative |
| Worker queue full (image gen) | Agent says "try later" |
| Holiday data missing for country | Agent says "no data for this country" |

### Graceful Degradation

If the streaming connection drops mid-response, the `TelegramStreamWriter` has accumulated whatever was sent. The `finalize()` method is called in a finally block, ensuring the last known state is displayed even on error.

## 9. Token Usage & Performance

### Estimated Token Consumption Per Interaction

| Component | Input tokens | Output tokens |
|-----------|-------------|---------------|
| System prompt | ~500 | -- |
| Today's events (5 events) | ~200 | -- |
| History (20 messages) | ~2000 | -- |
| User message | ~50 | -- |
| Tool definitions (13 tools) | ~2200 | -- |
| Agent response (per round) | -- | ~200-500 |
| Tool results (per call) | ~100-500 | -- |

**Typical interaction:** ~5200 input + ~400 output tokens.
**Worst case (15 rounds):** ~14700 input + ~3000 output tokens.

### Optimization Strategies

1. **Cache control on system prompt:** Use `cache_control: { type: 'ephemeral' }` on the system block. Since tool definitions and system prompt are identical across calls, the API can cache them.

2. **Today's events in system prompt:** Avoids the most common tool call round-trip. One fewer API round = significant latency savings.

3. **Today's events in system prompt (continued):** For "what's today?" queries, the agent resolves from context without any tool call. `get_events` with a date filter covers anything beyond today/tomorrow.

4. **Summary-only mode in `get_events`:** For "how many events this week?" type queries, the agent can request just counts instead of full event objects.

5. **History pruning:** 20 messages max. Old conversations don't leak into token counts.

### Latency Targets

| Metric | Target |
|--------|--------|
| Time to first text delta in Telegram | < 3 seconds |
| Simple query (no tool calls) | < 5 seconds total |
| Single tool call interaction | < 8 seconds total |
| Multi-tool interaction (3 rounds) | < 15 seconds total |
| Image generation (async) | < 30 seconds (worker) |

## 10. Security Considerations

1. **Event ownership:** All tool handlers verify `telegram_id` ownership before mutations. Users cannot access or modify other users' events unless explicitly shared.

2. **Invitation spam:** Rate limit `send_invitation` to 10 per hour per user.

3. **Input sanitization:** Tool inputs are validated before DB operations. The agent's JSON parsing is wrapped in try/catch. Invalid tool input returns a `success: false` result, not an exception.

4. **No prompt injection via event content:** Event titles/descriptions are treated as data, not instructions. The system prompt's rules section takes precedence.

5. **Telegram HTML escaping:** All user-generated content (event titles, locations) is HTML-escaped before including in streamed responses. The agent is instructed to use HTML formatting, but the `TelegramStreamWriter` double-checks for unescaped content.
