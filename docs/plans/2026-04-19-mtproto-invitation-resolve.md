# MTProto Invitation Resolve Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow `send_invitation` to resolve unknown @usernames via MTProto, auto-trigger user picker on resolve failure, annotate invitation cards with inviter timezone for new users, and show timezone-corrected invitation after onboarding.

**Architecture:** Extend the existing `send_invitation` tool handler to accept `invitee_username` without `invitee_id`. When only a username is provided, resolve it via `ctx.resolveUsername()` (MTProto). On resolve failure, internally call `handlePickUsers()` to open the Telegram contact picker. Add a timezone annotation line to `formatInvitation()` when recipient hasn't completed onboarding. Pass pending invitation data through onboarding scene params so the final step can re-display the invitation with the user's newly set timezone.

**Tech Stack:** TypeScript, GramIO scenes, bun:sqlite, Pyrogram MTProto bridge (existing)

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/services/ai/tools.ts` | Modify | Make `invitee_id` optional in schema |
| `src/services/ai/tool-handlers/sharing.ts` | Modify | MTProto resolve logic + pick_users fallback |
| `src/services/ai/tool-executor.ts` | Modify | Update `ToolInputMap` — `invitee_id` optional |
| `src/services/ai/system-prompt.ts` | Modify | Add instruction for MTProto resolve path |
| `src/services/event/formatters.ts` | Modify | Add timezone annotation when `recipientOnboarded=false` |
| `src/config/constants.ts` | Modify | Add `invite_timezone_note` i18n strings |
| `src/bot/scenes/types.ts` | Modify | Add invitation fields to `OnboardingState` |
| `src/bot/commands/start.ts` | Modify | Pass invitation data to onboarding scene |
| `src/bot/scenes/onboarding.scene.ts` | Modify | Post-onboarding invitation re-display |
| `test/services/ai/tool-handlers/sharing.test.ts` | Modify | Tests for resolve + pick_users fallback |
| `test/services/event/formatters.test.ts` | Modify | Test timezone annotation |
| `test/bot/commands/start-deeplink.test.ts` | Modify | Test invitation data passed to onboarding |

---

### Task 1: Make `invitee_id` optional in tool schema and types

**Files:**
- Modify: `src/services/ai/tools.ts:509-524`
- Modify: `src/services/ai/tool-executor.ts:154`
- Modify: `src/services/ai/tool-handlers/sharing.ts:186-190`

- [ ] **Step 1: Update tool schema — remove `invitee_id` from `required`**

In `src/services/ai/tools.ts`, change the `send_invitation` tool definition:

```ts
// tools.ts — send_invitation input_schema
input_schema: {
  type: 'object' as const,
  properties: {
    event_id: { type: 'number', description: 'ID of the event to invite to' },
    invitee_id: {
      type: 'number',
      description:
        'Telegram ID of the user to invite. Must be a value returned by find_contact, find_user, or pick_users in this conversation. ' +
        'Optional if invitee_username is provided — the bot will resolve via MTProto.',
    },
    invitee_username: {
      type: 'string',
      description:
        'Telegram @username of the invitee (without @). If invitee_id is not provided, the bot resolves the ID via MTProto. ' +
        'If resolve fails, a user picker opens automatically.',
    },
  },
  required: ['event_id'],
},
```

- [ ] **Step 2: Update `ToolInputMap` in tool-executor.ts**

```ts
send_invitation: { event_id: number; invitee_id?: number; invitee_username?: string };
```

- [ ] **Step 3: Update `SendInvitationInput` interface in sharing.ts**

```ts
interface SendInvitationInput {
  event_id: number;
  invitee_id?: number;
  invitee_username?: string;
}
```

- [ ] **Step 4: Run type check**

Run: `tsc --noEmit`
Expected: PASS (no callers pass `invitee_id` positionally — it's always an object)

- [ ] **Step 5: Commit**

```bash
git add src/services/ai/tools.ts src/services/ai/tool-executor.ts src/services/ai/tool-handlers/sharing.ts
git commit -m "refactor(send_invitation): make invitee_id optional in schema"
```

---

### Task 2: MTProto resolve + pick_users fallback in `handleSendInvitation`

**Files:**
- Modify: `src/services/ai/tool-handlers/sharing.ts:237-290`
- Test: `test/services/ai/tool-handlers/sharing.test.ts`

- [ ] **Step 1: Write failing tests for the new resolve path**

Add to `test/services/ai/tool-handlers/sharing.test.ts` inside the `handleSendInvitation` describe block:

```ts
test('resolves invitee via MTProto when only username provided', async () => {
  const event = eventService.createEvent({
    user_id: USER_ID,
    title: 'Resolve Party',
    start_at: '2026-03-20T18:00:00Z',
    timezone: 'UTC',
  });
  const ctx = makeCtx({
    resolveUsername: async (username: string) => {
      expect(username).toBe('targetuser');
      return { id: 300, firstName: 'Target', username: 'targetuser' };
    },
  });
  const result = await handleSendInvitation(ctx, {
    event_id: event.id,
    invitee_username: 'targetuser',
  });
  expect(result.success).toBe(true);
  expect(result.output).toContain('300');
});

test('opens pick_users when MTProto resolve fails', async () => {
  const event = eventService.createEvent({
    user_id: USER_ID,
    title: 'Picker Party',
    start_at: '2026-03-20T18:00:00Z',
    timezone: 'UTC',
  });
  let pickerPrompt = '';
  const ctx = makeCtx({
    resolveUsername: async () => null,
    sender: {
      sendMessage: async () => ({ message_id: 1 }),
      editMessageText: async () => {},
      sendUserPicker: async (_chatId: number, prompt: string) => {
        pickerPrompt = prompt;
        return { message_id: 1 };
      },
    },
  });
  const result = await handleSendInvitation(ctx, {
    event_id: event.id,
    invitee_username: 'nobody',
  });
  expect(result.success).toBe(true);
  expect(result.stopLoop).toBe(true);
  expect(pickerPrompt).toContain('@nobody');
});

test('returns error when neither invitee_id nor invitee_username provided', async () => {
  const event = eventService.createEvent({
    user_id: USER_ID,
    title: 'Missing ID',
    start_at: '2026-03-20T18:00:00Z',
    timezone: 'UTC',
  });
  const ctx = makeCtx();
  const result = await handleSendInvitation(ctx, { event_id: event.id });
  expect(result.success).toBe(false);
  expect(result.error).toContain('invitee_id');
});

test('returns error when resolve unavailable and no invitee_id', async () => {
  const event = eventService.createEvent({
    user_id: USER_ID,
    title: 'No Resolve',
    start_at: '2026-03-20T18:00:00Z',
    timezone: 'UTC',
  });
  // ctx without resolveUsername
  const ctx = makeCtx();
  const result = await handleSendInvitation(ctx, {
    event_id: event.id,
    invitee_username: 'someone',
  });
  expect(result.success).toBe(false);
  expect(result.error).toContain('MTProto');
});

test('auto-adds resolved user as contact', async () => {
  const event = eventService.createEvent({
    user_id: USER_ID,
    title: 'Contact Party',
    start_at: '2026-03-20T18:00:00Z',
    timezone: 'UTC',
  });
  const { ContactRepository } = await import(
    '../../../../src/database/repositories/contact.repository.ts'
  );
  const contactRepo = new ContactRepository(db);
  const ctx = makeCtx({
    resolveUsername: async () => ({ id: 400, firstName: 'Resolved', username: 'resolved_user' }),
    contactRepo,
  });
  await handleSendInvitation(ctx, {
    event_id: event.id,
    invitee_username: 'resolved_user',
  });
  const contact = contactRepo.findByTelegramId(USER_ID, 400);
  expect(contact).not.toBeNull();
  expect(contact!.name).toBe('Resolved');
});

test('falls back to pick_users when resolve fails and no sendUserPicker', async () => {
  const event = eventService.createEvent({
    user_id: USER_ID,
    title: 'No Picker',
    start_at: '2026-03-20T18:00:00Z',
    timezone: 'UTC',
  });
  const ctx = makeCtx({
    resolveUsername: async () => null,
    sender: {
      sendMessage: async () => ({ message_id: 1 }),
      editMessageText: async () => {},
      // no sendUserPicker
    },
  });
  const result = await handleSendInvitation(ctx, {
    event_id: event.id,
    invitee_username: 'nobody',
  });
  expect(result.success).toBe(false);
  expect(result.error).toContain('not found');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/services/ai/tool-handlers/sharing.test.ts`
Expected: new tests FAIL

- [ ] **Step 3: Implement resolve logic in `handleSendInvitation`**

Modify `src/services/ai/tool-handlers/sharing.ts`. Add import for `handlePickUsers` at top:

```ts
import { handlePickUsers } from './meta.ts';
```

Replace the beginning of `handleSendInvitation`:

```ts
export async function handleSendInvitation(ctx: AgentContext, input: SendInvitationInput): Promise<ToolResult> {
  if (!ctx.sharing?.invitationService) {
    return { success: false, error: 'Invitations are not configured.' };
  }

  let inviteeId = input.invitee_id;
  let inviteeUsername = input.invitee_username;
  let resolvedFirstName: string | undefined;

  // Resolve invitee_id via MTProto when only username provided
  if (!inviteeId && inviteeUsername) {
    if (!ctx.resolveUsername) {
      return { success: false, error: 'Cannot resolve @username: MTProto is not configured.' };
    }
    const resolved = await ctx.resolveUsername(inviteeUsername);
    if (!resolved) {
      // Username not found — open user picker automatically
      const lang = ctx.user.language as 'en' | 'ru';
      const prompt = lang === 'ru'
        ? `@${inviteeUsername} не найден в Telegram. Выберите нужного человека из контактов.`
        : `@${inviteeUsername} not found on Telegram. Select the person from your contacts.`;
      return handlePickUsers(ctx, { event_id: input.event_id, prompt });
    }
    inviteeId = resolved.id;
    resolvedFirstName = resolved.firstName;
    if (resolved.username) inviteeUsername = resolved.username;
  }

  if (!inviteeId) {
    return { success: false, error: 'Either invitee_id or invitee_username must be provided.' };
  }

  const result = ctx.sharing.invitationService.sendInvitation(
    input.event_id,
    ctx.user.telegram_id,
    inviteeId,
    inviteeUsername,
  );

  if (!result.success) {
    return { success: false, error: result.error };
  }

  const invitation = result.invitation!;

  // Auto-add invitee to inviter's contacts
  if (ctx.contactRepo) {
    const invitee = ctx.userRepo.findByTelegramId(inviteeId);
    const contactName = invitee?.first_name ?? invitee?.username
      ?? resolvedFirstName ?? inviteeUsername ?? `User ${inviteeId}`;
    ctx.contactRepo.upsert(
      ctx.user.telegram_id,
      contactName,
      inviteeUsername ?? invitee?.username ?? undefined,
      inviteeId,
    );
  }

  const event = ctx.eventService.getEvent(input.event_id, ctx.user.telegram_id);
  const delivery = await deliverInvitation({
    invitationId: invitation.id,
    eventId: input.event_id,
    inviteeId,
    inviteeUsername: inviteeUsername ?? lookupInviteeUsername(ctx, inviteeId),
    inviterId: ctx.user.telegram_id,
    inviterName: ctx.user.first_name ?? ctx.user.username ?? `User ${ctx.user.telegram_id}`,
    inviterUsername: ctx.user.username ?? undefined,
    event,
    lang: (ctx.user.language ?? 'en') as 'en' | 'ru',
    ctx,
  });

  return {
    success: true,
    output: t(ctx.user.language).aiTools.sharing.invitationCreated(invitation.id, input.event_id, inviteeId),
    agentHint: delivery.delivered
      ? 'The invitation was delivered to the invitee via bot API or MTProto. Tell the user it is sent.'
      : delivery.viaDeepLink
        ? 'Bot-API delivery failed. A deep-link fallback was sent to the inviter to forward manually. Tell the user to share the link.'
        : 'Invitation delivery failed entirely. Tell the user there was a delivery problem.',
  };
}
```

Key changes from the original:
- `inviteeId` is now a `let` that may be resolved from MTProto
- Failed resolve → calls `handlePickUsers` directly and returns its result
- Contact auto-add now works even without the invitee in `users` table — uses `resolvedFirstName` from MTProto

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/services/ai/tool-handlers/sharing.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Run lint + full test suite**

Run: `bun run lint && bun test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/services/ai/tool-handlers/sharing.ts test/services/ai/tool-handlers/sharing.test.ts
git commit -m "feat(send_invitation): resolve unknown users via MTProto, fallback to pick_users"
```

---

### Task 3: Add timezone annotation to invitation card

**Files:**
- Modify: `src/config/constants.ts`
- Modify: `src/services/event/formatters.ts:182-215`
- Test: `test/services/event/formatters.test.ts`

- [ ] **Step 1: Write failing test**

Add to `test/services/event/formatters.test.ts`:

```ts
test('formatInvitation shows inviter timezone note when recipient not onboarded', () => {
  const event = {
    title: 'Party',
    start_at: '2026-03-15T14:00:00Z',
    end_at: null,
    timezone: 'Europe/Belgrade',
    location: null,
    description: null,
    all_day: 0,
    category: null,
    recurrence_rule: null,
  } as CalendarEvent;
  const result = formatInvitation(event, 'Europe/Belgrade', 'ru', 'Alex', 100, 'alex', null, false);
  expect(result).toContain('Europe/Belgrade');
  expect(result).toContain('Alex');
  // Should contain the timezone note
  expect(result).toMatch(/часовом поясе/i);
});

test('formatInvitation shows inviter timezone note in English', () => {
  const event = {
    title: 'Party',
    start_at: '2026-03-15T14:00:00Z',
    end_at: null,
    timezone: 'America/New_York',
    location: null,
    description: null,
    all_day: 0,
    category: null,
    recurrence_rule: null,
  } as CalendarEvent;
  const result = formatInvitation(event, 'America/New_York', 'en', 'John', 100, 'john', null, false);
  expect(result).toContain('America/New_York');
  expect(result).toContain('timezone');
});

test('formatInvitation does NOT show timezone note when recipient is onboarded', () => {
  const event = {
    title: 'Party',
    start_at: '2026-03-15T14:00:00Z',
    end_at: null,
    timezone: 'Europe/Belgrade',
    location: null,
    description: null,
    all_day: 0,
    category: null,
    recurrence_rule: null,
  } as CalendarEvent;
  const result = formatInvitation(event, 'Europe/Belgrade', 'ru', 'Alex', 100, 'alex', 'Europe/Moscow', true);
  expect(result).not.toMatch(/часовом поясе/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/services/event/formatters.test.ts`
Expected: timezone note tests FAIL

- [ ] **Step 3: Add i18n strings to constants.ts**

Find the `invitation_received` strings in both `en` and `ru` blocks. Add `invite_timezone_note` nearby:

In the `en` block:
```ts
invite_timezone_note: (inviterName: string, tz: string) =>
  `\n\n⏰ Time shown in ${inviterName}'s timezone (${tz})`,
```

In the `ru` block:
```ts
invite_timezone_note: (inviterName: string, tz: string) =>
  `\n\n⏰ Время в часовом поясе ${inviterName} (${tz})`,
```

- [ ] **Step 4: Add timezone note to `formatInvitation`**

In `src/services/event/formatters.ts`, modify `formatInvitation()`. After building the card text (both branches — `!event.all_day` and the all_day fallback), append the note when `recipientOnboarded` is false:

```ts
export function formatInvitation(
  event: CalendarEvent,
  timezone: string,
  lang: string,
  inviterName: string,
  inviterId: number,
  inviterUsername?: string | null,
  recipientTimezone?: string | null,
  recipientOnboarded?: boolean,
): string {
  const inviterLink = inviterUsername
    ? `@${escapeHtml(inviterUsername)}`
    : `<a href="tg://user?id=${inviterId}">${escapeHtml(inviterName)}</a>`;
  const header = t(lang as Lang).invitation_received(escapeHtml(event.title), inviterLink);

  let card: string;
  if (!event.all_day) {
    const timeLabel = formatTimeWithTimezones(
      event.start_at,
      timezone,
      recipientTimezone ?? null,
      recipientOnboarded ?? false,
    );
    const eventDetail = formatEventDetail(event, timezone, lang, { includeTitle: false });
    const plainTime = event.end_at
      ? `${formatTime(event.start_at, timezone)}–${formatTime(event.end_at, timezone)}`
      : formatTime(event.start_at, timezone);
    const annotatedDetail = eventDetail.replace(plainTime, timeLabel);
    card = `${header}\n\n${annotatedDetail}`;
  } else {
    card = `${header}\n\n${formatEventDetail(event, timezone, lang, { includeTitle: false })}`;
  }

  // Add timezone note for non-onboarded recipients
  if (!recipientOnboarded) {
    card += t(lang as Lang).invite_timezone_note(escapeHtml(inviterName), timezone);
  }

  return card;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/services/event/formatters.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Run lint**

Run: `bun run lint`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/services/event/formatters.ts src/config/constants.ts test/services/event/formatters.test.ts
git commit -m "feat(invitation): show inviter timezone note for non-onboarded recipients"
```

---

### Task 4: Pass invitation data through onboarding + re-display after completion

**Files:**
- Modify: `src/bot/scenes/types.ts:13-18`
- Modify: `src/bot/commands/start.ts:45-83`
- Modify: `src/bot/scenes/onboarding.scene.ts:28-35,197-217`
- Modify: `test/bot/commands/start-deeplink.test.ts`

- [ ] **Step 1: Extend `OnboardingState` with invitation fields**

In `src/bot/scenes/types.ts`:

```ts
export interface OnboardingState {
  lang?: 'en' | 'ru';
  detectedTz?: string;
  timezone?: string;
  country?: string;
  // Pending invitation from deep link — re-displayed with correct timezone after onboarding
  pendingInvitationId?: number;
  pendingEventId?: number;
  pendingInviterTelegramId?: number;
}
```

- [ ] **Step 2: Write failing test — start.ts passes invitation data**

Add to `test/bot/commands/start-deeplink.test.ts`:

```ts
test('i_ deep link passes invitation data to onboarding scene', async () => {
  const { handleStart } = await import('../../../src/bot/commands/start.ts');
  const onboardingScene = { name: 'onboarding' };
  const ctx = {
    args: 'i_invite123',
    dbUser: { telegram_id: 100, language: 'ru', onboarding_completed: 0 },
    send: mock(() => Promise.resolve()),
    scene: { enter: mock(() => Promise.resolve()) },
  };
  await handleStart(
    ctx as never,
    makeDeps({
      onboardingScene: onboardingScene as never,
      deepLinkService: {
        resolve: mock(() => ({
          type: 'invitation' as const,
          payload: { invitation_id: 10, event_id: 42 },
          createdBy: 200,
        })),
      } as never,
      eventService: {
        getEvent: mock(() => ({ title: 'Party', start_at: '2026-03-15T18:00:00Z', timezone: 'UTC' })),
      } as never,
      invitationRepo: {
        findById: mock(() => ({ id: 10, inviter_id: 200, invitee_id: 100, status: 'pending' })),
      } as never,
      userRepo: {
        findByTelegramId: mock(() => ({ first_name: 'Sender', username: 'sender' })),
      } as never,
    }),
  );
  // Should pass invitation context to onboarding
  expect(ctx.scene.enter).toHaveBeenCalledWith(onboardingScene, {
    pendingInvitationId: 10,
    pendingEventId: 42,
    pendingInviterTelegramId: 200,
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test test/bot/commands/start-deeplink.test.ts`
Expected: new test FAILS (currently passes onboarding scene without second arg)

- [ ] **Step 4: Modify `start.ts` to pass invitation data**

In `src/bot/commands/start.ts`, change the invitation deep link block (around line 79-82):

```ts
if (!user.onboarding_completed) {
  cmdLogger.info({ userId: user.telegram_id }, 'Starting onboarding after invitation deep link');
  await ctx.scene.enter(deps.onboardingScene, {
    pendingInvitationId: invitation.id,
    pendingEventId: resolved.payload.event_id,
    pendingInviterTelegramId: invitation.inviter_id,
  });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test test/bot/commands/start-deeplink.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Update the existing test that checks onboarding enter**

The test at line 183 (`'i_ deep link starts onboarding for new user after showing invitation'`) currently asserts `expect(ctx.scene.enter).toHaveBeenCalledWith(onboardingScene)` — update it to match the new signature with params:

```ts
expect(ctx.scene.enter).toHaveBeenCalledWith(onboardingScene, {
  pendingInvitationId: 10,
  pendingEventId: 42,
  pendingInviterTelegramId: 200,
});
```

- [ ] **Step 7: Add `StartDeps` fields for post-onboarding invitation display**

In `src/bot/commands/start.ts`, the `StartDeps` interface needs `invitationRepo` and `userRepo` which are already there. No changes needed to the interface.

- [ ] **Step 8: Modify onboarding scene — add `.params()` and re-display logic**

In `src/bot/scenes/onboarding.scene.ts`:

Add imports at top:
```ts
import type { InvitationRepository } from '../../database/repositories/invitation.repository.ts';
import type { UserRepository } from '../../database/repositories/user.repository.ts';
import type { EventService } from '../../services/event/event-service.ts';
import { formatInvitation } from '../../services/event/formatters.ts';
```

Add params to `createOnboardingScene` function signature:
```ts
export function createOnboardingScene(
  db: DatabaseService,
  userComposer: UserResolverComposer,
  gcalConfigured = false,
  prefsService?: NotificationPreferencesService,
  holidayService?: HolidayService,
  resolveCityFn?: typeof resolveCity,
  invitationDeps?: {
    invitationRepo: InvitationRepository;
    userRepo: UserRepository;
    eventService: EventService;
  },
) {
```

Add interface for params (before the function):
```ts
interface OnboardingParams {
  pendingInvitationId?: number;
  pendingEventId?: number;
  pendingInviterTelegramId?: number;
}
```

Update scene chain — add `.params<OnboardingParams>()` BEFORE `.state()`:
```ts
return (
  new Scene('onboarding')
    .params<OnboardingParams>()
    .state<OnboardingState>()
    .extend(userComposer)
```

Note: per CLAUDE.md rules, `params()` must come before `state()` and `extend()`. However `state()` uses intersection (preserves), so `params().state().extend()` is correct.

In step 3 (the final step, around line 199), after `db.users.update(context.from.id, { onboarding_completed: 1 })` and before `context.scene.exit()`, add the invitation re-display:

```ts
// Re-display invitation with user's timezone after onboarding
const { pendingInvitationId, pendingEventId, pendingInviterTelegramId } = context.scene.params;
if (pendingInvitationId && pendingEventId && pendingInviterTelegramId && invitationDeps) {
  const invitation = invitationDeps.invitationRepo.findById(pendingInvitationId);
  if (invitation && invitation.status === 'pending') {
    const event = invitationDeps.eventService.getEvent(pendingEventId, pendingInviterTelegramId);
    const inviter = invitationDeps.userRepo.findByTelegramId(pendingInviterTelegramId);
    const inviterName = inviter?.first_name ?? inviter?.username ?? `User ${pendingInviterTelegramId}`;
    const { timezone: userTz } = context.scene.state;
    if (event && userTz) {
      const text = formatInvitation(
        event,
        event.timezone,
        l,
        inviterName,
        pendingInviterTelegramId,
        inviter?.username,
        userTz,
        true,
      );
      const kb = new InlineKeyboard()
        .text('✅ Accept', `${CB.INVITATION_ACTION}:accept:${invitation.id}`)
        .text('❌ Decline', `${CB.INVITATION_ACTION}:decline:${invitation.id}`)
        .row()
        .text('Maybe 🤔', `${CB.INVITATION_ACTION}:maybe:${invitation.id}`)
        .text(t(l).invite_propose_btn, `${CB.INVITATION_ACTION}:propose:${invitation.id}`);
      await context.send(text, { parse_mode: 'HTML', reply_markup: kb });
    }
  }
}
```

This must be placed AFTER the onboarding complete message and BEFORE `context.scene.exit()`.

- [ ] **Step 9: Wire `invitationDeps` in bot/index.ts**

Find where `createOnboardingScene` is called in `src/bot/index.ts` and add the new parameter:

```ts
const onboardingScene = createOnboardingScene(
  db,
  userComposer,
  gcalConfigured,
  prefsService,
  holidayService,
  undefined, // resolveCityFn — use default
  {
    invitationRepo: db.invitations,
    userRepo: db.users,
    eventService,
  },
);
```

- [ ] **Step 10: Run type check**

Run: `tsc --noEmit`
Expected: PASS

- [ ] **Step 11: Run full tests**

Run: `bun test`
Expected: ALL PASS

- [ ] **Step 12: Commit**

```bash
git add src/bot/scenes/types.ts src/bot/commands/start.ts src/bot/scenes/onboarding.scene.ts src/bot/index.ts test/bot/commands/start-deeplink.test.ts
git commit -m "feat(onboarding): re-display invitation with user timezone after onboarding"
```

---

### Task 5: Update system prompt for MTProto resolve path

**Files:**
- Modify: `src/services/ai/system-prompt.ts:131-136`
- Test: `test/services/ai/system-prompt.test.ts`

- [ ] **Step 1: Write failing test**

Add to `test/services/ai/system-prompt.test.ts`:

```ts
test('includes MTProto resolve instruction for connected users', () => {
  const prompt = buildSystemPrompt({
    ...ctx,
    telegramSessionConnected: true,
  });
  expect(prompt).toContain('invitee_username');
  expect(prompt).toContain('MTProto');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/services/ai/system-prompt.test.ts`
Expected: FAIL

- [ ] **Step 3: Add instruction to system prompt**

In `src/services/ai/system-prompt.ts`, after the existing invitation sequence instructions (around line 136), add:

```ts
- If the user has connect_telegram active and mentions an @username not found via find_user or find_contact, you can call send_invitation with only invitee_username (without invitee_id). The bot will resolve the ID via MTProto. If resolve fails, a user picker opens automatically.
```

Also check what context is available — `telegramSessionConnected` may need to be added to the prompt context type or derived from existing fields. Check how `buildSystemPrompt` receives context and condition this line on the user having a connected session.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/services/ai/system-prompt.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Run lint**

Run: `bun run lint`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/services/ai/system-prompt.ts test/services/ai/system-prompt.test.ts
git commit -m "feat(system-prompt): instruct AI about MTProto resolve for connected users"
```

---

### Task 6: Final integration — lint, knip, full test suite

**Files:** All modified files

- [ ] **Step 1: Run knip**

Run: `bunx knip`
Expected: No new unused exports

- [ ] **Step 2: Run full lint**

Run: `bun run lint`
Expected: PASS, zero warnings

- [ ] **Step 3: Run full test suite**

Run: `bun test`
Expected: ALL PASS

- [ ] **Step 4: Run tsc**

Run: `tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Self-review diff**

Run: `git diff main --stat && git diff main`
Review all changes for correctness.

- [ ] **Step 6: Create PR**

```bash
git push -u origin HEAD
gh pr create --title "feat: resolve unknown users via MTProto in send_invitation" --body "..."
```
