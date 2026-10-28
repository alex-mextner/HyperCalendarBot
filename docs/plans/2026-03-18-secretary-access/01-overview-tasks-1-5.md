> Part 1 of 2 of [Secretary Access Implementation Plan](../2026-03-18-secretary-access.md) — next: [02-tasks-6-11.md](02-tasks-6-11.md)

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

