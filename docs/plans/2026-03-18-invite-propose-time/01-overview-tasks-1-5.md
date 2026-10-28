> Part 1 of 2 of [Invite: Propose Alternative Time — Implementation Plan](../2026-03-18-invite-propose-time.md) — next: [02-tasks-6-10.md](02-tasks-6-10.md)

## File Map

| File | Change |
|---|---|
| `src/database/migrations.ts` | Add migration 025: `ALTER TABLE invitations ADD COLUMN proposed_time TEXT` |
| `src/database/types.ts` | Add `proposed_time: string \| null` to `Invitation` |
| `src/database/repositories/invitation.repository.ts` | Add `setProposedTime()`, `clearProposedTime()` |
| `src/services/sharing/invitation-service.ts` | Add `proposeTime()`, `rescheduleFromProposal()`, `keepOriginalTime()` |
| `src/config/constants.ts` | Add 11 new i18n strings (EN + RU), including `invite_kept_inviter` |
| `src/bot/commands/invite.ts` | Add 4th "Другое время 🕐" button |
| `src/services/ai/telegram-sender.ts` | Add 4th button to AI-agent invite keyboard |
| `src/bot/commands/start.ts` | Add 4th button to deep-link invite keyboard |
| `src/utils/invite-time-format.ts` | New: `formatProposedTime(isoUtc, timezone, lang)` util (ESM, shared) |
| `src/bot/handlers/callback.handler.ts` | Handle `propose`, `reschedule`, `dismiss` sub-actions; add `proposeTimeSessions` param |
| `src/bot/handlers/message.handler.ts` | Add `proposeTimeSessions` + `editMessage` + `notifyInviterProposal` deps; handle propose time text input + inviter notification |
| `src/bot/index.ts` | Create `proposeTimeSessions` Map; wire into both handlers |
| `test/services/sharing/invitation-service.test.ts` | Tests for 3 new service methods |
| `test/bot/handlers/callback-invitation.test.ts` | Tests for propose/reschedule/dismiss callbacks |
| `test/bot/handlers/message-handler-propose-time.test.ts` | New test file for text input flow |

---

## Task 1: DB Migration + Types

**Files:**
- Modify: `src/database/migrations.ts`
- Modify: `src/database/types.ts`

- [ ] **Step 1: Write failing test**

```typescript
// test/database/migrations.test.ts — add inside existing describe or create new
test('migration 025 adds proposed_time column to invitations', () => {
  const db = new Database(':memory:');
  runMigrations(db, migrations);
  const cols = db.prepare("PRAGMA table_info(invitations)").all() as { name: string }[];
  expect(cols.some(c => c.name === 'proposed_time')).toBe(true);
});
```

- [ ] **Step 2: Run test — confirm FAIL**

```bash
cd .worktrees/propose-time && bun test test/database/migrations.test.ts 2>&1 | tail -20
```
Expected: test fails with "Expected true, got false"

- [ ] **Step 3: Add migration 025**

In `src/database/migrations.ts`, after migration `024_default_reminder_intervals`:

```typescript
  {
    name: '025_invite_proposed_time',
    up: (db) => {
      db.exec(`ALTER TABLE invitations ADD COLUMN proposed_time TEXT`);
    },
  },
```

- [ ] **Step 4: Add `proposed_time` to Invitation type**

In `src/database/types.ts`, inside the `Invitation` interface, add after `responded_at`:

```typescript
  proposed_time: string | null;
```

- [ ] **Step 5: Run test — confirm PASS**

```bash
bun test test/database/migrations.test.ts 2>&1 | tail -10
```

- [ ] **Step 6: Commit**

```bash
git add src/database/migrations.ts src/database/types.ts test/database/migrations.test.ts
git commit -m "feat(invitations): add proposed_time column (migration 025)"
```

---

## Task 2: Repository Methods

**Files:**
- Modify: `src/database/repositories/invitation.repository.ts`
- Test: `test/database/repositories/invitation-repository-propose.test.ts` (new)

- [ ] **Step 1: Write failing tests**

Create `test/database/repositories/invitation-repository-propose.test.ts`:

```typescript
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations';
import { EventRepository } from '../../../src/database/repositories/event.repository';
import { InvitationRepository } from '../../../src/database/repositories/invitation.repository';
import { UserRepository } from '../../../src/database/repositories/user.repository';
import { runMigrations } from '../../../src/database/schema';

function setup() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  const users = new UserRepository(db);
  users.create({ telegram_id: 100 });
  users.create({ telegram_id: 200 });
  const events = new EventRepository(db);
  const invRepo = new InvitationRepository(db);
  const event = events.create({ user_id: 100, title: 'Party', start_at: '2026-04-01T10:00:00Z', timezone: 'UTC' });
  const inv = invRepo.create({ event_id: event.id, inviter_id: 100, invitee_id: 200 });
  return { invRepo, inv };
}

describe('InvitationRepository.setProposedTime', () => {
  test('sets proposed_time on invitation', () => {
    const { invRepo, inv } = setup();
    invRepo.setProposedTime(inv.id, '2026-04-01T14:00:00Z');
    const updated = invRepo.findById(inv.id)!;
    expect(updated.proposed_time).toBe('2026-04-01T14:00:00Z');
  });

  test('clearProposedTime sets proposed_time to null', () => {
    const { invRepo, inv } = setup();
    invRepo.setProposedTime(inv.id, '2026-04-01T14:00:00Z');
    invRepo.clearProposedTime(inv.id);
    const updated = invRepo.findById(inv.id)!;
    expect(updated.proposed_time).toBeNull();
  });
});
```

- [ ] **Step 2: Run — confirm FAIL**

```bash
bun test test/database/repositories/invitation-repository-propose.test.ts 2>&1 | tail -20
```

Expected: TypeError — `setProposedTime is not a function`

- [ ] **Step 3: Add methods to repository**

In `src/database/repositories/invitation.repository.ts`, after `setMessageInfo()`:

```typescript
  setProposedTime(id: number, proposedTime: string): void {
    this.db.prepare('UPDATE invitations SET proposed_time = ?, updated_at = datetime(\'now\') WHERE id = ?').run(proposedTime, id);
  }

  clearProposedTime(id: number): void {
    this.db.prepare('UPDATE invitations SET proposed_time = NULL, updated_at = datetime(\'now\') WHERE id = ?').run(id);
  }
```

- [ ] **Step 4: Run — confirm PASS**

```bash
bun test test/database/repositories/invitation-repository-propose.test.ts 2>&1 | tail -10
```

- [ ] **Step 5: Commit**

```bash
git add src/database/repositories/invitation.repository.ts test/database/repositories/invitation-repository-propose.test.ts
git commit -m "feat(invitations): add setProposedTime and clearProposedTime to repository"
```

---

## Task 3: Service Methods

**Files:**
- Modify: `src/services/sharing/invitation-service.ts`
- Modify: `test/services/sharing/invitation-service.test.ts`

Three new methods:
- `proposeTime(invitationId, userId, proposedTime)` — invitee sets proposed time
- `rescheduleFromProposal(invitationId, userId)` — inviter accepts the proposal
- `keepOriginalTime(invitationId, userId)` — inviter dismisses the proposal

`InvitationResult` needs a new optional field: `proposedTime?: string`

- [ ] **Step 1: Write failing tests**

Append to `test/services/sharing/invitation-service.test.ts`:

```typescript
  describe('proposeTime', () => {
    test('sets proposed_time and returns success', () => {
      const { service, invRepo, event } = setup();
      const inv = service.sendInvitation(event.id, INVITER, INVITEE).invitation!;
      const result = service.proposeTime(inv.id, INVITEE, '2026-04-01T16:00:00Z');
      expect(result.success).toBe(true);
      const updated = invRepo.findById(inv.id)!;
      expect(updated.proposed_time).toBe('2026-04-01T16:00:00Z');
    });

    test('proposeTime rejects non-invitee', () => {
      const { service, event } = setup();
      const inv = service.sendInvitation(event.id, INVITER, INVITEE).invitation!;
      const result = service.proposeTime(inv.id, INVITER, '2026-04-01T16:00:00Z');
      expect(result.success).toBe(false);
      expect(result.error).toContain('authorized');
    });

    test('proposeTime rejects unknown invitation', () => {
      const { service } = setup();
      const result = service.proposeTime(9999, INVITEE, '2026-04-01T16:00:00Z');
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('rescheduleFromProposal', () => {
    test('clears proposed_time and returns proposedTime in result', () => {
      const { service, invRepo, event } = setup();
      const inv = service.sendInvitation(event.id, INVITER, INVITEE).invitation!;
      service.proposeTime(inv.id, INVITEE, '2026-04-01T16:00:00Z');
      const result = service.rescheduleFromProposal(inv.id, INVITER);
      expect(result.success).toBe(true);
      expect(result.proposedTime).toBe('2026-04-01T16:00:00Z');
      const updated = invRepo.findById(inv.id)!;
      expect(updated.proposed_time).toBeNull();
      expect(updated.status).toBe('accepted');
    });

    test('rescheduleFromProposal rejects non-inviter', () => {
      const { service, event } = setup();
      const inv = service.sendInvitation(event.id, INVITER, INVITEE).invitation!;
      service.proposeTime(inv.id, INVITEE, '2026-04-01T16:00:00Z');
      const result = service.rescheduleFromProposal(inv.id, INVITEE);
      expect(result.success).toBe(false);
    });

    test('rescheduleFromProposal rejects if no proposed_time', () => {
      const { service, event } = setup();
      const inv = service.sendInvitation(event.id, INVITER, INVITEE).invitation!;
      const result = service.rescheduleFromProposal(inv.id, INVITER);
      expect(result.success).toBe(false);
      expect(result.error).toContain('No proposed time');
    });
  });

  describe('keepOriginalTime', () => {
    test('clears proposed_time, invitation stays pending', () => {
      const { service, invRepo, event } = setup();
      const inv = service.sendInvitation(event.id, INVITER, INVITEE).invitation!;
      service.proposeTime(inv.id, INVITEE, '2026-04-01T16:00:00Z');
      const result = service.keepOriginalTime(inv.id, INVITER);
      expect(result.success).toBe(true);
      const updated = invRepo.findById(inv.id)!;
      expect(updated.proposed_time).toBeNull();
      expect(updated.status).toBe('pending');
    });

    test('keepOriginalTime rejects non-inviter', () => {
      const { service, event } = setup();
      const inv = service.sendInvitation(event.id, INVITER, INVITEE).invitation!;
      service.proposeTime(inv.id, INVITEE, '2026-04-01T16:00:00Z');
      const result = service.keepOriginalTime(inv.id, INVITEE);
      expect(result.success).toBe(false);
    });
  });
```

- [ ] **Step 2: Run — confirm FAIL**

```bash
bun test test/services/sharing/invitation-service.test.ts 2>&1 | tail -20
```
Expected: failures on proposeTime/rescheduleFromProposal/keepOriginalTime not being functions.

- [ ] **Step 3: Extend InvitationResult + implement methods**

In `src/services/sharing/invitation-service.ts`:

First, add `proposedTime?: string` to `InvitationResult`:
```typescript
export interface InvitationResult {
  success: boolean;
  invitation?: Invitation;
  error?: string;
  conflicts?: CalendarEvent[];
  proposedTime?: string;
}
```

Then add after `cancelInvitation()`:

```typescript
  proposeTime(invitationId: number, userId: number, proposedTime: string): InvitationResult {
    const invitation = this.invRepo.findById(invitationId);
    if (!invitation) {
      return { success: false, error: 'Invitation not found' };
    }
    if (invitation.invitee_id !== userId) {
      return { success: false, error: 'Not authorized to propose' };
    }
    this.invRepo.setProposedTime(invitationId, proposedTime);
    return { success: true, invitation: this.invRepo.findById(invitationId)! };
  }

  rescheduleFromProposal(invitationId: number, userId: number): InvitationResult {
    const invitation = this.invRepo.findById(invitationId);
    if (!invitation) {
      return { success: false, error: 'Invitation not found' };
    }
    if (invitation.inviter_id !== userId) {
      return { success: false, error: 'Not authorized to reschedule' };
    }
    if (!invitation.proposed_time) {
      return { success: false, error: 'No proposed time on this invitation' };
    }
    const proposedTime = invitation.proposed_time;
    this.invRepo.clearProposedTime(invitationId);
    const ok = this.invRepo.updateStatus(invitationId, 'accepted', invitation.status as InvitationStatus);
    if (!ok) {
      return { success: false, error: 'Cannot update status — already changed' };
    }
    return { success: true, invitation: this.invRepo.findById(invitationId)!, proposedTime };
  }

  keepOriginalTime(invitationId: number, userId: number): InvitationResult {
    const invitation = this.invRepo.findById(invitationId);
    if (!invitation) {
      return { success: false, error: 'Invitation not found' };
    }
    if (invitation.inviter_id !== userId) {
      return { success: false, error: 'Not authorized' };
    }
    this.invRepo.clearProposedTime(invitationId);
    return { success: true, invitation: this.invRepo.findById(invitationId)! };
  }
```

- [ ] **Step 4: Run — confirm PASS**

```bash
bun test test/services/sharing/invitation-service.test.ts 2>&1 | tail -10
```

- [ ] **Step 5: Commit**

```bash
git add src/services/sharing/invitation-service.ts test/services/sharing/invitation-service.test.ts
git commit -m "feat(invitations): add proposeTime, rescheduleFromProposal, keepOriginalTime to service"
```

---

## Task 4: i18n Strings

**Files:**
- Modify: `src/config/constants.ts`

- [ ] **Step 1: Add EN strings**

In `src/config/constants.ts`, inside the `en:` block, after `invitation_response_maybe`:

```typescript
    invite_propose_btn: 'Other time 🕐',
    invite_propose_ask: 'What time do you suggest?\nOr type: "tomorrow at 3pm"',
    invite_propose_plus30: '+30 min',
    invite_propose_plus60: '+1 hour',
    invite_propose_sent: (time: string) => `⏰ You suggested: ${time}`,
    invite_propose_notify: (name: string, event: string, time: string) =>
      `📅 ${name} suggests rescheduling <b>${event}</b> to ${time}`,
    invite_reschedule_btn: 'Reschedule 📅',
    invite_keep_btn: 'Keep original',
    invite_rescheduled_inviter: (time: string) => `✅ Event rescheduled to ${time}`,
    invite_rescheduled_invitee: (event: string, time: string) =>
      `✅ <b>${event}</b> rescheduled to ${time}. You are automatically accepted.`,
    invite_kept_inviter: '❌ Suggestion declined',
    invite_kept_invitee: (event: string, time: string) =>
      `❌ Your suggestion was declined. Event stays at ${time}.`,
```

- [ ] **Step 2: Add RU strings**

In `src/config/constants.ts`, inside the `ru:` block, after `invitation_response_maybe`:

```typescript
    invite_propose_btn: 'Другое время 🕐',
    invite_propose_ask: 'Какое время предлагаешь?\nИли напиши: "завтра в 15:00"',
    invite_propose_plus30: '+30 мин',
    invite_propose_plus60: '+1 час',
    invite_propose_sent: (time: string) => `⏰ Вы предложили: ${time}`,
    invite_propose_notify: (name: string, event: string, time: string) =>
      `📅 ${name} предлагает перенести <b>${event}</b> на ${time}`,
    invite_reschedule_btn: 'Перенести 📅',
    invite_keep_btn: 'Оставить как есть',
    invite_rescheduled_inviter: (time: string) => `✅ Событие перенесено на ${time}`,
    invite_rescheduled_invitee: (event: string, time: string) =>
      `✅ <b>${event}</b> перенесено на ${time}. Вы автоматически приняты.`,
    invite_kept_inviter: '❌ Предложение отклонено',
    invite_kept_invitee: (event: string, time: string) =>
      `❌ Ваше предложение отклонено. Событие остаётся ${time}.`,
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
bun run lint 2>&1 | tail -20
```
Expected: 0 errors, 0 warnings

- [ ] **Step 4: Commit**

```bash
git add src/config/constants.ts
git commit -m "feat(invitations): add i18n strings for propose-time flow"
```

---

## Task 5: Add "Другое время" Button to Invite Command

**Files:**
- Modify: `src/bot/commands/invite.ts`
- Modify: `test/bot/commands/invite.test.ts`

- [ ] **Step 1: Write failing test**

In `test/bot/commands/invite.test.ts`, find the test that checks the keyboard and add assertion for 4th button. If no such test exists, add:

```typescript
test('invite keyboard has 4 buttons including propose', async () => {
  // ... existing setup ...
  // Verify keyboard contains inv:propose
  const sentMarkup = JSON.stringify(sentOptions?.reply_markup ?? {});
  expect(sentMarkup).toContain('inv:propose:');
});
```

If no keyboard test exists yet, create a minimal one. Check current test structure first by reading the test file.

- [ ] **Step 2: Run — confirm FAIL**

```bash
bun test test/bot/commands/invite.test.ts 2>&1 | tail -20
```

- [ ] **Step 3: Add 4th button in invite.ts**

In `src/bot/commands/invite.ts`, change the keyboard construction:

```typescript
  const keyboard = new InlineKeyboard()
    .text('Accept ✅', `${CB.INVITATION_ACTION}:accept:${invitation.id}`)
    .text('Decline ❌', `${CB.INVITATION_ACTION}:decline:${invitation.id}`)
    .row()
    .text('Maybe 🤔', `${CB.INVITATION_ACTION}:maybe:${invitation.id}`)
    .text(messages.invite_propose_btn, `${CB.INVITATION_ACTION}:propose:${invitation.id}`);
```

- [ ] **Step 4: Run — confirm PASS**

```bash
bun test test/bot/commands/invite.test.ts 2>&1 | tail -10
```

- [ ] **Step 5: Commit**

```bash
git add src/bot/commands/invite.ts test/bot/commands/invite.test.ts
git commit -m "feat(invitations): add propose-time button to invite keyboard"
```

---

## Task 5.1: Create formatProposedTime Shared Util

**Files:**
- Create: `src/utils/invite-time-format.ts`
- Test: `test/utils/invite-time-format.test.ts`

Used by both `callback.handler.ts` and `message.handler.ts`. Single source of truth for date display.

- [ ] **Step 1: Write failing test**

Create `test/utils/invite-time-format.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { formatProposedTime } from '../../src/utils/invite-time-format';

describe('formatProposedTime', () => {
  test('formats ISO UTC to readable EN string', () => {
    const result = formatProposedTime('2026-04-01T10:30:00Z', 'UTC', 'en');
    expect(result).toContain('Apr');
    expect(result).toContain('1');
  });

  test('formats ISO UTC to readable RU string', () => {
    const result = formatProposedTime('2026-04-01T10:30:00Z', 'UTC', 'ru');
    // Russian month name or numeric format
    expect(result).toMatch(/апр|1 апр/i);
  });

  test('applies timezone offset', () => {
    const utc = formatProposedTime('2026-04-01T10:00:00Z', 'UTC', 'en');
    const kyiv = formatProposedTime('2026-04-01T10:00:00Z', 'Europe/Kyiv', 'en');
    expect(utc).not.toBe(kyiv); // UTC+3 so time differs
  });
});
```

- [ ] **Step 2: Run — confirm FAIL**

```bash
bun test test/utils/invite-time-format.test.ts 2>&1 | tail -10
```

- [ ] **Step 3: Create the util**

Create `src/utils/invite-time-format.ts`:

```typescript
import { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';
import { ru } from 'date-fns/locale';
import type { Lang } from '../config/constants.ts';

export function formatProposedTime(isoUtc: string, timezone: string, lang: Lang): string {
  const d = new TZDate(new Date(isoUtc).getTime(), timezone);
  return lang === 'ru'
    ? format(d, 'd MMMM, HH:mm', { locale: ru })
    : format(d, 'MMM d, h:mm a');
}
```

> **Note on `date-fns/locale` import**: Check `src/services/event/formatters.ts` for the exact locale import used in the project (it may be `import { ru } from 'date-fns/locale/ru'` or `from 'date-fns/locale'`). Use the same form.

- [ ] **Step 4: Run — confirm PASS**

```bash
bun test test/utils/invite-time-format.test.ts 2>&1 | tail -10
```

- [ ] **Step 5: Commit**

```bash
git add src/utils/invite-time-format.ts test/utils/invite-time-format.test.ts
git commit -m "feat(invitations): add formatProposedTime util"
```

---

## Task 5.5: Add "Другое время" Button to telegram-sender.ts and start.ts

**Files:**
- Modify: `src/services/ai/telegram-sender.ts`
- Modify: `src/bot/commands/start.ts`

Both files build an invitation inline keyboard. They must match `invite.ts`.

- [ ] **Step 1: Add button to telegram-sender.ts**

Find the InlineKeyboard block (lines ~53-59) and add the 4th button:

```typescript
    const keyboard = new InlineKeyboard()
      .text('Accept ✅', `${CB.INVITATION_ACTION}:accept:${invitationId}`)
      .text('Decline ❌', `${CB.INVITATION_ACTION}:decline:${invitationId}`)
      .row()
      .text('Maybe 🤔', `${CB.INVITATION_ACTION}:maybe:${invitationId}`)
      .text(t(lang).invite_propose_btn, `${CB.INVITATION_ACTION}:propose:${invitationId}`);
```

> **Note:** `telegram-sender.ts` may need the user's `lang` passed in to call `t(lang).invite_propose_btn`. If the method doesn't have a `lang` param, use a hardcoded `'ru'` default — or add `lang` to the call site. Check the method signature and pass `lang` if available, otherwise use `'en'` as fallback.

- [ ] **Step 2: Add button to start.ts**

Find the InlineKeyboard block (lines ~65-71) and add the 4th button:

```typescript
              new InlineKeyboard()
                .text('Accept ✅', `${CB.INVITATION_ACTION}:accept:${invitation.id}`)
                .text('Decline ❌', `${CB.INVITATION_ACTION}:decline:${invitation.id}`)
                .row()
                .text('Maybe 🤔', `${CB.INVITATION_ACTION}:maybe:${invitation.id}`)
                .text(t(lang).invite_propose_btn, `${CB.INVITATION_ACTION}:propose:${invitation.id}`)
```

Where `lang` is the invitee's language (already available in the start.ts context).

- [ ] **Step 3: Write regression tests**

In `test/bot/commands/invite.test.ts` (or a new `test/bot/invite-keyboard.test.ts`), verify all three keyboard-building sites produce the propose button:

```typescript
test('telegram-sender invite keyboard includes propose button', () => {
  // Read the keyboard JSON built by telegram-sender.ts send-invitation helper
  // and confirm it contains `inv:propose:`
  // Use a unit test that calls the function with a mock bot API
  // OR simply grep the output of a helper that builds the keyboard
});

test('start.ts deep-link invite keyboard includes propose button', () => {
  // Same pattern — confirm inv:propose: appears in the keyboard
});
```

> **Note:** If the keyboard-building logic in `telegram-sender.ts` and `start.ts` is not easily unit-testable in isolation, at minimum run the full test suite and confirm no existing tests break. Add an integration smoke-test comment noting manual testing is required.

- [ ] **Step 4: Run linter**

```bash
bun run lint 2>&1 | tail -10
```

- [ ] **Step 5: Commit**

```bash
git add src/services/ai/telegram-sender.ts src/bot/commands/start.ts test/
git commit -m "feat(invitations): add propose-time button in telegram-sender and start deep-link flow"
```

---

