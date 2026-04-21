# Implementation Plan: Sync Calendar Changes

Based on spec: `docs/specs/2026-04-13-sync-calendar-changes.md`

## Task Breakdown

### Phase 1: Foundation (pure logic, no side effects)

#### Task 1.1: Change Detection Module
**New file**: `src/services/google/change-detection.ts`
**Test**: `test/services/google/change-detection.test.ts`

Types:
- `EventFieldSnapshot` — normalized common type (all_day: boolean, not number)
- `SharedField`, `PersonalField`, `TrackedField` — field category unions
- `FieldChange` — `{ field, oldValue, newValue }`

Functions:
- `snapshotFromCalendarEvent(e: CalendarEvent): EventFieldSnapshot` — normalizes all_day 0/1 → boolean
- `snapshotFromGoogleLocal(e: LocalEventFromGoogle): EventFieldSnapshot`
- `computeEventDiff(existing, incoming): FieldChange[]` — compare all tracked fields
  - Normalize: trim strings, `null === ''` for description/location, `null === null`
- `getSharedChanges(changes): FieldChange[]` — filter to shared fields only
- `getPersonalChanges(changes): FieldChange[]` — filter to personal fields only
- `hasTimeChange(changes): boolean` — start_at, end_at, or all_day changed
- `formatChanges(changes, lang): string` — i18n multi-line diff, front-load time changes

**Tests**:
- No changes → empty array
- Single field change (each of 8 tracked fields)
- Multiple fields changed simultaneously
- Normalization: trailing whitespace, null vs empty string, all_day 0 vs false
- `getSharedChanges` filters out timezone
- `getPersonalChanges` returns only timezone
- `formatChanges` output for RU and EN
- `formatChanges` with multiple changes (ordering: time first)

#### Task 1.2: DB Migration + Type Updates
**File**: `src/database/migrations.ts` (append new migration)
**File**: `src/database/types.ts`

Migration SQL:
```sql
ALTER TABLE edit_proposals ADD COLUMN expires_at TEXT;
ALTER TABLE edit_proposals ADD COLUMN original_values TEXT;
ALTER TABLE edit_proposals ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE edit_proposals ADD COLUMN organizer_message_id INTEGER;
ALTER TABLE edit_proposals ADD COLUMN organizer_chat_id INTEGER;
ALTER TABLE edit_proposals ADD COLUMN participant_message_id INTEGER;
ALTER TABLE edit_proposals ADD COLUMN participant_chat_id INTEGER;
ALTER TABLE participant_google_sync ADD COLUMN timezone_override TEXT;
CREATE INDEX IF NOT EXISTS idx_participant_google_sync_google_event
  ON participant_google_sync (user_id, google_event_id);
```

Type changes:
- `EditProposalStatus`: add `'expired'`
- `EditProposal`: add 7 new fields (expires_at, original_values, source, organizer_message_id,
  organizer_chat_id, participant_message_id, participant_chat_id)
- `CreateEditProposalData`: add optional expires_at, original_values, source
- `ParticipantGoogleSync`: add `timezone_override: string | null`

#### Task 1.3: Repository Enhancements
**File**: `src/database/repositories/edit-proposal.repository.ts`
**File**: `src/database/repositories/participant-google-sync.repository.ts`

EditProposalRepository:
- `getExpired(): EditProposal[]` — `WHERE status='pending' AND expires_at < datetime('now')`
- `getPendingByProposerAndEvent(proposerId, eventId): EditProposal | null`
- `updateChanges(id, changes, originalValues, expiresAt)` — update pending proposal in-place
- Update `create()` to accept new fields (expires_at, original_values, source)
- Update `updateStatus()` to also accept `'expired'`

ParticipantGoogleSyncRepository:
- `getByUserAndGoogleEventId(userId, googleEventId): ParticipantGoogleSync | null`
- `updateTimezoneOverride(userId, eventId, timezone): void`

**Tests**: unit tests for each new method

#### Task 1.4: i18n Strings
**File**: `src/config/constants.ts`

Add `sync` namespace to both `MSG.en` and `MSG.ru` (see spec for exact strings).
All strings front-loaded per CLAUDE.md rules.

### Phase 2: EventChangeNotifier

#### Task 2.1: EventChangeNotifier Service
**New file**: `src/services/event/event-change-notifier.ts`
**Test**: `test/services/event/event-change-notifier.test.ts`

```typescript
type ChangeSource = 'bot' | 'google_sync' | 'proposal_accept';

class EventChangeNotifier {
  constructor(private deps: EventChangeNotifierDeps) {}

  async onEventChanged(params: {
    event: CalendarEvent;
    changes: FieldChange[];
    source: ChangeSource;
    skipProposalExpiry?: boolean;  // true при proposal_accept
    excludeUserIds?: number[];     // не слать уведомление proposer'у
  }): Promise<void> {
    const { event, changes, source, skipProposalExpiry, excludeUserIds } = params;
    if (event.owner_type !== 'user') return;  // MVP: skip group events

    const sharedChanges = getSharedChanges(changes);
    if (sharedChanges.length === 0) return;

    const participants = this.deps.participantRepo.getByEvent(event.id);
    const active = participants.filter(p =>
      p.status !== 'declined' &&
      p.user_id !== event.user_id &&
      !excludeUserIds?.includes(p.user_id),
    );

    // Auto-expire pending proposals (unless caller already handled the proposal)
    if (!skipProposalExpiry) {
      const pendingProposals = this.deps.editProposalRepo.getPendingForEvent(event.id);
      for (const proposal of pendingProposals) {
        this.deps.editProposalRepo.updateStatus(proposal.id, 'expired');
        const lang = this.deps.getUserLang(proposal.proposer_id);
        await this.deps.notifyUser(
          proposal.proposer_id,
          t(lang).sync.proposalExpired(event.title),
        );
        if (proposal.organizer_message_id && proposal.organizer_chat_id) {
          const orgLang = this.deps.getUserLang(event.user_id);
          await this.deps.editMessage(
            proposal.organizer_chat_id,
            proposal.organizer_message_id,
            t(orgLang).sync.proposalExpiredOrganizer(event.title),
          );
        }
      }
    }

    if (active.length === 0) return;

    // Notify each active participant (excluding excludeUserIds)
    for (const p of active) {
      const lang = this.deps.getUserLang(p.user_id);
      const text = t(lang).sync.eventChanged(event.title, formatChanges(sharedChanges, lang));
      await this.deps.notifyUser(p.user_id, text);

      await this.deps.syncQueue.add('push-participant-event', {
        type: 'push-participant-event',
        userId: p.user_id,
        eventId: event.id,
        action: 'update',
      });
    }

    // Push to organizer's GCal (only if change came from bot, not from GCal itself)
    if (source === 'bot' || source === 'proposal_accept') {
      await this.deps.syncQueue.add('push-event', {
        type: 'push-event',
        userId: event.user_id,
        eventId: event.id,
        action: 'update',
      });
    }

    // Rematerialize reminders ONLY when source is google_sync
    // (bot/proposal_accept: EventService.updateEvent already rematerialized)
    if (source === 'google_sync' && hasTimeChange(sharedChanges)) {
      this.deps.materializer.deleteForEvent(event.id);
      this.deps.materializer.materialize(
        { id: event.id, start_at: event.start_at, reminder_overrides: event.reminder_overrides,
          all_day: event.all_day, user_timezone: event.timezone },
        event.user_id,
      );
    }
  }

  async onEventDeleted(params: {
    event: CalendarEvent;
    source: ChangeSource;
  }): Promise<void> {
    const { event, source } = params;
    if (event.owner_type !== 'user') return;

    const participants = this.deps.participantRepo.getByEvent(event.id);
    const active = participants.filter(p => p.status !== 'declined' && p.user_id !== event.user_id);

    // Auto-expire pending proposals
    const pendingProposals = this.deps.editProposalRepo.getPendingForEvent(event.id);
    for (const proposal of pendingProposals) {
      this.deps.editProposalRepo.updateStatus(proposal.id, 'expired');
    }

    for (const p of active) {
      const lang = this.deps.getUserLang(p.user_id);
      await this.deps.notifyUser(p.user_id, t(lang).sync.eventCancelled(event.title));

      // Delete from participant's Google Calendar
      await this.deps.syncQueue.add('push-participant-event', {
        type: 'push-participant-event',
        userId: p.user_id,
        eventId: event.id,
        action: 'delete',
      });
    }

    // Push delete to organizer's GCal (only if change came from bot)
    if (source === 'bot') {
      await this.deps.syncQueue.add('push-event', {
        type: 'push-event',
        userId: event.user_id,
        eventId: event.id,
        action: 'delete',
      });
    }

    // Clean up participant_google_sync records
    this.deps.participantSyncRepo.deleteByEvent(event.id);
  }
}
```

**Tests**:
- No participants → no side effects
- 3 active participants → 3 notifications + 3 push jobs
- 1 declined participant → skipped
- Pending proposals auto-expired + proposers notified
- `skipProposalExpiry: true` → proposals NOT expired
- `excludeUserIds: [42]` → user 42 NOT notified, others are
- Group event → early return
- Time change + `source: 'google_sync'` → rematerialization called
- Time change + `source: 'bot'` → rematerialization NOT called (EventService does it)
- `source: 'bot'` → push to organizer GCal
- `source: 'google_sync'` → NO push to organizer GCal
- Only shared changes passed → personal fields ignored
- No shared changes → early return (even if timezone changed)
- `onEventDeleted` → all participants notified + GCal deleted + participant_google_sync cleaned
- `onEventDeleted` + `source: 'bot'` → push delete to organizer GCal
- `onEventDeleted` + `source: 'google_sync'` → NO push delete to organizer GCal

#### Task 2.2: Integrate into EventService
**File**: `src/services/event/event-service.ts`
**File**: `src/bot/index.ts`

Changes to `EventServiceDeps`:
- Remove `onParticipantsNotify?: (userIds: number[], text: string) => void`
- Add `changeNotifier?: EventChangeNotifier`

`updateEvent(id, userId, data, notifierOptions?)`:
- New optional param: `notifierOptions?: { skipProposalExpiry?: boolean; excludeUserIds?: number[] }`
- After update + domain events, call `changeNotifier.onEventChanged()` with
  `computeEventDiff(snapshotFromCalendarEvent(existing), snapshotFromCalendarEvent(updated))`
- Pass `notifierOptions` through to the notifier (for proposal_accept flow)
- Fire-and-forget with `.catch(err => logger.error(...))`

`deleteEvent()`:
- Replace `onParticipantsNotify` block with `changeNotifier.onEventDeleted()`
- Fire-and-forget with `.catch(err => logger.error(...))`

`bot/index.ts`:
- Replace `onParticipantsNotify` lambda with `changeNotifier: new EventChangeNotifier({ ... })`

### Phase 3: Sync Service Integration

#### Task 3.1: Participant Detection in incrementalPull
**File**: `src/services/google/sync-service.ts`

SyncService constructor — new optional deps:
- `changeNotifier?: EventChangeNotifier`

`handleUpdatedOrNewEvent` — rewrite with snapshot pattern:

```
Transaction:
  existing = findByGoogleEventId(userId, calendarId, googleEventId)
  if (existing)
    snapshot = snapshotFromCalendarEvent(existing)
    // existing update code
    incoming = snapshotFromGoogleLocal(local)
    changes = computeEventDiff(snapshot, incoming)
    if (changes.length > 0) → capture pendingNotification for changeNotifier
  else
    participantSync = participantSyncRepo.getByUserAndGoogleEventId(userId, googleEventId)
    if (participantSync)
      masterEvent = eventRepo.findByIdUnfiltered(participantSync.event_id)
      → capture pendingNotification for handleParticipantChange
    else
      → insert new event (existing code)
End transaction
Execute pendingNotification (async)
```

`handleDeletedEvent` — make async, add participant detection:

```
existing = findByGoogleEventId(userId, calendarId, googleEventId)
if (existing)
  → changeNotifier.onEventDeleted(...) BEFORE remove
  → existing remove + sync log
else
  participantSync = participantSyncRepo.getByUserAndGoogleEventId(userId, googleEventId)
  if (participantSync)
    → handleParticipantDelete(userId, participantSync)
```

#### Task 3.2: Participant Change Handler
**New file**: `src/services/google/participant-change-handler.ts`
**Test**: `test/services/google/participant-change-handler.test.ts`

`handleParticipantChange(participantUserId, masterEvent, incomingLocal, participantSync, deps)`:

1. `computeEventDiff(snapshotFromCalendarEvent(masterEvent), snapshotFromGoogleLocal(incomingLocal))`
2. Split into shared + personal changes
3. **Personal changes** (timezone): `participantSyncRepo.updateTimezoneOverride(userId, eventId, newTz)`
4. **Shared changes**: if empty → return
5. Check existing pending proposal: `editProposalRepo.getPendingByProposerAndEvent(userId, eventId)`
6. If existing → `updateChanges()` + edit organizer message
7. If new → `create()` + send organizer notification with [Accept][Decline] buttons
   - Store `organizer_message_id`, `organizer_chat_id` after send
8. Update `participant_google_sync` etag

`handleParticipantDelete(participantUserId, participantSync, deps)`:

1. Load master event
2. `participantRepo.updateStatus(eventId, userId, 'declined')`
3. `invitationRepo.findActiveByEventAndInvitee(eventId, userId)` → if found, `updateStatus('declined')`
4. `participantSyncRepo.delete(userId, eventId)`
5. Cancel pending proposals from this participant
6. Notify organizer

**Tests**:
- Single shared field change → new proposal created
- Timezone-only change → no proposal, timezone_override updated
- Mixed shared+personal → proposal for shared, timezone stored separately
- Existing pending proposal → updated, not duplicated
- Organizer notified with buttons, message_id stored
- Participant delete → status=declined, organizer notified, participant_google_sync cleaned
- Participant delete with active invitation → invitation also declined
- Participant delete with no invitation → OK (null check)

### Phase 4: Proposal Lifecycle

#### Task 4.1: Callback Handlers (Accept / Reject)
**File**: `src/bot/handlers/callback.handler.ts`

`editprop:accept:{id}`:
1. Validate: caller is organizer (`event.user_id === ctx.from.id`)
2. Parse `changes` JSON from proposal → `FieldChange[]`
3. `editProposalRepo.updateStatus(id, 'accepted')` — BEFORE updateEvent to avoid auto-expiry race
4. Build `UpdateEventData` from changes (careful with all_day: boolean→number conversion)
5. `eventService.updateEvent(eventId, ownerId, data, { skipProposalExpiry: true, excludeUserIds: [proposal.proposer_id] })`
   — `skipProposalExpiry`: this proposal is already accepted, don't expire it
   — `excludeUserIds`: proposer gets a separate "accepted" message (step 7), not generic "changed"
6. Edit organizer message: remove buttons, show `✅`
7. Notify proposer with diff: `t(lang).sync.proposalAccepted(title, formatChanges(changes, lang))`

`editprop:reject:{id}`:
1. Validate: caller is organizer
2. `editProposalRepo.updateStatus(id, 'rejected')`
3. Edit organizer message: remove buttons, show `❌`
4. Push original event data to participant's GCal (revert): `syncQueue.add('push-participant-event', { action: 'update' })`
5. Notify proposer with diff: `t(lang).sync.proposalRejected(title, formatChanges(changes, lang))`

#### Task 4.2: Proposal Expiry Worker
**File**: `src/services/scheduled/bot-tasks.ts` (or new file if bot-tasks doesn't exist)

BullMQ repeating job (every 5 minutes) in `bot-tasks` queue:

```typescript
async function processExpiredProposals(deps): Promise<void> {
  const expired = deps.editProposalRepo.getExpired();
  for (const proposal of expired) {
    deps.editProposalRepo.updateStatus(proposal.id, 'expired');

    // Revert participant's Google Calendar copy
    await deps.syncQueue.add('push-participant-event', {
      type: 'push-participant-event',
      userId: proposal.proposer_id,
      eventId: proposal.event_id,
      action: 'update',
    });

    const event = deps.eventRepo.findByIdUnfiltered(proposal.event_id);
    if (!event) continue;

    // Notify participant
    const lang = deps.getUserLang(proposal.proposer_id);
    await deps.notifyUser(proposal.proposer_id, t(lang).sync.proposalExpired(event.title));

    // Edit organizer message (remove buttons)
    if (proposal.organizer_message_id && proposal.organizer_chat_id) {
      const orgLang = deps.getUserLang(event.user_id);
      await deps.editMessage(
        proposal.organizer_chat_id,
        proposal.organizer_message_id,
        t(orgLang).sync.proposalExpiredOrganizer(event.title),
      );
    }
  }
}
```

### Phase 5: Feature Tracking & Wiring

#### Task 5.1: Feature tracking maps
**File**: `src/services/feature-tracking.ts`

Add `editprop:accept` and `editprop:reject` to `CALLBACK_FEATURE_MAP`.

#### Task 5.2: Wire everything together
**File**: `src/bot/index.ts`

- Create `EventChangeNotifier` instance with all deps
- Pass to `EventService` (replaces `onParticipantsNotify`)
- Pass to `SyncService` (new dep)
- Register `editprop:accept` / `editprop:reject` callback handlers
- Add `proposal-expiry` repeating job to bot-tasks queue

### Phase 6: Integration Tests

**Test file**: `test/services/google/sync-change-propagation.test.ts`

Scenarios:
1. Organizer edits in GCal → participants notified + their GCal updated
2. Organizer edits via bot → same notifications (via EventChangeNotifier)
3. Participant edits shared fields in GCal → proposal created → organizer accepts → applied to all
4. Participant edits only timezone → no proposal, timezone_override stored
5. Participant edits shared+timezone → proposal for shared, timezone stored
6. Participant edits → proposal expires (1h TTL) → reverted + notified
7. Participant edits → organizer rejects → reverted + notified
8. Participant deletes → treated as decline, organizer notified
9. Organizer deletes → all participants notified + GCal copies deleted
10. Participant edits while organizer also editing → proposals auto-expired
11. Participant makes multiple edits → existing proposal updated, not duplicated
12. Group event → no change propagation (MVP filter)

## Dependency Graph

```
Phase 1 (parallel):
  Task 1.1 (change detection)
  Task 1.2 (migration + types)
  Task 1.3 (repo enhancements)
  Task 1.4 (i18n strings)
    │
    ▼
Phase 2:
  Task 2.1 (EventChangeNotifier)
  Task 2.2 (EventService integration)
    │
    ▼
Phase 3:
  Task 3.1 (SyncService participant detection)
  Task 3.2 (Participant change/delete handlers)
    │
    ▼
Phase 4:
  Task 4.1 (Callback handlers: accept/reject)
  Task 4.2 (Expiry worker)
    │
    ▼
Phase 5:
  Task 5.1 (Feature tracking)
  Task 5.2 (Wiring in bot/index.ts)
    │
    ▼
Phase 6:
  Integration tests
```

Phase 1 tasks are independent and can be done in parallel.
Each subsequent phase depends on the previous.
