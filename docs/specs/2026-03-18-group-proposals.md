# Patch: Calendar Change Proposals in Group Chats

**Extends:** spec 06-sharing-social, spec 2026-03-18-privacy-delegation
**Phase:** B (Sub-project 06)

---

## Terminology

| Term (RU) | Term (EN, code) | Who |
|-----------|-----------------|-----|
| предлагающий | proposer | Инициатор изменения |
| получатель | target | Тот, кому предлагается изменение |

---

## Overview

В групповом чате, где есть бот, любой пользователь может предложить изменение в календаре любого другого
участника того же чата. Изменение вступает в силу только после явного принятия получателем.

Поддерживаемые операции: создать, изменить, удалить, переименовать, переместить событие.

Доступ основан на факте совместного участия в чате — никаких предварительных разрешений не требуется.

---

## 0. Утилита доставки сообщений (обобщение)

Существующий `deliverInvitationAsync` в `src/services/ai/tool-handlers/sharing.ts` специфичен
для инвайтов. Он должен быть вынесен в универсальный `deliverMessageAsync` и использоваться
повсюду, где бот пишет пользователю вне AI-тёрна.

### Интерфейс

```typescript
interface DeliverMessageParams {
  target_id:          number;
  target_username?:   string;
  text:               string;
  keyboard?:          InlineKeyboard;
  // Fallback-сообщение предлагающему/инициатору, если доставить не удалось
  fallback_recipient_id: number;
  fallback_text:      string;
}

async function deliverMessageAsync(params: DeliverMessageParams): Promise<{ delivered: boolean; message_id?: number }>
```

### Цепочка доставки (универсальная)

1. **Bot API** — прямое `sendMessage(target_id, ...)`. Работает если пользователь хотя бы раз писал боту.
2. **MTProto fallback** — `mtprotoSendAsUser(target_id, text, target_username)`. Работает для
   пользователей с публичным username, даже если они никогда не писали боту.
3. **Deep link fallback** — если оба не сработали: отправить `fallback_text` инициатору
   с deeplink-кнопкой `[→ Написать боту]`, чтобы цель могла начать диалог сама.

`deliverInvitationAsync` рефакторится на вызов `deliverMessageAsync`.

---

## 1. Database

### calendar_proposals

```sql
CREATE TABLE calendar_proposals (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  group_chat_id        INTEGER NOT NULL,        -- Telegram chat_id группы
  group_chat_title     TEXT,                    -- для отображения в личном сообщении
  proposer_id          INTEGER NOT NULL,        -- telegram_id предлагающего
  target_id            INTEGER NOT NULL,        -- telegram_id получателя
  action               TEXT NOT NULL,           -- 'create' | 'update' | 'delete'
  payload              TEXT NOT NULL,           -- JSON: см. ниже
  summary              TEXT NOT NULL,           -- человекочитаемое описание для DM
  status               TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'accepted' | 'declined' | 'expired'
  group_message_id     INTEGER,                 -- id сообщения бота в группе ("отправил предложение")
  dm_message_id        INTEGER,                 -- id DM-сообщения у цели (для edit после ответа)
  expires_at           TEXT NOT NULL,           -- ISO8601 UTC: конец затрагиваемого события
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (proposer_id) REFERENCES users(telegram_id) ON DELETE CASCADE,
  FOREIGN KEY (target_id)   REFERENCES users(telegram_id) ON DELETE CASCADE
);

CREATE INDEX idx_proposals_target  ON calendar_proposals(target_id, status);
CREATE INDEX idx_proposals_expires ON calendar_proposals(expires_at, status);
```

### payload JSON shape

```typescript
type ProposalPayload =
  | { action: 'create'; event: EventCreateParams }
  | { action: 'update'; event_id: string; changes: EventUpdateParams }
  | { action: 'delete'; event_id: string };
```

Для `update`/`delete` `event_id` берётся из ранее расшаренного события в чате.
Если событие удалено до принятия предложения — executor возвращает `PROPOSAL_EVENT_GONE`.

---

## 2. New AI Tool

### `propose_calendar_change`

```typescript
{
  name: 'propose_calendar_change',
  description:
    'Propose a calendar change to another member of this group chat. ' +
    'The target receives a DM with Accept/Decline buttons — you cannot modify their calendar directly. ' +
    'Supported actions: "create" (new event), "update" (change fields of existing event), "delete" (remove event). ' +
    'For "update" and "delete", event_id must be known from a calendar view shared earlier in the chat. ' +
    'Use find_user first to resolve @username/name to telegram_id. ' +
    'After calling, STOP — the group chat will be notified of the outcome automatically.',
  input_schema: {
    type: 'object',
    properties: {
      target_telegram_id: {
        type: 'number',
        description: 'telegram_id of the group member to propose the change to.',
      },
      action: {
        type: 'string',
        enum: ['create', 'update', 'delete'],
      },
      event: {
        type: 'object',
        description: 'Full event data. Required for action "create".',
      },
      event_id: {
        type: 'string',
        description: 'ID of the existing event. Required for "update" and "delete".',
      },
      changes: {
        type: 'object',
        description: 'Fields to change. Required for action "update".',
      },
      summary: {
        type: 'string',
        description:
          'Human-readable description of the proposed change shown in the DM. ' +
          'Example: "добавить встречу «Ретро» — пятница 15:00–16:00" or "удалить «Планёрка» 14 марта".',
      },
    },
    required: ['target_telegram_id', 'action', 'summary'],
  },
}
```

### Executor logic

1. Проверяет что `target_telegram_id` — участник `group_chat_id` через Telegram API (`getChatMember`).
   Если нет → возвращает `PROPOSAL_TARGET_NOT_IN_CHAT`. AI: "Этот пользователь не состоит в данном чате."
2. Вычисляет `expires_at`:
   - `create`: конец создаваемого события (`event.end_time`)
   - `update`/`delete`: конец существующего события (берётся из БД по `event_id`)
   - Если время не определить → `now + 7 days`
3. Сохраняет строку в `calendar_proposals` (status = `'pending'`)
4. Доставляет DM цели через `deliverMessageAsync` (см. секцию 0) с кнопками [Принять ✅] [Отклонить ❌]
5. Отправляет в группу: `Отправил предложение Alice (@alice_cto). Она ответит в личных сообщениях. [→ Написать боту]`
   Сохраняет `group_message_id`.
6. Возвращает `{ status: 'awaiting_confirmation', proposal_id: N }`

---

## 3. DM-сообщение цели

```
John (@john_pm) предлагает изменение в твоём календаре (чат "Dev Team"):

📅 Добавить: «Ретро» — пятница, 20 марта, 15:00–16:00

[Принять ✅]  [Отклонить ❌]
```

Формат `summary` зависит от `action`:
- `create` → `📅 Добавить: «{title}» — {date}, {time}`
- `update` → `✏️ Изменить: «{title}» — {description of changes}`
- `delete` → `🗑 Удалить: «{title}» — {date}`

Callback data:
- `prop:accept:{id}`
- `prop:decline:{id}`

---

## 4. On Accept

```sql
UPDATE calendar_proposals SET status = 'accepted', updated_at = datetime('now') WHERE id = ?;
```

Executor выполняет `payload` напрямую через EventService от имени `target_id` — без AI-тёрна
и без прохождения через AI tool input schema. `target_id` берётся из `calendar_proposals`,
не из пользовательского ввода.

Бот редактирует DM у цели:
```
✅ Принято. Изменение применено к твоему календарю.
```

Бот редактирует сообщение в группе (по `group_message_id`):
```
✅ Alice приняла предложение John — «Ретро» добавлено в календарь.
```

---

## 5. On Decline

```sql
UPDATE calendar_proposals SET status = 'declined', updated_at = datetime('now') WHERE id = ?;
```

Бот редактирует DM у цели:
```
Предложение отклонено.
```

Бот редактирует сообщение в группе:
```
❌ Alice отклонила предложение John.
```

---

## 6. System Prompt Extension

### Chat context

В system prompt добавить секцию с типом чата:

```
- Chat type: group
- Chat ID: -100123456789
- Chat title: Dev Team
```

Для приватных чатов строки не добавляются (там это неприменимо).

### Новый блок Rules: Group Proposals

```
## Group Proposals

You are in a group chat. You CANNOT modify other users' calendars directly.
If the message asks to change, add, or delete something in another user's calendar:
1. Use find_user to resolve the target to telegram_id.
2. If find_user fails, tell the proposer what actually happened, in their own language — do not reword an "unavailable/couldn't verify" error as "hasn't started the bot" (that error means resolution could not be checked, not that the person doesn't use Telegram), and never paste the raw English error text verbatim.
3. Confirm the proposed change with ask_user if any details are ambiguous.
4. Call propose_calendar_change. STOP immediately after — do not add more text.

If the message is about the user's own calendar — act normally (no proposal needed).
If it's unclear whose calendar is meant — call ask_user: ["Мой", "@alice"].
```

---

## 7. Cron Jobs

| Job | Trigger | Action |
|-----|---------|--------|
| `expire-pending-proposals` | Hourly | `status = 'expired'` для `pending` строк где `expires_at < now`; редактировать DM у цели: `Предложение истекло.`; редактировать сообщение в группе: `⏱ Предложение John для Alice истекло.` |

---

## 8. Edge Cases

| Scenario | Handling |
|----------|----------|
| Target не в чате | `PROPOSAL_TARGET_NOT_IN_CHAT`. AI: "Этот пользователь не состоит в данном чате." |
| Target не писал боту | `deliverMessageAsync` → MTProto fallback → deep link к предлагающему: "Алиса ещё не запускала бота. Перешли ей эту ссылку." |
| `event_id` не существует или удалён до принятия | `PROPOSAL_EVENT_GONE`. Executor уведомляет цель и предлагающего в личке: "Событие больше не существует, предложение аннулировано." |
| Предложение истекло (принятие после `expires_at`) | `PROPOSAL_EXPIRED`. Бот: "Предложение истекло — событие уже завершилось." Кнопки убрать (edit message). |
| Несколько открытых предложений к одному пользователю | Нет ограничений. Цель принимает/отклоняет каждое независимо. |
| Принятие конфликтующих предложений (оба меняют одно событие) | Выполняются в порядке принятия целью (по `updated_at` записи). Второе может завершиться `PROPOSAL_EVENT_GONE` если первое удалило событие. |
| Предлагающий покидает чат до принятия | Предложение остаётся активным. После принятия выполняется как обычно. |
| Бот не может редактировать group_message (нет прав) | Silent fail. Результат сообщается только в личке. |
