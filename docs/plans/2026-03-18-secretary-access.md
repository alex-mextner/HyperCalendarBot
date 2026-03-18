# Secretary Access Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let calendar owners delegate access to secretaries who can read/write their calendar via AI tools.

**Architecture:** New `calendar_secretaries` table + `SecretaryRepository`; two new AI tools (`list_calendar_access`, `manage_secretaries`); `owner_id` param on all 14 event tools with `checkSecretaryAccess` guard; invite/revoke/self_remove flows via universal `deliverMessage` utility; `sec:accept`/`sec:decline` callbacks; daily cron to expire stale invites.

**Tech Stack:** Bun, bun:sqlite, GramIO, Anthropic SDK tool definitions, existing TelegramSender/MTProto delivery chain.

**Spec:** `docs/specs/2026-03-18-privacy-delegation.md`

---

## File Map

| Action | Path | Purpose |
|--------|------|---------|
| Create | `src/services/ai/deliver-message.ts` | Universal message delivery (Bot API → MTProto → deeplink) |
| Modify | `src/services/ai/tool-handlers/sharing.ts` | Refactor `deliverInvitationAsync` → use `deliverMessage` |
| Modify | `src/database/migrations.ts` | Add migration 021: `calendar_secretaries` |
| Modify | `src/database/types.ts` | Add `CalendarSecretary`, `SecretaryStatus`, `CreateSecretaryData` |
| Create | `src/database/repositories/secretary.repository.ts` | CRUD for `calendar_secretaries` |
| Create | `src/services/ai/tool-handlers/secretary.ts` | Handlers for `list_calendar_access` + `manage_secretaries` |
| Modify | `src/services/ai/tools.ts` | Add `list_calendar_access` + `manage_secretaries` tool defs |
| Modify | `src/services/ai/tool-executor.ts` | Dispatch two new tools |
| Create | `src/services/ai/tool-handlers/secretary-access.ts` | `checkSecretaryAccess` guard for event tools |
| Modify | `src/services/ai/tool-handlers/events.ts` | Add `owner_id?` + access check to all 14 event handlers |
| Modify | `src/services/ai/types.ts` | Add `secretaryRepo?`, `secretaryForLine?` to `AgentContext` |
| Modify | `src/services/ai/system-prompt.ts` | Add `secretaryForLine` to User Info + Secretary Access rules |
| Modify | `src/bot/handlers/callback.handler.ts` | Handle `sec:accept:{id}` and `sec:decline:{id}` |
| Modify | `src/bot/handlers/message.handler.ts` | Compute `secretaryForLine` in context builder |
| Modify | `src/bot/index.ts` | Wire `SecretaryRepository` into bot deps |
| Create | `src/worker/secretary-expiry.ts` | Cron: expire pending invites >7 days |

| Action | Path |
|--------|------|
| Create | `test/services/ai/deliver-message.test.ts` |
| Create | `test/database/repositories/secretary.repository.test.ts` |
| Create | `test/services/ai/tool-handlers/secretary.test.ts` |
| Create | `test/services/ai/tool-handlers/secretary-access.test.ts` |
| Modify | `test/services/ai/system-prompt.test.ts` |
| Modify | `test/bot/handlers/callback.handler.test.ts` |
| Create | `test/worker/secretary-expiry.test.ts` |

---

## Task 1: `deliverMessage` universal utility

**Files:**
- Create: `src/services/ai/deliver-message.ts`
- Modify: `src/services/ai/tool-handlers/sharing.ts`
- Test: `test/services/ai/deliver-message.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// test/services/ai/deliver-message.test.ts
import { test, expect, mock } from 'bun:test';
import { deliverMessage } from '../../../src/services/ai/deliver-message.ts';

test('deliverMessage: delivers via bot API on success', async () => {
  const fakeSend = mock(async () => ({ message_id: 42 }));
  const result = await deliverMessage({
    targetId: 100,
    text: 'hello',
    fallbackRecipientId: 999,
    fallbackText: 'fallback',
    botSend: fakeSend,
  });
  expect(fakeSend).toHaveBeenCalledWith(100, 'hello', undefined);
  expect(result).toEqual({ delivered: true, messageId: 42 });
});

test('deliverMessage: falls back to MTProto if bot API fails', async () => {
  const fakeSend = mock(async () => { throw new Error('403'); });
  const fakeMtproto = mock(async () => true);
  const result = await deliverMessage({
    targetId: 100,
    targetUsername: 'johndoe',
    text: 'hello',
    fallbackRecipientId: 999,
    fallbackText: 'fallback',
    botSend: fakeSend,
    mtprotoSend: fakeMtproto,
  });
  expect(fakeMtproto).toHaveBeenCalledWith(100, 'hello', 'johndoe');
  expect(result).toEqual({ delivered: true });
});

test('deliverMessage: sends deeplink to fallback recipient if all fail', async () => {
  const fakeSend = mock(async (id: number) => {
    if (id === 100) throw new Error('403');
    return { message_id: 1 };
  });
  const result = await deliverMessage({
    targetId: 100,
    text: 'hello',
    fallbackRecipientId: 999,
    fallbackText: 'They have not started the bot.',
    botSend: fakeSend,
  });
  expect(fakeSend).toHaveBeenCalledWith(999, 'They have not started the bot.');
  expect(result).toEqual({ delivered: false });
});
```

- [ ] **Step 2: Run — verify FAIL**

```bash
bun test test/services/ai/deliver-message.test.ts
```
Expected: `Cannot find module '../../../src/services/ai/deliver-message.ts'`

- [ ] **Step 3: Implement**

```typescript
// src/services/ai/deliver-message.ts
import type { InlineKeyboard } from 'gramio';

export interface DeliverMessageParams {
  targetId: number;
  targetUsername?: string;
  text: string;
  keyboard?: InlineKeyboard;
  fallbackRecipientId: number;
  fallbackText: string;
  botSend: (recipientId: number, text: string, keyboard?: InlineKeyboard) => Promise<{ message_id: number }>;
  mtprotoSend?: (userId: number, text: string, username?: string) => Promise<boolean>;
}

export async function deliverMessage(params: DeliverMessageParams): Promise<{ delivered: boolean; messageId?: number }> {
  const { targetId, targetUsername, text, keyboard, fallbackRecipientId, fallbackText, botSend, mtprotoSend } = params;

  // 1. Bot API
  try {
    const msg = await botSend(targetId, text, keyboard);
    return { delivered: true, messageId: msg.message_id };
  } catch {
    // continue to fallback
  }

  // 2. MTProto
  if (mtprotoSend) {
    try {
      const ok = await mtprotoSend(targetId, text, targetUsername);
      if (ok) return { delivered: true };
    } catch {
      // continue to fallback
    }
  }

  // 3. Deep link fallback to initiator
  try {
    await botSend(fallbackRecipientId, fallbackText);
  } catch {
    // silent
  }
  return { delivered: false };
}
```

- [ ] **Step 4: Run — verify PASS**

```bash
bun test test/services/ai/deliver-message.test.ts
```

- [ ] **Step 5: Refactor `deliverInvitationAsync` in `sharing.ts`**

Replace the 3-step manual delivery chain inside `deliverInvitationAsync` with a call to `deliverMessage`. Keep the outer function signature unchanged — only the internals change.

Run sharing tests to confirm nothing broke:
```bash
bun test test/services/sharing/
bun test test/services/ai/tool-handlers/
```

- [ ] **Step 6: Commit**

```bash
git add src/services/ai/deliver-message.ts src/services/ai/tool-handlers/sharing.ts test/services/ai/deliver-message.test.ts
git commit -m "feat: extract universal deliverMessage utility, refactor invitation delivery"
```

---

## Task 2: DB migration + types

**Files:**
- Modify: `src/database/migrations.ts`
- Modify: `src/database/types.ts`
- Test: `test/database/schema.test.ts`

- [ ] **Step 1: Write failing test**

Add to `test/database/schema.test.ts`:
```typescript
test('calendar_secretaries table exists', () => {
  const db = getTestDb();
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='calendar_secretaries'").get();
  expect(row).toBeTruthy();
});

test('calendar_secretaries has required columns', () => {
  const db = getTestDb();
  const cols = db.prepare('PRAGMA table_info(calendar_secretaries)').all() as { name: string }[];
  const names = cols.map(c => c.name);
  expect(names).toContain('owner_id');
  expect(names).toContain('secretary_id');
  expect(names).toContain('permission');
  expect(names).toContain('status');
  expect(names).toContain('created_at');
  expect(names).toContain('updated_at');
});
```

- [ ] **Step 2: Run — verify FAIL**

```bash
bun test test/database/schema.test.ts
```

- [ ] **Step 3: Add migration to `src/database/migrations.ts`**

Append to the migrations array (check current count — use next number after last):
```typescript
{
  name: '021_calendar_secretaries',
  up(db) {
    db.exec(`
      CREATE TABLE calendar_secretaries (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_id       INTEGER NOT NULL,
        secretary_id   INTEGER NOT NULL,
        permission     TEXT NOT NULL DEFAULT 'read',
        status         TEXT NOT NULL DEFAULT 'pending',
        dm_message_id  INTEGER,
        created_at     TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(owner_id, secretary_id),
        FOREIGN KEY (owner_id)     REFERENCES users(telegram_id) ON DELETE CASCADE,
        FOREIGN KEY (secretary_id) REFERENCES users(telegram_id) ON DELETE CASCADE
      );
      CREATE INDEX idx_secretaries_owner     ON calendar_secretaries(owner_id);
      CREATE INDEX idx_secretaries_secretary ON calendar_secretaries(secretary_id, status);
    `);
  },
},
```

- [ ] **Step 4: Add types to `src/database/types.ts`**

```typescript
export type SecretaryStatus = 'pending' | 'active' | 'revoked' | 'declined' | 'expired';
export type SecretaryPermission = 'read' | 'write';

export interface CalendarSecretary {
  id: number;
  owner_id: number;
  secretary_id: number;
  permission: SecretaryPermission;
  status: SecretaryStatus;
  dm_message_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface CreateSecretaryData {
  owner_id: number;
  secretary_id: number;
  permission: SecretaryPermission;
}
```

- [ ] **Step 5: Run — verify PASS**

```bash
bun test test/database/schema.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/database/migrations.ts src/database/types.ts test/database/schema.test.ts
git commit -m "feat: add calendar_secretaries migration and types"
```

---

## Task 3: SecretaryRepository

**Files:**
- Create: `src/database/repositories/secretary.repository.ts`
- Test: `test/database/repositories/secretary.repository.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// test/database/repositories/secretary.repository.test.ts
import { test, expect, beforeEach } from 'bun:test';
import { SecretaryRepository } from '../../../src/database/repositories/secretary.repository.ts';
import { createTestDb } from '../../helpers/test-db.ts';

let repo: SecretaryRepository;

beforeEach(() => {
  const db = createTestDb();
  repo = new SecretaryRepository(db);
});

test('upsert creates new pending record', () => {
  const rec = repo.upsert({ owner_id: 1, secretary_id: 2, permission: 'read' });
  expect(rec.status).toBe('pending');
  expect(rec.permission).toBe('read');
});

test('upsert reuses existing pending record < 7 days', () => {
  const a = repo.upsert({ owner_id: 1, secretary_id: 2, permission: 'read' });
  const b = repo.upsert({ owner_id: 1, secretary_id: 2, permission: 'write' });
  expect(a.id).toBe(b.id); // same row
});

test('updateStatus changes status', () => {
  const rec = repo.upsert({ owner_id: 1, secretary_id: 2, permission: 'write' });
  const ok = repo.updateStatus(rec.id, 'active');
  expect(ok).toBe(true);
  expect(repo.findById(rec.id)!.status).toBe('active');
});

test('getActiveSecretaryFor returns only active entries for secretary', () => {
  repo.upsert({ owner_id: 10, secretary_id: 99, permission: 'write' });
  repo.updateStatus(repo.upsert({ owner_id: 10, secretary_id: 99, permission: 'write' }).id, 'active');
  const result = repo.getActiveSecretaryFor(99);
  expect(result.length).toBeGreaterThan(0);
});

test('getSecretariesForOwner returns all non-revoked for owner', () => {
  repo.upsert({ owner_id: 5, secretary_id: 11, permission: 'read' });
  repo.upsert({ owner_id: 5, secretary_id: 12, permission: 'write' });
  const list = repo.getSecretariesForOwner(5);
  expect(list.length).toBe(2);
});

test('countActive returns count of active secretaries for owner', () => {
  const r = repo.upsert({ owner_id: 7, secretary_id: 20, permission: 'read' });
  repo.updateStatus(r.id, 'active');
  expect(repo.countActive(7)).toBe(1);
});
```

- [ ] **Step 2: Run — verify FAIL**

```bash
bun test test/database/repositories/secretary.repository.test.ts
```

- [ ] **Step 3: Implement**

```typescript
// src/database/repositories/secretary.repository.ts
import type { Database } from 'bun:sqlite';
import type { CalendarSecretary, CreateSecretaryData, SecretaryStatus } from '../types.ts';

export class SecretaryRepository {
  constructor(private db: Database) {}

  upsert(data: CreateSecretaryData): CalendarSecretary {
    // Reuse pending < 7 days
    const pending = this.db
      .prepare(`SELECT * FROM calendar_secretaries
                WHERE owner_id = ? AND secretary_id = ?
                AND status = 'pending'
                AND created_at > datetime('now', '-7 days')`)
      .get(data.owner_id, data.secretary_id) as CalendarSecretary | null;
    if (pending) return pending;

    // Never demote an active record — return it as-is
    const active = this.db
      .prepare(`SELECT * FROM calendar_secretaries WHERE owner_id = ? AND secretary_id = ? AND status = 'active'`)
      .get(data.owner_id, data.secretary_id) as CalendarSecretary | null;
    if (active) return active;

    // Insert new pending row; if a revoked/expired/declined conflict exists, reset it to pending
    const result = this.db
      .prepare(`INSERT INTO calendar_secretaries (owner_id, secretary_id, permission, status, created_at, updated_at)
                VALUES (?, ?, ?, 'pending', datetime('now'), datetime('now'))
                ON CONFLICT(owner_id, secretary_id) DO UPDATE SET
                  permission = excluded.permission,
                  status = 'pending',
                  created_at = datetime('now'),
                  updated_at = datetime('now')`)
      .run(data.owner_id, data.secretary_id, data.permission);
    return this.findById(Number(result.lastInsertRowid))!;
  }

  findById(id: number): CalendarSecretary | null {
    return (this.db.prepare('SELECT * FROM calendar_secretaries WHERE id = ?').get(id) as CalendarSecretary | null) ?? null;
  }

  findByOwnerAndSecretary(ownerId: number, secretaryId: number): CalendarSecretary | null {
    return (this.db
      .prepare('SELECT * FROM calendar_secretaries WHERE owner_id = ? AND secretary_id = ?')
      .get(ownerId, secretaryId) as CalendarSecretary | null) ?? null;
  }

  updateStatus(id: number, status: SecretaryStatus): boolean {
    const result = this.db
      .prepare(`UPDATE calendar_secretaries SET status = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(status, id);
    return result.changes > 0;
  }

  setDmMessageId(id: number, messageId: number): void {
    this.db.prepare(`UPDATE calendar_secretaries SET dm_message_id = ? WHERE id = ?`).run(messageId, id);
  }

  /** Active secretary relationships where secretaryId is the secretary */
  getActiveSecretaryFor(secretaryId: number): CalendarSecretary[] {
    return this.db
      .prepare(`SELECT * FROM calendar_secretaries WHERE secretary_id = ? AND status = 'active'`)
      .all(secretaryId) as CalendarSecretary[];
  }

  /** All non-revoked/expired records where ownerId is the owner */
  getSecretariesForOwner(ownerId: number): CalendarSecretary[] {
    return this.db
      .prepare(`SELECT * FROM calendar_secretaries WHERE owner_id = ? AND status NOT IN ('revoked', 'expired')`)
      .all(ownerId) as CalendarSecretary[];
  }

  countActive(ownerId: number): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as cnt FROM calendar_secretaries WHERE owner_id = ? AND status = 'active'`)
      .get(ownerId) as { cnt: number };
    return row.cnt;
  }

  expirePending(): number {
    const result = this.db
      .prepare(`UPDATE calendar_secretaries SET status = 'expired', updated_at = datetime('now')
                WHERE status = 'pending' AND created_at < datetime('now', '-7 days')`)
      .run();
    return result.changes;
  }
}
```

- [ ] **Step 4: Run — verify PASS**

```bash
bun test test/database/repositories/secretary.repository.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/database/repositories/secretary.repository.ts test/database/repositories/secretary.repository.test.ts
git commit -m "feat: add SecretaryRepository"
```

---

## Task 4: `list_calendar_access` tool

**Files:**
- Modify: `src/services/ai/tools.ts`
- Create: `src/services/ai/tool-handlers/secretary.ts`
- Modify: `src/services/ai/tool-executor.ts`
- Modify: `src/services/ai/types.ts`
- Test: `test/services/ai/tool-handlers/secretary.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// test/services/ai/tool-handlers/secretary.test.ts
import { test, expect } from 'bun:test';
import { handleListCalendarAccess } from '../../../src/services/ai/tool-handlers/secretary.ts';
import type { AgentContext } from '../../../src/services/ai/types.ts';

function makeCtx(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    user: { telegram_id: 1, username: 'alice', first_name: 'Alice', language: 'ru', timezone: 'UTC', timezone_updated_at: null },
    chatId: 1,
    messageText: '',
    eventService: {} as never,
    holidayService: {} as never,
    chatHistory: {} as never,
    userRepo: {} as never,
    reminderRepo: {} as never,
    ...overrides,
  } as AgentContext;
}

test('list_calendar_access: returns empty when no secretary repo', () => {
  const ctx = makeCtx();
  const result = handleListCalendarAccess(ctx);
  expect(result.success).toBe(false);
});

test('list_calendar_access: returns own info + empty lists when no relations', () => {
  const mockRepo = {
    getActiveSecretaryFor: () => [],
    getSecretariesForOwner: () => [],
  };
  const ctx = makeCtx({ secretaryRepo: mockRepo as never });
  const result = handleListCalendarAccess(ctx);
  expect(result.success).toBe(true);
  const out = result.output as { own: { telegram_id: number }; my_secretaries: unknown[]; secretary_for: unknown[] };
  expect(out.own.telegram_id).toBe(1);
  expect(out.my_secretaries).toHaveLength(0);
  expect(out.secretary_for).toHaveLength(0);
});
```

- [ ] **Step 2: Run — verify FAIL**

```bash
bun test test/services/ai/tool-handlers/secretary.test.ts
```

- [ ] **Step 3: Extend AgentContext in `src/services/ai/types.ts`**

```typescript
import type { SecretaryRepository } from '../../database/repositories/secretary.repository.ts';
import type { TelegramSender } from '../telegram-sender.ts';
// in AgentContext interface — add if missing:
secretaryRepo?: SecretaryRepository;
secretaryForLine?: string;
sender?: TelegramSender;  // may already exist — add only if missing
```

- [ ] **Step 4: Implement handler in `src/services/ai/tool-handlers/secretary.ts`**

```typescript
// src/services/ai/tool-handlers/secretary.ts
import type { AgentContext } from '../types.ts';

export type ToolResult = { success: boolean; output?: unknown; error?: string };

export function handleListCalendarAccess(ctx: AgentContext): ToolResult {
  if (!ctx.secretaryRepo || !ctx.userRepo) return { success: false, error: 'Secretary feature not configured.' };

  const secretaryForRecords = ctx.secretaryRepo.getActiveSecretaryFor(ctx.user.telegram_id);
  const mySecretaryRecords = ctx.secretaryRepo.getSecretariesForOwner(ctx.user.telegram_id);

  // Enrich with username/display_name from users table
  const enrichUser = (telegramId: number) => {
    const u = ctx.userRepo!.findByTelegramId(telegramId);
    return { telegram_id: telegramId, username: u?.username, display_name: u?.first_name ?? u?.username ?? `User ${telegramId}` };
  };

  return {
    success: true,
    output: {
      own: enrichUser(ctx.user.telegram_id),
      my_secretaries: mySecretaryRecords.map(r => ({ ...r, ...enrichUser(r.secretary_id) })),
      secretary_for: secretaryForRecords.map(r => ({ ...r, ...enrichUser(r.owner_id) })),
    },
  };
}
```

- [ ] **Step 5: Add tool definition to `src/services/ai/tools.ts`**

```typescript
{
  name: 'list_calendar_access',
  description:
    'List all calendars this user has access to. Returns their own calendar and any ' +
    'calendars they can manage as a secretary. Also returns secretaries the user has ' +
    'added to their own calendar. Call when the user asks about their secretaries or asks ' +
    'about calendars they manage as secretary for someone else, or when context is ambiguous.',
  input_schema: { type: 'object' as const, properties: {}, required: [] },
},
```

- [ ] **Step 6: Add dispatch to `src/services/ai/tool-executor.ts`**

Add to the switch/map:
```typescript
case 'list_calendar_access':
  return handleListCalendarAccess(ctx);
```
Import `handleListCalendarAccess` from `./tool-handlers/secretary.ts`.

- [ ] **Step 7: Run — verify PASS**

```bash
bun test test/services/ai/tool-handlers/secretary.test.ts
bun test test/services/ai/tool-executor.test.ts
```

- [ ] **Step 8: Commit**

```bash
git add src/services/ai/tools.ts src/services/ai/types.ts src/services/ai/tool-handlers/secretary.ts src/services/ai/tool-executor.ts test/services/ai/tool-handlers/secretary.test.ts
git commit -m "feat: add list_calendar_access tool"
```

---

## Task 5: `manage_secretaries` — invite action

**Files:**
- Modify: `src/services/ai/tools.ts`
- Modify: `src/services/ai/tool-handlers/secretary.ts`
- Modify: `src/services/ai/tool-executor.ts`
- Test: `test/services/ai/tool-handlers/secretary.test.ts`

- [ ] **Step 1: Write failing tests**

Add to secretary.test.ts:
```typescript
import { handleManageSecretaries } from '../../../src/services/ai/tool-handlers/secretary.ts';

test('manage_secretaries invite: returns SECRETARY_NOT_FOUND when user missing', () => {
  const ctx = makeCtx({
    secretaryRepo: { upsert: () => ({}) } as never,
    userRepo: { findByTelegramId: () => null } as never,
  });
  const result = handleManageSecretaries(ctx, { action: 'invite', secretary_telegram_id: 999, permission: 'read' });
  expect(result.success).toBe(false);
  expect(result.error).toContain('SECRETARY_NOT_FOUND');
});

test('manage_secretaries invite: returns SECRETARY_LIMIT_REACHED when at 10', () => {
  const ctx = makeCtx({
    secretaryRepo: { countActive: () => 10, upsert: () => ({}) } as never,
    userRepo: { findByTelegramId: () => ({ telegram_id: 999 }) } as never,
  });
  const result = handleManageSecretaries(ctx, { action: 'invite', secretary_telegram_id: 999, permission: 'read' });
  expect(result.error).toContain('SECRETARY_LIMIT_REACHED');
});

test('manage_secretaries invite: success returns awaiting_confirmation', () => {
  const ctx = makeCtx({
    secretaryRepo: {
      countActive: () => 0,
      upsert: () => ({ id: 7, owner_id: 1, secretary_id: 999, permission: 'read', status: 'pending' }),
    } as never,
    userRepo: { findByTelegramId: () => ({ telegram_id: 999, username: 'bob', first_name: 'Bob' }) } as never,
    sender: { sendRaw: mock(async () => ({ message_id: 1 })) } as never,
  });
  const result = handleManageSecretaries(ctx, { action: 'invite', secretary_telegram_id: 999, permission: 'read' });
  expect(result.success).toBe(true);
  expect((result.output as { status: string }).status).toBe('awaiting_confirmation');
});
```

- [ ] **Step 2: Run — verify FAIL**

```bash
bun test test/services/ai/tool-handlers/secretary.test.ts
```

- [ ] **Step 3: Implement `handleManageSecretaries` in `secretary.ts`**

Handle `invite` action — check user exists, check limit, upsert record, fire `deliverMessage` async (don't await), return `awaiting_confirmation`.

```typescript
export function handleManageSecretaries(ctx: AgentContext, input: ManageSecretariesInput): ToolResult {
  if (!ctx.secretaryRepo || !ctx.userRepo) return { success: false, error: 'Secretary feature not configured.' };

  if (input.action === 'invite') {
    const { secretary_telegram_id, permission } = input;
    if (!secretary_telegram_id || !permission) return { success: false, error: 'secretary_telegram_id and permission required for invite.' };

    const secretaryUser = ctx.userRepo.findByTelegramId(secretary_telegram_id);
    if (!secretaryUser) return { success: false, error: 'SECRETARY_NOT_FOUND' };

    if (ctx.secretaryRepo.countActive(ctx.user.telegram_id) >= 10) return { success: false, error: 'SECRETARY_LIMIT_REACHED' };

    const record = ctx.secretaryRepo.upsert({ owner_id: ctx.user.telegram_id, secretary_id: secretary_telegram_id, permission });

    // Fire and forget
    sendSecretaryInvite(ctx, record, secretaryUser).catch(() => {});

    return { success: true, output: { status: 'awaiting_confirmation', secretary_access_id: record.id } };
  }

  // revoke and self_remove handled in Task 6
  return { success: false, error: `Unknown action: ${input.action}` };
}
```

`sendSecretaryInvite` builds the invite message text + [Принять `sec:accept:{id}`]/[Отклонить `sec:decline:{id}`] keyboard and calls `deliverMessage`. After delivery, if `result.messageId` is set, call `ctx.secretaryRepo!.setDmMessageId(record.id, result.messageId)` so callbacks can edit the invite later.

- [ ] **Step 4: Add tool def to `tools.ts`** (see spec section 2 for full description + input_schema)

- [ ] **Step 5: Add dispatch to `tool-executor.ts`**

```typescript
case 'manage_secretaries':
  return handleManageSecretaries(ctx, input as ManageSecretariesInput);
```

- [ ] **Step 6: Run — verify PASS**

```bash
bun test test/services/ai/tool-handlers/secretary.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add src/services/ai/tools.ts src/services/ai/tool-handlers/secretary.ts src/services/ai/tool-executor.ts test/services/ai/tool-handlers/secretary.test.ts
git commit -m "feat: add manage_secretaries invite action"
```

---

## Task 6: `manage_secretaries` — revoke + self_remove

**Files:**
- Modify: `src/services/ai/tool-handlers/secretary.ts`
- Test: `test/services/ai/tool-handlers/secretary.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
test('manage_secretaries revoke: updates status to revoked', () => {
  const mockUpdate = mock(() => true);
  const ctx = makeCtx({
    secretaryRepo: {
      findById: () => ({ id: 5, owner_id: 1, secretary_id: 99, status: 'active', permission: 'write' }),
      updateStatus: mockUpdate,
    } as never,
    userRepo: { findByTelegramId: () => ({ telegram_id: 99, username: 'bob', first_name: 'Bob' }) } as never,
    sender: {} as never,
  });
  const result = handleManageSecretaries(ctx, { action: 'revoke', secretary_access_id: 5 });
  expect(result.success).toBe(true);
  expect(mockUpdate).toHaveBeenCalledWith(5, 'revoked');
});

test('manage_secretaries self_remove: fails if caller is not the secretary', () => {
  const ctx = makeCtx({
    secretaryRepo: {
      findById: () => ({ id: 5, owner_id: 10, secretary_id: 999, status: 'active' }), // secretary_id != ctx.user.telegram_id (1)
      updateStatus: mock(() => true),
    } as never,
  });
  const result = handleManageSecretaries(ctx, { action: 'self_remove', secretary_access_id: 5 });
  expect(result.success).toBe(false);
  expect(result.error).toContain('SECRETARY_ACCESS_DENIED');
});

test('manage_secretaries self_remove: succeeds when caller matches secretary_id', () => {
  const mockUpdate = mock(() => true);
  const ctx = makeCtx({
    secretaryRepo: {
      findById: () => ({ id: 5, owner_id: 10, secretary_id: 1, status: 'active' }), // secretary_id == ctx.user.telegram_id (1)
      updateStatus: mockUpdate,
    } as never,
    userRepo: { findByTelegramId: () => ({ telegram_id: 10, username: 'alice', first_name: 'Alice' }) } as never,
    sender: {} as never,
  });
  const result = handleManageSecretaries(ctx, { action: 'self_remove', secretary_access_id: 5 });
  expect(result.success).toBe(true);
  expect(mockUpdate).toHaveBeenCalledWith(5, 'revoked');
});
```

- [ ] **Step 2: Run — verify FAIL**

```bash
bun test test/services/ai/tool-handlers/secretary.test.ts
```

- [ ] **Step 3: Add revoke + self_remove branches to `handleManageSecretaries`**

```typescript
if (input.action === 'revoke') {
  if (!input.secretary_access_id) return { success: false, error: 'secretary_access_id required for revoke.' };
  const record = ctx.secretaryRepo.findById(input.secretary_access_id);
  if (!record || record.owner_id !== ctx.user.telegram_id) return { success: false, error: 'SECRETARY_ACCESS_DENIED' };

  ctx.secretaryRepo.updateStatus(record.id, 'revoked');

  const secUser = ctx.userRepo!.findByTelegramId(record.secretary_id);
  if (secUser && ctx.sender) {
    const ownerName = ctx.user.first_name ?? ctx.user.username ?? `User ${ctx.user.telegram_id}`;
    const ownerHandle = ctx.user.username ? ` (@${ctx.user.username})` : '';
    sendSecretaryNotification(ctx, record.secretary_id, secUser.username,
      `Твой доступ к календарю ${ownerName}${ownerHandle} был отозван.`).catch(err =>
      logger.error({ err }, 'failed to send revoke notification')
    );
  }
  return { success: true, output: { ok: true } };
}

if (input.action === 'self_remove') {
  if (!input.secretary_access_id) return { success: false, error: 'secretary_access_id required for self_remove.' };
  const record = ctx.secretaryRepo.findById(input.secretary_access_id);
  if (!record) return { success: false, error: 'SECRETARY_ACCESS_DENIED' };
  if (record.secretary_id !== ctx.user.telegram_id) return { success: false, error: 'SECRETARY_ACCESS_DENIED' };

  ctx.secretaryRepo.updateStatus(record.id, 'revoked');

  const secName = ctx.user.first_name ?? ctx.user.username ?? `User ${ctx.user.telegram_id}`;
  const secHandle = ctx.user.username ? ` (@${ctx.user.username})` : '';
  const ownerUser = ctx.userRepo!.findByTelegramId(record.owner_id);
  if (ownerUser && ctx.sender) {
    sendSecretaryNotification(ctx, record.owner_id, ownerUser.username,
      `${secName}${secHandle} добровольно покинул роль секретаря твоего календаря.`).catch(err =>
      logger.error({ err }, 'failed to send self_remove notification')
    );
  }
  return { success: true, output: { ok: true } };
}
```

`sendSecretaryNotification` is a thin helper that calls `deliverMessage`.

- [ ] **Step 4: Run — verify PASS**

```bash
bun test test/services/ai/tool-handlers/secretary.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/services/ai/tool-handlers/secretary.ts test/services/ai/tool-handlers/secretary.test.ts
git commit -m "feat: add manage_secretaries revoke and self_remove actions"
```

---

## Task 7: `sec:accept` / `sec:decline` callbacks

**Files:**
- Modify: `src/bot/handlers/callback.handler.ts`
- Test: `test/bot/handlers/callback.handler.test.ts`

- [ ] **Step 1: Write failing tests**

Extract `handleSecretaryAccept` and `handleSecretaryDecline` as named exports from `callback.handler.ts` for direct testability. Add to `test/bot/handlers/callback.handler.test.ts`:

```typescript
import { handleSecretaryAccept, handleSecretaryDecline } from '../../../src/bot/handlers/callback.handler.ts';

const pendingRecord = {
  id: 5, owner_id: 10, secretary_id: 20, permission: 'write' as const,
  status: 'pending' as const, dm_message_id: 777, created_at: '', updated_at: '',
};

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    secretaryRepo: {
      findById: mock(() => pendingRecord),
      updateStatus: mock(() => true),
      setDmMessageId: mock(() => {}),
    },
    userRepo: { findByTelegramId: mock(() => ({ first_name: 'Alice', username: 'alice', telegram_id: 10 })) },
    sendMessage: mock(async () => {}),
    editMessage: mock(async () => {}),
    ...overrides,
  };
}

test('sec:accept: sets status active and notifies owner', async () => {
  const deps = makeDeps();
  await handleSecretaryAccept(5, deps as never);

  expect(deps.secretaryRepo.updateStatus).toHaveBeenCalledWith(5, 'active');
  expect(deps.sendMessage).toHaveBeenCalledWith(
    pendingRecord.owner_id,
    expect.stringContaining('принял')
  );
});

test('sec:accept: edits invitation message at secretary', async () => {
  const deps = makeDeps();
  await handleSecretaryAccept(5, deps as never);

  expect(deps.editMessage).toHaveBeenCalledWith(
    pendingRecord.secretary_id,
    pendingRecord.dm_message_id,
    expect.stringContaining('Принято')
  );
});

test('sec:accept: no-op if record not found', async () => {
  const deps = makeDeps({
    secretaryRepo: { findById: mock(() => null), updateStatus: mock(() => true) },
  });
  await expect(handleSecretaryAccept(5, deps as never)).resolves.toBeUndefined();
  expect(deps.secretaryRepo.updateStatus).not.toHaveBeenCalled();
});

test('sec:decline: sets status declined and notifies owner', async () => {
  const deps = makeDeps();
  await handleSecretaryDecline(5, deps as never);

  expect(deps.secretaryRepo.updateStatus).toHaveBeenCalledWith(5, 'declined');
  expect(deps.sendMessage).toHaveBeenCalledWith(
    pendingRecord.owner_id,
    expect.stringContaining('отклонил')
  );
});
```

- [ ] **Step 2: Run — verify FAIL**

```bash
bun test test/bot/handlers/callback.handler.test.ts
```

- [ ] **Step 3: Add handler in `callback.handler.ts`**

Follow the existing `inv:accept:` / `inv:decline:` pattern:

```typescript
if (data.startsWith('sec:accept:')) {
  const id = Number(data.slice('sec:accept:'.length));
  await handleSecretaryAccept(id, ctx, deps);
  return;
}
if (data.startsWith('sec:decline:')) {
  const id = Number(data.slice('sec:decline:'.length));
  await handleSecretaryDecline(id, ctx, deps);
  return;
}
```

`handleSecretaryAccept`:
1. `secretaryRepo.findById(id)` — if null, skip
2. `secretaryRepo.updateStatus(id, 'active')`
3. Notify owner: `Пользователь @{secretary_username} принял приглашение и теперь является секретарём твоего календаря.`
4. Edit original invitation message at secretary using `record.dm_message_id` (if not null): `✅ Принято. Ты теперь секретарь {owner_name} (@{owner_username}). Напиши мне, чтобы управлять её/его календарём.`

`handleSecretaryDecline`:
1. `secretaryRepo.findById(id)` — if null, skip
2. `secretaryRepo.updateStatus(id, 'declined')`
3. Notify owner: `@{secretary_username} отклонил приглашение секретаря.`
4. Edit original invitation message at secretary: `Приглашение отклонено.`

- [ ] **Step 4: Run — verify PASS**

```bash
bun test test/bot/handlers/callback.handler.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/bot/handlers/callback.handler.ts test/bot/handlers/callback.handler.test.ts
git commit -m "feat: add sec:accept and sec:decline callback handlers"
```

---

## Task 8: `owner_id` on event tools + `checkSecretaryAccess` guard

**Files:**
- Create: `src/services/ai/tool-handlers/secretary-access.ts`
- Modify: `src/services/ai/tools.ts` (14 tools)
- Modify: `src/services/ai/tool-handlers/events.ts` (all handlers)
- Test: `test/services/ai/tool-handlers/secretary-access.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// test/services/ai/tool-handlers/secretary-access.test.ts
import { test, expect } from 'bun:test';
import { checkSecretaryAccess } from '../../../src/services/ai/tool-handlers/secretary-access.ts';

const makeRepo = (record: unknown) => ({
  findByOwnerAndSecretary: () => record,
} as never);

test('no owner_id → returns caller telegram_id', () => {
  const result = checkSecretaryAccess(1, undefined, null, 'read');
  expect(result).toEqual({ ok: true, effectiveUserId: 1 });
});

test('owner_id present, no active record → denied', () => {
  const result = checkSecretaryAccess(1, 99, makeRepo(null), 'read');
  expect(result.ok).toBe(false);
  expect(result.error).toContain('SECRETARY_ACCESS_DENIED');
});

test('owner_id present, active read record → ok for read op', () => {
  const record = { status: 'active', permission: 'read' };
  const result = checkSecretaryAccess(1, 99, makeRepo(record), 'read');
  expect(result).toEqual({ ok: true, effectiveUserId: 99 });
});

test('owner_id present, active read record → denied for write op', () => {
  const record = { status: 'active', permission: 'read' };
  const result = checkSecretaryAccess(1, 99, makeRepo(record), 'write');
  expect(result.ok).toBe(false);
  expect(result.error).toContain('SECRETARY_ACCESS_DENIED');
});

test('owner_id present, active write record → ok for write op', () => {
  const record = { status: 'active', permission: 'write' };
  const result = checkSecretaryAccess(1, 99, makeRepo(record), 'write');
  expect(result).toEqual({ ok: true, effectiveUserId: 99 });
});
```

- [ ] **Step 2: Run — verify FAIL**

```bash
bun test test/services/ai/tool-handlers/secretary-access.test.ts
```

- [ ] **Step 3: Implement `secretary-access.ts`**

```typescript
// src/services/ai/tool-handlers/secretary-access.ts
import type { SecretaryRepository } from '../../../database/repositories/secretary.repository.ts';

type AccessMode = 'read' | 'write';

export function checkSecretaryAccess(
  callerUserId: number,
  ownerId: number | undefined,
  secretaryRepo: Pick<SecretaryRepository, 'findByOwnerAndSecretary'> | null,
  mode: AccessMode,
): { ok: true; effectiveUserId: number } | { ok: false; error: string } {
  if (!ownerId) return { ok: true, effectiveUserId: callerUserId };

  if (!secretaryRepo) return { ok: false, error: 'SECRETARY_ACCESS_DENIED' };

  const record = secretaryRepo.findByOwnerAndSecretary(ownerId, callerUserId);
  if (!record || record.status !== 'active') return { ok: false, error: 'SECRETARY_ACCESS_DENIED' };
  if (mode === 'write' && record.permission !== 'write') return { ok: false, error: 'SECRETARY_ACCESS_DENIED' };

  return { ok: true, effectiveUserId: ownerId };
}
```

- [ ] **Step 4: Run — verify PASS**

```bash
bun test test/services/ai/tool-handlers/secretary-access.test.ts
```

- [ ] **Step 5: Add `owner_id` param to all 14 tool definitions in `tools.ts`**

For each of the 14 tools listed in spec section 2, add to `properties`:
```typescript
owner_id: {
  type: 'number',
  description: 'Telegram ID of a user whose calendar to operate on. Only works if you have active secretary access to that user\'s calendar.',
},
```

- [ ] **Step 6: Update all 14 event handlers in `events.ts`**

For each handler, replace `ctx.user.telegram_id` where it's used as the data owner:
```typescript
// Before
const events = ctx.eventService.getEventsInRange(ctx.user.telegram_id, ...);

// After
const access = checkSecretaryAccess(ctx.user.telegram_id, input.owner_id, ctx.secretaryRepo ?? null, 'read');
if (!access.ok) return { success: false, error: access.error };
const events = ctx.eventService.getEventsInRange(access.effectiveUserId, ...);
```

For write operations (`create_event`, `update_event`, `delete_event`, `snooze_event`, `set_reminder`, `set_event_visibility`), use `'write'` mode.
For read operations (`get_events`, `get_event`, `search_events`, `get_free_slots`, `get_upcoming`, `get_reminders`, `render_day_image`, `render_week_image`), use `'read'` mode.

- [ ] **Step 7: Run ALL tests**

```bash
bun test
```
Fix any failures before committing.

- [ ] **Step 8: Commit**

```bash
git add src/services/ai/tool-handlers/secretary-access.ts src/services/ai/tools.ts src/services/ai/tool-handlers/events.ts test/services/ai/tool-handlers/secretary-access.test.ts
git commit -m "feat: add owner_id to event tools with secretary access guard"
```

---

## Task 9: System prompt extension

**Files:**
- Modify: `src/services/ai/system-prompt.ts`
- Modify: `src/services/ai/types.ts` (already done in Task 4)
- Modify: `src/bot/handlers/message.handler.ts`
- Test: `test/services/ai/system-prompt.test.ts`

- [ ] **Step 1: Write failing test**

Add to `test/services/ai/system-prompt.test.ts`:
```typescript
test('includes secretaryForLine in User Info when present', () => {
  const ctx = makeTestCtx({ secretaryForLine: '@alice_cto (read+write)' });
  const prompt = buildSystemPrompt(ctx);
  expect(prompt).toContain('Calendars you can manage as secretary: @alice_cto (read+write)');
});

test('omits secretary line when secretaryForLine absent', () => {
  const ctx = makeTestCtx({});
  const prompt = buildSystemPrompt(ctx);
  expect(prompt).not.toContain('Calendars you can manage as secretary');
});

test('includes Secretary Access rules block when secretaryForLine present', () => {
  const ctx = makeTestCtx({ secretaryForLine: '@bob_pm (read only)' });
  const prompt = buildSystemPrompt(ctx);
  expect(prompt).toContain('## Secretary Access');
});
```

- [ ] **Step 2: Run — verify FAIL**

```bash
bun test test/services/ai/system-prompt.test.ts
```

- [ ] **Step 3: Update `buildSystemPrompt` in `system-prompt.ts`**

In the `## User Info` section, add after `tzFreshness` line:
```typescript
${ctx.secretaryForLine ? `- Calendars you can manage as secretary: ${ctx.secretaryForLine}` : ''}
```

Add new block at the end (before closing template literal):
```typescript
${ctx.secretaryForLine ? `
## Secretary Access

If "Calendars you can manage as secretary" is listed above:
- If the message clearly targets someone else's calendar (they name the person, say "у Алисы", "для Алисы", etc.) — pass owner_id to the event tool.
- If ambiguous (no person mentioned, the user could mean their own or a delegating user's calendar) — call ask_user with options like ["Мой", "@alice_cto"]. Do not assume.
- If clearly the user's own calendar — do NOT pass owner_id.
- When showing someone else's calendar, always say whose it is: "Вот расписание Алисы на сегодня:".

If no secretary calendars are listed, ignore all of this.

When the user wants to add a secretary to their calendar:
1. Use find_user to resolve name/username to telegram_id.
2. If not found: tell the user this person hasn't used the bot yet — they need to message it first.
3. Use ask_user to confirm permission level: "Добавить @john секретарём?" with ["Чтение и запись", "Только чтение", "Отмена"].
4. Call manage_secretaries with action "invite". STOP immediately after — do not add more text.

When the user (as owner) wants to remove a secretary from their calendar:
- Confirm first: ask_user "Убрать @john из секретарей твоего календаря?" with ["Да", "Нет"].
- Then call manage_secretaries with action "revoke".

When the user (as secretary) wants to stop being secretary for someone:
- No confirmation needed — it's their own voluntary choice.
- Call list_calendar_access first to get the secretary_access_id, then call manage_secretaries with action "self_remove" directly.` : ''}
```

- [ ] **Step 4: Build `secretaryForLine` in `message.handler.ts`**

In `buildAgentContextFactory`, after assembling the base context:
```typescript
const activeFor = deps.secretaryRepo?.getActiveSecretaryFor(user.telegram_id) ?? [];
const secretaryForLine = activeFor.length > 0
  ? activeFor.map(r => {
      const owner = deps.userRepo.findByTelegramId(r.owner_id);
      const name = owner?.username ? `@${owner.username}` : `User ${r.owner_id}`;
      return `${name} (${r.permission === 'write' ? 'read+write' : 'read only'})`;
    }).join(', ')
  : undefined;

return { ...baseCtx, secretaryRepo: deps.secretaryRepo, secretaryForLine };
```

- [ ] **Step 5: Run — verify PASS**

```bash
bun test test/services/ai/system-prompt.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/services/ai/system-prompt.ts src/bot/handlers/message.handler.ts test/services/ai/system-prompt.test.ts
git commit -m "feat: add secretary access section to system prompt"
```

---

## Task 10: Cron — expire pending invites

**Files:**
- Create: `src/worker/secretary-expiry.ts`
- Create: `src/worker/bot-tasks-queue.ts`
- Modify: `src/bot/index.ts`
- Test: `test/worker/secretary-expiry.test.ts`

**Pattern:** BullMQ `queue.add(..., { repeat: { every: ... } })` — same as `src/services/google/sync-cron.ts`. Do NOT use `setInterval`.

Also add `getPendingExpired()` to `SecretaryRepository` and a corresponding test in `test/database/repositories/secretary.repository.test.ts`:

```typescript
// add to secretary.repository.test.ts
test('getPendingExpired returns pending records older than 7 days', () => {
  // insert a record with old created_at via raw SQL to simulate age
  repo['db'].prepare(
    `INSERT INTO calendar_secretaries (owner_id, secretary_id, permission, status, created_at, updated_at)
     VALUES (50, 51, 'read', 'pending', datetime('now', '-8 days'), datetime('now', '-8 days'))`
  ).run();
  const result = repo.getPendingExpired();
  expect(result.length).toBeGreaterThan(0);
  expect(result[0].owner_id).toBe(50);
});
```

- [ ] **Step 2: Write failing test**

```typescript
// test/worker/secretary-expiry.test.ts
import { test, expect, mock } from 'bun:test';
import { runSecretaryExpiry } from '../../../src/worker/secretary-expiry.ts';

test('expiry: expires pending records then notifies owner with username', async () => {
  const expired = [
    { id: 1, owner_id: 10, secretary_id: 20, permission: 'read' as const,
      status: 'pending' as const, created_at: '', updated_at: '' },
  ];
  const mockExpirePending = mock(() => expired); // returns records it just expired
  const mockNotify = mock(async () => {});
  const mockFindUser = mock(() => ({ username: 'john_sec', first_name: 'John' }));

  await runSecretaryExpiry({
    secretaryRepo: { expirePending: mockExpirePending } as never,
    userRepo: { findByTelegramId: mockFindUser } as never,
    notify: mockNotify,
  });

  expect(mockExpirePending).toHaveBeenCalled();
  expect(mockNotify).toHaveBeenCalledWith(10, expect.stringContaining('@john_sec'));
  expect(mockNotify).toHaveBeenCalledWith(10, expect.stringContaining('истекло'));
});
```

- [ ] **Step 3: Implement `src/worker/secretary-expiry.ts`**

Redesign `expirePending()` in `SecretaryRepository` to return the just-expired records (expire + return in one call, fixes TOCTOU):

```typescript
// In secretary.repository.ts — replace expirePending():
expirePending(): CalendarSecretary[] {
  const toExpire = this.getPendingExpired();
  if (toExpire.length > 0) {
    this.db.prepare(
      `UPDATE calendar_secretaries SET status = 'expired', updated_at = datetime('now')
       WHERE status = 'pending' AND created_at < datetime('now', '-7 days')`
    ).run();
  }
  return toExpire;
}

getPendingExpired(): CalendarSecretary[] {
  return this.db.prepare(
    `SELECT * FROM calendar_secretaries WHERE status = 'pending' AND created_at < datetime('now', '-7 days')`
  ).all() as CalendarSecretary[];
}
```

Update `test/database/repositories/secretary.repository.test.ts` — change existing `expirePending` test to check returned records:
```typescript
test('expirePending returns expired records and marks them expired', () => {
  repo['db'].prepare(
    `INSERT INTO calendar_secretaries (owner_id, secretary_id, permission, status, created_at, updated_at)
     VALUES (7, 8, 'read', 'pending', datetime('now', '-8 days'), datetime('now', '-8 days'))`
  ).run();
  const result = repo.expirePending();
  expect(result.length).toBeGreaterThan(0);
  expect(repo.findByOwnerAndSecretary(7, 8)!.status).toBe('expired');
});
```

Then `runSecretaryExpiry`:

```typescript
// src/worker/secretary-expiry.ts
import type { CalendarSecretary } from '../database/types.ts';
import type { UserRepository } from '../database/repositories/user.repository.ts';
import { logger } from '../utils/logger.ts';

export async function runSecretaryExpiry(deps: {
  secretaryRepo: { expirePending(): CalendarSecretary[] };
  userRepo: Pick<UserRepository, 'findByTelegramId'>;
  notify: (userId: number, text: string) => Promise<void>;
}): Promise<void> {
  const expired = deps.secretaryRepo.expirePending(); // expire first, then notify

  for (const record of expired) {
    const secUser = deps.userRepo.findByTelegramId(record.secretary_id);
    const name = secUser?.username ? `@${secUser.username}` : secUser?.first_name ?? `User ${record.secretary_id}`;
    await deps.notify(record.owner_id,
      `Приглашение для ${name} истекло — нет ответа в течение 7 дней.`
    ).catch(err => logger.error({ err, recordId: record.id }, 'failed to send expiry notification'));
  }
}
```

Then create `src/worker/bot-tasks-queue.ts` — a BullMQ queue for bot maintenance crons, following the exact pattern of `src/services/google/sync-queue.ts`:

```typescript
// src/worker/bot-tasks-queue.ts
import { Queue, Worker } from 'bullmq';
import { parseRedisUrl } from '../utils/redis.ts';
import { logger } from '../utils/logger.ts';

const botTasksLogger = logger.child({ module: 'bot-tasks' });

export type BotTaskJobType = 'cron-secretary-expiry';

export interface BotTaskJobData {
  type: BotTaskJobType;
}

interface BotTasksQueueDeps {
  redisUrl: string;
  onSecretaryExpiry?: () => Promise<void>;
}

export function createBotTasksQueue(deps: BotTasksQueueDeps) {
  const connection = parseRedisUrl(deps.redisUrl);

  const queue = new Queue<BotTaskJobData>('bot-tasks', {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 10_000 },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500 },
    },
  });

  const worker = new Worker<BotTaskJobData>(
    'bot-tasks',
    async (job) => {
      if (job.data.type === 'cron-secretary-expiry') {
        if (deps.onSecretaryExpiry) await deps.onSecretaryExpiry();
        return;
      }
    },
    { connection, concurrency: 1 },
  );

  worker.on('failed', (job, err) => {
    if (!job) return;
    botTasksLogger.error({ jobId: job.id, type: job.data.type, error: err.message }, 'Bot task job failed');
  });

  return { queue, worker };
}

export async function setupSecretaryExpiryCron(queue: Queue<BotTaskJobData>): Promise<void> {
  await queue.add(
    'secretary-expiry-tick',
    { type: 'cron-secretary-expiry' },
    { repeat: { every: 24 * 60 * 60_000 }, removeOnComplete: true, jobId: 'secretary-expiry-tick' },
  );
  botTasksLogger.info('Secretary expiry cron scheduled (daily)');
}
```

Wire in `src/bot/index.ts`:
```typescript
import { createBotTasksQueue, setupSecretaryExpiryCron } from '../worker/bot-tasks-queue.ts';
import { runSecretaryExpiry } from '../worker/secretary-expiry.ts';

const { queue: botTasksQueue } = createBotTasksQueue({
  redisUrl: config.REDIS_URL,
  onSecretaryExpiry: () => runSecretaryExpiry({
    secretaryRepo,
    userRepo: db.users,
    notify: (userId, text) => bot.api.sendMessage(userId, text),
  }),
});
await setupSecretaryExpiryCron(botTasksQueue);
```

- [ ] **Step 4: Run — verify PASS**

```bash
bun test test/worker/secretary-expiry.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/worker/secretary-expiry.ts src/worker/bot-tasks-queue.ts src/database/repositories/secretary.repository.ts src/bot/index.ts test/worker/secretary-expiry.test.ts
git commit -m "feat: add secretary invite expiry cron job via BullMQ"
```

---

## Task 11: Wiring — `src/bot/index.ts`

**Files:**
- Modify: `src/bot/index.ts`

- [ ] **Step 1: Add `SecretaryRepository` to bot deps**

```typescript
import { SecretaryRepository } from '../database/repositories/secretary.repository.ts';
// In createBot or equivalent:
const secretaryRepo = new SecretaryRepository(db.database);
```

Pass `secretaryRepo` to:
- `buildAgentContextFactory` (for system prompt + tool handlers)
- Callback handler deps (for `sec:accept` / `sec:decline`)
- Secretary expiry cron (if wired here)

- [ ] **Step 2: Run full test suite**

```bash
bun test
```

Fix any wiring failures. No new tests needed here — existing tests cover the components.

- [ ] **Step 3: Smoke test manually**

Start bot, try: "добавь Боба секретарём". Verify invite message arrives. Accept — verify access granted and owner notified.

- [ ] **Step 4: Final commit**

```bash
git add src/bot/index.ts
git commit -m "feat: wire SecretaryRepository into bot deps"
```

---

## Done

All tasks complete when `bun test` passes with no failures and `bun run lint` reports zero warnings.
