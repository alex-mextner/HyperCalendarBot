# Shared Events Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When invitee accepts invitation, event appears in their calendar. Creator edits are instantly visible. Invitee delete = decline. Invitee edit = propose change to creator. Time conflicts detected at accept.

**Architecture:** Participants model — event exists once (owned by creator), `event_participants` junction table links attendees. Calendar queries UNION owned events + participated events. No data duplication, no sync. Creator edits are instant (single record). Invitee "delete" = change participant status to declined. Edit proposals via separate table + bot message to creator.

**Tech Stack:** bun:sqlite, GramIO, pino, bun test

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/database/migrations.ts` | Migration 014: `event_participants` table, migration 015: `edit_proposals` table |
| `src/database/types.ts` | `EventParticipant`, `EditProposal` interfaces |
| `src/database/repositories/participant.repository.ts` | NEW: CRUD for event_participants |
| `src/database/repositories/event.repository.ts` | Add `getVisibleInRange()`, `getVisibleUpcoming()` with participant JOIN |
| `src/database/index.ts` | Wire `ParticipantRepository` |
| `src/services/sharing/invitation-service.ts` | `acceptInvitation` adds participant row |
| `src/services/event/event-service.ts` | Use visible queries for calendar views; delete/edit awareness |
| `src/services/event/conflict-checker.ts` | NEW: `checkConflicts(userId, startAt, endAt)` |
| `src/services/ai/tool-handlers/event.ts` | delete_event: detect shared → decline; update_event: detect shared → propose |
| `src/services/ai/tool-handlers/sharing.ts` | Add `propose_edit` handler |
| `src/services/ai/tools.ts` | Add `propose_edit` tool definition |
| `src/services/ai/tool-executor.ts` | Route `propose_edit` |
| `src/bot/handlers/callback.handler.ts` | Handle edit proposal accept/reject callbacks |
| `src/bot/commands/today.ts` | Use visible events (owned + participated) |
| `src/bot/commands/tomorrow.ts` | Use visible events |
| `src/bot/commands/week.ts` | Use visible events |
| `src/config/constants.ts` | `EDIT_PROPOSAL` callback prefix, i18n strings |
| `test/services/sharing/shared-events.test.ts` | NEW: all shared events tests |
| `test/services/event/conflict-checker.test.ts` | NEW: conflict detection tests |
| `test/database/repositories/participant.repository.test.ts` | NEW: participant repo tests |

---

### Task 1: Database — event_participants table

**Files:**
- Modify: `src/database/migrations.ts`
- Modify: `src/database/types.ts`
- Create: `src/database/repositories/participant.repository.ts`
- Modify: `src/database/index.ts`
- Create: `test/database/repositories/participant.repository.test.ts`

- [ ] **Step 1: Write failing test — participant CRUD**

```typescript
// test/database/repositories/participant.repository.test.ts
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { ParticipantRepository } from '../../../src/database/repositories/participant.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';

const CREATOR_ID = 100;
const INVITEE_ID = 200;

function createTestDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

describe('ParticipantRepository', () => {
  let db: Database;
  let participantRepo: ParticipantRepository;
  let eventRepo: EventRepository;
  let eventId: number;

  beforeEach(() => {
    db = createTestDb();
    const userRepo = new UserRepository(db);
    eventRepo = new EventRepository(db);
    participantRepo = new ParticipantRepository(db);
    userRepo.create({ telegram_id: CREATOR_ID, timezone: 'UTC' });
    userRepo.create({ telegram_id: INVITEE_ID, timezone: 'UTC' });
    eventId = eventRepo.create({
      user_id: CREATOR_ID,
      title: 'Team Sync',
      start_at: '2026-03-20T10:00:00Z',
      timezone: 'UTC',
    }).id;
  });

  test('add creates participant', () => {
    const p = participantRepo.add(eventId, INVITEE_ID, 'accepted');
    expect(p.event_id).toBe(eventId);
    expect(p.user_id).toBe(INVITEE_ID);
    expect(p.status).toBe('accepted');
    expect(p.role).toBe('attendee');
  });

  test('add with organizer role', () => {
    const p = participantRepo.add(eventId, CREATOR_ID, 'accepted', 'organizer');
    expect(p.role).toBe('organizer');
  });

  test('findByEventAndUser returns participant', () => {
    participantRepo.add(eventId, INVITEE_ID, 'accepted');
    const p = participantRepo.findByEventAndUser(eventId, INVITEE_ID);
    expect(p).not.toBeNull();
    expect(p!.status).toBe('accepted');
  });

  test('findByEventAndUser returns null when not found', () => {
    expect(participantRepo.findByEventAndUser(eventId, 999)).toBeNull();
  });

  test('getByEvent returns all participants', () => {
    participantRepo.add(eventId, INVITEE_ID, 'accepted');
    participantRepo.add(eventId, 300, 'pending');
    const all = participantRepo.getByEvent(eventId);
    expect(all).toHaveLength(2);
  });

  test('getAcceptedByUser returns events user participates in', () => {
    participantRepo.add(eventId, INVITEE_ID, 'accepted');
    const events = participantRepo.getAcceptedEventIds(INVITEE_ID);
    expect(events).toContain(eventId);
  });

  test('getAcceptedByUser excludes declined', () => {
    participantRepo.add(eventId, INVITEE_ID, 'declined');
    const events = participantRepo.getAcceptedEventIds(INVITEE_ID);
    expect(events).not.toContain(eventId);
  });

  test('updateStatus changes status', () => {
    participantRepo.add(eventId, INVITEE_ID, 'accepted');
    participantRepo.updateStatus(eventId, INVITEE_ID, 'declined');
    const p = participantRepo.findByEventAndUser(eventId, INVITEE_ID);
    expect(p!.status).toBe('declined');
  });

  test('delete removes participant', () => {
    participantRepo.add(eventId, INVITEE_ID, 'accepted');
    participantRepo.delete(eventId, INVITEE_ID);
    expect(participantRepo.findByEventAndUser(eventId, INVITEE_ID)).toBeNull();
  });

  test('cascade: deleting event removes participants', () => {
    participantRepo.add(eventId, INVITEE_ID, 'accepted');
    eventRepo.delete(eventId, CREATOR_ID);
    expect(participantRepo.getByEvent(eventId)).toHaveLength(0);
  });

  test('unique constraint: cannot add same user twice', () => {
    participantRepo.add(eventId, INVITEE_ID, 'accepted');
    expect(() => participantRepo.add(eventId, INVITEE_ID, 'pending')).toThrow();
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `bun test test/database/repositories/participant.repository.test.ts`
Expected: FAIL — ParticipantRepository doesn't exist

- [ ] **Step 3: Implement migration + types + repository**

Migration 014 in `src/database/migrations.ts`:
```typescript
{
  name: '014_event_participants',
  up: (db) => {
    db.exec(`
      CREATE TABLE event_participants (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id  INTEGER NOT NULL,
        user_id   INTEGER NOT NULL,
        status    TEXT NOT NULL DEFAULT 'pending',
        role      TEXT NOT NULL DEFAULT 'attendee',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(event_id, user_id),
        FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_participants_user_status ON event_participants(user_id, status);
      CREATE INDEX idx_participants_event ON event_participants(event_id);
    `);
  },
},
```

Types in `src/database/types.ts`:
```typescript
export type ParticipantStatus = 'pending' | 'accepted' | 'declined' | 'maybe';
export type ParticipantRole = 'organizer' | 'attendee';

export interface EventParticipant {
  id: number;
  event_id: number;
  user_id: number;
  status: ParticipantStatus;
  role: ParticipantRole;
  created_at: string;
  updated_at: string;
}
```

Repository `src/database/repositories/participant.repository.ts`:
```typescript
import type { Database } from 'bun:sqlite';
import type { EventParticipant, ParticipantRole, ParticipantStatus } from '../types.ts';

export class ParticipantRepository {
  constructor(private db: Database) {}

  add(eventId: number, userId: number, status: ParticipantStatus, role: ParticipantRole = 'attendee'): EventParticipant {
    this.db
      .prepare('INSERT INTO event_participants (event_id, user_id, status, role) VALUES (?, ?, ?, ?)')
      .run(eventId, userId, status, role);
    return this.findByEventAndUser(eventId, userId)!;
  }

  findByEventAndUser(eventId: number, userId: number): EventParticipant | null {
    return this.db
      .prepare('SELECT * FROM event_participants WHERE event_id = ? AND user_id = ?')
      .get(eventId, userId) as EventParticipant | null;
  }

  getByEvent(eventId: number): EventParticipant[] {
    return this.db
      .prepare('SELECT * FROM event_participants WHERE event_id = ?')
      .all(eventId) as EventParticipant[];
  }

  getAcceptedEventIds(userId: number): number[] {
    const rows = this.db
      .prepare("SELECT event_id FROM event_participants WHERE user_id = ? AND status = 'accepted'")
      .all(userId) as { event_id: number }[];
    return rows.map(r => r.event_id);
  }

  updateStatus(eventId: number, userId: number, status: ParticipantStatus): void {
    this.db
      .prepare("UPDATE event_participants SET status = ?, updated_at = datetime('now') WHERE event_id = ? AND user_id = ?")
      .run(status, eventId, userId);
  }

  delete(eventId: number, userId: number): void {
    this.db
      .prepare('DELETE FROM event_participants WHERE event_id = ? AND user_id = ?')
      .run(eventId, userId);
  }
}
```

Wire in `src/database/index.ts`: add `participants: new ParticipantRepository(db)`.

- [ ] **Step 4: Run test — verify it passes**
- [ ] **Step 5: Commit**

```bash
git commit -m "feat(sharing): event_participants table + repository (migration 014)"
```

---

### Task 2: Event repository — visible events queries (owned + participated)

**Files:**
- Modify: `src/database/repositories/event.repository.ts`
- Create: `test/services/sharing/shared-events.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// test/services/sharing/shared-events.test.ts
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { ParticipantRepository } from '../../../src/database/repositories/participant.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';

const CREATOR = 100;
const INVITEE = 200;

function createTestDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

describe('visible events (owned + participated)', () => {
  let db: Database;
  let eventRepo: EventRepository;
  let participantRepo: ParticipantRepository;

  beforeEach(() => {
    db = createTestDb();
    const userRepo = new UserRepository(db);
    eventRepo = new EventRepository(db);
    participantRepo = new ParticipantRepository(db);
    userRepo.create({ telegram_id: CREATOR, timezone: 'UTC' });
    userRepo.create({ telegram_id: INVITEE, timezone: 'UTC' });
  });

  test('getVisibleInRange returns own events', () => {
    eventRepo.create({
      user_id: INVITEE, title: 'My Event',
      start_at: '2026-03-20T10:00:00Z', timezone: 'UTC',
    });
    const events = eventRepo.getVisibleInRange(INVITEE, '2026-03-20', '2026-03-21');
    expect(events).toHaveLength(1);
    expect(events[0].title).toBe('My Event');
  });

  test('getVisibleInRange returns accepted participated events', () => {
    const event = eventRepo.create({
      user_id: CREATOR, title: 'Shared Meeting',
      start_at: '2026-03-20T10:00:00Z', timezone: 'UTC',
    });
    participantRepo.add(event.id, INVITEE, 'accepted');

    const events = eventRepo.getVisibleInRange(INVITEE, '2026-03-20', '2026-03-21');
    expect(events).toHaveLength(1);
    expect(events[0].title).toBe('Shared Meeting');
  });

  test('getVisibleInRange excludes declined participated events', () => {
    const event = eventRepo.create({
      user_id: CREATOR, title: 'Declined',
      start_at: '2026-03-20T10:00:00Z', timezone: 'UTC',
    });
    participantRepo.add(event.id, INVITEE, 'declined');

    const events = eventRepo.getVisibleInRange(INVITEE, '2026-03-20', '2026-03-21');
    expect(events).toHaveLength(0);
  });

  test('getVisibleInRange does not duplicate if user is both owner and participant', () => {
    const event = eventRepo.create({
      user_id: CREATOR, title: 'Own',
      start_at: '2026-03-20T10:00:00Z', timezone: 'UTC',
    });
    participantRepo.add(event.id, CREATOR, 'accepted', 'organizer');

    const events = eventRepo.getVisibleInRange(CREATOR, '2026-03-20', '2026-03-21');
    expect(events).toHaveLength(1);
  });

  test('getVisibleInRange shows mix of own and shared events', () => {
    eventRepo.create({
      user_id: INVITEE, title: 'Own Event',
      start_at: '2026-03-20T09:00:00Z', timezone: 'UTC',
    });
    const shared = eventRepo.create({
      user_id: CREATOR, title: 'Shared Event',
      start_at: '2026-03-20T14:00:00Z', timezone: 'UTC',
    });
    participantRepo.add(shared.id, INVITEE, 'accepted');

    const events = eventRepo.getVisibleInRange(INVITEE, '2026-03-20', '2026-03-21');
    expect(events).toHaveLength(2);
    expect(events.map(e => e.title).sort()).toEqual(['Own Event', 'Shared Event']);
  });

  test('isParticipant returns true for participated event', () => {
    const event = eventRepo.create({
      user_id: CREATOR, title: 'Shared',
      start_at: '2026-03-20T10:00:00Z', timezone: 'UTC',
    });
    participantRepo.add(event.id, INVITEE, 'accepted');
    expect(eventRepo.isParticipant(event.id, INVITEE)).toBe(true);
  });

  test('isParticipant returns false for non-participant', () => {
    const event = eventRepo.create({
      user_id: CREATOR, title: 'Private',
      start_at: '2026-03-20T10:00:00Z', timezone: 'UTC',
    });
    expect(eventRepo.isParticipant(event.id, INVITEE)).toBe(false);
  });
});
```

- [ ] **Step 2: Run — verify fails**

- [ ] **Step 3: Implement visible event queries**

Add to `EventRepository`:
```typescript
getVisibleInRange(userId: number, startDate: string, endDate: string): CalendarEvent[] {
  return this.db.prepare(`
    SELECT DISTINCT e.* FROM events e
    WHERE e.start_at >= ? AND e.start_at < ?
      AND e.recurrence_rule IS NULL
      AND (
        e.user_id = ?
        OR e.id IN (
          SELECT event_id FROM event_participants
          WHERE user_id = ? AND status = 'accepted'
        )
      )
    ORDER BY e.start_at
  `).all(startDate, endDate, userId, userId) as CalendarEvent[];
}

isParticipant(eventId: number, userId: number): boolean {
  const row = this.db
    .prepare("SELECT 1 FROM event_participants WHERE event_id = ? AND user_id = ? AND status = 'accepted'")
    .get(eventId, userId);
  return row != null;
}
```

- [ ] **Step 4: Run — verify passes**
- [ ] **Step 5: Commit**

```bash
git commit -m "feat(sharing): getVisibleInRange query — owned + participated events"
```

---

### Task 3: Accept invitation adds participant row

**Files:**
- Modify: `src/services/sharing/invitation-service.ts`
- Test: `test/services/sharing/shared-events.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
describe('acceptInvitation — adds participant', () => {
  // ... setup with invitationService, participantRepo, eventRepo, etc.

  test('accepting adds participant with accepted status', () => {
    const event = eventService.createEvent({
      user_id: CREATOR, title: 'Party',
      start_at: '2026-03-20T18:00:00Z', timezone: 'UTC',
    });
    const inv = invitationRepo.create({
      event_id: event.id, inviter_id: CREATOR, invitee_id: INVITEE,
    });
    invitationService.acceptInvitation(inv.id, INVITEE);

    const participant = participantRepo.findByEventAndUser(event.id, INVITEE);
    expect(participant).not.toBeNull();
    expect(participant!.status).toBe('accepted');
    expect(participant!.role).toBe('attendee');
  });

  test('accepting twice does not create duplicate participant', () => {
    const event = eventService.createEvent({
      user_id: CREATOR, title: 'Party',
      start_at: '2026-03-20T18:00:00Z', timezone: 'UTC',
    });
    const inv = invitationRepo.create({
      event_id: event.id, inviter_id: CREATOR, invitee_id: INVITEE,
    });
    invitationService.acceptInvitation(inv.id, INVITEE);

    const participants = participantRepo.getByEvent(event.id);
    expect(participants).toHaveLength(1);
  });

  test('declining does not add participant', () => {
    const event = eventService.createEvent({
      user_id: CREATOR, title: 'Skip',
      start_at: '2026-03-20T18:00:00Z', timezone: 'UTC',
    });
    const inv = invitationRepo.create({
      event_id: event.id, inviter_id: CREATOR, invitee_id: INVITEE,
    });
    invitationService.declineInvitation(inv.id, INVITEE);

    expect(participantRepo.findByEventAndUser(event.id, INVITEE)).toBeNull();
  });

  test('maybe adds participant with maybe status', () => {
    const event = eventService.createEvent({
      user_id: CREATOR, title: 'Maybe',
      start_at: '2026-03-20T18:00:00Z', timezone: 'UTC',
    });
    const inv = invitationRepo.create({
      event_id: event.id, inviter_id: CREATOR, invitee_id: INVITEE,
    });
    invitationService.maybeInvitation(inv.id, INVITEE);

    const participant = participantRepo.findByEventAndUser(event.id, INVITEE);
    expect(participant).not.toBeNull();
    expect(participant!.status).toBe('maybe');
  });

  test('accepted event appears in invitee calendar', () => {
    const event = eventService.createEvent({
      user_id: CREATOR, title: 'Visible Meeting',
      start_at: '2026-03-20T10:00:00Z', timezone: 'UTC',
    });
    const inv = invitationRepo.create({
      event_id: event.id, inviter_id: CREATOR, invitee_id: INVITEE,
    });
    invitationService.acceptInvitation(inv.id, INVITEE);

    const visible = eventRepo.getVisibleInRange(INVITEE, '2026-03-20', '2026-03-21');
    expect(visible).toHaveLength(1);
    expect(visible[0].title).toBe('Visible Meeting');
    expect(visible[0].user_id).toBe(CREATOR); // owned by creator, not invitee
  });
});
```

- [ ] **Step 2: Run — verify fails**
- [ ] **Step 3: Implement — inject ParticipantRepository into InvitationService**

In `InvitationService` constructor, add optional `participantRepo?: ParticipantRepository`.

In `acceptInvitation`, after status update:
```typescript
if (this.participantRepo) {
  const existing = this.participantRepo.findByEventAndUser(invitation.event_id, userId);
  if (!existing) {
    this.participantRepo.add(invitation.event_id, userId, 'accepted');
  } else {
    this.participantRepo.updateStatus(invitation.event_id, userId, 'accepted');
  }
}
```

In `maybeInvitation`, similar with status 'maybe'.

In `declineInvitation`, update participant to 'declined' if exists:
```typescript
if (this.participantRepo) {
  const existing = this.participantRepo.findByEventAndUser(invitation.event_id, userId);
  if (existing) {
    this.participantRepo.updateStatus(invitation.event_id, userId, 'declined');
  }
}
```

- [ ] **Step 4: Run — verify passes**
- [ ] **Step 5: Commit**

```bash
git commit -m "feat(sharing): acceptInvitation adds event_participant row"
```

---

### Task 4: Time conflict detection

**Files:**
- Create: `src/services/event/conflict-checker.ts`
- Create: `test/services/event/conflict-checker.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// test/services/event/conflict-checker.test.ts
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { ParticipantRepository } from '../../../src/database/repositories/participant.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import { ReminderRepository } from '../../../src/database/repositories/reminder.repository.ts';
import { checkConflicts } from '../../../src/services/event/conflict-checker.ts';

const USER = 200;

describe('checkConflicts', () => {
  let db: Database;
  let eventRepo: EventRepository;
  let eventService: EventService;

  beforeEach(() => {
    db = createTestDb();
    new UserRepository(db).create({ telegram_id: USER, timezone: 'UTC' });
    eventRepo = new EventRepository(db);
    eventService = new EventService(eventRepo, new ReminderRepository(db));
  });

  test('detects overlapping event', () => {
    eventService.createEvent({
      user_id: USER, title: 'Existing',
      start_at: '2026-03-20T10:00:00Z', end_at: '2026-03-20T11:00:00Z', timezone: 'UTC',
    });
    const conflicts = checkConflicts(eventRepo, USER, '2026-03-20T10:30:00Z', '2026-03-20T11:30:00Z');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].title).toBe('Existing');
  });

  test('no conflict when times adjacent (end = start)', () => {
    eventService.createEvent({
      user_id: USER, title: 'Before',
      start_at: '2026-03-20T09:00:00Z', end_at: '2026-03-20T10:00:00Z', timezone: 'UTC',
    });
    const conflicts = checkConflicts(eventRepo, USER, '2026-03-20T10:00:00Z', '2026-03-20T11:00:00Z');
    expect(conflicts).toHaveLength(0);
  });

  test('no conflict with all-day events', () => {
    eventService.createEvent({
      user_id: USER, title: 'Holiday', start_at: '2026-03-20', all_day: true, timezone: 'UTC',
    });
    const conflicts = checkConflicts(eventRepo, USER, '2026-03-20T10:00:00Z', '2026-03-20T11:00:00Z');
    expect(conflicts).toHaveLength(0);
  });

  test('conflict with point event (no end_at, 30min default)', () => {
    eventService.createEvent({
      user_id: USER, title: 'Call', start_at: '2026-03-20T10:30:00Z', timezone: 'UTC',
    });
    const conflicts = checkConflicts(eventRepo, USER, '2026-03-20T10:00:00Z', '2026-03-20T11:00:00Z');
    expect(conflicts).toHaveLength(1);
  });

  test('excludes specific event by id', () => {
    const event = eventService.createEvent({
      user_id: USER, title: 'Self',
      start_at: '2026-03-20T10:00:00Z', end_at: '2026-03-20T11:00:00Z', timezone: 'UTC',
    });
    const conflicts = checkConflicts(eventRepo, USER, '2026-03-20T10:00:00Z', '2026-03-20T11:00:00Z', event.id);
    expect(conflicts).toHaveLength(0);
  });

  test('detects conflicts with participated events', () => {
    const participantRepo = new ParticipantRepository(db);
    const creatorId = 100;
    new UserRepository(db).create({ telegram_id: creatorId, timezone: 'UTC' });
    const shared = eventService.createEvent({
      user_id: creatorId, title: 'Shared Meeting',
      start_at: '2026-03-20T10:00:00Z', end_at: '2026-03-20T11:00:00Z', timezone: 'UTC',
    });
    participantRepo.add(shared.id, USER, 'accepted');

    const conflicts = checkConflicts(eventRepo, USER, '2026-03-20T10:30:00Z', '2026-03-20T11:30:00Z');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].title).toBe('Shared Meeting');
  });
});
```

- [ ] **Step 2: Run — verify fails**
- [ ] **Step 3: Implement conflict checker**

```typescript
// src/services/event/conflict-checker.ts
import type { EventRepository } from '../../database/repositories/event.repository.ts';
import type { CalendarEvent } from '../../database/types.ts';

export function checkConflicts(
  eventRepo: EventRepository,
  userId: number,
  startAt: string,
  endAt?: string | null,
  excludeEventId?: number,
): CalendarEvent[] {
  const effectiveEnd = endAt ?? new Date(new Date(startAt).getTime() + 30 * 60_000).toISOString();
  return eventRepo.findVisibleOverlapping(userId, startAt, effectiveEnd, excludeEventId);
}
```

Add `findVisibleOverlapping` to EventRepository:
```sql
SELECT DISTINCT e.* FROM events e
WHERE e.all_day = 0
  AND COALESCE(e.id, 0) != ?
  AND e.start_at < ?
  AND COALESCE(e.end_at, strftime('%Y-%m-%dT%H:%M:%SZ', e.start_at, '+30 minutes')) > ?
  AND (
    e.user_id = ?
    OR e.id IN (SELECT event_id FROM event_participants WHERE user_id = ? AND status = 'accepted')
  )
```

- [ ] **Step 4: Run — verify passes**
- [ ] **Step 5: Commit**

```bash
git commit -m "feat(sharing): time conflict detection for owned + participated events"
```

---

### Task 5: Conflict warning on invitation accept

**Files:**
- Modify: `src/services/sharing/invitation-service.ts`
- Modify: `src/bot/handlers/callback.handler.ts`
- Test: `test/services/sharing/shared-events.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
describe('accept with conflict warning', () => {
  test('acceptInvitation returns conflicts when time overlaps', () => {
    eventService.createEvent({
      user_id: INVITEE, title: 'Existing Meeting',
      start_at: '2026-03-20T10:00:00Z', end_at: '2026-03-20T11:00:00Z', timezone: 'UTC',
    });
    const event = eventService.createEvent({
      user_id: CREATOR, title: 'New Meeting',
      start_at: '2026-03-20T10:30:00Z', end_at: '2026-03-20T11:30:00Z', timezone: 'UTC',
    });
    const inv = invitationRepo.create({
      event_id: event.id, inviter_id: CREATOR, invitee_id: INVITEE,
    });
    const result = invitationService.acceptInvitation(inv.id, INVITEE);
    expect(result.success).toBe(true);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts![0].title).toBe('Existing Meeting');
  });

  test('acceptInvitation returns empty conflicts when no overlap', () => {
    const event = eventService.createEvent({
      user_id: CREATOR, title: 'Free Slot',
      start_at: '2026-03-20T15:00:00Z', timezone: 'UTC',
    });
    const inv = invitationRepo.create({
      event_id: event.id, inviter_id: CREATOR, invitee_id: INVITEE,
    });
    const result = invitationService.acceptInvitation(inv.id, INVITEE);
    expect(result.success).toBe(true);
    expect(result.conflicts ?? []).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run — verify fails**
- [ ] **Step 3: Implement**

Add `conflicts?: CalendarEvent[]` to `InvitationResult` type.
In `acceptInvitation`, after adding participant, check conflicts:
```typescript
const sourceEvent = this.eventRepo.findById(invitation.event_id, invitation.inviter_id);
const conflicts = sourceEvent
  ? checkConflicts(this.eventRepo, userId, sourceEvent.start_at, sourceEvent.end_at, sourceEvent.id)
  : [];
return { success: true, invitation: updated, conflicts };
```

In callback handler, if `result.conflicts?.length`, append warning to response:
```typescript
if (result.conflicts?.length) {
  const conflictNames = result.conflicts.map(c => c.title).join(', ');
  editText += `\n\n⚠️ ${lang === 'ru' ? 'Конфликт' : 'Conflict'}: ${conflictNames}`;
}
```

- [ ] **Step 4: Run — verify passes**
- [ ] **Step 5: Commit**

```bash
git commit -m "feat(sharing): time conflict warning on invitation accept"
```

---

### Task 6: Calendar views show participated events

**Files:**
- Modify: `src/services/event/event-service.ts`
- Modify: `src/bot/commands/today.ts`
- Modify: `src/bot/commands/tomorrow.ts`
- Modify: `src/bot/commands/week.ts`
- Test: `test/services/sharing/shared-events.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
describe('calendar views include participated events', () => {
  test('getEventsForDay returns participated events', () => {
    const event = eventService.createEvent({
      user_id: CREATOR, title: 'Team Standup',
      start_at: '2026-03-20T10:00:00Z', timezone: 'UTC',
    });
    participantRepo.add(event.id, INVITEE, 'accepted');

    const day = eventService.getEventsForDay(INVITEE, '2026-03-20', 'UTC');
    expect(day.some(occ => occ.event.title === 'Team Standup')).toBe(true);
  });

  test('getEventsForDay excludes declined participated events', () => {
    const event = eventService.createEvent({
      user_id: CREATOR, title: 'Declined',
      start_at: '2026-03-20T10:00:00Z', timezone: 'UTC',
    });
    participantRepo.add(event.id, INVITEE, 'declined');

    const day = eventService.getEventsForDay(INVITEE, '2026-03-20', 'UTC');
    expect(day.some(occ => occ.event.title === 'Declined')).toBe(false);
  });

  test('getUpcoming returns participated events', () => {
    const event = eventService.createEvent({
      user_id: CREATOR, title: 'Future Sync',
      start_at: new Date(Date.now() + 86400000).toISOString(), timezone: 'UTC',
    });
    participantRepo.add(event.id, INVITEE, 'accepted');

    const upcoming = eventService.getUpcoming(INVITEE, 20, 'UTC');
    expect(upcoming.some(occ => occ.event.title === 'Future Sync')).toBe(true);
  });
});
```

- [ ] **Step 2: Run — verify fails**
- [ ] **Step 3: Implement — switch EventService internal queries to visible variants**

In `getEventsForDay`, `getEventsForWeek`, `getEventsInRange`, `getUpcoming`, `searchEvents`:
replace `this.eventRepo.getInRange(userId, ...)` with `this.eventRepo.getVisibleInRange(userId, ...)`.

Same for recurring templates: add `getVisibleRecurringTemplates(userId)` that includes templates from participated events.

Calendar commands (today/tomorrow/week) don't need changes — they call EventService which now returns visible events.

- [ ] **Step 4: Run — verify passes**
- [ ] **Step 5: Commit**

```bash
git commit -m "feat(sharing): calendar views show participated events"
```

---

### Task 7: Invitee deletes shared event = decline

**Files:**
- Modify: `src/services/ai/tool-handlers/event.ts`
- Modify: `src/services/event/event-service.ts`
- Test: `test/services/sharing/shared-events.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
describe('invitee deletes shared event', () => {
  test('AI delete_event on participated event declines instead of deleting', () => {
    const event = eventService.createEvent({
      user_id: CREATOR, title: 'Shared',
      start_at: '2026-03-20T10:00:00Z', timezone: 'UTC',
    });
    const inv = invitationRepo.create({
      event_id: event.id, inviter_id: CREATOR, invitee_id: INVITEE,
    });
    invitationService.acceptInvitation(inv.id, INVITEE);

    // Invitee tries to delete
    const result = handleDeleteEvent(inviteeCtx, { event_id: event.id });
    expect(result.success).toBe(true);
    expect(result.output).toContain('declined');

    // Event still exists for creator
    expect(eventService.getEvent(event.id, CREATOR)).not.toBeNull();

    // Participant status changed to declined
    const participant = participantRepo.findByEventAndUser(event.id, INVITEE);
    expect(participant!.status).toBe('declined');

    // No longer visible to invitee
    const visible = eventRepo.getVisibleInRange(INVITEE, '2026-03-20', '2026-03-21');
    expect(visible).toHaveLength(0);
  });

  test('creator can still delete their own event normally', () => {
    const event = eventService.createEvent({
      user_id: CREATOR, title: 'Mine',
      start_at: '2026-03-20T10:00:00Z', timezone: 'UTC',
    });
    participantRepo.add(event.id, INVITEE, 'accepted');

    const result = handleDeleteEvent(creatorCtx, { event_id: event.id });
    expect(result.success).toBe(true);
    // Event deleted, participants cascade-deleted
    expect(eventService.getEvent(event.id, CREATOR)).toBeNull();
  });
});
```

- [ ] **Step 2: Run — verify fails**
- [ ] **Step 3: Implement**

In `handleDeleteEvent` (event tool handler), before deleting:
```typescript
const event = ctx.eventService.getEvent(input.event_id, ctx.user.telegram_id);
if (!event) {
  // Check if user is a participant (not owner)
  if (ctx.participantRepo?.isParticipant(input.event_id, ctx.user.telegram_id)) {
    ctx.participantRepo.updateStatus(input.event_id, ctx.user.telegram_id, 'declined');
    return { success: true, output: 'You have declined this shared event. It has been removed from your calendar.' };
  }
  return { success: false, error: 'Event not found.' };
}
// ... normal delete for owner
```

- [ ] **Step 4: Run — verify passes**
- [ ] **Step 5: Commit**

```bash
git commit -m "feat(sharing): invitee delete_event = decline invitation"
```

---

### Task 8: Creator delete notifies participants

**Files:**
- Modify: `src/services/event/event-service.ts`
- Test: `test/services/sharing/shared-events.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
describe('creator delete notifies participants', () => {
  test('deleting event with participants triggers notification callback', () => {
    const notifications: { userId: number; text: string }[] = [];
    const eventServiceWithNotify = new EventService(eventRepo, reminderRepo, {
      onParticipantsNotify: (userIds, text) => {
        for (const uid of userIds) notifications.push({ userId: uid, text });
      },
    });
    const event = eventServiceWithNotify.createEvent({
      user_id: CREATOR, title: 'Cancelled',
      start_at: '2026-03-20T10:00:00Z', timezone: 'UTC',
    });
    participantRepo.add(event.id, INVITEE, 'accepted');

    eventServiceWithNotify.deleteEvent(event.id, CREATOR);

    expect(notifications).toHaveLength(1);
    expect(notifications[0].userId).toBe(INVITEE);
    expect(notifications[0].text).toContain('Cancelled');
  });
});
```

- [ ] **Step 2-4: Implement + verify**

Add `onParticipantsNotify?: (userIds: number[], text: string) => void` callback to EventService options. In `deleteEvent`, before deletion, get participants and notify:
```typescript
const participants = this.participantRepo?.getByEvent(eventId) ?? [];
const acceptedIds = participants.filter(p => p.status === 'accepted').map(p => p.user_id);
if (acceptedIds.length && this.onParticipantsNotify) {
  this.onParticipantsNotify(acceptedIds, `❌ Event "${event.title}" has been cancelled by the organizer.`);
}
```

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(sharing): notify participants when creator deletes event"
```

---

### Task 9: Creator edit notifies participants

**Files:**
- Modify: `src/services/event/event-service.ts`
- Test: `test/services/sharing/shared-events.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
describe('creator edit notifies participants', () => {
  test('changing time notifies accepted participants', () => {
    const notifications: { userId: number; text: string }[] = [];
    // ... setup with onParticipantsNotify callback
    const event = eventService.createEvent({ ... });
    participantRepo.add(event.id, INVITEE, 'accepted');

    eventService.updateEvent(event.id, CREATOR, { start_at: '2026-03-20T15:00:00Z' });

    expect(notifications).toHaveLength(1);
    expect(notifications[0].text).toContain('rescheduled');
  });

  test('changing title notifies participants', () => { ... });

  test('no notification for non-shared event edit', () => {
    // Event with no participants → no notifications
    eventService.updateEvent(event.id, CREATOR, { title: 'New' });
    expect(notifications).toHaveLength(0);
  });

  test('changing description does not trigger time-change notification', () => {
    // Only time/title/location changes trigger notification
  });
});
```

- [ ] **Step 2-4: Implement + verify**

In `updateEvent`, after applying update, if participants exist and significant fields changed (title, start_at, end_at, location):
```typescript
const participants = this.participantRepo?.getByEvent(eventId) ?? [];
const acceptedIds = participants.filter(p => p.status === 'accepted').map(p => p.user_id);
if (acceptedIds.length && this.onParticipantsNotify && hasSignificantChanges(patch)) {
  this.onParticipantsNotify(acceptedIds, `📅 Event "${event.title}" has been updated by the organizer.`);
}
```

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(sharing): notify participants on significant event edits"
```

---

### Task 10: Edit proposal — invitee proposes changes to creator

**Files:**
- Modify: `src/database/migrations.ts` — migration 015: edit_proposals table
- Modify: `src/database/types.ts` — EditProposal interface
- Modify: `src/services/ai/tools.ts` — propose_edit tool
- Modify: `src/services/ai/tool-handlers/sharing.ts` — handler
- Modify: `src/services/ai/tool-executor.ts` — route
- Modify: `src/config/constants.ts` — EDIT_PROPOSAL callback + i18n
- Modify: `src/bot/handlers/callback.handler.ts` — accept/reject proposal
- Test: `test/services/sharing/shared-events.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
describe('edit proposals', () => {
  test('propose_edit on participated event stores proposal', () => {
    // Invitee calls propose_edit with {start_at: '...'}
    // Proposal stored in edit_proposals table
    // Returns success
  });

  test('propose_edit on own event returns error', () => {
    // Not a participant → error
  });

  test('propose_edit on non-participant event returns error', () => {
    // Not owner, not participant → error
  });

  test('creator accepting proposal applies changes', () => {
    // Creator clicks Accept on proposal callback
    // Source event updated
    // All participants notified
  });

  test('creator rejecting proposal notifies proposer', () => {
    // Creator clicks Reject
    // Proposer gets notification that proposal was rejected
  });
});
```

- [ ] **Step 2-4: Implement**

Migration 015:
```sql
CREATE TABLE edit_proposals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    INTEGER NOT NULL,
  proposer_id INTEGER NOT NULL,
  changes     TEXT NOT NULL,  -- JSON
  reason      TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);
```

Tool handler: verify user is participant → store proposal → send message to creator with Accept/Reject InlineKeyboard (`ep:accept:{id}` / `ep:reject:{id}`).

Callback handler: on accept → apply changes via eventService.updateEvent → notify all participants. On reject → notify proposer.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(sharing): edit proposals — invitee proposes, creator accepts/rejects"
```

---

### Task 11: AI system prompt + tool updates

**Files:**
- Modify: `src/services/ai/system-prompt.ts`
- Modify: `src/services/ai/tools.ts` — update delete_event description

- [ ] **Step 1: Update system prompt**

Add:
```
- Shared events: when the user accepted an invitation, the event appears in their calendar.
  If they ask to delete it, this declines the invitation (removes from their calendar only).
  If they ask to edit it, use propose_edit tool — changes go to the event creator for approval.
- When creating events with participants, mention the event will appear in their calendar after they accept.
```

Update `delete_event` tool description:
```
Delete an event. If the event was received via invitation (shared), this declines the invitation and removes it from your calendar only — the original event is not affected.
```

- [ ] **Step 2: Commit**

```bash
git commit -m "feat(sharing): AI system prompt for shared events behavior"
```

---

### Task 12: Integration test — full flow

**Files:**
- Test: `test/services/sharing/shared-events.test.ts`

- [ ] **Step 1: Write integration test**

```typescript
describe('full shared event lifecycle', () => {
  test('create → invite → accept → appears in calendar → creator edits → invitee sees update → invitee declines → gone', () => {
    // 1. Creator creates event
    const event = eventService.createEvent({
      user_id: CREATOR, title: 'Sprint Review',
      start_at: '2026-03-20T14:00:00Z', end_at: '2026-03-20T15:00:00Z',
      timezone: 'UTC', location: 'Room 42',
    });

    // 2. Invitation sent + accepted
    const inv = invitationRepo.create({ event_id: event.id, inviter_id: CREATOR, invitee_id: INVITEE });
    const acceptResult = invitationService.acceptInvitation(inv.id, INVITEE);
    expect(acceptResult.success).toBe(true);

    // 3. Event visible in invitee calendar
    let visible = eventRepo.getVisibleInRange(INVITEE, '2026-03-20', '2026-03-21');
    expect(visible).toHaveLength(1);
    expect(visible[0].title).toBe('Sprint Review');

    // 4. Creator reschedules
    eventService.updateEvent(event.id, CREATOR, { start_at: '2026-03-20T16:00:00Z' });

    // 5. Invitee sees updated time (same event, single source of truth)
    visible = eventRepo.getVisibleInRange(INVITEE, '2026-03-20', '2026-03-21');
    expect(visible[0].start_at).toBe('2026-03-20T16:00:00Z');

    // 6. Invitee declines (removes from their calendar)
    participantRepo.updateStatus(event.id, INVITEE, 'declined');
    visible = eventRepo.getVisibleInRange(INVITEE, '2026-03-20', '2026-03-21');
    expect(visible).toHaveLength(0);

    // 7. Original event untouched
    expect(eventService.getEvent(event.id, CREATOR)!.title).toBe('Sprint Review');
  });
});
```

- [ ] **Step 2-4: Run, fix any issues**
- [ ] **Step 5: Final commit**

```bash
git commit -m "test(sharing): integration test — full shared event lifecycle"
```

---

## Edge Cases Covered

| Case | Handling |
|------|----------|
| Maybe → Accept | Participant status updated, event becomes visible |
| Accept → Decline (via delete) | Participant status → declined, event hidden |
| Re-invite after decline | New invitation possible (declined doesn't block) |
| Pending invite, creator deletes event | CASCADE deletes invitation + participants |
| Invitee clicks Accept on stale message | invitationRepo.findById returns null → error |
| Creator is also participant (organizer) | DISTINCT in query prevents duplicates |
| Recurring event shared | Recurring template visible, occurrences expand normally |
| Time conflict at accept | Warning shown, not blocked (user decides) |
