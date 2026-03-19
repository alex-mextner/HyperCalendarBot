# Default Event Duration Setting

## Summary

Add per-user configurable default meeting duration. When creating an event without an explicit end time, both the AI agent and the add-event wizard use this value to compute `end_at`.

## Storage

New column in `users` table (migration `027_default_event_duration`):

```sql
ALTER TABLE users ADD COLUMN default_event_duration_minutes INTEGER NOT NULL DEFAULT 60;
```

Update `User` interface and `UpdateUserData` in `src/database/types.ts`.

## UI (settings.ts)

Location: **"🌍 Основные"** category (`stg:general`).

Display in the General view text:
```
Длительность встреч: 60 мин
  По умолчанию, если не указано время окончания.
```

New button in the General keyboard:
```
⏱ Длительность встреч: 60 мин →   stg:edit_duration
```

### Duration sub-screen (`stg:edit_duration`)

Text:
```
⏱ Длительность встреч по умолчанию

Текущая: 60 мин
Выберите или введите число минут:
```

Keyboard: three preset buttons + Back:
```
[15 мин]  [30 мин]  [1 ч]
[🔙 Назад]
```

Callback actions: `stg:set_duration:15`, `stg:set_duration:30`, `stg:set_duration:60`.

Free-text input: opening this sub-screen sets a short-lived in-memory state (`pendingDurationInput: Map<userId, true>`) with 5-min TTL. The next plain-number message from that user is intercepted in the message pipeline (before AI layer), parsed as minutes, saved, and the bot replies with confirmation.

## AI Tool (`manage_settings`)

### `get` / `general`
Add `default_event_duration_minutes` to the returned object.

### `update` / `general`
Accept `default_event_duration_minutes: number` in `updates`. Validate > 0.

Update tool description to list `default_event_duration_minutes` under the `general` category.

## AI Agent — event creation

In `system-prompt.ts`, when `default_event_duration_minutes` is set, add to the system prompt:
```
Default event duration: N minutes. When creating an event with no explicit end time or duration, set end_at = start_at + N minutes.
```

## Wizard (`add-event` scene)

When the wizard reaches the "end time" step and the user skips it (or no end is entered), pre-fill `end_at` as `start_at + default_event_duration_minutes`.

## Tests

- `UserRepository.update` persists `default_event_duration_minutes`
- Settings callback: `stg:set_duration:30` updates the value and re-renders the sub-screen
- Free-text input interception: a plain "45" message while duration input is pending updates the setting
- `handleManageSettings` get/update for `default_event_duration_minutes`
- `system-prompt.ts` includes duration line when setting is present
