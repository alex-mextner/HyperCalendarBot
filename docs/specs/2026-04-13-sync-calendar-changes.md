# Sync Calendar Changes: Bidirectional Change Propagation

## Problem

Когда пользователь редактирует событие в Google Calendar, текущий `incrementalPull` обновляет
локальную копию, но не учитывает роль пользователя (организатор vs участник) и не оповещает
других участников. Нужна полноценная двусторонняя синхронизация изменений с учётом ролей.

## Scenarios

### 1. Организатор редактирует своё событие в Google Calendar

**Текущее поведение**: `incrementalPull` → `handleUpdatedOrNewEvent` → обновляет `events` row.
Участники не оповещаются, их Google Calendar копии не обновляются.

**Целевое поведение**:
1. Pull обновляет локальное событие (уже работает)
2. Вычисляется diff: какие поля изменились
3. Если есть участники (`event_participants`) → каждому отправляется уведомление с описанием изменений
4. Push обновлённого события в Google Calendar каждого участника (через `pushParticipantEvent`)
5. Напоминания пересчитываются (rematerialization), если изменилось время

### 2. Участник редактирует чужое событие в Google Calendar

**Текущее поведение**: Pull для участника видит изменённый google event, но не находит его
в `events` таблице (event принадлежит организатору). Создаётся дубликат — **баг**.

**Целевое поведение**:
1. При pull для участника — проверять `participant_google_sync` таблицу
2. Если google_event_id совпадает — это событие, в которое участник приглашён
3. Сравнить изменённые поля с мастер-событием (организатора)
4. Создать `edit_proposal` и отправить организатору с кнопками [Принять] [Отклонить]
5. Если организатор не ответил в течение TTL (по умолчанию 1 час):
   - Пропозал автоматически истекает
   - Копия в Google Calendar участника откатывается к оригинальным значениям
   - Участнику отправляется уведомление: «Организатор не подтвердил изменения, событие возвращено к исходным значениям»
6. Если организатор принимает:
   - Изменения применяются к мастер-событию
   - Всем остальным участникам отправляются уведомления
   - Push обновлённого события в Google Calendar всех участников
7. Если организатор отклоняет:
   - Копия в Google Calendar участника откатывается
   - Участнику отправляется уведомление: «Организатор отклонил изменения»

### 3. Участник удаляет событие в Google Calendar

**Целевое поведение**: трактуется как decline invitation.
1. Обновить `event_participants.status` → `'declined'`
2. Обновить `invitations.status` → `'declined'` (если есть)
3. Удалить `participant_google_sync` record
4. Уведомить организатора: «Иван отклонил участие в "Standup"»

### 4. Организатор удаляет событие → уведомить участников

**Текущее поведение**: `handleDeletedEvent` удаляет event из DB. Участники не оповещаются.

**Целевое поведение**:
1. Перед удалением — проверить участников
2. Каждому участнику отправить уведомление: «Событие "Standup" отменено организатором»
3. Удалить копии из Google Calendar участников (push delete)
4. Очистить `participant_google_sync` records
5. Обновить `event_participants.status` → `'declined'` (или отдельный статус `'cancelled'`)
6. Удалить локальное событие

## Поддерживаемые поля

Каждое изменение этих полей отслеживается и маршрутизируется по вышеописанным сценариям:

| Поле | Тип | Уведомление |
|------|-----|-------------|
| `start_at` / `end_at` | Время | «Standup перенесён: 15:00→16:00» |
| `all_day` | Тип | «Standup теперь на весь день» / «Standup больше не на весь день: 15:00-16:00» |
| `title` | Текст | «Событие переименовано: Standup → Daily sync» |
| `description` | Текст | «Обновлено описание события "Standup"» |
| `location` | Текст | «Новое место для "Standup": Zoom → Google Meet» |
| `recurrence_rule` | Правило | «Изменено расписание повторений для "Standup"» |

Для нескольких изменений одновременно — объединяем в одно сообщение:
```
📅 Иван изменил «Standup»:
• Время: 15:00 → 16:00
• Место: Zoom → Google Meet
```

## Change Detection (Diff)

```typescript
interface FieldChange {
  field: 'title' | 'description' | 'start_at' | 'end_at' | 'all_day' | 'location' | 'recurrence_rule';
  oldValue: string | number | boolean | null;
  newValue: string | number | boolean | null;
}

// Поля, которые участвуют в diff
const TRACKED_FIELDS = [
  'title', 'description', 'start_at', 'end_at',
  'all_day', 'location', 'recurrence_rule',
] as const;

function computeEventDiff(
  existing: Pick<CalendarEvent, typeof TRACKED_FIELDS[number]>,
  incoming: Pick<CalendarEvent, typeof TRACKED_FIELDS[number]>,
): FieldChange[] {
  // Для каждого поля: сравнить нормализованные значения
  // all_day: 0/1 → boolean
  // start_at/end_at: normalize to ISO UTC for comparison
  // rest: string equality, null === null
}
```

## Participant Pull Detection

Текущий `incrementalPull` вызывает `handleUpdatedOrNewEvent`, который ищет event
только в `events` таблице: `findByGoogleEventId(userId, calendarId, googleEventId)`.

**Изменение**: если event НЕ найден в `events`, проверить `participant_google_sync`:

```
findByGoogleEventId(userId, calendarId, googleEventId)
  ↓ not found
participantSyncRepo.getByUserAndGoogleEventId(userId, googleEventId)
  ↓ found → participantSyncRecord
  ↓ eventRepo.findByIdUnfiltered(participantSyncRecord.event_id)
  ↓ → masterEvent (owner's event)
  → route to handleParticipantChange(userId, masterEvent, incomingGoogleEvent)
```

Нужен новый метод в `ParticipantGoogleSyncRepository`:
```typescript
getByUserAndGoogleEventId(userId: number, googleEventId: string): ParticipantGoogleSync | null
```

## Database Changes

### Migration: `edit_proposals` enhancements

```sql
ALTER TABLE edit_proposals ADD COLUMN expires_at TEXT;
ALTER TABLE edit_proposals ADD COLUMN original_values TEXT; -- JSON: snapshot for revert
ALTER TABLE edit_proposals ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
  -- 'google_sync' | 'manual' | 'ai_tool'
ALTER TABLE edit_proposals ADD COLUMN organizer_message_id INTEGER;
  -- Telegram message ID sent to organizer (for button editing after response)
ALTER TABLE edit_proposals ADD COLUMN participant_message_id INTEGER;
  -- Telegram message ID sent to participant (for status update)
```

### Migration: `participant_google_sync` index

```sql
CREATE INDEX IF NOT EXISTS idx_participant_google_sync_google_event
  ON participant_google_sync (user_id, google_event_id);
```

## Edit Proposal Lifecycle

```
┌──────────┐   organizer accepts   ┌──────────┐
│ pending  │ ────────────────────→  │ accepted │
└──────────┘                        └──────────┘
     │                                    │
     │ organizer rejects                  │ apply changes to master event
     ↓                                    │ notify all participants
┌──────────┐                              │ push to participants' GCal
│ rejected │                              ↓
└──────────┘                        ┌──────────────────┐
     │                              │ master event     │
     │ TTL expires (1h default)     │ updated          │
     ↓                              └──────────────────┘
┌──────────┐
│ expired  │
└──────────┘
     │
     │ revert participant's GCal copy
     │ notify participant
     ↓
```

### Expiry Worker

BullMQ repeating job в `bot-tasks` queue (проверка каждые 5 минут):

```typescript
// Pseudocode
const expiredProposals = editProposalRepo.getExpired(); // WHERE status='pending' AND expires_at < NOW()
for (const proposal of expiredProposals) {
  editProposalRepo.updateStatus(proposal.id, 'expired');
  // Revert participant's Google Calendar copy
  syncQueue.add('push-participant-event', {
    userId: proposal.proposer_id,
    eventId: proposal.event_id,
    action: 'update', // pushes master event data back, overwriting participant's edits
  });
  // Notify participant
  notify(proposal.proposer_id, t(lang).sync.proposalExpired(eventTitle));
  // Edit organizer's message: remove buttons
  editMessage(proposal.organizer_message_id, t(lang).sync.proposalExpiredOrganizer(eventTitle));
}
```

## Callback Actions

| Callback data | Actor | Description |
|---|---|---|
| `editprop:accept:{id}` | organizer | Принять предложенные изменения |
| `editprop:reject:{id}` | organizer | Отклонить изменения |

## Edge Cases

### 1. Участник и организатор редактируют одновременно

Организатор редактирует в боте или Google Calendar → push/pull обновляет мастер-событие.
Если на момент pull организатора есть pending proposal от участника:
- Организатор может не знать о proposal
- **Решение**: при обновлении мастер-события проверить pending proposals. Если мастер-событие
  изменилось (организатором), auto-expire все pending proposals с пометкой «событие изменено
  организатором» и откатить участникам.

### 2. Участник делает несколько правок подряд

Если уже есть pending proposal от этого участника для этого события:
- Обновить существующий proposal (новые `changes`, новый `expires_at`)
- Обновить сообщение организатору (edit message)

### 3. Повторяющиеся события (recurrence exceptions)

Google Calendar может вернуть exception (изменённый occurrence) как отдельный event
с `recurringEventId`. Для MVP — пропускаем recurrence exceptions от участников.
Организаторские изменения recurrence обрабатываем целиком.

### 4. Организатор не в боте / offline

Proposal создаётся и доставляется через стандартный `deliverMessageAsync`.
TTL работает независимо от онлайна организатора — если не ответил за час, proposal истекает.

### 5. Участник без Google Calendar sync

Участник без подключённого Google Calendar не может редактировать событие через Google.
Его изменения через бота (AI agent / edit command) уже проходят через `edit_proposals` flow.

### 6. Множество участников

При принятии proposal от одного участника — push updated event to ALL participants,
не только предложившему. У каждого своя запись в `participant_google_sync`.

### 7. Participant удаляет, потом пытается снова принять приглашение

После delete (= decline): `participant_google_sync` удалён, `event_participants.status = 'declined'`.
Если приглашение пересылается или участник принимает через deep link — стандартный flow
invitation-service пересоздаёт participant record и pushes event to Google.

## Notification Messages (i18n)

Namespace: `MSG.{lang}.sync`

```typescript
sync: {
  // Organizer changed event → notify participant
  eventChanged: (title: string, changes: string) =>
    `📅 ${title}\n${changes}`,
  eventCancelled: (title: string) =>
    `❌ ${title} — отменено организатором`,

  // Participant proposes changes → notify organizer
  changeProposed: (participantName: string, title: string, changes: string) =>
    `📝 ${participantName} предлагает изменить «${title}»:\n${changes}`,
  acceptBtn: 'Принять ✅',
  rejectBtn: 'Отклонить ❌',

  // Organizer accepts → notify participant
  proposalAccepted: (title: string) =>
    `✅ Изменения для «${title}» приняты организатором`,
  // Organizer rejects → notify participant
  proposalRejected: (title: string) =>
    `❌ Изменения для «${title}» отклонены организатором`,
  // TTL expired → notify participant
  proposalExpired: (title: string) =>
    `⏰ «${title}» — организатор не ответил, событие возвращено к исходным значениям`,
  // TTL expired → edit organizer's message
  proposalExpiredOrganizer: (title: string) =>
    `⏰ Предложение по «${title}» истекло`,

  // Participant deleted event = declined
  participantDeclinedViaGoogle: (participantName: string, title: string) =>
    `👋 ${participantName} отклонил участие в «${title}» (удалил из Google Calendar)`,

  // Change descriptions
  changeTime: (oldTime: string, newTime: string) =>
    `• Время: ${oldTime} → ${newTime}`,
  changeTitle: (oldTitle: string, newTitle: string) =>
    `• Название: ${oldTitle} → ${newTitle}`,
  changeLocation: (oldLoc: string, newLoc: string) =>
    `• Место: ${oldLoc} → ${newLoc}`,
  changeDescription: '• Описание обновлено',
  changeAllDay: (isAllDay: boolean) =>
    isAllDay ? '• Теперь на весь день' : '• Больше не на весь день',
  changeRecurrence: '• Расписание повторений изменено',
}
```

## Files to Change

### New files
- `src/services/google/change-detection.ts` — `computeEventDiff()`, `formatChanges()`
- `src/services/google/participant-change-handler.ts` — `handleParticipantChange()`, proposal creation
- `src/services/google/owner-change-handler.ts` — participant notifications after owner's event update
- `test/services/google/change-detection.test.ts`
- `test/services/google/participant-change-handler.test.ts`
- `test/services/google/owner-change-handler.test.ts`

### Modified files
- `src/database/migrations.ts` — new migration for `edit_proposals` columns + index
- `src/database/types.ts` — update `EditProposal` interface
- `src/database/repositories/edit-proposal.repository.ts` — `getExpired()`, `updateChanges()`
- `src/database/repositories/participant-google-sync.repository.ts` — `getByUserAndGoogleEventId()`
- `src/services/google/sync-service.ts` — integrate participant detection in `handleUpdatedOrNewEvent`
  and `handleDeletedEvent`, call owner-change-handler after owner updates
- `src/services/google/sync-queue.ts` — add `proposal-expiry` repeating job
- `src/config/constants.ts` — add `sync` namespace to `MSG.en` / `MSG.ru`
- `src/bot/handlers/callback.handler.ts` — handle `editprop:accept`, `editprop:reject`
- `src/services/feature-tracking.ts` — add feature keys for new callbacks

## Sequencing

1. **Change detection** — `computeEventDiff()` + tests (pure logic, no deps)
2. **DB migration** — edit_proposals columns, participant_google_sync index
3. **Participant pull detection** — modify `sync-service.ts` to check participant_google_sync
4. **Participant change handler** — proposal creation, notifications
5. **Owner change handler** — participant notifications after owner edits
6. **Callback handlers** — accept/reject buttons
7. **Expiry worker** — BullMQ repeating job for proposal TTL
8. **i18n strings** — add to constants.ts
9. **Integration tests** — end-to-end sync scenarios
