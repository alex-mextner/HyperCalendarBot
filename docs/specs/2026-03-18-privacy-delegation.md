# Patch: Calendar Secretary Access

**Extends:** spec 06-sharing-social, spec 2026-03-17-bot-ux-automation
**Phase:** B (Sub-project 06)

---

## Terminology

| Term (RU) | Term (EN, code) | Who |
|-----------|-----------------|-----|
| делегирующий | owner | Владелец календаря, тот кто даёт доступ |
| секретарь | secretary | Тот кто получает доступ и управляет чужим календарём |

---

## Overview

Делегирующий может назначить одного или нескольких секретарей, которые управляют его календарём.
Всё через AI-агента — новых команд нет.

Два уровня доступа:
- `read` — видит все события включая приватные (обходит privacy filter), без записи
- `write` — видит + создаёт/редактирует/удаляет события от имени делегирующего

Секретарь не может назначать секретарей к чужому календарю (к тому, в котором он сам секретарь).
К своему личному календарю — может, как любой пользователь.
Секретарь не может менять настройки делегирующего.

---

## 1. Database

### calendar_secretaries

```sql
CREATE TABLE calendar_secretaries (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id       INTEGER NOT NULL,                     -- telegram_id делегирующего
  secretary_id   INTEGER NOT NULL,                     -- telegram_id секретаря
  permission     TEXT NOT NULL DEFAULT 'read',         -- 'read' | 'write'
  status         TEXT NOT NULL DEFAULT 'pending',      -- 'pending' | 'active' | 'revoked' | 'declined' | 'expired'
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(owner_id, secretary_id),
  FOREIGN KEY (owner_id)     REFERENCES users(telegram_id) ON DELETE CASCADE,
  FOREIGN KEY (secretary_id) REFERENCES users(telegram_id) ON DELETE CASCADE
);

CREATE INDEX idx_secretaries_owner     ON calendar_secretaries(owner_id);
CREATE INDEX idx_secretaries_secretary ON calendar_secretaries(secretary_id, status);
```

---

## 2. New AI Tools

### `list_calendar_access`

Возвращает полную картину:
- чужие календари, к которым у пользователя есть доступ как у секретаря
- секретари, которых пользователь добавил к своему собственному календарю (их может быть несколько)

AI вызывает когда пользователь спрашивает про своих секретарей или про чужие календари где он сам секретарь, или когда контекст неоднозначен.

```typescript
{
  name: 'list_calendar_access',
  description:
    'List all calendars this user has access to. Returns their own calendar and any ' +
    'calendars they can manage as a secretary. Also returns secretaries the user has ' +
    'added to their own calendar. Call when the user asks about their secretaries or asks about calendars they manage as secretary for someone else, ' +
    'or when context is ambiguous and you need to know which calendars are available.',
  input_schema: {
    type: 'object',
    properties: {},
    required: [],
  },
}
```

Response shape:
```json
{
  "own": {
    "telegram_id": 123,
    "username": "alex_ultra",
    "display_name": "Alex"
  },
  "my_secretaries": [
    { "id": 1, "telegram_id": 456, "username": "john_sec", "display_name": "John", "permission": "write", "status": "active" },
    { "id": 2, "telegram_id": 789, "username": "mary_r", "display_name": "Mary", "permission": "read", "status": "pending" }
  ],
  "secretary_for": [
    { "id": 3, "owner_telegram_id": 999, "owner_username": "alice_cto", "owner_display_name": "Alice", "permission": "write" }
  ]
}
```

---

### `manage_secretaries`

Тул для двух сценариев: делегирующий приглашает/убирает секретарей своего календаря;
секретарь отказывается от своей роли в чужом календаре.
Приглашение требует подтверждения от приглашаемого. Отзыв доступа делегирующим — через `ask_user`.
Добровольный выход секретаря — без подтверждения.

```typescript
{
  name: 'manage_secretaries',
  description:
    'Invite a secretary to your own calendar, or manage your own secretary role in someone else\'s calendar. ' +
    'action "invite": invite a person to be secretary of YOUR calendar. ' +
    'They receive an invitation and must accept it — access is not granted until they do. ' +
    'They can decline immediately or revoke their access at any later time. ' +
    'Use find_user first to resolve name/username to telegram_id. ' +
    'After calling "invite", STOP — you will be notified when they accept or decline. ' +
    'action "revoke": withdraw secretary access you previously granted to someone for YOUR calendar (works on pending or active). ' +
    'action "self_remove": resign from being secretary of someone else\'s calendar.',
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['invite', 'revoke', 'self_remove'],
      },
      secretary_telegram_id: {
        type: 'number',
        description: 'telegram_id of the person to invite as secretary. Required for action "invite".',
      },
      permission: {
        type: 'string',
        enum: ['read', 'write'],
        description: 'Access level: "read" = view only, "write" = full calendar management. Required for action "invite".',
      },
      secretary_access_id: {
        type: 'number',
        description: 'ID of the secretary access record to revoke or remove. Required for actions "revoke" and "self_remove".',
      },
    },
    required: ['action'],
  },
}
```

**`action: "invite"`:**
1. Проверяет что `secretary_telegram_id` есть в `users` — если нет, возвращает `SECRETARY_NOT_FOUND`
2. Upsert строки: если запись с `(owner_id, secretary_id)` уже существует с `status = 'pending'` и `created_at > now - 7 days` — переиспользовать (не создавать новую, вернуть существующий `id`). Иначе — `INSERT OR REPLACE` с `status = 'pending'`, сброс `created_at`
3. Отправляет бот-сообщение секретарю (см. секцию 4)
4. Возвращает `{ status: 'awaiting_confirmation', secretary_access_id: N }`
5. AI получает → говорит делегирующему: _"Отправил @john приглашение стать секретарём. Скажу, когда он примет."_ → **STOP**

**`action: "revoke"`:**
1. Ставит `status = 'revoked'`, `updated_at = datetime('now')`
2. Бот отправляет секретарю:
   ```
   Твой доступ к календарю Alice (@alice_ultra) был отозван.
   ```
3. Возвращает `{ ok: true }`

**`action: "self_remove"`:**
1. Проверяет что `calendar_secretaries.secretary_id == current_user.telegram_id` для указанного `secretary_access_id` — иначе `SECRETARY_ACCESS_DENIED`
2. Ставит `status = 'revoked'`, `updated_at = datetime('now')`
3. Бот отправляет делегирующему:
   ```
   @john_sec (John) добровольно покинул роль секретаря твоего календаря.
   ```
4. Возвращает `{ ok: true }`

---

### `owner_id` на event-тулах

Все тулы для работы с событиями получают опциональный параметр `owner_id: number`.
Когда передан, tool executor:
1. Проверяет `calendar_secretaries` — `owner_id → secretary_id = я, status = 'active'`
2. Для write-операций (`create_event`, `update_event`, `delete_event`, `snooze_event`, `set_reminder`, `set_event_visibility`): дополнительно проверяет `permission = 'write'`
3. Проверка не прошла → возвращает `SECRETARY_ACCESS_DENIED`
4. Прошла → выполняет операцию на данных делегирующего

Затронутые тулы:
`get_events`, `create_event`, `update_event`, `delete_event`, `get_event`, `search_events`,
`get_free_slots`, `get_upcoming`, `snooze_event`, `set_reminder`, `get_reminders`,
`render_day_image`, `render_week_image`, `set_event_visibility`

Суффикс в description каждого затронутого тула:
> `owner_id: (optional) Telegram ID of a user whose calendar to operate on. Only works if you have active secretary access to that user's calendar.`

---

## 3. System Prompt Extension

### User Info section

Добавить после существующих полей пользователя:

```
- Calendars you can manage as secretary: ${secretaryForLine}
```

`secretaryForLine` строится при сборке промпта из БД:
- Нет активных → строка не добавляется
- Есть → `@alice_cto (read+write), @bob_pm (read only)`

### Новый блок Rules: Secretary Access

```
## Secretary Access

If "Calendars you can manage as secretary" is listed above:
- If the message clearly targets someone else's calendar (they name the person, say "у Алисы", "для Алисы", etc.) — pass owner_id to the event tool.
- If ambiguous (no person mentioned, the user could mean their own or a delegating user's calendar) — call ask_user with options like ["Мой", "@alice_cto"]. Do not assume.
- If clearly the user's own calendar — do NOT pass owner_id.
- When showing someone else's calendar, always say whose it is: "Вот расписание Алисы на сегодня:".

If no secretary calendars are listed, ignore all of this.

When the user wants to add a secretary to their calendar:
1. Use find_user to resolve name/username to telegram_id.
2. If find_user fails, tell the user what actually happened, in their own language — do not reword an "unavailable/couldn't verify" error as "hasn't used the bot yet" (that error means resolution could not be checked, not that the person doesn't use Telegram), and never paste the raw English error text verbatim.
3. Use ask_user to confirm permission level: "Добавить @john секретарём?" with ["Чтение и запись", "Только чтение", "Отмена"].
4. Call manage_secretaries with action "invite". STOP immediately after — do not add more text.

When the user (as owner) wants to remove a secretary from their calendar:
- Confirm first: ask_user "Убрать @john из секретарей твоего календаря?" with ["Да", "Нет"].
- Then call manage_secretaries with action "revoke".

When the user (as secretary) wants to stop being secretary for someone:
- No confirmation needed — it's their own voluntary choice.
- Call manage_secretaries with action "self_remove" directly.
```

---

## 4. Сообщение-приглашение (bot-side)

Когда `manage_secretaries { action: "invite" }` выполняется, tool executor напрямую отправляет
бот-сообщение секретарю (вне AI-тёрна):

```
Alice (@alice_ultra) хочет добавить тебя секретарём своего календаря.

Уровень доступа: Чтение и запись
Ты сможешь видеть все события Alice и управлять ими от её имени.
Ты можешь отказаться сейчас или прекратить доступ в любой момент позже.

[Принять]    [Отклонить]
```

После принятия секретарь может в любой момент написать боту "перестань быть секретарём Алисы"
(или любую похожую фразу) — AI вызовет `manage_secretaries { action: "self_remove" }`.
Подтверждения не требуется, это добровольный отказ от своей роли.

Callback data:
- `sec:accept:{id}`
- `sec:decline:{id}`

### On Accept

```sql
UPDATE calendar_secretaries SET status = 'active', updated_at = datetime('now') WHERE id = ?;
```

Бот → делегирующему (plain message, вне AI):
```
✅ @john_sec принял приглашение и теперь является секретарём твоего календаря.
```

Бот редактирует оригинальное сообщение-приглашение у секретаря:
```
✅ Принято. Ты теперь секретарь Alice (@alice_ultra). Напиши мне, чтобы управлять её календарём.
```

### On Decline

```sql
UPDATE calendar_secretaries SET status = 'declined', updated_at = datetime('now') WHERE id = ?;
```

Бот → делегирующему:
```
@john_sec отклонил приглашение секретаря.
```

Бот редактирует приглашение у секретаря:
```
Приглашение отклонено.
```

---

## 5. Cron Jobs

| Job | Trigger | Action |
|-----|---------|--------|
| `expire-pending-secretary-invites` | Daily | `status = 'expired'` для `pending` строк старше 7 дней; уведомление делегирующему: `Приглашение для @john_sec (John) истекло — нет ответа в течение 7 дней.` |

---

## 6. Edge Cases

| Scenario | Handling |
|----------|----------|
| `secretary_telegram_id` не в `users` | `SECRETARY_NOT_FOUND`. AI: "Этот человек ещё не пользовался ботом — пусть напишет /start." |
| Секретарь пытается пригласить секретаря к чужому (делегирующего) календарю | Предотвращено дизайном: `manage_secretaries` не принимает `owner_id` и всегда работает с календарём вызывающего пользователя. Добавить секретаря к чужому календарю через этот тул физически невозможно. |
| `self_remove` — вызывающий не является секретарём в указанной записи | Executor проверяет `secretary_id == current_user.telegram_id` → `SECRETARY_ACCESS_DENIED` |
| Доступ отозван в середине операции | Event tool → `SECRETARY_ACCESS_DENIED`. AI: "У тебя больше нет доступа к календарю этого пользователя." |
| Делегирующий удаляет аккаунт | `ON DELETE CASCADE` удаляет все строки `calendar_secretaries` |
| Секретарь удаляет аккаунт | `ON DELETE CASCADE` удаляет его строки |
| Лимит секретарей | 10 активных на одного делегирующего. `SECRETARY_LIMIT_REACHED`. |
| Повторное приглашение после отклонения/отзыва/истечения | Разрешено. Так как `UNIQUE(owner_id, secretary_id)`, новую строку создать нельзя — обновляем существующую: если `pending` < 7 дней → переиспользовать как есть, иначе UPDATE `status = 'pending'`, `created_at = datetime('now')`, повторно отправить приглашение. |
