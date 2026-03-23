# Remove `as unknown as` Casts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace all 126 `as unknown as` double-casts with proper GramIO types, `ctx.is()` narrowing, and correct interfaces — zero unsafe casts remaining.

**Architecture:**
- `BotCommandContext` / `BotCallbackContext` in `types.ts` stay as intersection types with `MessageContext<AnyBot>` / `CallbackQueryContext<AnyBot>`, changed from `as unknown as T` to `as T` (single cast) at registration sites.
- Scene step handlers gain proper update-type narrowing via `ctx.is('message')` / `ctx.is('callback_query')` instead of manual casts.
- `group-context.ts` helpers accept `{ chat?: { type: string; id: number } }` — already satisfied by `BotCommandContext` without cast.
- Non-GramIO casts (dh-exchange, web server) fixed with typed interfaces.

**Tech Stack:** GramIO, @gramio/scenes, Bun, TypeScript, biome

---

## Key GramIO type facts (read before editing)

- `Context<Bot>.is('message')` narrows `this` to `ContextType<Bot, 'message'> & Derives`.
  Use `ctx.is('message')` / `ctx.is('callback_query')` inside step handlers that receive a union.
- `MessageContext<AnyBot>` has `.chat: Chat`, `.chatId: number`, `.from`, `.text`, `.args` (in command handlers).
- `CallbackQueryContext<AnyBot>` has `.chatId?: number`, `.message?: MessageContext`, `.payload.data`, `.editText()`.
- `Context.updateType` is **protected** — not accessible in TS. Use `ctx.is()` instead.
- Scene `.onEnter()` context is typed as `ContextType<Bot, 'message'>` by @gramio/scenes, even when entered from a callback_query. When `editText` is needed, a single cast `(context as { editText: ... })` is the minimum required — NOT double cast.
- `(ctx as SomeInterface).prop` (single cast) is acceptable when TypeScript sees structural overlap.
  `(ctx as unknown as X)` (double cast) is NOT acceptable — it bypasses all type checks.

---

## File structure

| File | Action | Notes |
|---|---|---|
| `src/bot/group-context.ts` | Modify | Loosen `CtxWithChat` so `BotCommandContext` satisfies it natively |
| `src/bot/types.ts` | Modify | Ensure `BotCommandContext` / `BotCallbackContext` cover all needed props |
| `src/bot/scenes/timezone.scene.ts` | Modify | Replace 13 double-casts with `ctx.is()` + single casts for framework limits |
| `src/bot/scenes/onboarding.scene.ts` | Modify | Replace 10 double-casts |
| `src/bot/scenes/edit-value.scene.ts` | Modify | Replace 3 double-casts |
| `src/bot/scenes/import.scene.ts` | Modify | Replace 1 double-cast |
| `src/bot/index.ts` | Modify | Replace 45 double-casts: middleware (use `ctx.is()`) + command registrations |
| `src/bot/handlers/callback.handler.ts` | Modify | Replace 10 double-casts |
| `src/bot/handlers/message.handler.ts` | Modify | Replace 5 double-casts |
| `src/bot/commands/edit.ts` | Modify | 3 casts |
| `src/bot/commands/delete.ts` | Modify | 4 casts |
| `src/bot/commands/settings.ts` | Modify | 1 cast |
| `src/bot/commands/{week,month,today,tomorrow,free,search,import,birthdays}` | Modify | 2 casts each (isGroup pattern) |
| `src/bot/commands/add.ts` | Modify | 1 cast |
| `src/services/voice-call/dh-exchange.ts` | Modify | 4 casts (MTProto transport interface) |
| `src/web/server.ts` | Modify | 1 cast (Bun.serve type) |
| `src/worker/ai-messages-queue.ts` | Modify | 2 casts |
| `src/services/ai/tool-executor.ts` | Modify | 2 casts |
| `src/services/ai/telegram-sender.ts` | Modify | 1 cast |
| `src/services/ai/tool-handlers/settings.ts` | Modify | 1 cast |
| `src/services/voice/ntgcalls-ffi.ts` | Modify | 1 cast |
| Remaining files (pipeline, middleware, scenes/storage, etc.) | Modify | All remaining |

---

## Task 0: Establish baseline

- [ ] **Step 1: Record tsc error count**

```bash
tsc --noEmit 2>&1 | wc -l
```
Save this number. All subsequent tasks must not increase it.

- [ ] **Step 2: Confirm total cast count**

```bash
grep -rn "as unknown as" src/ --include="*.ts" | wc -l
```
Expected: 126 (or current count at time of execution).

---

## Task 1: Loosen `CtxWithChat` — fix 12 `isGroup` casts in commands

**Files:**
- Modify: `src/bot/group-context.ts`
- Test: `bun test test/bot/commands/` (if exists) or at minimum `bun run lint`

`BotCommandContext` extends `MessageContext<AnyBot>` which has `chat: Chat` (non-optional, has `type: TelegramChatType`). The current `CtxWithChat.chat` is optional and uses our own `ChatType` — structurally compatible, but TypeScript can't prove it without a cast.

Fix: broaden the parameter types to use `string` for `type` and `number` for `id`, making `MessageContext<AnyBot>` (and thus `BotCommandContext`) natively assignable without cast.

- [ ] **Step 1: Write failing test** — verify that `isGroup` and `getGroupId` accept a real `MessageContext`-compatible value without cast

```ts
// test/bot/group-context.test.ts
import { test, expect } from 'bun:test';
import { isGroup, getGroupId } from '../../src/bot/group-context.ts';

test('isGroup accepts group chat object', () => {
  const ctx = { chat: { type: 'group', id: 123 } };
  expect(isGroup(ctx)).toBe(true);
});

test('isGroup accepts private chat', () => {
  const ctx = { chat: { type: 'private', id: 456 } };
  expect(isGroup(ctx)).toBe(false);
});

test('getGroupId returns null for private', () => {
  const ctx = { chat: { type: 'private', id: 1 } };
  expect(getGroupId(ctx)).toBeNull();
});

test('getGroupId returns id for supergroup', () => {
  const ctx = { chat: { type: 'supergroup', id: 999 } };
  expect(getGroupId(ctx)).toBe(999);
});
```

- [ ] **Step 2: Run test — verify it fails** (import error or type error is fine)

```bash
bun test test/bot/group-context.test.ts
```

- [ ] **Step 3: Update `group-context.ts`**

```ts
export type ChatType = 'group' | 'supergroup' | 'private' | 'channel';

export interface CtxWithChat {
  chat?: { type: string; id: number };
}

export function isGroup(ctx: CtxWithChat): boolean {
  return ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
}

export function getGroupId(ctx: CtxWithChat): number | null {
  if (!isGroup(ctx)) return null;
  return ctx.chat?.id ?? null;
}
```

- [ ] **Step 4: Remove `as unknown as CtxWithChat` from all command files**

Files to edit (remove the cast — just pass `ctx` directly):
- `src/bot/commands/week.ts` lines ~27-28
- `src/bot/commands/month.ts` lines ~27-28
- `src/bot/commands/today.ts` lines ~26-27
- `src/bot/commands/tomorrow.ts` lines ~26-27
- `src/bot/commands/free.ts` lines ~22-23
- `src/bot/commands/search.ts` lines ~28-29
- `src/bot/commands/import.ts` line ~13
- `src/bot/commands/add.ts` line ~24
- `src/bot/commands/birthdays.ts` lines ~58-59
- `src/bot/handlers/callback.handler.ts` line ~415

Pattern to replace in each file:
```ts
// Before:
if (isGroup(ctx as unknown as CtxWithChat)) {
// After:
if (isGroup(ctx)) {

// Before:
const groupId = getGroupId(ctx as unknown as CtxWithChat);
// After:
const groupId = getGroupId(ctx);
```

- [ ] **Step 5: Run tests + lint**

```bash
bun test test/bot/group-context.test.ts
bun run lint
```
Expected: tests pass, 0 lint warnings.

- [ ] **Step 6: Commit**

```bash
git add src/bot/group-context.ts test/bot/group-context.test.ts \
  src/bot/commands/week.ts src/bot/commands/month.ts \
  src/bot/commands/today.ts src/bot/commands/tomorrow.ts \
  src/bot/commands/free.ts src/bot/commands/search.ts \
  src/bot/commands/import.ts src/bot/commands/add.ts \
  src/bot/commands/birthdays.ts src/bot/handlers/callback.handler.ts
git commit -m "fix(types): loosen CtxWithChat — remove as unknown as from isGroup/getGroupId calls"
```

---

## Task 2: Fix `timezone.scene.ts` — 13 casts

**Files:**
- Modify: `src/bot/scenes/timezone.scene.ts`
- Test: existing scene tests + `bun run lint`

The scene step handlers receive `ContextType<Bot, 'message'> | ContextType<Bot, 'callback_query'>` union. Use `ctx.is()` to narrow. For `editText` in `onEnter` (typed as message context by @gramio/scenes but called from callback_query at runtime), use a **single cast** — this is a framework limitation.

- [ ] **Step 1: Establish tsc baseline before any changes**

```bash
tsc --noEmit 2>&1 | wc -l
```
Record this number. After all tasks, the count must not increase.

- [ ] **Step 2: Verify existing timezone scene test (if any) passes**

```bash
bun test 2>&1 | grep -i timezone
```

- [ ] **Step 3: Replace casts in `timezone.scene.ts`**

```bash
grep -n "as unknown as" src/bot/scenes/timezone.scene.ts
```

Replace each `context as unknown as { ... }` occurrence with proper narrowing or single cast.

**`onEnter` — `editText` (framework limit, single cast):**
```ts
// Before:
const cbCtx = context as unknown as {
  editText: (text: string, opts?: unknown) => Promise<unknown>;
};
await cbCtx.editText(chooserText, { reply_markup: chooserKb });

// After:
await (context as { editText: (text: string, opts?: unknown) => Promise<unknown> })
  .editText(chooserText, { reply_markup: chooserKb });
```

**Step handlers — use `ctx.is()`:**
```ts
// Before (callback_query data):
const data = (context as unknown as { data: string }).data;

// After:
if (!context.is('callback_query')) return;
const data = context.payload.data;
```

```ts
// Before (text input):
const text = (context as unknown as { text?: string }).text?.trim();

// After:
const text = context.is('message') ? context.text?.trim() : undefined;
```

```ts
// Before (bot api access):
const bot = (context as unknown as BotApiCtx).bot;
const chatId = (context as unknown as { chatId?: number }).chatId ?? 0;

// After:
const { bot } = context;
const chatId = context.chatId ?? 0;
```

```ts
// Before (message ctx):
const msg = (context as unknown as { message?: MsgCtx }).message;

// After:
const msg = context.is('callback_query') ? context.message : undefined;
```

```ts
// Before (send result):
await context.scene.update({ geoMsgId: (geoMsg as unknown as { id: number }).id }, { step: undefined });

// After:
const geoMsgResult = geoMsg as { id: number };  // single cast — geoMsg is from bot.api response
await context.scene.update({ geoMsgId: geoMsgResult.id }, { step: undefined });
```

```ts
// Before (tempMsg.delete):
(tempMsg as unknown as MsgCtx).delete().catch(...)

// After:
(tempMsg as MsgCtx).delete().catch(...)
```

Note: Remove the `BotApiCtx` type alias at the top of the file once all usages are eliminated. Remove `MsgCtx` type alias if it's only used as a single cast.

- [ ] **Step 4: Run lint + tsc**

```bash
bun run lint
tsc --noEmit 2>&1 | wc -l
```
Expected: same or fewer tsc errors than baseline.

- [ ] **Step 5: Commit**

```bash
git add src/bot/scenes/timezone.scene.ts
git commit -m "fix(types): remove double casts from timezone.scene.ts using ctx.is() narrowing"
```

---

## Task 3: Fix `onboarding.scene.ts` — 10 casts

**Files:**
- Modify: `src/bot/scenes/onboarding.scene.ts`

Same pattern as Task 2. Each step that handles both `message` and `callback_query` events uses double casts. Replace with `ctx.is()`.

- [ ] **Step 1: Verify existing tests pass before changes**
```bash
bun test
```

- [ ] **Step 3: Replace all double casts**

Pattern (repeated ~10 times):
```ts
// Before:
const data = (context as unknown as { data: string }).data;
// After:
if (!context.is('callback_query')) return;
const data = context.payload.data;

// Before:
const cbCtx = context as unknown as {
  dbUser?: User; editText: ...; scene: ...; answer: ...;
};
// After: remove cbCtx alias, use context.is() + getSceneUser(context)

// Before:
const text = (context as unknown as { text?: string }).text?.trim();
// After:
const text = context.is('message') ? context.text?.trim() : undefined;
```

For `context as unknown as { ... }` where multiple properties are needed:
- Get `dbUser` via `getSceneUser(context)` (already single-cast in helpers.ts — fine)
- Get `editText` via `context.is('callback_query') ? context.editText : null`
- Get `send` via `context.is('message') ? context.send.bind(context) : null`

- [ ] **Step 4: Run test + full test suite**
```bash
bun test test/bot/scenes/onboarding.scene.test.ts
bun test
```

- [ ] **Step 5: Commit**
```bash
git add src/bot/scenes/onboarding.scene.ts test/bot/scenes/onboarding.scene.test.ts
git commit -m "fix(types): remove double casts from onboarding.scene.ts"
```

---

## Task 4: Fix `edit-value.scene.ts` and `import.scene.ts` — 4 casts total

**Files:**
- Modify: `src/bot/scenes/edit-value.scene.ts`
- Modify: `src/bot/scenes/import.scene.ts`

- [ ] **Step 1: Read the 4 cast sites**

```bash
grep -n "as unknown as" src/bot/scenes/edit-value.scene.ts src/bot/scenes/import.scene.ts
```

- [ ] **Step 2: Fix `edit-value.scene.ts` (3 casts)**

```ts
// Before:
const params = (context as unknown as { scene: { params: EditValueParams } }).scene.params;
// After: scene.params is typed from .params<EditValueParams>()
const params = context.scene.params;  // already typed if scene has .params<>() chain

// Before:
const text = (context as unknown as { text?: string }).text;
// After:
const text = context.is('message') ? context.text : undefined;

// Before:
context as unknown as { dbUser?: User; ... }
// After: use getSceneUser(context)
```

- [ ] **Step 3: Fix `import.scene.ts` (1 cast)**

```ts
// Before:
const ctx = context as unknown as {
  document?: { file_id: string; file_name?: string };
  getFile: () => Promise<{ file_path: string }>;
  ...
};
// After:
// context.is('message') gives MessageContext which has document via payload
if (!context.is('message')) return;
const doc = context.document;  // available on MessageContext
```

- [ ] **Step 4: Run tests + lint**
```bash
bun test
bun run lint
```

- [ ] **Step 5: Commit**
```bash
git add src/bot/scenes/edit-value.scene.ts src/bot/scenes/import.scene.ts
git commit -m "fix(types): remove double casts from edit-value and import scenes"
```

---

## Task 5: Fix `index.ts` middleware casts — 11 casts (part 1 of 3 for index.ts)

**Files:**
- Modify: `src/bot/index.ts`

The middleware anonymous handlers use double casts to access `from`, `chatId`, `dbUser`, `send`, etc. Fix using `ctx.is()` narrowing and the known GramIO interfaces.

- [ ] **Step 1: Identify all middleware casts**

```bash
grep -n "as unknown as" src/bot/index.ts | grep -v "BotCommandContext\|BotCallbackContext"
```

- [ ] **Step 2: Fix `runWithChatId` middleware** (line ~368)

```ts
// Before:
.use((context, next) =>
  runWithChatId(Number((context as unknown as { chatId?: number | bigint }).chatId ?? 0), next),
)
// After — chatId is available on base Context (or check via is()):
.use((context, next) => {
  const chatId = 'chatId' in context ? Number((context as { chatId: number | bigint }).chatId) : 0;
  return runWithChatId(chatId, next);
})
```

- [ ] **Step 3: Fix rate-limiter middleware** (lines ~370-384)

```ts
// Before:
const ctx = context as unknown as GramIOContextWithFrom;
const userId = ctx.from?.id;
if (!userId) return next();
const { allowed, firstBlock } = rateLimiter.checkWithWarning(userId);
if (!allowed) {
  if (firstBlock && 'send' in context) {
    const derived = context as unknown as GramIOContextWithDerived;
    const lang = (derived.dbUser?.language ?? 'en') as 'en' | 'ru';
    await derived.send(t(lang).rate_limited);
  }
  return;
}

// After — TargetMixin.from is available on MessageContext and CallbackQueryContext:
.use(async (context, next) => {
  const from = 'from' in context ? (context as { from?: { id: number } }).from : undefined;
  const userId = from?.id;
  if (!userId) return next();
  const { allowed, firstBlock } = rateLimiter.checkWithWarning(userId);
  if (!allowed) {
    if (firstBlock && 'send' in context) {
      const dbUser = 'dbUser' in context ? (context as { dbUser?: { language?: string } }).dbUser : undefined;
      const lang = (dbUser?.language ?? 'en') as 'en' | 'ru';
      await (context as { send: (text: string) => Promise<unknown> }).send(t(lang).rate_limited);
    }
    return;
  }
  return next();
})
```

- [ ] **Step 4: Fix storage cast** (line ~193)

The `scenesSetup.storage` cast exists because `@gramio/storage` type is generic. Examine `createSceneStorage` return type and create a proper interface in `scenes/storage.ts`:

```ts
// In src/bot/scenes/storage.ts — add export:
export interface SceneKvStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}
```

Then in `index.ts`:
```ts
// Before:
const kvStorage = scenesSetup.storage as unknown as {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
};
// After:
import type { SceneKvStorage } from './scenes/storage.ts';
const kvStorage = scenesSetup.storage as SceneKvStorage;
```

- [ ] **Step 5: Fix conversation-logger middleware** (lines ~393-473)

The existing code already uses `ctx.updateType` via a double cast. Replace with `ctx.is()` checks. This was already partially fixed for the log bug — verify it uses single cast only:

```ts
// The type annotation block should be:
const ctx = context as {
  text?: string;
  updateType?: string;  // keep for documentation
  payload?: { data?: string };
  dbUser?: User;
  chatId?: number | bigint;
  send?: (text: string, opts?: Record<string, unknown>) => Promise<unknown>;
  editText?: (text: string, opts?: Record<string, unknown>) => Promise<unknown>;
};
// Verify there's no "as unknown as" — should be single cast
```

- [ ] **Step 6: Fix `prefsService` cast** (line ~285)

```ts
// Before:
...mber) => prefsService.getOrCreate(userId) as unknown as Record<string, unknown>,
// After — check what this is used for and apply the minimum cast:
...mber) => prefsService.getOrCreate(userId) as Record<string, unknown>,
```

- [ ] **Step 7: Fix `callSettingsRepo` cast** (line ~268)

```ts
// Before:
db.callSettings as unknown as AgentContext['callSettingsRepo'],
// After — single cast (types should overlap):
db.callSettings as AgentContext['callSettingsRepo'],
```

- [ ] **Step 8: Run lint**

```bash
bun run lint
```

- [ ] **Step 9: Commit**

```bash
git add src/bot/index.ts src/bot/scenes/storage.ts
git commit -m "fix(types): replace double casts in index.ts middleware with ctx.is() and single casts"
```

---

## Task 6: Fix `index.ts` command registration casts — 20 casts (part 2 of 3 for index.ts)

**Files:**
- Modify: `src/bot/index.ts`

The 20 command registrations all use `ctx as unknown as BotCommandContext`. Since `BotCommandContext = MessageContext<AnyBot> & DerivedProps & ...`, and `MessageContext<AnyBot>` is a structural subset of `BotCommandContext`, a single cast is sufficient — TypeScript sees enough overlap to allow it.

- [ ] **Step 1: Check that single cast works**

Run tsc to see if single cast compiles:
```bash
# Try replacing ONE cast manually, then check:
tsc --noEmit 2>&1 | grep -c "error TS"
```

- [ ] **Step 2: Replace all command registration double casts**

Pattern to apply across all `.command(...)` registrations in `src/bot/index.ts`:
```ts
// Before:
.command('ping', (ctx) => handlePing(ctx as unknown as BotCommandContext))
// After:
.command('ping', (ctx) => handlePing(ctx as BotCommandContext))
```

Same for all ~20 handlers: start, ping, help, today, tomorrow, week, month, add, edit, delete, search, free, settings, import, holidays, birthdays, invite, invitations, share, cal.

For the inline `/cal` handler:
```ts
// Before:
const calCtx = ctx as unknown as BotCommandContext;
// After:
const calCtx = ctx as BotCommandContext;
```

- [ ] **Step 3: Run tsc to verify**

```bash
tsc --noEmit 2>&1 | head -20
```
Expected: same or fewer errors (not more).

- [ ] **Step 4: Run tests + lint**

```bash
bun test
bun run lint
```

- [ ] **Step 5: Commit**

```bash
git add src/bot/index.ts
git commit -m "fix(types): replace double casts in command registrations with single casts"
```

---

## Task 7: Fix `callback.handler.ts` — 10 casts

**Files:**
- Modify: `src/bot/handlers/callback.handler.ts`

The callback handler is typed with `ctx: BotCallbackContext` which is `CallbackQueryContext<AnyBot> & DerivedProps & { scene: SceneAccess }`. `CallbackQueryContext` has `.chatId?: number`, `.message?: MessageContext`, `.chat: Chat` (via TargetMixin via CallbackQuery interface).

- [ ] **Step 1: Check CallbackQueryContext properties**

Already researched:
- `ctx.chatId` — `number | undefined` (override from TargetMixin)
- `ctx.message` — `MessageContext<Bot> | undefined`
- `ctx.message?.id` — `number` (MessageContext has `.id: number`)
- `ctx.chat?.id` — `number` via `Chat.id`

- [ ] **Step 2: Fix each cast**

```ts
// Line ~1034-1035:
// Before:
const settingsMsgId = (ctx as unknown as { message?: { id?: number; message_id?: number } }).message?.id ?? 0;
const settingsChatId = (ctx as unknown as { chatId?: number }).chatId ?? 0;
// After — both available on BotCallbackContext natively:
const settingsMsgId = ctx.message?.id ?? 0;
const settingsChatId = ctx.chatId ?? 0;

// Line ~1053:
// Before:
const chatId = (ctx as unknown as { chat?: { id: number } }).chat?.id;
// After:
const chatId = ctx.chatId;

// Line ~1195, ~1206 (message?.text):
// Before:
(ctx as unknown as { message?: { text?: string } }).message?.text ?? ''
// After:
ctx.message?.text ?? ''
// Note: MessageContext.text is getter — check if ctx.message.text works.
// If not: ctx.message?.payload?.text ?? '' OR use ctx.message?.text ?? ''
```

- [ ] **Step 3: Run lint + tsc**
```bash
bun run lint
tsc --noEmit 2>&1 | head -30
```

- [ ] **Step 4: Commit**
```bash
git add src/bot/handlers/callback.handler.ts
git commit -m "fix(types): remove double casts from callback.handler.ts"
```

---

## Task 8: Fix `message.handler.ts` — 5 casts

**Files:**
- Modify: `src/bot/handlers/message.handler.ts`

- [ ] **Step 1: Locate all 5 cast sites**

```bash
grep -n "as unknown as" src/bot/handlers/message.handler.ts
```

- [ ] **Step 2: Fix each cast**

The voice message cast (accessing `ctx.voice`):
```ts
// Before:
const voiceRaw = (ctx as unknown as { voice?: { ... } }).voice;
// After — voice is on the raw message payload, access via ctx.payload:
const voiceRaw = (ctx as { voice?: { file_id: string; duration: number } }).voice;
// Single cast is sufficient since we're accessing a known payload field
```

The chat/from/id casts (lines ~873, 900, 933-935):
```ts
// Before:
(ctx as unknown as { chat?: { type: string; title?: string } }).chat
// After:
// ctx.chat is on BotCommandContext via MessageContext (type: Chat)
ctx.chat  // Chat has .type and .title

// Before:
(ctx as unknown as { replyToMessage?: { from?: { id?: number } } }).replyToMessage
// After:
// MessageContext has replyMessage or replyToMessage — check actual property name
(ctx as { replyToMessage?: { from?: { id?: number } } }).replyToMessage  // single cast
```

- [ ] **Step 3: Run lint + tests**
```bash
bun run lint
bun test
```

- [ ] **Step 4: Commit**
```bash
git add src/bot/handlers/message.handler.ts
git commit -m "fix(types): remove double casts from message.handler.ts"
```

---

## Task 9: Fix `commands/edit.ts`, `commands/delete.ts`, `commands/settings.ts`

**Files:**
- Modify: `src/bot/commands/edit.ts` (3 casts)
- Modify: `src/bot/commands/delete.ts` (4 casts)
- Modify: `src/bot/commands/settings.ts` (1 cast)

- [ ] **Step 1: Check all casts**

```bash
grep -n "as unknown as" src/bot/commands/edit.ts src/bot/commands/delete.ts src/bot/commands/settings.ts
```

- [ ] **Step 2: Fix `edit.ts`**

```ts
// isGroup cast — fixed by Task 1 (CtxWithChat)

// Line ~106:
// Before:
const messageId = (ctx.message as unknown as { id: number } | undefined)?.id ?? 0;
// After — ctx.message is the GramIO Message object; check if it has .message_id or .id:
// BotCommandContext extends MessageContext which IS the message, so use ctx.id:
const messageId = ctx.id ?? 0;  // MessageContext.id is the message ID
```

- [ ] **Step 3: Fix `delete.ts` (4 casts)**

```bash
grep -n "as unknown as" src/bot/commands/delete.ts
```
Follow same pattern — replace with property access on `BotCommandContext`.

- [ ] **Step 4: Fix `settings.ts` (1 cast)**

```ts
// Line ~291:
// Before:
await (ctx as unknown as { message?: { delete: () => Promise<void> } }).message?.delete();
// After:
// BotCommandContext = MessageContext — the context IS the message, use ctx.delete():
await ctx.delete?.();
// Or if delete is guaranteed:
await (ctx as { delete?: () => Promise<void> }).delete?.();
```

- [ ] **Step 5: Run full test suite**
```bash
bun test
bun run lint
```

- [ ] **Step 6: Commit**
```bash
git add src/bot/commands/edit.ts src/bot/commands/delete.ts src/bot/commands/settings.ts
git commit -m "fix(types): remove double casts from edit/delete/settings command handlers"
```

---

## Task 10: Fix non-GramIO casts — `dh-exchange.ts`, `web/server.ts`, `ai-messages-queue.ts`, `tool-executor.ts`

**Files:**
- Modify: `src/services/voice-call/dh-exchange.ts` (4 casts)
- Modify: `src/web/server.ts` (1 cast)
- Modify: `src/worker/ai-messages-queue.ts` (2 casts)
- Modify: `src/services/ai/tool-executor.ts` (2 casts)

- [ ] **Step 1: Fix `dh-exchange.ts`** — 4 casts for `transport.invoke()`

```bash
grep -n "as unknown as" src/services/voice-call/dh-exchange.ts
```

The transport's `invoke()` method signature is not typed properly. Add a typed interface:
```ts
// Find the type of `transport` parameter in the function
// It's likely `{ invoke(method: string, params: Record<string, unknown>): Promise<unknown> }`
// Currently: transport.invoke('phone.requestCall', payload as unknown as Record<string, unknown>)
// Fix: either type the payload properly, or use single cast
transport.invoke('phone.requestCall', payload as Record<string, unknown>)
```

- [ ] **Step 2: Fix `web/server.ts`** — 1 cast for `Bun.serve()`

```ts
// Before:
const server = Bun.serve(serveOptions as unknown as Parameters<typeof Bun.serve>[0]);
// After — single cast:
const server = Bun.serve(serveOptions as Parameters<typeof Bun.serve>[0]);
```

- [ ] **Step 3: Fix `ai-messages-queue.ts` and `tool-executor.ts`**

```bash
grep -n "as unknown as" src/worker/ai-messages-queue.ts src/services/ai/tool-executor.ts
```

Read each cast site and apply minimum fix (single cast or add proper type).

- [ ] **Step 4: Run lint + tests**
```bash
bun test
bun run lint
```

- [ ] **Step 5: Commit**
```bash
git add src/services/voice-call/dh-exchange.ts src/web/server.ts \
  src/worker/ai-messages-queue.ts src/services/ai/tool-executor.ts
git commit -m "fix(types): remove double casts from non-GramIO files"
```

---

## Task 10.5: Fix remaining `index.ts` casts — part 3 of 3 (14 casts)

**Files:**
- Modify: `src/bot/index.ts`

After Tasks 5 and 6 there are still ~14 casts in `index.ts` in scene/callback/contact-sharing handling blocks (around lines 556, 753, 787, 801, 810, 812, 813, 832, and others).

- [ ] **Step 1: Confirm remaining casts in index.ts**

```bash
grep -n "as unknown as" src/bot/index.ts
```

- [ ] **Step 2: Fix each remaining cast**

These are generally inline casts to access specific properties on context objects inside event handlers. For each:
- If accessing a GramIO property (`chatId`, `chat`, `from`, `dbUser`) → check `BotCommandContext` or `BotCallbackContext` types
- If accessing properties outside GramIO context (e.g. bot API responses) → single cast `as Type`

Example patterns you'll encounter:
```ts
// chat title (for group detection):
(ctx as unknown as { chat?: { type: string; title?: string } }).chat
// Fix → ctx.chat (Chat has .title?: string natively)

// dbUser from context:
(ctx as unknown as { dbUser?: User }).dbUser
// Fix → ctx.dbUser (on BotCommandContext/BotCallbackContext)

// requestId, chat_shared (special message types):
(ctx as unknown as { requestId?: number }).requestId
// Fix → single cast (ctx as { requestId?: number }).requestId
```

- [ ] **Step 3: Run lint**
```bash
bun run lint
```

- [ ] **Step 4: Commit**
```bash
git add src/bot/index.ts
git commit -m "fix(types): remove remaining double casts from index.ts"
```

---

## Task 11: Fix remaining files — pipeline, middleware, other commands

**Files:**
- All remaining files with `as unknown as`

- [ ] **Step 1: Get current count**

```bash
grep -rn "as unknown as" src/ --include="*.ts" | grep -v "^Binary"
```

- [ ] **Step 2: Fix each remaining cast**

For each file, read the cast, understand what type is needed, apply the minimum fix:
- If it's a GramIO context property → use `ctx.is()` or `ctx.property` directly
- If it's a wider structural cast → single cast `as Type`
- Keep a record of any that truly cannot be fixed without framework changes

Likely files remaining after Tasks 1-10.5:
- `src/bot/pipeline/intent-matcher-layer.ts` — `chatId` cast → `ctx.chatId`
- `src/bot/middleware/scene-command-escape.ts` — storage type → single cast
- `src/bot/middleware/callback-fallback.ts` — storage type → single cast
- `src/bot/scenes/storage.ts` — `db as unknown as DatabaseSync` → check bun:sqlite types
- `src/bot/scenes/chat-scoped-storage.ts` — storage cast
- `src/services/ai/telegram-sender.ts` — 1 cast
- `src/services/ai/tool-handlers/settings.ts` — 1 cast
- `src/services/voice/ntgcalls-ffi.ts` — 1 cast
- Other command files

- [ ] **Step 3: Run full suite**
```bash
bun test
bun run lint
tsc --noEmit 2>&1 | wc -l
```

- [ ] **Step 4: Commit**
```bash
git add -p  # stage each changed file carefully
git commit -m "fix(types): remove remaining double casts from pipeline, middleware, commands"
```

---

## Task 12: Final verification — zero double casts, all tests pass

- [ ] **Step 1: Confirm zero `as unknown as` occurrences**

```bash
grep -rn "as unknown as" src/ --include="*.ts"
```
Expected: 0 results.

- [ ] **Step 2: Run full test suite**

```bash
bun test
```
Expected: all tests pass (~1684+).

- [ ] **Step 3: Run tsc**

```bash
tsc --noEmit 2>&1 | head -50
```
Expected: same number of errors as before (0 new errors introduced).

- [ ] **Step 4: Run lint — zero warnings**

```bash
bun run lint
```
Expected: no warnings, no errors.

- [ ] **Step 5: If tsc has new errors, fix them**

For each error, apply the minimum fix — single cast or type annotation.

- [ ] **Step 6: Final commit if any cleanup needed**

```bash
git add -p
git commit -m "fix(types): final cleanup — verify zero as unknown as casts"
```

---

## Notes for executor

- **Do not break working code**: read each cast site before changing it
- **Single cast `as Type` is acceptable** where TypeScript needs help with structural compatibility
- **`ctx.is('message')` is the canonical narrowing** for mixed update type handlers
- **`getSceneUser(context)` and `getSceneLang(context)` in `helpers.ts` use single cast** — leave them as-is
- **tsc baseline**: run `tsc --noEmit 2>&1 | wc -l` before starting and compare after each task
- **Never remove a working test** — if a test breaks, investigate and fix the root cause
