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

### Shared fields (участники оповещаются / создаются proposals)

| Поле | Тип | Уведомление |
|------|-----|-------------|
| `start_at` / `end_at` | Время | «Standup: 15:00 → 16:00» |
| `all_day` | Тип | «Standup теперь на весь день» |
| `title` | Текст | «Standup → Daily sync» |
| `description` | Текст | «Описание обновлено» |
| `location` | Текст | «Zoom → Google Meet» |
| `recurrence_rule` | Правило | «Расписание повторений изменено» |

### Personal fields (применяются только к автору)

| Поле | Тип | Поведение |
|------|-----|-----------|
| `timezone` | Зона | Организатор: обновляет master event молча. Участник: сохраняется в `participant_google_sync.timezone_override`, proposal не создаётся. |

### Scope: только `owner_type = 'user'`

Групповые события (`owner_type = 'group'`) имеют другую семантику владения (`created_by` ≠ `user_id`).
В MVP participant change flow обрабатывает только user-owned events.
`EventChangeNotifier` фильтрует: `if (event.owner_type !== 'user') return;`

### Пример сводного уведомления

```
📅 «Standup» изменён:
• 15:00 → 16:00
• Zoom → Google Meet
```

## Architecture: EventChangeNotifier

### Problem

Сейчас оповещение участников — примитивный callback `onParticipantsNotify: (userIds, text) => void`
в `EventService`. Он:
- Не знает про Google Calendar sync (не пушит обновления в GCal участников)
- Не знает про edit proposals (не отменяет pending proposals при изменении организатором)
- Не ремaterialизует напоминания
- Хардкодит английское сообщение: `Event "${title}" has been cancelled`
- Не вызывается при `updateEvent` — только при `deleteEvent`

Когда организатор меняет событие через бота (AI agent, edit command) — участники **не оповещаются**.
Это баг в текущей архитектуре.

### Solution: `EventChangeNotifier` service

Единая точка для всех side-effects при изменении событий с участниками.
Вызывается из ЛЮБОГО источника изменений:

```
Bot (AI agent, /edit)  ──→  EventService.updateEvent()  ──→  EventChangeNotifier.onEventChanged()
                             EventService.deleteEvent()  ──→  EventChangeNotifier.onEventDeleted()

Google Calendar sync   ──→  SyncService.handleUpdatedOrNewEvent()  ──→  EventChangeNotifier.onEventChanged()
                             SyncService.handleDeletedEvent()       ──→  EventChangeNotifier.onEventDeleted()

Proposal accept        ──→  EventService.updateEvent()  ──→  EventChangeNotifier.onEventChanged()
```

```typescript
// src/services/event/event-change-notifier.ts

type ChangeSource = 'bot' | 'google_sync' | 'proposal_accept';

interface EventChangeNotifierDeps {
  participantRepo: ParticipantRepository;
  editProposalRepo: EditProposalRepository;
  participantSyncRepo: ParticipantGoogleSyncRepository;
  materializer: ReminderMaterializer;
  syncQueue: Queue<GoogleSyncJobData>;            // for GCal push to participants
  notifyUser: (userId: number, text: string) => Promise<void>;
  editMessage: (chatId: number, messageId: number, text: string) => Promise<void>;
  getUserLang: (userId: number) => Lang;
  getUserName: (userId: number) => string;
}

class EventChangeNotifier {
  async onEventChanged(params: {
    event: CalendarEvent;
    changes: FieldChange[];
    source: ChangeSource;
  }): Promise<void> {
    // 1. Skip if no shared fields changed or no participants
    // 2. Auto-expire pending proposals for this event
    // 3. Notify each active participant (status !== 'declined')
    // 4. Push updated event to each participant's GCal
    // 5. Rematerialize reminders if time changed
    // 6. Push to organizer's GCal if source === 'bot' (not 'google_sync' — would loop)
  }

  async onEventDeleted(params: {
    event: CalendarEvent;
    source: ChangeSource;
  }): Promise<void> {
    // 1. Notify each active participant
    // 2. Delete from each participant's GCal
    // 3. Clean up participant_google_sync records
    // 4. Auto-expire pending proposals
  }
}
```

### Integration into EventService

`EventService` gets a new optional dep: `changeNotifier?: EventChangeNotifier`.
Replaces `onParticipantsNotify`.

```typescript
// EventService.updateEvent — existing code already computes oldEvent vs updatedEvent
updateEvent(id, userId, data) {
  const existing = this.eventRepo.findById(id, userId);
  const updated = this.eventRepo.update(id, userId, data);
  // ... materializer, domain events (existing) ...
  if (this.changeNotifier && updated && existing) {
    const changes = computeEventDiff(existing, updated);
    // fire-and-forget with .catch(log)
    this.changeNotifier.onEventChanged({
      event: updated, changes, source: 'bot',
    }).catch(err => logger.error({ err }, 'EventChangeNotifier.onEventChanged failed'));
  }
  return updated;
}

// EventService.deleteEvent — replaces onParticipantsNotify
deleteEvent(id, userId) {
  const event = this.eventRepo.findById(id, userId);
  if (this.changeNotifier && event) {
    this.changeNotifier.onEventDeleted({
      event, source: 'bot',
    }).catch(err => logger.error({ err }, 'EventChangeNotifier.onEventDeleted failed'));
  }
  // ... existing materializer + domain events ...
}
```

### Integration into SyncService

SyncService calls `EventChangeNotifier` **outside the transaction** (async),
using the same snapshot pattern as `conflictNotification`:

```typescript
// Inside handleUpdatedOrNewEvent transaction:
let pendingChangeNotification: (() => Promise<void>) | null = null;
const tx = this.db.transaction(() => {
  const existing = this.eventRepo.findByGoogleEventId(...);
  if (existing) {
    const snapshot = { title: existing.title, start_at: existing.start_at, ... };
    this.eventRepo.update(existing.id, userId, { title: local.title, ... });
    const changes = computeEventDiff(snapshot, local);
    if (changes.length > 0 && this.changeNotifier) {
      const updatedEvent = { ...existing, ...local }; // merged
      pendingChangeNotification = () =>
        this.changeNotifier!.onEventChanged({ event: updatedEvent, changes, source: 'google_sync' });
    }
  }
});
tx();
if (pendingChangeNotification) await pendingChangeNotification();
```

### Source-aware behavior

`EventChangeNotifier.onEventChanged` uses `source` to prevent feedback loops:

| Source | Push to organizer GCal | Push to participants GCal | Notify participants |
|--------|----------------------|--------------------------|-------------------|
| `bot` | Yes (via sync queue) | Yes | Yes |
| `google_sync` | No (change came from GCal) | Yes | Yes |
| `proposal_accept` | Yes | Yes | Yes |

## Change Detection (Diff)

### Common input type: `EventFieldSnapshot`

`CalendarEvent.all_day` — `number` (0/1, SQLite). `LocalEventFromGoogle.all_day` — `boolean`.
Нельзя сравнивать напрямую. `computeEventDiff` принимает нормализованный snapshot:

```typescript
// src/services/google/change-detection.ts

interface EventFieldSnapshot {
  title: string;
  description: string | null;
  start_at: string;
  end_at: string | null;
  all_day: boolean;             // normalized: CalendarEvent.all_day 0→false, 1→true
  timezone: string;
  location: string | null;
  recurrence_rule: string | null;
}

function snapshotFromCalendarEvent(e: CalendarEvent): EventFieldSnapshot {
  return { ...e, all_day: e.all_day === 1 };
}

function snapshotFromGoogleLocal(e: LocalEventFromGoogle): EventFieldSnapshot {
  return { ...e, all_day: Boolean(e.all_day) }; // already boolean, explicit for safety
}
```

### Tracked fields: shared vs personal

Поля делятся на **shared** (пропагируются участникам, создают proposals) и **personal**
(применяются только к автору изменения):

| Поле | Тип | Shared/Personal |
|------|-----|-----------------|
| `start_at` / `end_at` | Время | **Shared** |
| `all_day` | Тип | **Shared** |
| `title` | Текст | **Shared** |
| `description` | Текст | **Shared** |
| `location` | Текст | **Shared** |
| `recurrence_rule` | Правило | **Shared** |
| `timezone` | Зона | **Personal** |

**`timezone` — personal field**: изменение timezone влияет только на пользователя, который
его сделал. Если организатор меняет timezone — обновляется master event, участники не
оповещаются. Если участник меняет timezone — сохраняется в `participant_google_sync.timezone_override`,
master event не затрагивается, proposal не создаётся.

### Interface

```typescript
type SharedField = 'title' | 'description' | 'start_at' | 'end_at' | 'all_day' | 'location' | 'recurrence_rule';
type PersonalField = 'timezone';
type TrackedField = SharedField | PersonalField;

interface FieldChange {
  field: TrackedField;
  oldValue: string | boolean | null;
  newValue: string | boolean | null;
}

const SHARED_FIELDS: readonly SharedField[] = [
  'title', 'description', 'start_at', 'end_at',
  'all_day', 'location', 'recurrence_rule',
];

const PERSONAL_FIELDS: readonly PersonalField[] = ['timezone'];

function computeEventDiff(existing: EventFieldSnapshot, incoming: EventFieldSnapshot): FieldChange[] {
  // Compare all tracked fields (shared + personal)
  // Normalize: trim strings, null === null, '' === null for description/location
  // Return FieldChange[] — callers filter by shared/personal as needed
}

function getSharedChanges(changes: FieldChange[]): FieldChange[] {
  return changes.filter(c => (SHARED_FIELDS as readonly string[]).includes(c.field));
}

function getPersonalChanges(changes: FieldChange[]): FieldChange[] {
  return changes.filter(c => (PERSONAL_FIELDS as readonly string[]).includes(c.field));
}

function hasTimeChange(changes: FieldChange[]): boolean {
  return changes.some(c => c.field === 'start_at' || c.field === 'end_at' || c.field === 'all_day');
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

### Transaction / async boundary

`handleUpdatedOrNewEvent` оборачивает SELECT+UPDATE в `db.transaction()` (синхронный, bun:sqlite).
Async side-effects (Telegram messages, GCal push) выполняются **после** транзакции.

Паттерн — аналогично существующему `conflictNotification`:

```typescript
let pendingNotification: (() => Promise<void>) | null = null;

const tx = this.db.transaction(() => {
  const existing = this.eventRepo.findByGoogleEventId(userId, calendarId, local.google_event_id);

  if (existing) {
    // --- Owner update path ---
    // Snapshot BEFORE update (для diff)
    const snapshot = snapshotFromCalendarEvent(existing);
    // Apply update (existing code)
    this.eventRepo.update(existing.id, userId, { title: local.title, ... });
    this.eventRepo.updateSyncFields(existing.id, { ... });
    // Compute diff
    const incoming = snapshotFromGoogleLocal(local);
    const changes = computeEventDiff(snapshot, incoming);
    if (changes.length > 0 && this.changeNotifier) {
      const updatedEvent = this.eventRepo.findByGoogleEventId(userId, calendarId, local.google_event_id)!;
      pendingNotification = () =>
        this.changeNotifier!.onEventChanged({ event: updatedEvent, changes, source: 'google_sync' });
    }
  } else {
    // --- Check participant_google_sync ---
    const participantSync = this.participantSyncRepo?.getByUserAndGoogleEventId(userId, local.google_event_id);
    if (participantSync) {
      const masterEvent = this.eventRepo.findByIdUnfiltered(participantSync.event_id);
      if (masterEvent) {
        pendingNotification = () =>
          this.handleParticipantChange(userId, masterEvent, local, participantSync);
      }
    } else {
      // --- New event (existing insert code) ---
      this.eventRepo.insertSyncedEvent({ ... });
    }
  }
});
tx();
if (pendingNotification) await pendingNotification();
```

`handleDeletedEvent` аналогично переводится на async:

```typescript
// Было: private handleDeletedEvent(...)  : void
// Стало: private async handleDeletedEvent(...)  : Promise<void>

let pendingNotification: (() => Promise<void>) | null = null;

const existing = this.eventRepo.findByGoogleEventId(userId, calendarId, googleEventId);
if (existing) {
  // Owner delete — notify participants BEFORE removing event
  if (this.changeNotifier) {
    pendingNotification = () =>
      this.changeNotifier!.onEventDeleted({ event: existing, source: 'google_sync' });
  }
  this.eventRepo.remove(existing.id, userId);
  // ... sync log ...
} else {
  // Participant delete — treat as decline
  const participantSync = this.participantSyncRepo?.getByUserAndGoogleEventId(userId, googleEventId);
  if (participantSync) {
    pendingNotification = () => this.handleParticipantDelete(userId, participantSync);
  }
}

if (pendingNotification) await pendingNotification();
```

## Database Changes

### Migration: `edit_proposals` enhancements

```sql
ALTER TABLE edit_proposals ADD COLUMN expires_at TEXT;
ALTER TABLE edit_proposals ADD COLUMN original_values TEXT;
ALTER TABLE edit_proposals ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE edit_proposals ADD COLUMN organizer_message_id INTEGER;
ALTER TABLE edit_proposals ADD COLUMN organizer_chat_id INTEGER;
ALTER TABLE edit_proposals ADD COLUMN participant_message_id INTEGER;
ALTER TABLE edit_proposals ADD COLUMN participant_chat_id INTEGER;
```

**`original_values`** (JSON) — audit trail: snapshot значений master event на момент создания proposal.
Для реверта НЕ используется (revert пушит текущие данные master event). Нужен для:
- Аудит: что именно было в момент предложения
- UI: показать организатору "было X → предлагается Y" даже если master event уже менялся
- `changes[].oldValue` хранит то же самое, но `original_values` — плоский map для быстрого чтения

**`organizer_chat_id` / `participant_chat_id`** — для `editMessageText` нужен `chat_id`.
Для DM `chat_id = user.telegram_id`, но хранится явно, а не вычисляется — на случай
если сообщение отправлено в другой чат (группу, MTProto fallback).

**`source`**: `'google_sync' | 'manual' | 'ai_tool'` — откуда пришло предложение.

### Migration: `participant_google_sync` — timezone override + index

```sql
ALTER TABLE participant_google_sync ADD COLUMN timezone_override TEXT;
CREATE INDEX IF NOT EXISTS idx_participant_google_sync_google_event
  ON participant_google_sync (user_id, google_event_id);
```

`timezone_override` — личная timezone участника для этого события. Если `NULL`,
используется timezone из master event. Заполняется только при personal timezone change
от участника через GCal.

### Type updates

```typescript
// EditProposalStatus — добавить 'expired'
type EditProposalStatus = 'pending' | 'accepted' | 'rejected' | 'expired';

// EditProposal — новые поля
interface EditProposal {
  id: number;
  event_id: number;
  proposer_id: number;
  changes: string;               // JSON: FieldChange[]
  reason: string | null;
  status: EditProposalStatus;
  created_at: string;
  expires_at: string | null;
  original_values: string | null; // JSON: { [field]: oldValue }
  source: 'google_sync' | 'manual' | 'ai_tool';
  organizer_message_id: number | null;
  organizer_chat_id: number | null;
  participant_message_id: number | null;
  participant_chat_id: number | null;
}

// CreateEditProposalData — новые поля
interface CreateEditProposalData {
  event_id: number;
  proposer_id: number;
  changes: string;
  reason?: string;
  expires_at?: string;
  original_values?: string;
  source?: 'google_sync' | 'manual' | 'ai_tool';
}

// ParticipantGoogleSync — новое поле
interface ParticipantGoogleSync {
  // ... existing fields ...
  timezone_override: string | null;
}
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
`EventChangeNotifier.onEventChanged()` автоматически auto-expire все pending proposals
для этого события. Участникам-proposer'ам отправляется уведомление «событие изменено
организатором», их GCal-копии обновляются до нового состояния.

### 2. Участник делает несколько правок подряд

Если уже есть pending proposal от этого участника для этого события:
- Обновить существующий proposal (новые `changes`, новый `expires_at`)
- Обновить сообщение организатору (edit message via `organizer_chat_id` + `organizer_message_id`)

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

### 8. Групповые события (`owner_type = 'group'`)

Не обрабатываются в MVP. `EventChangeNotifier` проверяет `event.owner_type === 'user'`
и пропускает group events. Follow-up: определить семантику "организатор" для group events
(`created_by`? все участники группы?).

### 9. Participant decline через `findActiveByEventAndInvitee`

В `handleParticipantDelete` для обновления invitation status используется
`invitationRepo.findActiveByEventAndInvitee(eventId, inviteeId)`, который ищет
только `pending | maybe | accepted`. Если invitation уже `declined` — метод вернёт `null`,
и это OK: invitation уже в правильном статусе, дополнительное обновление не нужно.

### 10. Revert push → повторный pull (sync loop)

Когда revert push отправляет master data в GCal участника → Google присылает webhook →
pull для участника → `participant_google_sync` найден → `computeEventDiff(masterEvent, pulled)` →
diff пустой (данные совпадают) → early return. **Цикла нет**, один лишний pull processing.

### 11. Timezone change от участника

Participant меняет timezone в GCal → pull детектирует изменение → `computeEventDiff` возвращает
timezone change в `PersonalField`. `handleParticipantChange` видит что shared changes пустые →
proposal НЕ создаётся. Timezone сохраняется в `participant_google_sync.timezone_override`.
Revert для timezone не нужен.

## Notification Messages (i18n)

Namespace: `MSG.{lang}.sync`. Строки следуют правилу front-load: первые слова — суть,
без филлеров типа "Изменения для", "Напоминание:", "Событие".

### Russian (`MSG.ru.sync`)

```typescript
sync: {
  // Organizer changed event → notify participant
  eventChanged: (title: string, changes: string) =>
    `📅 «${title}» изменён:\n${changes}`,
  eventCancelled: (title: string) =>
    `❌ «${title}» — отменено организатором`,

  // Participant proposes changes → notify organizer
  changeProposed: (participantName: string, title: string, changes: string) =>
    `📝 ${participantName} → «${title}»:\n${changes}`,
  acceptBtn: 'Принять ✅',
  rejectBtn: 'Отклонить ❌',

  // Organizer responds → notify participant
  proposalAccepted: (title: string, changes: string) =>
    `✅ «${title}» принято:\n${changes}`,
  proposalRejected: (title: string, changes: string) =>
    `❌ «${title}» отклонено:\n${changes}`,

  // TTL expired
  proposalExpired: (title: string) =>
    `⏰ «${title}» — нет ответа, изменения отменены`,
  proposalExpiredOrganizer: (title: string) =>
    `⏰ «${title}» — предложение истекло`,

  // Participant declined via Google
  participantDeclinedViaGoogle: (participantName: string, title: string) =>
    `👋 ${participantName} отклонил «${title}»`,

  // Change descriptions (front-loaded: field value first)
  changeTime: (oldTime: string, newTime: string) =>
    `• ${oldTime} → ${newTime}`,
  changeTitle: (oldTitle: string, newTitle: string) =>
    `• ${oldTitle} → ${newTitle}`,
  changeLocation: (oldLoc: string, newLoc: string) =>
    `• ${oldLoc} → ${newLoc}`,
  changeDescription: '• Описание обновлено',
  changeAllDay: (isAllDay: boolean) =>
    isAllDay ? '• Теперь на весь день' : '• Больше не на весь день',
  changeRecurrence: '• Повторения изменены',
}
```

### English (`MSG.en.sync`)

```typescript
sync: {
  eventChanged: (title: string, changes: string) =>
    `📅 "${title}" changed:\n${changes}`,
  eventCancelled: (title: string) =>
    `❌ "${title}" — cancelled by organizer`,

  changeProposed: (participantName: string, title: string, changes: string) =>
    `📝 ${participantName} → "${title}":\n${changes}`,
  acceptBtn: 'Accept ✅',
  rejectBtn: 'Decline ❌',

  proposalAccepted: (title: string, changes: string) =>
    `✅ "${title}" accepted:\n${changes}`,
  proposalRejected: (title: string, changes: string) =>
    `❌ "${title}" declined:\n${changes}`,

  proposalExpired: (title: string) =>
    `⏰ "${title}" — no response, changes reverted`,
  proposalExpiredOrganizer: (title: string) =>
    `⏰ "${title}" — proposal expired`,

  participantDeclinedViaGoogle: (participantName: string, title: string) =>
    `👋 ${participantName} declined "${title}"`,

  changeTime: (oldTime: string, newTime: string) =>
    `• ${oldTime} → ${newTime}`,
  changeTitle: (oldTitle: string, newTitle: string) =>
    `• ${oldTitle} → ${newTitle}`,
  changeLocation: (oldLoc: string, newLoc: string) =>
    `• ${oldLoc} → ${newLoc}`,
  changeDescription: '• Description updated',
  changeAllDay: (isAllDay: boolean) =>
    isAllDay ? '• Now all-day' : '• No longer all-day',
  changeRecurrence: '• Recurrence changed',
}
```

## Rematerialization

При изменении `start_at`, `end_at` или `all_day` — напоминания нужно пересчитать.
`EventChangeNotifier` использует `hasTimeChange(changes)` и вызывает:

```typescript
if (hasTimeChange(changes)) {
  materializer.deleteForEvent(event.id);
  materializer.materialize(
    { id: event.id, start_at: event.start_at, reminder_overrides: event.reminder_overrides,
      all_day: event.all_day, user_timezone: event.timezone },
    event.user_id,
  );
  // Для каждого участника с accepted status — тоже rematerialize их reminders
  for (const p of activeParticipants) {
    materializer.deleteForEvent(event.id); // participant reminders are per-event, not per-user
    // (если у участников свои reminders — будущая фича)
  }
}
```

## Domain Events (future extension)

На данный момент `EventChangeNotifier` НЕ эмитит domain events. Существующий
`domainEventBus` в `EventService` продолжает эмитить `myCalendar.updatedEvent` /
`myCalendar.deletedEvent` как раньше.

В будущем можно добавить:
- `sync.ownerChanged` — для аналитики и аудита
- `sync.participantProposed` — для внешних интеграций
- `sync.proposalResolved` — для уведомлений в групповые чаты

## Files to Change

### New files
- `src/services/event/event-change-notifier.ts` — `EventChangeNotifier` class
- `src/services/google/change-detection.ts` — `computeEventDiff()`, `formatChanges()`, `EventFieldSnapshot`
- `src/services/google/participant-change-handler.ts` — `handleParticipantChange()`, `handleParticipantDelete()`
- `test/services/event/event-change-notifier.test.ts`
- `test/services/google/change-detection.test.ts`
- `test/services/google/participant-change-handler.test.ts`

### Modified files
- `src/database/migrations.ts` — new migration: `edit_proposals` columns, `participant_google_sync.timezone_override` + index
- `src/database/types.ts` — update `EditProposal`, `EditProposalStatus`, `CreateEditProposalData`, `ParticipantGoogleSync`
- `src/database/repositories/edit-proposal.repository.ts` — `getExpired()`, `getPendingByProposerAndEvent()`, `updateChanges()`, update `create()`
- `src/database/repositories/participant-google-sync.repository.ts` — `getByUserAndGoogleEventId()`, `updateTimezoneOverride()`
- `src/services/event/event-service.ts` — replace `onParticipantsNotify` with `changeNotifier?: EventChangeNotifier`
- `src/services/google/sync-service.ts` — integrate participant detection + `changeNotifier` in `handleUpdatedOrNewEvent` / `handleDeletedEvent`, make `handleDeletedEvent` async
- `src/services/google/sync-queue.ts` — add `proposal-expiry` repeating job
- `src/config/constants.ts` — add `sync` namespace to `MSG.en` / `MSG.ru`
- `src/bot/handlers/callback.handler.ts` — handle `editprop:accept`, `editprop:reject`
- `src/bot/index.ts` — wire `EventChangeNotifier` into `EventService` and `SyncService`
- `src/services/feature-tracking.ts` — add feature keys for new callbacks

## Sequencing

1. **Change detection** — `EventFieldSnapshot`, `computeEventDiff()`, `formatChanges()` + tests
2. **DB migration + types** — edit_proposals columns, timezone_override, index, type updates
3. **Repository enhancements** — edit-proposal + participant-google-sync new methods + tests
4. **i18n strings** — `sync` namespace in `MSG.en` / `MSG.ru`
5. **EventChangeNotifier** — the core service + tests
6. **EventService integration** — replace `onParticipantsNotify` with `changeNotifier`
7. **SyncService integration** — participant detection, async `handleDeletedEvent`, snapshot pattern
8. **Participant change handler** — proposal creation, timezone override
9. **Callback handlers** — accept/reject buttons for edit proposals
10. **Expiry worker** — BullMQ repeating job for proposal TTL
11. **Wiring** — `bot/index.ts` DI setup
12. **Integration tests** — end-to-end sync scenarios
