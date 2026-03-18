# Group Calendar Proposals Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In group chats with the bot, let any member propose calendar changes (create/update/delete) to another member; target accepts or declines via DM.

**Architecture:** New `calendar_proposals` table + `CalendarProposalRepository`; `propose_calendar_change` AI tool; `prop:accept`/`prop:decline` callbacks execute event changes directly as target user; group system prompt extension; hourly cron for expiry.

**Tech Stack:** Bun, bun:sqlite, GramIO, Anthropic SDK tool definitions, `deliverMessage` utility (from secretary-access plan).

**Spec:** `docs/specs/2026-03-18-group-proposals.md`

**Prerequisite:** Secretary Access plan must be complete (provides `deliverMessage` utility).

---

## File Map

| Action | Path | Purpose |
|--------|------|---------|
| Modify | `src/database/migrations.ts` | Add migration 022: `calendar_proposals` |
| Modify | `src/database/types.ts` | Add `CalendarProposal`, `ProposalStatus`, `ProposalPayload` |
| Create | `src/database/repositories/calendar-proposal.repository.ts` | CRUD for proposals |
| Create | `src/services/ai/tool-handlers/proposals.ts` | Handler for `propose_calendar_change` |
| Modify | `src/services/ai/tools.ts` | Add `propose_calendar_change` tool def |
| Modify | `src/services/ai/tool-executor.ts` | Dispatch `propose_calendar_change` |
| Modify | `src/services/ai/types.ts` | Add `calendarProposalRepo?` to `AgentContext` |
| Modify | `src/services/ai/system-prompt.ts` | Add Group Proposals rules to Group Context block |
| Modify | `src/bot/handlers/callback.handler.ts` | Handle `prop:accept:{id}` and `prop:decline:{id}` |
| Modify | `src/bot/index.ts` | Wire `CalendarProposalRepository` |
| Create | `src/worker/proposal-expiry.ts` | Cron: expire proposals past `expires_at` |

| Action | Path |
|--------|------|
| Create | `test/database/repositories/calendar-proposal.repository.test.ts` |
| Create | `test/services/ai/tool-handlers/proposals.test.ts` |
| Modify | `test/services/ai/system-prompt.test.ts` |
| Modify | `test/bot/handlers/callback.handler.test.ts` |
| Create | `test/worker/proposal-expiry.test.ts` |

---

## Task 1: DB migration + types

**Files:**
- Modify: `src/database/migrations.ts`
- Modify: `src/database/types.ts`
- Test: `test/database/schema.test.ts`

- [ ] **Step 1: Write failing test**

Add to `test/database/schema.test.ts`:
```typescript
test('calendar_proposals table exists', () => {
  const db = getTestDb();
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='calendar_proposals'").get();
  expect(row).toBeTruthy();
});

test('calendar_proposals has required columns', () => {
  const db = getTestDb();
  const cols = db.prepare('PRAGMA table_info(calendar_proposals)').all() as { name: string }[];
  const names = cols.map(c => c.name);
  for (const col of ['group_chat_id', 'proposer_id', 'target_id', 'action', 'payload', 'summary', 'status', 'expires_at']) {
    expect(names).toContain(col);
  }
});
```

- [ ] **Step 2: Run — verify FAIL**

```bash
bun test test/database/schema.test.ts
```

- [ ] **Step 3: Add migration to `src/database/migrations.ts`**

```typescript
{
  name: '022_calendar_proposals',
  up(db) {
    db.exec(`
      CREATE TABLE calendar_proposals (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        group_chat_id      INTEGER NOT NULL,
        group_chat_title   TEXT,
        proposer_id        INTEGER NOT NULL,
        target_id          INTEGER NOT NULL,
        action             TEXT NOT NULL,
        payload            TEXT NOT NULL,
        summary            TEXT NOT NULL,
        status             TEXT NOT NULL DEFAULT 'pending',
        group_message_id   INTEGER,
        dm_message_id      INTEGER,
        expires_at         TEXT NOT NULL,
        created_at         TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (proposer_id) REFERENCES users(telegram_id) ON DELETE CASCADE,
        FOREIGN KEY (target_id)   REFERENCES users(telegram_id) ON DELETE CASCADE
      );
      CREATE INDEX idx_proposals_target  ON calendar_proposals(target_id, status);
      CREATE INDEX idx_proposals_expires ON calendar_proposals(expires_at, status);
    `);
  },
},
```

- [ ] **Step 4: Add types to `src/database/types.ts`**

```typescript
export type ProposalStatus = 'pending' | 'accepted' | 'declined' | 'expired';
export type ProposalAction = 'create' | 'update' | 'delete';

export interface CalendarProposal {
  id: number;
  group_chat_id: number;
  group_chat_title: string | null;
  proposer_id: number;
  target_id: number;
  action: ProposalAction;
  payload: string; // JSON
  summary: string;
  status: ProposalStatus;
  group_message_id: number | null;
  dm_message_id: number | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export interface CreateProposalData {
  group_chat_id: number;
  group_chat_title?: string;
  proposer_id: number;
  target_id: number;
  action: ProposalAction;
  payload: string;
  summary: string;
  expires_at: string;
}
```

- [ ] **Step 5: Run — verify PASS**

```bash
bun test test/database/schema.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/database/migrations.ts src/database/types.ts test/database/schema.test.ts
git commit -m "feat: add calendar_proposals migration and types"
```

---

## Task 2: CalendarProposalRepository

**Files:**
- Create: `src/database/repositories/calendar-proposal.repository.ts`
- Test: `test/database/repositories/calendar-proposal.repository.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// test/database/repositories/calendar-proposal.repository.test.ts
import { test, expect, beforeEach } from 'bun:test';
import { CalendarProposalRepository } from '../../../src/database/repositories/calendar-proposal.repository.ts';
import { createTestDb } from '../../helpers/test-db.ts';

let repo: CalendarProposalRepository;

beforeEach(() => {
  repo = new CalendarProposalRepository(createTestDb());
});

const base: CreateProposalData = {
  group_chat_id: -100,
  group_chat_title: 'Dev Team',
  proposer_id: 1,
  target_id: 2,
  action: 'create',
  payload: '{"action":"create","event":{"title":"Test"}}',
  summary: 'добавить встречу Test',
  expires_at: '2099-12-31T23:59:59Z',
};

test('create returns new proposal with pending status', () => {
  const p = repo.create(base);
  expect(p.status).toBe('pending');
  expect(p.action).toBe('create');
});

test('findById returns null for unknown id', () => {
  expect(repo.findById(999)).toBeNull();
});

test('updateStatus changes status', () => {
  const p = repo.create(base);
  const ok = repo.updateStatus(p.id, 'accepted');
  expect(ok).toBe(true);
  expect(repo.findById(p.id)!.status).toBe('accepted');
});

test('setGroupMessageId stores the message id', () => {
  const p = repo.create(base);
  repo.setGroupMessageId(p.id, 555);
  expect(repo.findById(p.id)!.group_message_id).toBe(555);
});

test('getExpired returns proposals past expires_at with pending status', () => {
  const p = repo.create({ ...base, expires_at: '2000-01-01T00:00:00Z' });
  const expired = repo.getExpired();
  expect(expired.some(e => e.id === p.id)).toBe(true);
});

test('expirePending updates expired proposals to expired status', () => {
  const p = repo.create({ ...base, expires_at: '2000-01-01T00:00:00Z' });
  repo.expirePending();
  expect(repo.findById(p.id)!.status).toBe('expired');
});
```

- [ ] **Step 2: Run — verify FAIL**

```bash
bun test test/database/repositories/calendar-proposal.repository.test.ts
```

- [ ] **Step 3: Implement**

```typescript
// src/database/repositories/calendar-proposal.repository.ts
import type { Database } from 'bun:sqlite';
import type { CalendarProposal, CreateProposalData, ProposalStatus } from '../types.ts';

export class CalendarProposalRepository {
  constructor(private db: Database) {}

  create(data: CreateProposalData): CalendarProposal {
    const result = this.db
      .prepare(`INSERT INTO calendar_proposals
        (group_chat_id, group_chat_title, proposer_id, target_id, action, payload, summary, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(data.group_chat_id, data.group_chat_title ?? null, data.proposer_id, data.target_id,
           data.action, data.payload, data.summary, data.expires_at);
    return this.findById(Number(result.lastInsertRowid))!;
  }

  findById(id: number): CalendarProposal | null {
    return (this.db.prepare('SELECT * FROM calendar_proposals WHERE id = ?').get(id) as CalendarProposal | null) ?? null;
  }

  updateStatus(id: number, status: ProposalStatus): boolean {
    const result = this.db
      .prepare(`UPDATE calendar_proposals SET status = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(status, id);
    return result.changes > 0;
  }

  setGroupMessageId(id: number, messageId: number): void {
    this.db.prepare(`UPDATE calendar_proposals SET group_message_id = ? WHERE id = ?`).run(messageId, id);
  }

  setDmMessageId(id: number, messageId: number): void {
    this.db.prepare(`UPDATE calendar_proposals SET dm_message_id = ? WHERE id = ?`).run(messageId, id);
  }

  getExpired(): CalendarProposal[] {
    return this.db
      .prepare(`SELECT * FROM calendar_proposals WHERE status = 'pending' AND expires_at < datetime('now')`)
      .all() as CalendarProposal[];
  }

  expirePending(): number {
    const result = this.db
      .prepare(`UPDATE calendar_proposals SET status = 'expired', updated_at = datetime('now')
                WHERE status = 'pending' AND expires_at < datetime('now')`)
      .run();
    return result.changes;
  }
}
```

- [ ] **Step 4: Run — verify PASS**

```bash
bun test test/database/repositories/calendar-proposal.repository.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/database/repositories/calendar-proposal.repository.ts test/database/repositories/calendar-proposal.repository.test.ts
git commit -m "feat: add CalendarProposalRepository"
```

---

## Task 3: `propose_calendar_change` tool + handler

**Files:**
- Create: `src/services/ai/tool-handlers/proposals.ts`
- Modify: `src/services/ai/tools.ts`
- Modify: `src/services/ai/tool-executor.ts`
- Modify: `src/services/ai/types.ts`
- Test: `test/services/ai/tool-handlers/proposals.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// test/services/ai/tool-handlers/proposals.test.ts
import { test, expect, mock } from 'bun:test';
import { handleProposeCalendarChange } from '../../../src/services/ai/tool-handlers/proposals.ts';

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    user: { telegram_id: 1, username: 'alice', first_name: 'Alice', language: 'ru', timezone: 'UTC' },
    chatId: -100123,
    groupTitle: 'Dev Team',
    messageText: '',
    eventService: {} as never,
    holidayService: {} as never,
    chatHistory: {} as never,
    userRepo: { findByTelegramId: () => null } as never,
    reminderRepo: {} as never,
    sendMessageToChat: mock(async () => ({ message_id: 1 })),
    botUsername: 'mybot',
    ...overrides,
  } as never;
}

test('propose: no calendarProposalRepo → error', async () => {
  const result = await handleProposeCalendarChange(makeCtx(), { target_telegram_id: 2, action: 'create', summary: 'test' });
  expect(result.success).toBe(false);
  expect(result.error).toContain('not configured');
});

test('propose: target not in chat → PROPOSAL_TARGET_NOT_IN_CHAT', async () => {
  const result = await handleProposeCalendarChange(makeCtx({
    calendarProposalRepo: { create: mock(() => ({ id: 1 })), setDmMessageId: mock(() => {}), setGroupMessageId: mock(() => {}) } as never,
    checkGroupMembership: mock(async () => false),
  }), { target_telegram_id: 2, action: 'create', summary: 'add meeting', event: { title: 'Meeting', start_at: '2099-01-01T10:00:00Z', end_at: '2099-01-01T11:00:00Z' } });
  expect(result.success).toBe(false);
  expect(result.error).toContain('PROPOSAL_TARGET_NOT_IN_CHAT');
});

test('propose: creates proposal and returns awaiting_confirmation', async () => {
  const mockCreate = mock(() => ({ id: 42, status: 'pending', target_id: 2 }));
  const result = await handleProposeCalendarChange(makeCtx({
    calendarProposalRepo: { create: mockCreate, setDmMessageId: mock(() => {}), setGroupMessageId: mock(() => {}) } as never,
    checkGroupMembership: mock(async () => true),
    sender: { sendMessage: mock(async () => ({ message_id: 5 })), sendAsUser: undefined } as never,
  }), {
    target_telegram_id: 2,
    action: 'create',
    summary: 'добавить Ретро',
    event: { title: 'Ретро', start_at: '2099-03-20T13:00:00Z', end_at: '2099-03-20T14:00:00Z' },
  });
  expect(result.success).toBe(true);
  expect((result.output as { status: string }).status).toBe('awaiting_confirmation');
  expect(mockCreate).toHaveBeenCalled();
});
```

Export a single `async handleProposeCalendarChange` function. No separate sync/async variant.

- [ ] **Step 2: Run — verify FAIL**

```bash
bun test test/services/ai/tool-handlers/proposals.test.ts
```

- [ ] **Step 3: Extend `AgentContext` in `src/services/ai/types.ts`**

```typescript
import type { CalendarProposalRepository } from '../../database/repositories/calendar-proposal.repository.ts';
// in AgentContext interface — add these fields:
calendarProposalRepo?: CalendarProposalRepository;
checkGroupMembership?: (chatId: number, userId: number) => Promise<boolean>;
// These may already exist (used by system-prompt.ts) — add if missing:
isGroup?: boolean;
groupTitle?: string;
groupChatId?: number;
```

- [ ] **Step 4: Implement handler**

```typescript
// src/services/ai/tool-handlers/proposals.ts
import type { AgentContext } from '../types.ts';
import { deliverMessage } from '../deliver-message.ts';
import { InlineKeyboard } from 'gramio';

interface ProposeInput {
  target_telegram_id: number;
  action: 'create' | 'update' | 'delete';
  summary: string;
  event?: Record<string, unknown>;
  event_id?: string;
  changes?: Record<string, unknown>;
}

export async function handleProposeCalendarChange(ctx: AgentContext, input: ProposeInput): Promise<{ success: boolean; output?: unknown; error?: string }> {
  if (!ctx.calendarProposalRepo) return { success: false, error: 'Proposals feature not configured.' };

  // Verify target is in this group chat
  const inChat = ctx.checkGroupMembership
    ? await ctx.checkGroupMembership(ctx.chatId, input.target_telegram_id)
    : true; // if no checker provided, assume ok (handled at wiring level)
  if (!inChat) return { success: false, error: 'PROPOSAL_TARGET_NOT_IN_CHAT' };

  // Compute expires_at from event time or +7 days
  const expiresAt = computeExpiresAt(input);

  const payload = buildPayload(input);

  const proposal = ctx.calendarProposalRepo.create({
    group_chat_id: ctx.chatId,
    group_chat_title: ctx.groupTitle ?? undefined,
    proposer_id: ctx.user.telegram_id,
    target_id: input.target_telegram_id,
    action: input.action,
    payload: JSON.stringify(payload),
    summary: input.summary,
    expires_at: expiresAt,
  });

  // Deliver DM to target (fire and forget)
  deliverProposalDm(ctx, proposal, input.target_telegram_id).catch(err =>
    logger.error({ err }, 'proposal DM delivery failed')
  );

  // Notify group chat
  notifyGroupChat(ctx, proposal, input.target_telegram_id).catch(err =>
    logger.error({ err }, 'proposal group notification failed')
  );;

  return { success: true, output: { status: 'awaiting_confirmation', proposal_id: proposal.id } };
}

function computeExpiresAt(input: ProposeInput): string {
  if (input.action === 'create' && input.event?.end_at) return input.event.end_at as string;
  // For update/delete: caller should pass event end_at in event field; fallback +7d
  return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
}

function buildPayload(input: ProposeInput): unknown {
  if (input.action === 'create') return { action: 'create', event: input.event };
  if (input.action === 'update') return { action: 'update', event_id: input.event_id, changes: input.changes };
  return { action: 'delete', event_id: input.event_id };
}

async function deliverProposalDm(ctx: AgentContext, proposal: { id: number; summary: string }, targetId: number): Promise<void> {
  if (!ctx.sender) return;

  const proposerName = ctx.user.first_name ?? ctx.user.username ?? `User ${ctx.user.telegram_id}`;
  const proposerHandle = ctx.user.username ? ` (@${ctx.user.username})` : '';
  const chatName = ctx.groupTitle ?? `chat ${ctx.chatId}`;
  // Determine emoji from summary prefix — can be enhanced; summary already set by AI
  const text =
    `${proposerName}${proposerHandle} предлагает изменение в твоём календаре (чат "${chatName}"):\n\n` +
    `${proposal.summary}`;

  const keyboard = new InlineKeyboard()
    .text('Принять ✅', `prop:accept:${proposal.id}`)
    .text('Отклонить ❌', `prop:decline:${proposal.id}`);

  const targetUser = ctx.userRepo!.findByTelegramId(targetId);
  const result = await deliverMessage({
    targetId,
    targetUsername: targetUser?.username,
    text,
    keyboard,
    fallbackRecipientId: ctx.user.telegram_id,
    fallbackText: `Не удалось доставить предложение — пользователь ещё не запускал бота.`,
    botSend: async (id, msg, kb) => {
      const sent = await ctx.sender!.sendMessage!(id, msg, kb);
      return { message_id: (sent as { message_id: number }).message_id };
    },
    mtprotoSend: ctx.sender.sendAsUser?.bind(ctx.sender),
  });

  if (result.messageId) {
    ctx.calendarProposalRepo!.setDmMessageId(proposal.id, result.messageId);
  }
}

async function notifyGroupChat(ctx: AgentContext, proposal: { id: number }, targetId: number): Promise<void> {
  if (!ctx.sendMessageToChat) return;
  const targetUser = ctx.userRepo!.findByTelegramId(targetId);
  const targetName = targetUser?.first_name ?? targetUser?.username ?? `User ${targetId}`;
  const targetHandle = targetUser?.username ? ` (@${targetUser.username})` : '';
  const botUsername = ctx.botUsername ? `@${ctx.botUsername}` : 'боту';

  const msg = await ctx.sendMessageToChat(ctx.chatId,
    `Отправил предложение ${targetName}${targetHandle}. Она/он ответит в личных сообщениях.`,
    { reply_markup: new InlineKeyboard().url('→ Написать боту', `https://t.me/${ctx.botUsername ?? 'bot'}`) }
  ) as { message_id: number };

  if (msg?.message_id) {
    ctx.calendarProposalRepo!.setGroupMessageId(proposal.id, msg.message_id);
  }
}
```

Note: `deliverProposalDm` and `notifyGroupChat` receive `input.target_telegram_id` directly, not from the proposal object — avoids relying on the returned record's fields. Add `import { logger } from '../../utils/logger.ts'` at top of file.

- [ ] **Step 5: Add tool def to `tools.ts`**

```typescript
{
  name: 'propose_calendar_change',
  description:
    'Propose a calendar change to another member of this group chat. ' +
    'The target receives a DM with Accept/Decline buttons — you cannot modify their calendar directly. ' +
    'Supported actions: "create" (new event), "update" (change fields of existing event), "delete" (remove event). ' +
    'For "update" and "delete", event_id must be known from a calendar view shared earlier in the chat. ' +
    'Use find_user first to resolve @username/name to telegram_id. ' +
    'After calling, STOP — the group chat will be notified of the outcome automatically.',
  input_schema: {
    type: 'object' as const,
    properties: {
      target_telegram_id: { type: 'number', description: 'telegram_id of the group member to propose the change to.' },
      action: { type: 'string', enum: ['create', 'update', 'delete'] },
      event: { type: 'object', description: 'Full event data. Required for action "create".' },
      event_id: { type: 'string', description: 'ID of the existing event. Required for "update" and "delete".' },
      changes: { type: 'object', description: 'Fields to change. Required for action "update".' },
      summary: {
        type: 'string',
        description: 'Human-readable description shown in the DM. Example: "добавить встречу «Ретро» — пятница 15:00–16:00".',
      },
    },
    required: ['target_telegram_id', 'action', 'summary'],
  },
},
```

- [ ] **Step 6: Add dispatch to `tool-executor.ts`**

```typescript
case 'propose_calendar_change':
  return handleProposeCalendarChange(ctx, input as ProposeInput);
```

Since the handler is async, ensure `executeTool` is already async (it should be).

- [ ] **Step 7: Run — verify PASS**

```bash
bun test test/services/ai/tool-handlers/proposals.test.ts
bun test test/services/ai/tool-executor.test.ts
```

- [ ] **Step 8: Commit**

```bash
git add src/services/ai/tool-handlers/proposals.ts src/services/ai/tools.ts src/services/ai/tool-executor.ts src/services/ai/types.ts test/services/ai/tool-handlers/proposals.test.ts
git commit -m "feat: add propose_calendar_change tool"
```

---

## Task 4: `prop:accept` / `prop:decline` callbacks

**Files:**
- Modify: `src/bot/handlers/callback.handler.ts`
- Test: `test/bot/handlers/callback.handler.test.ts`

The acceptance flow executes the proposal payload directly via `EventService` as the target user — **not** through the AI, not through tool input schema.

- [ ] **Step 1: Write failing tests**

Add to `test/bot/handlers/callback.handler.test.ts`. Import `handleProposalAccept` and `handleProposalDecline` as named exports from `callback.handler.ts` (extract them as pure functions for testability):

```typescript
import { handleProposalAccept, handleProposalDecline } from '../../../src/bot/handlers/callback.handler.ts';

const basePendingProposal = {
  id: 10, proposer_id: 1, target_id: 2, status: 'pending' as const,
  action: 'create' as const,
  payload: JSON.stringify({ action: 'create', event: { title: 'Ретро', start_at: '2099-03-20T15:00:00Z', end_at: '2099-03-20T16:00:00Z' } }),
  summary: 'добавить Ретро', group_chat_id: -100, group_message_id: 555, dm_message_id: 777,
  expires_at: '2099-12-31T00:00:00Z', group_chat_title: 'Dev Team', created_at: '', updated_at: '',
};

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    proposalRepo: {
      findById: mock(() => basePendingProposal),
      updateStatus: mock(() => true),
    },
    eventService: {
      createEvent: mock(() => ({ id: 99, title: 'Ретро' })),
      updateEvent: mock(() => ({ id: 1 })),
      deleteEvent: mock(() => true),
    },
    userRepo: { findByTelegramId: mock(() => ({ first_name: 'Alice', username: 'alice', telegram_id: 1 })) },
    editMessage: mock(async () => {}),
    sendMessage: mock(async () => {}),
    ...overrides,
  };
}

test('prop:accept: executes create payload as target_id=2, edits DM and group', async () => {
  const deps = makeDeps();
  await handleProposalAccept(10, deps as never);

  expect(deps.proposalRepo.updateStatus).toHaveBeenCalledWith(10, 'accepted');
  expect(deps.eventService.createEvent).toHaveBeenCalledWith(2, expect.objectContaining({ title: 'Ретро' }));
  expect(deps.editMessage).toHaveBeenCalledTimes(2); // DM + group
});

test('prop:accept: event gone → notifies both parties, does not crash', async () => {
  const deps = makeDeps({
    eventService: { createEvent: mock(() => null) }, // EventService returns null → event gone
  });
  await handleProposalAccept(10, deps as never);

  expect(deps.proposalRepo.updateStatus).toHaveBeenCalledWith(10, 'expired');
  expect(deps.sendMessage).toHaveBeenCalledTimes(2); // proposer + target notified
});

test('prop:accept: no-op if status != pending, edits DM only', async () => {
  const deps = makeDeps({
    proposalRepo: {
      findById: mock(() => ({ ...basePendingProposal, status: 'expired' })),
      updateStatus: mock(() => true),
    },
  });
  await handleProposalAccept(10, deps as never);

  expect(deps.eventService.createEvent).not.toHaveBeenCalled();
  expect(deps.editMessage).toHaveBeenCalledWith(
    basePendingProposal.target_id, basePendingProposal.dm_message_id,
    expect.stringContaining('истекло')
  );
});

test('prop:decline: sets declined and edits DM + group', async () => {
  const deps = makeDeps();
  await handleProposalDecline(10, deps as never);

  expect(deps.proposalRepo.updateStatus).toHaveBeenCalledWith(10, 'declined');
  expect(deps.editMessage).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 2: Run — verify FAIL**

```bash
bun test test/bot/handlers/callback.handler.test.ts
```

- [ ] **Step 3: Implement in `callback.handler.ts`**

```typescript
if (data.startsWith('prop:accept:')) {
  const id = Number(data.slice('prop:accept:'.length));
  await handleProposalAccept(id, ctx, deps);
  return;
}
if (data.startsWith('prop:decline:')) {
  const id = Number(data.slice('prop:decline:'.length));
  await handleProposalDecline(id, ctx, deps);
  return;
}
```

`handleProposalAccept`:
1. `repo.findById(id)` — if null or `status !== 'pending'`, edit DM "Предложение истекло", skip
2. `repo.updateStatus(id, 'accepted')`
3. Parse `proposal.payload` as `ProposalPayload`
4. Execute payload as `target_id`:
   - `create`: `eventService.createEvent(proposal.target_id, event_data)`
   - `update`: `eventService.updateEvent(event_id, proposal.target_id, changes)`
   - `delete`: `eventService.deleteEvent(event_id, proposal.target_id)`
5. **PROPOSAL_EVENT_GONE**: if EventService returns `null`/`false` (event not found or deleted):
   - `repo.updateStatus(id, 'expired')`
   - `sendMessage(proposal.target_id, 'Событие больше не существует — предложение аннулировано.')`
   - `sendMessage(proposal.proposer_id, 'Событие больше не существует — предложение аннулировано.')`
   - Skip DM/group edits, return
6. Edit DM at target: `✅ Принято. Изменение применено к твоему календарю.`
7. Edit group message (if `group_message_id`): `✅ {targetName} принял(а) предложение {proposerName} — {summary}.`
8. Notify proposer via bot API: `✅ {targetName} принял(а) твоё предложение.`

`handleProposalDecline`:
1. `repo.findById(id)` — if null, skip
2. `repo.updateStatus(id, 'declined')`
3. Edit DM: `Предложение отклонено.`
4. Edit group message: `❌ {targetName} отклонил(а) предложение {proposerName}.`

For editing messages, use `bot.api.editMessageText(chatId, messageId, newText)`.

- [ ] **Step 4: Run — verify PASS**

```bash
bun test test/bot/handlers/callback.handler.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/bot/handlers/callback.handler.ts test/bot/handlers/callback.handler.test.ts
git commit -m "feat: add prop:accept and prop:decline callback handlers"
```

---

## Task 5: System prompt extension

**Files:**
- Modify: `src/services/ai/system-prompt.ts`
- Test: `test/services/ai/system-prompt.test.ts`

The Group Context block already exists. Extend it with Group Proposals rules.

- [ ] **Step 1: Write failing test**

Add to `test/services/ai/system-prompt.test.ts`:
```typescript
test('group context includes Group Proposals rules when isGroup=true', () => {
  const ctx = makeTestCtx({ isGroup: true, groupTitle: 'Dev Team', groupChatId: -100 });
  const prompt = buildSystemPrompt(ctx);
  expect(prompt).toContain('## Group Proposals');
  expect(prompt).toContain('propose_calendar_change');
});

test('group proposals rules absent in private chat', () => {
  const ctx = makeTestCtx({ isGroup: false });
  const prompt = buildSystemPrompt(ctx);
  expect(prompt).not.toContain('## Group Proposals');
});
```

- [ ] **Step 2: Run — verify FAIL**

```bash
bun test test/services/ai/system-prompt.test.ts
```

- [ ] **Step 3: Extend Group Context block in `system-prompt.ts`**

Inside the `ctx.isGroup && ctx.groupTitle` conditional block, append after existing group rules:

```typescript
## Group Proposals

You are in a group chat. You CANNOT modify other users' calendars directly.
If the message asks to change, add, or delete something in another user's calendar:
1. Use find_user to resolve the target to telegram_id.
2. If target not found in users: tell the proposer this person hasn't started the bot yet.
3. Confirm the proposed change with ask_user if any details are ambiguous.
4. Call propose_calendar_change. STOP immediately after — do not add more text.

If the message is about the user's own calendar — act normally (no proposal needed).
If it's unclear whose calendar is meant — call ask_user: ["Мой", "@alice"].
```

- [ ] **Step 4: Run — verify PASS**

```bash
bun test test/services/ai/system-prompt.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/services/ai/system-prompt.ts test/services/ai/system-prompt.test.ts
git commit -m "feat: add Group Proposals rules to system prompt"
```

---

## Task 6: AgentContext + wiring

**Files:**
- Modify: `src/bot/index.ts`
- Modify: `src/bot/handlers/message.handler.ts`

- [ ] **Step 1: Add `CalendarProposalRepository` to bot**

In `src/bot/index.ts`:
```typescript
import { CalendarProposalRepository } from '../database/repositories/calendar-proposal.repository.ts';
const calendarProposalRepo = new CalendarProposalRepository(db.database);
```

Pass to:
- `buildAgentContextFactory` deps
- Callback handler deps

- [ ] **Step 2: Add `checkGroupMembership` to context**

In `buildAgentContextFactory` / message handler, add a `checkGroupMembership` function using Telegram `getChatMember`:
```typescript
checkGroupMembership: async (chatId: number, userId: number) => {
  try {
    const member = await bot.api.getChatMember(chatId, userId);
    return !['left', 'kicked'].includes(member.status);
  } catch {
    return false;
  }
},
```

- [ ] **Step 3: Pass `calendarProposalRepo` to context builder**

In `buildAgentContextFactory`, add to returned context:
```typescript
calendarProposalRepo: deps.calendarProposalRepo,
checkGroupMembership: deps.checkGroupMembership,
```

- [ ] **Step 4: Run full test suite**

```bash
bun test
```

Fix any failures.

- [ ] **Step 5: Commit**

```bash
git add src/bot/index.ts src/bot/handlers/message.handler.ts
git commit -m "feat: wire CalendarProposalRepository and group membership check"
```

---

## Task 7: Cron — expire pending proposals

**Files:**
- Create: `src/worker/proposal-expiry.ts`
- Test: `test/worker/proposal-expiry.test.ts`

- [ ] **Step 1: Find existing cron pattern**

```bash
grep -r "cron\|setInterval\|schedule\|agenda" src/ --include="*.ts" -l
```
Follow the exact same pattern.

- [ ] **Step 2: Write failing test**

```typescript
// test/worker/proposal-expiry.test.ts
import { test, expect, mock } from 'bun:test';
import { runProposalExpiry } from '../../../src/worker/proposal-expiry.ts';

test('expiry: edits DM and group message for each expired proposal', async () => {
  const expired = [{
    id: 1, proposer_id: 10, target_id: 20, group_chat_id: -100,
    group_message_id: 500, dm_message_id: 600, summary: 'add meeting',
    status: 'expired', action: 'create', payload: '{}', expires_at: '', created_at: '', updated_at: '',
    group_chat_title: 'Dev Team',
  }];
  const mockExpirePending = mock(() => expired); // returns newly expired records
  const mockEditMsg = mock(async () => {});

  await runProposalExpiry({
    proposalRepo: { expirePending: mockExpirePending } as never,
    editMessage: mockEditMsg,
  });

  expect(mockExpirePending).toHaveBeenCalled();
  expect(mockEditMsg).toHaveBeenCalledTimes(2); // DM (target_id=20) + group (group_chat_id=-100)
});

test('expiry: skips DM edit if dm_message_id is null', async () => {
  const expired = [{
    id: 2, target_id: 20, group_chat_id: -100,
    group_message_id: 500, dm_message_id: null,
    status: 'expired', action: 'create', payload: '{}', expires_at: '', created_at: '', updated_at: '',
  }];
  const mockEditMsg = mock(async () => {});

  await runProposalExpiry({
    proposalRepo: { expirePending: mock(() => expired) } as never,
    editMessage: mockEditMsg,
  });

  expect(mockEditMsg).toHaveBeenCalledTimes(1); // only group
});
```

- [ ] **Step 3: Implement `src/worker/proposal-expiry.ts`**

Change `expirePending()` to return the list of records it just expired (fetch + update in one call):

```typescript
// In CalendarProposalRepository — replace existing expirePending():
expirePending(): CalendarProposal[] {
  const toExpire = this.db
    .prepare(`SELECT * FROM calendar_proposals WHERE status = 'pending' AND expires_at < datetime('now')`)
    .all() as CalendarProposal[];
  if (toExpire.length > 0) {
    this.db
      .prepare(`UPDATE calendar_proposals SET status = 'expired', updated_at = datetime('now')
                WHERE status = 'pending' AND expires_at < datetime('now')`)
      .run();
  }
  return toExpire;
}
```

Also update `test/database/repositories/calendar-proposal.repository.test.ts` — change existing `expirePending` test:
```typescript
test('expirePending returns expired records and marks them expired', () => {
  const p = repo.create({ ...base, expires_at: '2000-01-01T00:00:00Z' });
  const expired = repo.expirePending();
  expect(expired.some(e => e.id === p.id)).toBe(true);
  expect(repo.findById(p.id)!.status).toBe('expired');
});
```

Then `runProposalExpiry` uses the returned list:

```typescript
// src/worker/proposal-expiry.ts
import type { CalendarProposal } from '../database/types.ts';
import { logger } from '../utils/logger.ts';

export async function runProposalExpiry(deps: {
  proposalRepo: { expirePending(): CalendarProposal[] };
  editMessage: (chatId: number, messageId: number, text: string) => Promise<void>;
}): Promise<void> {
  const expired = deps.proposalRepo.expirePending(); // expire first, then notify

  for (const p of expired) {
    if (p.dm_message_id) {
      await deps.editMessage(p.target_id, p.dm_message_id, 'Предложение истекло.').catch(err =>
        logger.error({ err, proposalId: p.id }, 'failed to edit expired proposal DM')
      );
    }
    if (p.group_message_id) {
      await deps.editMessage(p.group_chat_id, p.group_message_id, `⏱ Предложение истекло.`).catch(err =>
        logger.error({ err, proposalId: p.id }, 'failed to edit expired proposal group message')
      );
    }
  }
}
```

Wire into cron using the existing pattern. Run hourly.

- [ ] **Step 4: Run — verify PASS**

```bash
bun test test/worker/proposal-expiry.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/worker/proposal-expiry.ts test/worker/proposal-expiry.test.ts
git commit -m "feat: add proposal expiry cron job"
```

---

## Done

All tasks complete when `bun test` passes with no failures and `bun run lint` reports zero warnings.
