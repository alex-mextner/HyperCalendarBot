# Sharing Cleanup: setInterval → BullMQ

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `setInterval` in `sharing-cleanup.ts` with a BullMQ repeating job so the cleanup runs on the same Redis-backed cron infrastructure as everything else.

**Architecture:** Extract the pure `tick` logic from `setupSharingCleanup` into a standalone `runSharingCleanup(deps)` function. Add `cron-sharing-cleanup` job type to `bot-tasks-queue.ts`. Remove `setInterval` / `SharingCleanupHandle` entirely. Update `index.ts` wiring.

**Prerequisite:** `src/worker/bot-tasks-queue.ts` must exist (created in the Secretary Access plan).

**Spec:** n/a — pure infrastructure migration, no behaviour change.

---

## File Map

| Action | Path | Purpose |
|--------|------|---------|
| Modify | `src/services/sharing/sharing-cleanup.ts` | Replace setInterval with pure `runSharingCleanup` export |
| Modify | `src/worker/bot-tasks-queue.ts` | Add `cron-sharing-cleanup` type + handler + setup fn |
| Modify | `src/index.ts` | Wire BullMQ cron, remove `sharingCleanup.stop()` |
| Modify | `test/services/sharing/sharing-cleanup.test.ts` | Adapt to pure function API |

---

## Task 1: Extract pure function + update tests

**Files:**
- Modify: `src/services/sharing/sharing-cleanup.ts`
- Modify: `test/services/sharing/sharing-cleanup.test.ts`

The `tick()` body already works correctly — we just lift it out and delete the `setInterval` wrapper.

- [ ] **Step 1: Update tests first**

Replace all occurrences of the `setupSharingCleanup` / `handle.tick()` pattern with a direct call to `runSharingCleanup`:

```typescript
// test/services/sharing/sharing-cleanup.test.ts
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations';
import { DeepLinkRepository } from '../../../src/database/repositories/deep-link.repository';
import { EventRepository } from '../../../src/database/repositories/event.repository';
import { InvitationRepository } from '../../../src/database/repositories/invitation.repository';
import { UserRepository } from '../../../src/database/repositories/user.repository';
import { runMigrations } from '../../../src/database/schema';
import { runSharingCleanup } from '../../../src/services/sharing/sharing-cleanup';

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

const USER_A = 100;
const USER_B = 200;

describe('runSharingCleanup', () => {
  test('expires past invitations', () => {
    const db = createTestDb();
    const users = new UserRepository(db);
    const events = new EventRepository(db);
    const invitations = new InvitationRepository(db);
    const deepLinks = new DeepLinkRepository(db);

    users.create({ telegram_id: USER_A });
    users.create({ telegram_id: USER_B });

    const event = events.create({
      user_id: USER_A,
      title: 'Past Event',
      start_at: '2020-01-01T10:00:00Z',
      end_at: '2020-01-01T11:00:00Z',
      timezone: 'UTC',
    });

    invitations.create({ event_id: event.id, inviter_id: USER_A, invitee_id: USER_B });

    const result = runSharingCleanup({ invitationRepo: invitations, deepLinkRepo: deepLinks });

    expect(result.expiredInvitations).toBe(1);
    expect(invitations.findById(1)!.status).toBe('expired');
  });

  test('deletes expired deep links', () => {
    const db = createTestDb();
    const users = new UserRepository(db);
    const invitations = new InvitationRepository(db);
    const deepLinks = new DeepLinkRepository(db);

    users.create({ telegram_id: USER_A });

    deepLinks.create({
      code: 's_expired1',
      type: 'shared_event',
      payload: '{"event_id":1}',
      created_by: USER_A,
      expires_at: '2020-01-01T00:00:00Z',
    });

    deepLinks.create({
      code: 's_valid1',
      type: 'shared_event',
      payload: '{"event_id":2}',
      created_by: USER_A,
      expires_at: '2099-01-01T00:00:00Z',
    });

    const result = runSharingCleanup({ invitationRepo: invitations, deepLinkRepo: deepLinks });

    expect(result.deletedDeepLinks).toBe(1);
    expect(deepLinks.findByCode('s_expired1')).toBeNull();
    expect(deepLinks.findByCode('s_valid1')).not.toBeNull();
  });

  test('returns zero counts when nothing to clean', () => {
    const db = createTestDb();
    const invitations = new InvitationRepository(db);
    const deepLinks = new DeepLinkRepository(db);

    const result = runSharingCleanup({ invitationRepo: invitations, deepLinkRepo: deepLinks });

    expect(result.expiredInvitations).toBe(0);
    expect(result.deletedDeepLinks).toBe(0);
    expect(result.cleanedSessions).toBe(0);
  });

  test('handles errors gracefully', () => {
    const db = createTestDb();
    const invitations = new InvitationRepository(db);
    const deepLinks = new DeepLinkRepository(db);

    db.close();

    const result = runSharingCleanup({ invitationRepo: invitations, deepLinkRepo: deepLinks });

    expect(result.expiredInvitations).toBe(0);
    expect(result.deletedDeepLinks).toBe(0);
    expect(result.cleanedSessions).toBe(0);
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

```bash
bun test test/services/sharing/sharing-cleanup.test.ts
```

Expected: `Cannot find module ... runSharingCleanup` (named export doesn't exist yet).

- [ ] **Step 3: Rewrite `sharing-cleanup.ts`**

Replace the entire file — keep the `SharingCleanupResult` type and the logic, remove `SharingCleanupHandle`, `setInterval`, `DEFAULT_INTERVAL_MS`:

```typescript
// src/services/sharing/sharing-cleanup.ts
import type { DeepLinkRepository } from '../../database/repositories/deep-link.repository.ts';
import type { InvitationRepository } from '../../database/repositories/invitation.repository.ts';
import { logger } from '../../utils/logger.ts';

const sharingLogger = logger.child({ module: 'sharing-cleanup' });

export interface SharingCleanupResult {
  expiredInvitations: number;
  deletedDeepLinks: number;
  cleanedSessions: number;
}

export function runSharingCleanup(deps: {
  invitationRepo: InvitationRepository;
  deepLinkRepo: DeepLinkRepository;
}): SharingCleanupResult {
  try {
    const expiredInvitations = deps.invitationRepo.expirePastInvitations();
    const deletedDeepLinks = deps.deepLinkRepo.deleteExpired();
    const cleanedSessions = 0;

    if (expiredInvitations > 0 || deletedDeepLinks > 0) {
      sharingLogger.info({ expiredInvitations, deletedDeepLinks, cleanedSessions }, 'Sharing cleanup completed');
    }

    return { expiredInvitations, deletedDeepLinks, cleanedSessions };
  } catch (error) {
    sharingLogger.error({ error: String(error) }, 'Sharing cleanup failed');
    return { expiredInvitations: 0, deletedDeepLinks: 0, cleanedSessions: 0 };
  }
}
```

- [ ] **Step 4: Run — verify PASS**

```bash
bun test test/services/sharing/sharing-cleanup.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/services/sharing/sharing-cleanup.ts test/services/sharing/sharing-cleanup.test.ts
git commit -m "refactor: extract runSharingCleanup as pure function, remove setInterval"
```

---

## Task 2: Add `cron-sharing-cleanup` to `bot-tasks-queue.ts`

**Files:**
- Modify: `src/worker/bot-tasks-queue.ts`

- [ ] **Step 1: Extend the queue**

Add `'cron-sharing-cleanup'` to `BotTaskJobType`, add `onSharingCleanup?` to deps, handle in worker, export setup function:

```typescript
// Additions to BotTaskJobType union:
| 'cron-sharing-cleanup'

// In BotTasksQueueDeps add:
onSharingCleanup?: () => void;

// In worker handler add:
if (job.data.type === 'cron-sharing-cleanup') {
  deps.onSharingCleanup?.();
  return;
}

// New export:
export async function setupSharingCleanupCron(queue: Queue<BotTaskJobData>): Promise<void> {
  await queue.add(
    'sharing-cleanup-tick',
    { type: 'cron-sharing-cleanup' },
    { repeat: { every: 10 * 60_000 }, removeOnComplete: true, jobId: 'sharing-cleanup-tick' },
  );
  botTasksLogger.info('Sharing cleanup cron scheduled (every 10min)');
}
```

- [ ] **Step 2: Run full test suite — no regressions**

```bash
bun test
```

- [ ] **Step 3: Commit**

```bash
git add src/worker/bot-tasks-queue.ts
git commit -m "feat: add cron-sharing-cleanup job type to bot-tasks queue"
```

---

## Task 3: Update `index.ts` wiring

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Replace `setupSharingCleanup` with BullMQ**

Remove:
```typescript
import { setupSharingCleanup } from './services/sharing/sharing-cleanup.ts';
// ...
const sharingCleanup = setupSharingCleanup(db.invitations, db.deepLinks);
```

Add `onSharingCleanup` to the existing `createBotTasksQueue` call:
```typescript
import { runSharingCleanup } from './services/sharing/sharing-cleanup.ts';
import { setupSharingCleanupCron } from './worker/bot-tasks-queue.ts';

// In createBotTasksQueue deps, add:
onSharingCleanup: () => runSharingCleanup({ invitationRepo: db.invitations, deepLinkRepo: db.deepLinks }),

// After queue creation:
await setupSharingCleanupCron(botTasksQueue);
```

Remove `sharingCleanup.stop()` from both `SIGINT` and `SIGTERM` handlers — the BullMQ worker closes via `botTasksQueue` worker close instead.

- [ ] **Step 2: Run full test suite**

```bash
bun test
```

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire sharing cleanup via BullMQ, remove setInterval"
```

---

## Done

All tasks complete when `bun test` passes with no failures and `bun run lint` reports zero warnings.
No `setInterval` remains in the sharing cleanup path.
