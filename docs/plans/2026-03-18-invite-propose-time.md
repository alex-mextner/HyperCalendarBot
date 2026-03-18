# Invite: Propose Alternative Time — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow invitation recipients to propose an alternative event time; inviter gets a notification with one-click reschedule.

**Architecture:** New `proposed_time` column on `invitations` table. New service methods in `InvitationService`. New `inv:propose`, `inv:reschedule`, `inv:dismiss` callback sub-actions (`inv:dismiss` replaces the stub `inv:keep` for inviter actions). A `proposeTimeSessions` Map shared between callback and message handlers for free-text time input. Shared `formatProposedTime` ESM util to avoid duplicate date-formatting logic.

**Spec:** `docs/specs/invite-propose-time.md`

**Tech Stack:** Bun, bun:sqlite, GramIO, TypeScript, existing `parseSimpleDate` util.

**Worktree:** `.worktrees/propose-time` on branch `feat/invite-propose-time`

---

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

## Task 6: Callback Handler — Propose Sub-action

**Files:**
- Modify: `src/bot/handlers/callback.handler.ts`
- Modify: `test/bot/handlers/callback-invitation.test.ts`

### What to implement

When callback data is `inv:propose:{id}`:
1. Fetch invitation from `invitationRepo` (need to add it to callback handler deps — see below)
2. Fetch event to get `start_at` (quick button offsets)
3. Set `proposeTimeSessions.set(userId, { invitationId: id, eventStart: event.start_at })`
4. Send the time prompt message with quick buttons (use `ctx.message?.send(...)`)
5. `await ctx.answer()`

When callback data is `inv:propose:{id}:+30` or `inv:propose:{id}:+60`:
1. Fetch invitation + event
2. Compute `proposedTime = new Date(event.start_at + offset).toISOString()`
3. Call `invitationService.proposeTime(id, userId, proposedTime)`
4. Edit original invite message: `ctx.editText(t(lang).invite_propose_sent(formattedTime))`
5. Notify inviter via `invitationNotifyDeps`

### Deps changes needed

Add to `createCallbackHandler` signature (new last parameter):
```typescript
  proposeTimeSessions?: Map<number, { invitationId: number; eventStart: string }>,
  invitationRepo?: InvitationRepository,
```

Add `editMessage` to `invitationNotifyDeps`:
```typescript
invitationNotifyDeps?: {
  userRepo: UserRepository;
  sendMessage: (chatId: number, text: string, options: { parse_mode: string }) => Promise<void>;
  editMessage?: (chatId: number, messageId: number, text: string, markup?: unknown) => Promise<void>;
},
```

Need to import `InvitationRepository`:
```typescript
import type { InvitationRepository } from '../../database/repositories/invitation.repository.ts';
```

- [ ] **Step 1: Update makeHandler and write failing tests**

First, update `makeHandler` in `test/bot/handlers/callback-invitation.test.ts` to accept new params:

```typescript
function makeHandler(
  invitationService: Record<string, unknown>,
  proposeTimeSessions?: Map<number, { invitationId: number; eventStart: string }>,
  invitationRepo?: Record<string, unknown>,
  eventRepoArg?: Record<string, unknown>,
  invitationNotifyDeps?: Record<string, unknown>,
) {
  return createCallbackHandler(
    {} as never,               // eventService
    {} as never,               // editValueScene
    {} as never,               // holidayService
    {} as never,               // prefsService
    undefined,                 // calendarRepo
    undefined,                 // disconnectDeps
    undefined,                 // onCalendarsDone
    undefined,                 // renderService
    invitationService as never,
    undefined,                 // groupChatRepo
    eventRepoArg as never,     // eventRepo
    undefined,                 // chatHistoryRepo
    undefined,                 // onAiButtonClick
    undefined,                 // oauthDeps
    invitationNotifyDeps as never,
    undefined,                 // onboardingScene
    undefined,                 // editProposalDeps
    undefined,                 // callSettingsRepo
    undefined,                 // sharingSettingsRepo
    undefined,                 // feedbackDeps
    undefined,                 // userRepo
    undefined,                 // intentDeps
    undefined,                 // secretaryDeps
    undefined,                 // proposalDeps
    undefined,                 // snoozeDeps
    proposeTimeSessions,
    invitationRepo as never,
  );
}
```

Then append tests:

```typescript
  test('propose callback sets session and sends prompt', async () => {
    const proposeTimeSessions = new Map<number, { invitationId: number; eventStart: string }>();
    const inv = { id: 5, invitee_id: 200, inviter_id: 100, event_id: 3, status: 'pending', proposed_time: null };
    const event = { id: 3, start_at: '2026-04-01T10:00:00Z' };
    const invitationRepo = { findById: mock(() => inv) };
    const eventRepoMock = { findById: mock(() => event) };
    const invitationService = { proposeTime: mock(() => ({ success: true, invitation: inv })) };

    const ctx = {
      data: 'inv:propose:5',
      dbUser: { telegram_id: 200, language: 'en', timezone: 'UTC' },
      answer: mock(() => Promise.resolve()),
      editText: mock(() => Promise.resolve()),
      message: { send: mock(() => Promise.resolve()) },
    };

    const handler = makeHandler(invitationService, proposeTimeSessions, invitationRepo, eventRepoMock);
    await handler(ctx as never);

    expect(proposeTimeSessions.has(200)).toBe(true);
    expect(ctx.message.send).toHaveBeenCalled();
    expect(ctx.answer).toHaveBeenCalled();
  });

  test('propose:+30 calls proposeTime with +30min offset', async () => {
    const inv = { id: 5, invitee_id: 200, inviter_id: 100, event_id: 3, status: 'pending',
                  proposed_time: null, message_id: 42, chat_id: 200 };
    const event = { id: 3, start_at: '2026-04-01T10:00:00Z', title: 'Party' };
    const invitationRepo = { findById: mock(() => inv) };
    const eventRepoMock = { findById: mock(() => event) };
    const invitationService = {
      proposeTime: mock(() => ({ success: true, invitation: { ...inv, proposed_time: '2026-04-01T10:30:00Z' } })),
    };
    const notifyDeps = {
      userRepo: { findByTelegramId: mock(() => ({ language: 'en', first_name: 'Alice' })) },
      sendMessage: mock(() => Promise.resolve()),
    };

    const ctx = {
      data: 'inv:propose:5:+30',
      dbUser: { telegram_id: 200, language: 'en', timezone: 'UTC' },
      answer: mock(() => Promise.resolve()),
      editText: mock(() => Promise.resolve()),
    };

    const handler = makeHandler(invitationService, undefined, invitationRepo, eventRepoMock, notifyDeps);
    await handler(ctx as never);

    expect(invitationService.proposeTime).toHaveBeenCalledWith(5, 200, '2026-04-01T10:30:00Z');
    expect(ctx.editText).toHaveBeenCalled();
    expect(notifyDeps.sendMessage).toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run — confirm FAIL**

```bash
bun test test/bot/handlers/callback-invitation.test.ts 2>&1 | tail -20
```

- [ ] **Step 3: Update createCallbackHandler signature**

In `src/bot/handlers/callback.handler.ts`:

1. Add import at top:
```typescript
import type { InvitationRepository } from '../../database/repositories/invitation.repository.ts';
```

2. Add to `invitationNotifyDeps` type (around line 70):
```typescript
  invitationNotifyDeps?: {
    userRepo: UserRepository;
    sendMessage: (chatId: number, text: string, options: { parse_mode: string }) => Promise<void>;
    editMessage?: (chatId: number, messageId: number, text: string, markup?: unknown) => Promise<void>;
  },
```

3. Add two parameters at the end of `createCallbackHandler` signature (after `snoozeDeps`):
```typescript
  proposeTimeSessions?: Map<number, { invitationId: number; eventStart: string }>,
  invitationRepo?: InvitationRepository,
```

- [ ] **Step 4: Handle `propose` sub-actions in the invitation callback block**

In the invitation callback block (after line ~471 `return;`), replace/extend the current block. Inside `if (action === CB.INVITATION_ACTION && invitationService)`:

After the `maybe` handler and before the `if (!result)` check, add handling for `propose`:

```typescript
        if (subAction === 'propose') {
          const offsetStr = parts[3]; // '+30' or '+60' or undefined
          const inv = invitationRepo?.findById(invId);
          if (!inv) { await ctx.answer({ text: t(lang).invitation_not_found }); return; }

          const event = eventRepo?.findById(inv.event_id, inv.inviter_id);

          if (offsetStr === '+30' || offsetStr === '+60') {
            // Quick offset button
            const offsetMs = offsetStr === '+30' ? 30 * 60_000 : 60 * 60_000;
            const baseTime = event?.start_at ? new Date(event.start_at).getTime() : Date.now();
            const proposedTime = new Date(baseTime + offsetMs).toISOString();
            const propResult = invitationService.proposeTime(invId, user.telegram_id, proposedTime);
            if (!propResult.success) { await ctx.answer({ text: propResult.error ?? 'Error' }); return; }

            const formatted = formatProposedTime(proposedTime, user.timezone, lang);
            await ctx.answer();
            await ctx.editText(t(lang).invite_propose_sent(formatted), { parse_mode: 'HTML' }).catch(() => {});

            if (invitationNotifyDeps && event) {
              notifyInviterProposal(inv, user, formatted, event.title ?? `Event #${inv.event_id}`, invitationNotifyDeps, lang)
                .catch(() => {});
            }
          } else {
            // Free-text mode: set session, send prompt
            if (proposeTimeSessions) {
              proposeTimeSessions.set(user.telegram_id, {
                invitationId: invId,
                eventStart: event?.start_at ?? new Date().toISOString(),
              });
            }
            await ctx.answer();
            const msgs = t(lang);
            const quickKeyboard = new InlineKeyboard()
              .text(msgs.invite_propose_plus30, `${CB.INVITATION_ACTION}:propose:${invId}:+30`)
              .text(msgs.invite_propose_plus60, `${CB.INVITATION_ACTION}:propose:${invId}:+60`);
            await (ctx as unknown as { message?: { send: (text: string, opts: unknown) => Promise<unknown> } })
              .message?.send(msgs.invite_propose_ask, { reply_markup: quickKeyboard });
          }
          return;
        }
```

Add imports at the top of `callback.handler.ts`:

```typescript
import { formatProposedTime } from '../../utils/invite-time-format.ts';
```

Add the helper function `notifyInviterProposal` near the bottom of the file (before or after `notifyInviter`).

**Important:** `invitationNotifyDeps.sendMessage` must accept `reply_markup` in its options. Change the type in `createCallbackHandler` signature:

```typescript
invitationNotifyDeps?: {
  userRepo: UserRepository;
  sendMessage: (chatId: number, text: string, options: { parse_mode: string; reply_markup?: unknown }) => Promise<void>;
  editMessage?: (chatId: number, messageId: number, text: string, markup?: unknown) => Promise<void>;
},
```

Then the helper:

```typescript
async function notifyInviterProposal(
  invitation: Invitation,
  respondent: User,
  formattedTime: string,
  eventTitle: string,
  deps: {
    userRepo: UserRepository;
    sendMessage: (chatId: number, text: string, options: { parse_mode: string; reply_markup?: unknown }) => Promise<void>;
  },
): Promise<void> {
  const inviter = deps.userRepo.findByTelegramId(invitation.inviter_id);
  if (!inviter) return;
  const inviterLang = (inviter.language ?? 'en') as Lang;
  const name = respondent.first_name ?? respondent.username ?? `#${respondent.telegram_id}`;
  const text = t(inviterLang).invite_propose_notify(name, eventTitle, formattedTime);
  const keyboard = new InlineKeyboard()
    .text(t(inviterLang).invite_reschedule_btn, `${CB.INVITATION_ACTION}:reschedule:${invitation.id}`)
    .text(t(inviterLang).invite_keep_btn, `${CB.INVITATION_ACTION}:dismiss:${invitation.id}`);
  await deps.sendMessage(invitation.inviter_id, text, { parse_mode: 'HTML', reply_markup: keyboard });
}
```

- [ ] **Step 5: Run — confirm PASS**

```bash
bun test test/bot/handlers/callback-invitation.test.ts 2>&1 | tail -10
```

- [ ] **Step 6: Commit**

```bash
git add src/bot/handlers/callback.handler.ts test/bot/handlers/callback-invitation.test.ts
git commit -m "feat(invitations): handle inv:propose callback sub-actions in callback handler"
```

---

## Task 7: Callback Handler — Reschedule + Dismiss

**Files:**
- Modify: `src/bot/handlers/callback.handler.ts`
- Modify: `test/bot/handlers/callback-invitation.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `test/bot/handlers/callback-invitation.test.ts`:

```typescript
  test('reschedule callback calls rescheduleFromProposal and updates event', async () => {
    const proposedTime = '2026-04-01T14:00:00Z';
    const inv = { id: 5, invitee_id: 200, inviter_id: 100, event_id: 3, status: 'pending',
                  proposed_time: proposedTime, message_id: 42, chat_id: 200 };
    const event = { id: 3, start_at: '2026-04-01T10:00:00Z', end_at: '2026-04-01T11:00:00Z', title: 'Party' };
    const invitationRepo = { findById: mock(() => inv) };
    const eventRepoMock = { findById: mock(() => event) };
    const eventServiceMock = { updateEvent: mock(() => event) };
    const invitationService = {
      rescheduleFromProposal: mock(() => ({ success: true, invitation: inv, proposedTime })),
    };
    const notifyDeps = {
      userRepo: { findByTelegramId: mock(() => ({ language: 'en', first_name: 'Alice' })) },
      sendMessage: mock(() => Promise.resolve()),
    };

    const ctx = {
      data: 'inv:reschedule:5',
      dbUser: { telegram_id: 100, language: 'en', timezone: 'UTC' }, // inviter
      answer: mock(() => Promise.resolve()),
      editText: mock(() => Promise.resolve()),
    };

    // createCallbackHandler with eventServiceMock as first arg
    const handler = createCallbackHandler(
      eventServiceMock as never,
      {} as never, {} as never, {} as never,
      undefined, undefined, undefined, undefined,
      invitationService as never,
      undefined, eventRepoMock as never,
      undefined, undefined, undefined,
      notifyDeps as never,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined,
      invitationRepo as never,
    );
    await handler(ctx as never);

    expect(invitationService.rescheduleFromProposal).toHaveBeenCalledWith(5, 100);
    expect(eventServiceMock.updateEvent).toHaveBeenCalled();
    expect(notifyDeps.sendMessage).toHaveBeenCalled();
    expect(ctx.editText).toHaveBeenCalled();
  });

  test('dismiss callback calls keepOriginalTime and notifies invitee', async () => {
    const inv = { id: 5, invitee_id: 200, inviter_id: 100, event_id: 3, status: 'pending',
                  proposed_time: '2026-04-01T14:00:00Z', message_id: 42, chat_id: 200 };
    const event = { id: 3, start_at: '2026-04-01T10:00:00Z', title: 'Party' };
    const invitationRepo = { findById: mock(() => inv) };
    const eventRepoMock = { findById: mock(() => event) };
    const invitationService = {
      keepOriginalTime: mock(() => ({ success: true, invitation: { ...inv, proposed_time: null } })),
    };
    const notifyDeps = {
      userRepo: { findByTelegramId: mock(() => ({ language: 'en', first_name: 'Alice' })) },
      sendMessage: mock(() => Promise.resolve()),
      editMessage: mock(() => Promise.resolve()),
    };

    const ctx = {
      data: 'inv:dismiss:5',
      dbUser: { telegram_id: 100, language: 'en', timezone: 'UTC' }, // inviter
      answer: mock(() => Promise.resolve()),
      editText: mock(() => Promise.resolve()),
    };

    const handler = createCallbackHandler(
      {} as never, {} as never, {} as never, {} as never,
      undefined, undefined, undefined, undefined,
      invitationService as never,
      undefined, eventRepoMock as never,
      undefined, undefined, undefined,
      notifyDeps as never,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined,
      invitationRepo as never,
    );
    await handler(ctx as never);

    expect(invitationService.keepOriginalTime).toHaveBeenCalledWith(5, 100);
    expect(notifyDeps.sendMessage).toHaveBeenCalled();
    expect(notifyDeps.editMessage).toHaveBeenCalled();
    expect(ctx.editText).toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run — confirm FAIL**

```bash
bun test test/bot/handlers/callback-invitation.test.ts 2>&1 | tail -20
```

- [ ] **Step 3: Implement `reschedule` handler**

Inside `if (action === CB.INVITATION_ACTION && invitationService)`, after the propose block:

```typescript
        if (subAction === 'reschedule') {
          const reschedResult = invitationService.rescheduleFromProposal(invId, user.telegram_id);
          if (!reschedResult.success) {
            await ctx.answer({ text: reschedResult.error ?? 'Error' });
            return;
          }

          const invitation = reschedResult.invitation!;
          const proposedTime = reschedResult.proposedTime!;
          const event = eventRepo?.findById(invitation.event_id, user.telegram_id);

          // Update event times (preserve duration)
          if (event && eventService) {
            const durationMs = event.end_at
              ? new Date(event.end_at).getTime() - new Date(event.start_at).getTime()
              : 0;
            const newStart = proposedTime;
            const newEnd = durationMs > 0
              ? new Date(new Date(proposedTime).getTime() + durationMs).toISOString()
              : undefined;
            eventService.updateEvent(event.id, user.telegram_id, {
              start_at: newStart,
              ...(newEnd ? { end_at: newEnd } : {}),
            });
          }

          // Format time in inviter's timezone for inviter's message
          const formattedTimeInviter = formatProposedTime(proposedTime, user.timezone, lang);
          await ctx.answer();
          await ctx.editText(t(lang).invite_rescheduled_inviter(formattedTimeInviter), { parse_mode: 'HTML' }).catch(() => {});

          // Notify invitee — use invitee's timezone and language
          if (invitationNotifyDeps) {
            const eventTitle = event?.title ?? `Event #${invitation.event_id}`;
            const inviteeUser = invitationNotifyDeps.userRepo.findByTelegramId(invitation.invitee_id);
            const inviteeLang = ((inviteeUser?.language ?? 'en') as Lang);
            const inviteeTz = inviteeUser?.timezone ?? 'UTC';
            const formattedTimeInvitee = formatProposedTime(proposedTime, inviteeTz, inviteeLang);
            invitationNotifyDeps.sendMessage(
              invitation.invitee_id,
              t(inviteeLang).invite_rescheduled_invitee(eventTitle, formattedTimeInvitee),
              { parse_mode: 'HTML' },
            ).catch(() => {});
          }
          return;
        }
```

- [ ] **Step 4: Implement `dismiss` handler**

```typescript
        if (subAction === 'dismiss') {
          const keepResult = invitationService.keepOriginalTime(invId, user.telegram_id);
          if (!keepResult.success) {
            await ctx.answer({ text: keepResult.error ?? 'Error' });
            return;
          }

          const invitation = keepResult.invitation!;
          const event = eventRepo?.findById(invitation.event_id, user.telegram_id);
          // Use invitee's timezone for invitee-facing message
          const inviteeUser = invitationNotifyDeps?.userRepo.findByTelegramId(invitation.invitee_id);
          const inviteeLang = ((inviteeUser?.language ?? 'en') as Lang);
          const inviteeTz = inviteeUser?.timezone ?? 'UTC';
          const formattedOriginal = event?.start_at
            ? formatProposedTime(event.start_at, inviteeTz, inviteeLang)
            : '';

          await ctx.answer();
          await ctx.editText(t(lang).invite_kept_inviter, { parse_mode: 'HTML' }).catch(() => {});

          if (invitationNotifyDeps) {
            const eventTitle = event?.title ?? `Event #${invitation.event_id}`;
            const inviteeUser = invitationNotifyDeps.userRepo.findByTelegramId(invitation.invitee_id);
            const inviteeLang = ((inviteeUser?.language ?? 'en') as Lang);

            // Notify invitee
            invitationNotifyDeps.sendMessage(
              invitation.invitee_id,
              t(inviteeLang).invite_kept_invitee(eventTitle, formattedOriginal),
              { parse_mode: 'HTML' },
            ).catch(() => {});

            // Restore original invite message with buttons
            if (invitationNotifyDeps.editMessage && invitation.message_id && invitation.chat_id) {
              const inviterUser = invitationNotifyDeps.userRepo.findByTelegramId(invitation.inviter_id);
              const inviterName = inviterUser?.first_name ?? inviterUser?.username ?? `#${invitation.inviter_id}`;
              const originalText = t(inviteeLang).invitation_received(eventTitle, inviterName);
              const keyboard = new InlineKeyboard()
                .text('Accept ✅', `${CB.INVITATION_ACTION}:accept:${invitation.id}`)
                .text('Decline ❌', `${CB.INVITATION_ACTION}:decline:${invitation.id}`)
                .row()
                .text('Maybe 🤔', `${CB.INVITATION_ACTION}:maybe:${invitation.id}`)
                .text(t(inviteeLang).invite_propose_btn, `${CB.INVITATION_ACTION}:propose:${invitation.id}`);
              invitationNotifyDeps.editMessage(
                invitation.chat_id, invitation.message_id, originalText, keyboard
              ).catch(() => {});
            }
          }
          return;
        }
```

- [ ] **Step 5: Run — confirm PASS**

```bash
bun test test/bot/handlers/callback-invitation.test.ts 2>&1 | tail -10
```

- [ ] **Step 6: Commit**

```bash
git add src/bot/handlers/callback.handler.ts test/bot/handlers/callback-invitation.test.ts
git commit -m "feat(invitations): handle inv:reschedule and inv:dismiss callbacks"
```

---

## Task 8: Message Handler — Propose Time Text Input

**Files:**
- Modify: `src/bot/handlers/message.handler.ts`
- Create: `test/bot/handlers/message-handler-propose-time.test.ts`

### What to add

New deps in `MessageHandlerDeps`:
```typescript
  proposeTimeSessions?: Map<number, { invitationId: number; eventStart: string }>;
  editMessage?: (chatId: number, messageId: number, text: string) => Promise<void>;
```

New internal function `handleProposeTimeInput(ctx, text, user, session, deps)`.

Session check right before group handling logic (after line 487 scene check).

- [ ] **Step 1: Write failing test**

Create `test/bot/handlers/message-handler-propose-time.test.ts`:

```typescript
import { describe, expect, mock, test } from 'bun:test';
import { createMessageHandler } from '../../../src/bot/handlers/message.handler';

function makeUser(overrides = {}) {
  return { telegram_id: 200, language: 'en', timezone: 'UTC', ...overrides };
}

function makeCtx(text: string, userId = 200) {
  return {
    text,
    dbUser: makeUser({ telegram_id: userId }),
    chatId: userId,
    send: mock(() => Promise.resolve()),
    chat: { type: 'private' },
  };
}

describe('message handler: propose time session', () => {
  test('handles text input when proposeTimeSession exists', async () => {
    const proposeTimeSessions = new Map<number, { invitationId: number; eventStart: string }>();
    proposeTimeSessions.set(200, { invitationId: 5, eventStart: '2026-04-01T10:00:00Z' });

    const inv = { id: 5, invitee_id: 200, inviter_id: 100, event_id: 3, status: 'pending',
                  proposed_time: null, message_id: 42, chat_id: 200 };
    const invitationService = {
      proposeTime: mock(() => ({ success: true, invitation: { ...inv, proposed_time: '2026-04-01T15:00:00Z' } })),
    };
    const invitationRepo = { findById: mock(() => inv) };
    const editMessage = mock(() => Promise.resolve());
    const sendMessage = mock(() => Promise.resolve());

    const handler = createMessageHandler({
      agent: { run: mock(() => Promise.resolve({ responseText: '' })) } as never,
      eventService: {} as never,
      holidayService: {} as never,
      chatHistory: { save: mock(() => {}), getLast: mock(() => []) } as never,
      userRepo: { findByTelegramId: mock(() => makeUser({ telegram_id: 100 })) } as never,
      reminderRepo: {} as never,
      sceneStorage: { get: mock(() => Promise.resolve(null)) },
      proposeTimeSessions,
      invitationService: invitationService as never,
      invitationRepo: invitationRepo as never,
      editMessage,
      sendMessageToUser: sendMessage,
    });

    const ctx = makeCtx('tomorrow at 3pm');
    await handler(ctx as never);

    expect(invitationService.proposeTime).toHaveBeenCalledWith(5, 200, expect.any(String));
    expect(proposeTimeSessions.has(200)).toBe(false); // session cleared
    expect(editMessage).toHaveBeenCalled(); // original invite message edited
  });

  test('notifies inviter after successful text time input', async () => {
    const proposeTimeSessions = new Map<number, { invitationId: number; eventStart: string }>();
    proposeTimeSessions.set(200, { invitationId: 5, eventStart: '2026-04-01T10:00:00Z' });

    const inv = { id: 5, invitee_id: 200, inviter_id: 100, event_id: 3, status: 'pending',
                  proposed_time: null, message_id: 42, chat_id: 200 };
    const invitationService = {
      proposeTime: mock(() => ({ success: true, invitation: { ...inv, proposed_time: '2026-04-01T15:00:00Z' } })),
    };
    const invitationRepo = { findById: mock(() => inv) };
    const notifyInviterProposal = mock(() => Promise.resolve());

    const handler = createMessageHandler({
      agent: { run: mock(() => Promise.resolve({ responseText: '' })) } as never,
      eventService: { getEvent: mock(() => ({ title: 'Party' })) } as never,
      holidayService: {} as never,
      chatHistory: { save: mock(() => {}), getLast: mock(() => []) } as never,
      userRepo: {} as never,
      reminderRepo: {} as never,
      sceneStorage: { get: mock(() => Promise.resolve(null)) },
      proposeTimeSessions,
      invitationService: invitationService as never,
      invitationRepo: invitationRepo as never,
      notifyInviterProposal,
    });

    const ctx = makeCtx('tomorrow at 3pm');
    await handler(ctx as never);

    expect(notifyInviterProposal).toHaveBeenCalledWith(5, expect.any(Object), expect.any(String), 'Party');
  });

  test('re-asks on invalid time input', async () => {
    const proposeTimeSessions = new Map<number, { invitationId: number; eventStart: string }>();
    proposeTimeSessions.set(200, { invitationId: 5, eventStart: '2026-04-01T10:00:00Z' });

    const ctx = makeCtx('not a time at all');
    const handler = createMessageHandler({
      agent: { run: mock(() => Promise.resolve({ responseText: '' })) } as never,
      eventService: {} as never,
      holidayService: {} as never,
      chatHistory: { save: mock(() => {}), getLast: mock(() => []) } as never,
      userRepo: {} as never,
      reminderRepo: {} as never,
      sceneStorage: { get: mock(() => Promise.resolve(null)) },
      proposeTimeSessions,
    });

    await handler(ctx as never);
    expect(ctx.send).toHaveBeenCalled(); // error message sent
    expect(proposeTimeSessions.has(200)).toBe(true); // session kept for retry
  });
});
```

- [ ] **Step 2: Run — confirm FAIL**

```bash
bun test test/bot/handlers/message-handler-propose-time.test.ts 2>&1 | tail -20
```

- [ ] **Step 3: Add deps to MessageHandlerDeps**

In `src/bot/handlers/message.handler.ts`, inside `MessageHandlerDeps`:

```typescript
  proposeTimeSessions?: Map<number, { invitationId: number; eventStart: string }>;
  editMessage?: (chatId: number, messageId: number, text: string) => Promise<void>;
  notifyInviterProposal?: (invitationId: number, inviteeUser: User, formattedTime: string, eventTitle: string) => Promise<void>;
```

- [ ] **Step 4: Add handleProposeTimeInput function**

Add after the existing `handleVoiceMessage` function:

Add import at top of `message.handler.ts`:

```typescript
import { formatProposedTime } from '../../utils/invite-time-format.ts';
```

Also add to `MessageHandlerDeps`:

```typescript
  notifyInviterProposal?: (invitationId: number, inviteeUser: User, formattedTime: string, eventTitle: string) => Promise<void>;
```

Then the function:

```typescript
async function handleProposeTimeInput(
  ctx: BotCommandContext,
  text: string,
  user: User,
  session: { invitationId: number; eventStart: string },
  deps: MessageHandlerDeps,
): Promise<void> {
  const lang = user.language as 'en' | 'ru';
  const chatId = ctx.chatId;
  if (!chatId) return;

  const parsed = parseSimpleDate(text, user.timezone);

  if (!parsed) {
    deps.proposeTimeSessions!.set(user.telegram_id, session);
    await ctx.send(lang === 'ru' ? 'Не могу распознать время. Попробуй ещё раз:' : 'Could not parse time. Try again:');
    return;
  }

  const proposedTime = parsed.toISOString();
  const result = deps.invitationService?.proposeTime(session.invitationId, user.telegram_id, proposedTime);

  if (!result?.success) {
    await ctx.send(result?.error ?? (lang === 'ru' ? 'Ошибка' : 'Error'));
    return;
  }

  const formattedTime = formatProposedTime(proposedTime, user.timezone, lang);
  await ctx.send(t(lang).invite_propose_sent(formattedTime), { parse_mode: 'HTML' });

  // Edit original invite message
  const invitation = deps.invitationRepo?.findById(session.invitationId);
  if (invitation?.message_id && invitation.chat_id && deps.editMessage) {
    deps.editMessage(invitation.chat_id, invitation.message_id, t(lang).invite_propose_sent(formattedTime))
      .catch(() => {});
  }

  // Notify inviter (same as quick-button path)
  if (deps.notifyInviterProposal && invitation) {
    const eventTitle = deps.eventService
      ? (deps.eventService.getEvent(invitation.event_id, invitation.inviter_id)?.title ?? `Event #${invitation.event_id}`)
      : `Event #${invitation.event_id}`;
    deps.notifyInviterProposal(invitation.id, user, formattedTime, eventTitle).catch(() => {});
  }
}
```

> **Note on `parseSimpleDate` import:** It's already imported in the add-event scene as `import { parseSimpleDate } from '../../utils/date.ts'`. Add the same static import to `message.handler.ts`.

- [ ] **Step 5: Add session check in the message handler**

In `createMessageHandler` return function, after line 487 (`if (activeScene) return;`):

```typescript
    // Propose-time session: invitee typing a new time in response to an invite
    if (deps.proposeTimeSessions) {
      const proposeSession = deps.proposeTimeSessions.get(user.telegram_id);
      if (proposeSession) {
        deps.proposeTimeSessions.delete(user.telegram_id);
        return handleProposeTimeInput(ctx, text, user, proposeSession, deps);
      }
    }
```

- [ ] **Step 6: Run — confirm PASS**

```bash
bun test test/bot/handlers/message-handler-propose-time.test.ts 2>&1 | tail -10
```

- [ ] **Step 7: Commit**

```bash
git add src/bot/handlers/message.handler.ts test/bot/handlers/message-handler-propose-time.test.ts
git commit -m "feat(invitations): handle propose-time text input in message handler"
```

---

## Task 9: Wire Up in bot/index.ts

**Files:**
- Modify: `src/bot/index.ts`

- [ ] **Step 1: Create proposeTimeSessions Map**

In `src/bot/index.ts`, after the `adminReplySession` declaration (around line 153):

```typescript
  const proposeTimeSessions = new Map<number, { invitationId: number; eventStart: string }>();
```

- [ ] **Step 2: Update invitationNotifyDeps in createCallbackHandler call**

Find the `invitationNotifyDeps` object (lines ~392-397) and add `editMessage`:

```typescript
        {
          userRepo: db.users,
          sendMessage: async (chatId: number, text: string, options: { parse_mode: string; reply_markup?: unknown }) => {
            await bot.api.sendMessage({ chat_id: chatId, text, parse_mode: options.parse_mode,
              ...(options.reply_markup ? { reply_markup: options.reply_markup } : {}) });
          },
          editMessage: async (chatId: number, messageId: number, text: string, markup?: unknown) => {
            await bot.api.editMessageText({
              chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML',
              ...(markup ? { reply_markup: markup } : {}),
            }).catch(() => {});
          },
        },
```

- [ ] **Step 3: Pass proposeTimeSessions + invitationRepo to createCallbackHandler**

At the end of `createCallbackHandler(...)` call, add the two new last arguments:

```typescript
        proposeTimeSessions,
        db.invitations,
```

- [ ] **Step 4: Pass proposeTimeSessions + editMessage + notifyInviterProposal to createMessageHandler**

In the `createMessageHandler({ ... })` deps object (around line 540-570), add:

```typescript
        proposeTimeSessions,
        editMessage: async (chatId: number, messageId: number, text: string) => {
          await bot.api.editMessageText({ chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML' }).catch(() => {});
        },
        notifyInviterProposal: async (invitationId: number, inviteeUser: User, formattedTime: string, eventTitle: string) => {
          const inv = db.invitations.findById(invitationId);
          if (!inv) return;
          const inviter = db.users.findByTelegramId(inv.inviter_id);
          if (!inviter) return;
          const inviterLang = (inviter.language ?? 'en') as 'en' | 'ru';
          const { InlineKeyboard } = await import('gramio');
          const { CB, t } = await import('../config/constants.ts');
          const keyboard = new InlineKeyboard()
            .text(t(inviterLang).invite_reschedule_btn, `${CB.INVITATION_ACTION}:reschedule:${invitationId}`)
            .text(t(inviterLang).invite_keep_btn, `${CB.INVITATION_ACTION}:dismiss:${invitationId}`);
          const name = inviteeUser.first_name ?? inviteeUser.username ?? `#${inviteeUser.telegram_id}`;
          await bot.api.sendMessage({
            chat_id: inv.inviter_id,
            text: t(inviterLang).invite_propose_notify(name, eventTitle, formattedTime),
            parse_mode: 'HTML',
            reply_markup: keyboard,
          });
        },
```

- [ ] **Step 5: Run full test suite**

```bash
bun test 2>&1 | tail -10
```

Expected: all existing tests pass + new tests pass. No regressions.

- [ ] **Step 6: Run linter**

```bash
bun run lint 2>&1 | tail -20
```

Expected: 0 errors, 0 warnings.

- [ ] **Step 7: Commit**

```bash
git add src/bot/index.ts
git commit -m "feat(invitations): wire proposeTimeSessions into callback and message handlers"
```

---

## Task 10: Full Test Suite + Final Verification

- [ ] **Step 1: Run complete test suite**

```bash
bun test 2>&1 | tail -15
```

Expected: all prior 1709+ tests pass, new tests pass, 0 failures.

- [ ] **Step 2: Run linter**

```bash
bun run lint 2>&1 | tail -20
```

Expected: 0 errors, 0 warnings.

- [ ] **Step 3: Check test coverage**

```bash
bun test --coverage 2>&1 | grep -E "All files|invitation"
```

- [ ] **Step 4: Final commit if anything left unstaged**

Ensure everything is committed. `git status` should show clean working tree.

---

## Notes for the Implementing Agent

1. **`formatProposedTime`**: Lives in `src/utils/invite-time-format.ts` (created in Task 5.1). Both `callback.handler.ts` and `message.handler.ts` import it from there. Check `src/services/event/formatters.ts` for the exact `date-fns/locale` import path used in the project and mirror it.

2. **`ctx.message?.send`**: In GramIO callback contexts, `ctx.message` is the message that contained the inline keyboard. Its `send()` method sends a new message to the same chat. This is how the time prompt gets delivered.

3. **`invitationService` in callback.handler**: The service is already passed as a parameter. The new methods `proposeTime`, `rescheduleFromProposal`, `keepOriginalTime` need to be on the `InvitationService` class — TypeScript will complain if they're missing.

4. **Session TTL**: The `proposeTimeSessions` Map has no built-in TTL. This is fine for MVP — if the bot restarts or user never responds, the session just disappears. Same pattern as other session Maps in the codebase.

5. **`inv:keep` existing behavior**: The existing `inv:keep` handler (just shows a toast) is NOT the same as `inv:dismiss`. Leave `keep` unchanged; `dismiss` is a new sub-action.

6. **Locale for date formatting**: In `formatters.ts`, check how `date-fns` locale is imported for RU. Use the same pattern.

7. **`t` import in message.handler.ts**: The message handler doesn't currently import `t` from constants. Add it: `import { t } from '../../config/constants.ts';`
