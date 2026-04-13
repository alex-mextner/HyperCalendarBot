# Implementation Plan: Sync Calendar Changes

Based on spec: `docs/specs/2026-04-13-sync-calendar-changes.md`

## Task Breakdown

### Phase 1: Foundation (pure logic, no side effects)

#### Task 1.1: Change Detection Module
**File**: `src/services/google/change-detection.ts`
**Test**: `test/services/google/change-detection.test.ts`

- `computeEventDiff(existing, incoming)` → `FieldChange[]`
  - Compare tracked fields: title, description, start_at, end_at, all_day, location, recurrence_rule
  - Normalize values before comparison (e.g. all_day 0/1 → boolean, trim timestamps)
  - Return empty array if no changes
- `formatChanges(changes, lang)` → string
  - Human-readable multi-line diff using i18n strings
  - Front-load most important change (time > location > title > description > recurrence)
- `hasTimeChange(changes)` → boolean
  - Utility to check if reminders need rematerialization

**Tests**:
- No changes → empty array
- Single field change (each of 7 fields)
- Multiple fields changed
- Normalization: trailing whitespace, null vs empty string
- `formatChanges` output for each field type
- `formatChanges` with multiple changes

#### Task 1.2: DB Migration + Type Updates
**File**: `src/database/migrations.ts` (append new migration)
**File**: `src/database/types.ts`

Migration:
```sql
ALTER TABLE edit_proposals ADD COLUMN expires_at TEXT;
ALTER TABLE edit_proposals ADD COLUMN original_values TEXT;
ALTER TABLE edit_proposals ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE edit_proposals ADD COLUMN organizer_message_id INTEGER;
ALTER TABLE edit_proposals ADD COLUMN participant_message_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_participant_google_sync_google_event
  ON participant_google_sync (user_id, google_event_id);
```

Update `EditProposal` interface:
```typescript
interface EditProposal {
  // existing fields...
  expires_at: string | null;
  original_values: string | null; // JSON
  source: 'google_sync' | 'manual' | 'ai_tool';
  organizer_message_id: number | null;
  participant_message_id: number | null;
}
```

Update `EditProposalStatus`: add `'expired'`.

#### Task 1.3: Repository Enhancements
**File**: `src/database/repositories/edit-proposal.repository.ts`
**File**: `src/database/repositories/participant-google-sync.repository.ts`

EditProposalRepository:
- `getExpired()` → expired pending proposals
- `getPendingByProposerAndEvent(proposerId, eventId)` → for "update existing proposal" logic
- `updateChanges(id, changes, originalValues, expiresAt)` → update pending proposal
- Update `create()` to accept new fields

ParticipantGoogleSyncRepository:
- `getByUserAndGoogleEventId(userId, googleEventId)` → lookup by google_event_id

**Tests**: unit tests for each new method

### Phase 2: Sync Service Integration

#### Task 2.1: Participant Change Detection in incrementalPull
**File**: `src/services/google/sync-service.ts`

Modify `handleUpdatedOrNewEvent`:
```
existing = findByGoogleEventId(userId, calendarId, googleEventId)
if (existing) → current flow (owner update)
  + NEW: after update, call ownerChangeHandler
else
  participantSync = participantSyncRepo.getByUserAndGoogleEventId(userId, googleEventId)
  if (participantSync)
    masterEvent = eventRepo.findByIdUnfiltered(participantSync.event_id)
    → handleParticipantChange(userId, masterEvent, incomingGoogleEvent, participantSync)
  else
    → current flow (insert new event)
```

Modify `handleDeletedEvent`:
```
existing = findByGoogleEventId(userId, calendarId, googleEventId)
if (existing) → current flow (owner delete)
  + NEW: notify participants, delete their GCal copies
else
  participantSync = participantSyncRepo.getByUserAndGoogleEventId(userId, googleEventId)
  if (participantSync)
    → handleParticipantDelete(userId, participantSync)
```

SyncService constructor needs new deps:
- `participantRepo: ParticipantRepository`
- `editProposalRepo: EditProposalRepository`
- `onParticipantChange` callback
- `onOwnerChange` callback

#### Task 2.2: Owner Change Handler
**File**: `src/services/google/owner-change-handler.ts`
**Test**: `test/services/google/owner-change-handler.test.ts`

Called after `handleUpdatedOrNewEvent` updates an owner's event:

```typescript
async function handleOwnerChange(
  event: CalendarEvent,
  changes: FieldChange[],
  deps: {
    participantRepo: ParticipantRepository;
    editProposalRepo: EditProposalRepository;
    syncQueue: Queue<GoogleSyncJobData>;
    notifyUser: (userId: number, message: string) => Promise<void>;
    getUserLang: (userId: number) => Lang;
    getUserName: (userId: number) => string;
  },
): Promise<void> {
  if (changes.length === 0) return;

  const participants = deps.participantRepo.getByEvent(event.id);
  if (participants.length === 0) return;

  // Auto-expire pending proposals for this event (organizer changed it themselves)
  const pendingProposals = deps.editProposalRepo.getPendingForEvent(event.id);
  for (const proposal of pendingProposals) {
    deps.editProposalRepo.updateStatus(proposal.id, 'expired');
    // Notify proposer that organizer changed the event
  }

  // Notify each participant
  for (const p of participants) {
    if (p.status === 'declined') continue;
    const lang = deps.getUserLang(p.user_id);
    const message = formatChanges(changes, lang);
    await deps.notifyUser(p.user_id, message);

    // Push updated event to participant's Google Calendar
    deps.syncQueue.add('push-participant-event', {
      type: 'push-participant-event',
      userId: p.user_id,
      eventId: event.id,
      action: 'update',
    });
  }

  // Rematerialize reminders if time changed
  if (hasTimeChange(changes)) {
    // trigger reminder recalculation
  }
}
```

**Tests**:
- No participants → no notifications
- 3 participants → 3 notifications + 3 push jobs
- Declined participant skipped
- Pending proposals auto-expired
- Time change triggers rematerialization

#### Task 2.3: Participant Change Handler
**File**: `src/services/google/participant-change-handler.ts`
**Test**: `test/services/google/participant-change-handler.test.ts`

Called when participant's pull detects changes to a shared event:

```typescript
async function handleParticipantChange(
  participantUserId: number,
  masterEvent: CalendarEvent,
  incomingLocal: LocalEventFromGoogle,
  participantSync: ParticipantGoogleSync,
  deps: { ... },
): Promise<void> {
  const changes = computeEventDiff(masterEvent, incomingLocal);
  if (changes.length === 0) return;

  // Check for existing pending proposal
  const existing = deps.editProposalRepo.getPendingByProposerAndEvent(
    participantUserId, masterEvent.id
  );

  const originalValues = JSON.stringify(
    Object.fromEntries(
      changes.map(c => [c.field, c.oldValue])
    )
  );

  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

  if (existing) {
    // Update existing proposal
    deps.editProposalRepo.updateChanges(
      existing.id,
      JSON.stringify(changes),
      originalValues,
      expiresAt,
    );
    // Edit organizer's message with updated changes
  } else {
    // Create new proposal
    const proposal = deps.editProposalRepo.create({
      event_id: masterEvent.id,
      proposer_id: participantUserId,
      changes: JSON.stringify(changes),
      original_values: originalValues,
      expires_at: expiresAt,
      source: 'google_sync',
    });
    // Send notification to organizer with inline buttons
    // Store organizer_message_id
  }

  // Update participant_google_sync etag (so we don't re-process same change)
  deps.participantSyncRepo.updateSyncFields(participantUserId, masterEvent.id, {
    google_etag: incomingLocal.google_etag ?? undefined,
    last_synced_at: new Date().toISOString(),
  });
}
```

**Tests**:
- Single field change → new proposal created
- Multiple fields → all in one proposal
- Existing pending proposal → updated, not duplicated
- Organizer notified via message with buttons
- participant_google_sync etag updated

#### Task 2.4: Participant Delete Handler

In `handleDeletedEvent`, when participant deletes:

```typescript
async function handleParticipantDelete(
  participantUserId: number,
  participantSync: ParticipantGoogleSync,
  deps: { ... },
): Promise<void> {
  const masterEvent = deps.eventRepo.findByIdUnfiltered(participantSync.event_id);
  if (!masterEvent) return;

  // Update participant status to declined
  deps.participantRepo.updateStatus(masterEvent.id, participantUserId, 'declined');

  // Update invitation status if exists
  const invitation = deps.invitationRepo.findByEventAndInvitee(masterEvent.id, participantUserId);
  if (invitation) {
    deps.invitationRepo.updateStatus(invitation.id, 'declined', invitation.status);
  }

  // Clean up participant_google_sync
  deps.participantSyncRepo.delete(participantUserId, masterEvent.id);

  // Cancel any pending proposals from this participant
  const pendingProposals = deps.editProposalRepo.getPendingByProposerAndEvent(
    participantUserId, masterEvent.id,
  );
  for (const p of pendingProposals) {
    deps.editProposalRepo.updateStatus(p.id, 'rejected');
  }

  // Notify organizer
  const participantName = deps.getUserName(participantUserId);
  const lang = deps.getUserLang(masterEvent.user_id);
  await deps.notifyUser(
    masterEvent.user_id,
    t(lang).sync.participantDeclinedViaGoogle(participantName, masterEvent.title),
  );
}
```

### Phase 3: Proposal Lifecycle

#### Task 3.1: Callback Handlers (Accept / Reject)
**File**: `src/bot/handlers/callback.handler.ts`

```
editprop:accept:{id}  →  apply changes to master event, notify all participants, push updates
editprop:reject:{id}  →  revert participant's GCal copy, notify participant
```

Accept flow:
1. Validate: caller is the organizer (event.user_id === ctx.from.id)
2. Parse `changes` JSON from proposal
3. Apply each change to the master event via `eventRepo.update()`
4. Mark proposal as accepted
5. Edit organizer message: remove buttons, show "✅ Принято"
6. Notify participant: "✅ Изменения приняты"
7. Notify other participants about the changes
8. Push updated event to all participants' Google Calendars
9. Push updated event to organizer's Google Calendar (if synced)
10. Rematerialize reminders if time changed

Reject flow:
1. Validate: caller is the organizer
2. Mark proposal as rejected
3. Edit organizer message: remove buttons, show "❌ Отклонено"
4. Push original event data to participant's Google Calendar (revert)
5. Notify participant: "❌ Изменения отклонены"

#### Task 3.2: Proposal Expiry Worker
**File**: modify `src/services/scheduled/bot-tasks.ts` or equivalent

BullMQ repeating job (every 5 minutes):
```typescript
async function processExpiredProposals(deps: { ... }): Promise<void> {
  const expired = deps.editProposalRepo.getExpired();
  for (const proposal of expired) {
    deps.editProposalRepo.updateStatus(proposal.id, 'expired');

    // Revert participant's Google Calendar copy
    deps.syncQueue.add('push-participant-event', {
      type: 'push-participant-event',
      userId: proposal.proposer_id,
      eventId: proposal.event_id,
      action: 'update',
    });

    // Notify participant
    const event = deps.eventRepo.findByIdUnfiltered(proposal.event_id);
    if (event) {
      const lang = deps.getUserLang(proposal.proposer_id);
      await deps.notifyUser(proposal.proposer_id, t(lang).sync.proposalExpired(event.title));
    }

    // Edit organizer message (remove buttons)
    if (proposal.organizer_message_id && event) {
      const orgLang = deps.getUserLang(event.user_id);
      await deps.editMessage(
        event.user_id,
        proposal.organizer_message_id,
        t(orgLang).sync.proposalExpiredOrganizer(event.title),
      );
    }
  }
}
```

### Phase 4: Owner Delete → Participant Notification

#### Task 4.1: Enhance handleDeletedEvent
**File**: `src/services/google/sync-service.ts`

Before deleting the event:
1. Get all participants: `participantRepo.getByEvent(eventId)`
2. For each active participant:
   - Notify: "❌ Событие отменено организатором"
   - Delete from their Google Calendar: `syncQueue.add('push-participant-event', { action: 'delete' })`
   - Clean up `participant_google_sync`
3. Delete the event (existing logic)

### Phase 5: i18n & Feature Tracking

#### Task 5.1: Add i18n strings
**File**: `src/config/constants.ts`

Add `sync` namespace to `MSG.en` and `MSG.ru` with all strings from the spec.

#### Task 5.2: Feature tracking maps
**File**: `src/services/feature-tracking.ts`

Add `editprop:accept` and `editprop:reject` to `CALLBACK_FEATURE_MAP`.

### Phase 6: Integration & Wiring

#### Task 6.1: Wire everything together
- Pass new deps to SyncService constructor
- Register callback handlers
- Set up expiry repeating job
- Wire sync queue with new job types if needed

#### Task 6.2: Integration tests
- Scenario: organizer edits in GCal → participants notified + GCal updated
- Scenario: participant edits in GCal → proposal created → organizer accepts → applied
- Scenario: participant edits → proposal expires → reverted
- Scenario: participant edits → organizer rejects → reverted
- Scenario: participant deletes → treated as decline
- Scenario: organizer deletes → participants notified
- Scenario: participant edits while organizer also editing → proposals auto-expired

## Dependency Graph

```
Task 1.1 (change detection)     ─┐
Task 1.2 (migration + types)    ─┤
Task 1.3 (repo enhancements)    ─┤─→ Task 2.1 (sync-service integration)
                                  │
Task 5.1 (i18n strings)         ─┤─→ Task 2.2 (owner change handler)
                                  │─→ Task 2.3 (participant change handler)
                                  │─→ Task 2.4 (participant delete handler)
                                  │
                                  ├─→ Task 3.1 (callback handlers)
                                  ├─→ Task 3.2 (expiry worker)
                                  ├─→ Task 4.1 (owner delete notifications)
                                  │
                                  └─→ Task 6.1 (wiring)
                                       └─→ Task 6.2 (integration tests)
```

Phase 1 tasks are independent and can be done in parallel.
Phase 2–4 depend on Phase 1.
Phase 5 can be done alongside Phase 1.
Phase 6 is last.
