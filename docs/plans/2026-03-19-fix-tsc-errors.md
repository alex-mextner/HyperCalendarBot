# Fix TypeScript Errors + Lefthook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate all TypeScript errors in `src/` and `test/` and add lefthook pre-commit hooks for biome + tsc.

**Architecture:** Fix src/ errors with proper type fixes (null guards, optional chaining, type narrowing, correct return types). Fix test/ errors with `as unknown as T` and `!` assertions freely. Add lefthook as git pre-commit guard.

**Tech Stack:** TypeScript strict mode, lefthook, biome

---

## Error inventory

- `src/` — 118 errors across 20 files
- `test/` — 185 errors across 45 files
- `scripts/` — 4 errors (out of scope — dev tools only)

Run to see src/ + test/ count: `bunx tsc --noEmit 2>&1 | grep -E "^src/|^test/" | grep "error TS" | wc -l`

---

### Task 1: Add lefthook

**Files:**
- Create: `lefthook.yml`
- Modify: `package.json` (add lefthook dev dep + postinstall)

- [ ] **Step 1: Install lefthook**

```bash
bun add -d lefthook
```

- [ ] **Step 2: Create lefthook.yml**

```yaml
pre-commit:
  parallel: false
  commands:
    biome:
      run: node_modules/.bin/biome check .
      fail_text: "Biome lint/format failed — run: bun run lint:fix"
    tsc:
      run: node_modules/.bin/tsc --noEmit
      fail_text: "TypeScript errors found — fix before committing"
```

- [ ] **Step 3: Install hooks**

```bash
bunx lefthook install
```

Expected: creates `.git/hooks/pre-commit`

- [ ] **Step 4: Verify hook file exists**

```bash
cat .git/hooks/pre-commit
```

Expected: lefthook runner script

---

### Task 2: Fix src/services/voice/ and src/services/voice-call/ errors

**Files:**
- Modify: `src/services/voice/stress-marker.ts` (9 errors)
- Modify: `src/services/voice/stress-dictionary.ts` (3 errors)
- Modify: `src/services/voice/thinking-phrase-player.ts` (4 errors)
- Modify: `src/services/voice/call-session-manager.ts` (4 errors)
- Modify: `src/services/voice/call-signaling.ts` (1 error)
- Modify: `src/services/voice/interruption-classifier.ts` (1 error)
- Modify: `src/services/voice-call/dh-exchange.ts` (3 errors)

**Fix strategy:**

`stress-marker.ts` — array element accesses are `string | undefined` due to `noUncheckedIndexedAccess`. Add non-null assertions where the code guarantees the value (after length/bounds checks), or add explicit null guards.

`stress-dictionary.ts` — same pattern: `key` from `Object.keys()` is `string | undefined`. Use `for...of` with non-null assertion, or use `for (const key of Object.keys(dict))` with `!` where array index access returns undefined.

`thinking-phrase-player.ts` — random element from array returns `T | undefined`. Add `!` after the access (it's inside a length guard) or use `?? defaultValue`.

`call-session-manager.ts` — type cast issues: `undefined` being cast to `{ sessionId: string }`. Fix by making the type `{ sessionId: string | undefined }` or use proper conditional logic.

`call-signaling.ts` — `"phoneCallDiscardReasonHangup"` not in `DiscardReason` union. Either add it to the type, or cast with `as DiscardReason`.

`interruption-classifier.ts` — `string | undefined` passed as `string`. Add `?? ''` or `!`.

`dh-exchange.ts` — `number | undefined` passed where `string | number | bigint | boolean` expected. Add null guard or use `!`.

- [ ] **Step 1: Fix stress-marker.ts**

```bash
bunx tsc --noEmit 2>&1 | grep "src/services/voice/stress-marker.ts"
```

Read the file and fix each error:
- Array index access returning `string | undefined` → add `!` where inside a bounds-checked loop
- `string | undefined` passed to function expecting `string` → add `!` or `?? ''`

- [ ] **Step 2: Fix stress-dictionary.ts**

```bash
bunx tsc --noEmit 2>&1 | grep "src/services/voice/stress-dictionary.ts"
```

- `key` from iteration possibly undefined → add `!`
- Array index access → add `!`

- [ ] **Step 3: Fix thinking-phrase-player.ts**

```bash
bunx tsc --noEmit 2>&1 | grep "src/services/voice/thinking-phrase-player.ts"
```

- `T | undefined` → `T`: add `!` (random element inside length guard)
- `string[] | undefined` → `string[]`: add `!` or `?? []`

- [ ] **Step 4: Fix call-session-manager.ts**

```bash
bunx tsc --noEmit 2>&1 | grep "src/services/voice/call-session-manager.ts"
```

- Cast issues between `{ sessionId: string | undefined }` and `{ sessionId: string }`.
  Fix the type definition to match actual usage, or add runtime assertion.

- [ ] **Step 5: Fix call-signaling.ts, interruption-classifier.ts, dh-exchange.ts**

```bash
bunx tsc --noEmit 2>&1 | grep -E "call-signaling|interruption-classifier|dh-exchange"
```

- `call-signaling.ts`: cast `"phoneCallDiscardReasonHangup" as DiscardReason` (or add to type)
- `interruption-classifier.ts`: add `!` or `?? ''` to string
- `dh-exchange.ts`: add null guard `if (val === undefined) throw ...` or `!`

- [ ] **Step 6: Verify 0 errors in these files**

```bash
bunx tsc --noEmit 2>&1 | grep -E "src/services/voice/|src/services/voice-call/"
```

Expected: no output

---

### Task 3: Fix src/services/intent/ errors

**Files:**
- Modify: `src/services/intent/intent-executor.ts` (12 errors)
- Modify: `src/services/intent/variable-resolver.ts` (4 errors)
- Modify: `src/services/intent/intent-matcher.ts` (1 error)

**Fix strategy:**

`intent-executor.ts` — `step` is `WorkflowStep | undefined` after array index access. Add guard `if (!step) return` (or throw) before using it. There are 11 usages on lines 204–263. Read the logic — likely a while/for loop where step could be out of bounds.

`variable-resolver.ts` — array index access returning undefined. Add `!` where logically guaranteed, or `?? ''`.

`intent-matcher.ts` — `string | undefined` → `string`. Add `!` or null guard.

- [ ] **Step 1: Fix intent-executor.ts**

```bash
bunx tsc --noEmit 2>&1 | grep "src/services/intent/intent-executor.ts"
```

Read lines 200–270 of the file. Add a guard before the block that uses `step`:

```ts
const step = workflow.steps[stepIndex];
if (!step) return; // or throw new Error(`Step ${stepIndex} not found`)
```

This fixes all 11 downstream uses in one guard.

- [ ] **Step 2: Fix variable-resolver.ts and intent-matcher.ts**

```bash
bunx tsc --noEmit 2>&1 | grep -E "variable-resolver|intent-matcher"
```

Add `!` after bounded array accesses, add `?? ''` for string defaults.

- [ ] **Step 3: Verify 0 errors in these files**

```bash
bunx tsc --noEmit 2>&1 | grep "src/services/intent/"
```

Expected: no output

---

### Task 4: Fix src/services/image/ and src/worker/ errors

**Files:**
- Modify: `src/services/image/data-mapper.ts` (6 errors)
- Modify: `src/worker/templates/helpers.ts` (12 errors)
- Modify: `src/worker/templates/daily-agenda.ts` (2 errors)
- Modify: `src/worker/image-render.queue.ts` (2 errors)
- Modify: `src/worker/templates/labels.ts` (1 error)

**Fix strategy:**

`data-mapper.ts` — `string | undefined` → `string`: add `!` where value is derived from known data, or `?? ''`. WeekDay array type mismatch: ensure `dayName` is `string` (not `string | undefined`) — use `format(date, 'EEE') ?? ''` or similar.

`helpers.ts` — 12 errors, all array index accesses returning undefined. Add `!` where inside bounds-checked loops.

`daily-agenda.ts` — `col` possibly undefined: add guard `if (!col) continue`.

`image-render.queue.ts`:
- `document` not found (line 40): this is inside a `page.evaluate()` Playwright callback — the `document` reference runs in the browser context, not Node. Fix by casting inside the callback: `(globalThis as unknown as { document: Document }).document` or simply `// @ts-expect-error - browser context`. Do NOT add `/// <reference lib="dom" />` — that would pollute the server-side type environment.
- `timeout` not in `DefaultJobOptions`: remove the `timeout` property or use the correct BullMQ v4 option name (`jobTimeout` or similar).

`labels.ts` — `Labels | undefined` → `Labels`: add `!` or null guard.

- [ ] **Step 1: Fix data-mapper.ts**

```bash
bunx tsc --noEmit 2>&1 | grep "src/services/image/data-mapper.ts"
```

Fix `string | undefined` → add `!` or `?? ''`. For WeekDay type, ensure `dayName: string` by asserting `format(...)!` or `String(format(...))`.

- [ ] **Step 2: Fix helpers.ts**

```bash
bunx tsc --noEmit 2>&1 | grep "src/worker/templates/helpers.ts"
```

12 array index accesses → add `!` inside loops that already checked length.

- [ ] **Step 3: Fix daily-agenda.ts, image-render.queue.ts, labels.ts**

```bash
bunx tsc --noEmit 2>&1 | grep -E "daily-agenda|image-render.queue|labels.ts"
```

- `daily-agenda.ts`: `if (!col) continue` before block
- `image-render.queue.ts`: check if `timeout` should be `removeOnComplete`/`attempts`. Remove or rename.
  For `document` (line 40, inside `page.evaluate()`): add `// @ts-expect-error - browser context` on the line above, or cast `(globalThis as unknown as { document: Document }).document`. Do NOT use `/// <reference lib="dom" />`.
- `labels.ts`: add `!` or early return guard

- [ ] **Step 4: Verify 0 errors in these files**

```bash
bunx tsc --noEmit 2>&1 | grep -E "src/services/image/|src/worker/"
```

Expected: no output

---

### Task 5: Fix src/services/ai/ errors

**Files:**
- Modify: `src/services/ai/telegram-sender.ts` (3 errors)
- Modify: `src/services/ai/tool-executor.ts` (3 errors)
- Modify: `src/services/ai/tool-handlers/settings.ts` (1 error)
- Modify: `src/services/ai/tool-handlers/sharing.ts` (3 errors)

**Fix strategy:**

`telegram-sender.ts` — `parse_mode?: string` but GramIO expects `parse_mode: "HTML" | "MarkdownV2" | "Markdown"`. Fix the type to `parse_mode?: "HTML" | "MarkdownV2" | "Markdown"`.

`tool-executor.ts`:
- `string | undefined` → `string`: add `!` or throw
- `ManageSettingsInput` mismatch: check what properties differ — add missing required fields or cast with `as ManageSettingsInput`
- `ProposeInput` cast: use `as unknown as ProposeInput`

`tool-handlers/settings.ts` — `SharingSettings` → `Record<string, unknown>`: use `as unknown as Record<string, unknown>`.

`tool-handlers/sharing.ts`:
- `sender.sendInvitation` possibly undefined: add `if (!sender.sendInvitation) throw ...`
- `string | null` → `string | undefined`: replace `null` with `undefined ?? undefined` or use `?? undefined`

- [ ] **Step 1: Fix telegram-sender.ts**

```bash
bunx tsc --noEmit 2>&1 | grep "src/services/ai/telegram-sender.ts"
```

Change `parse_mode?: string` to `parse_mode?: "HTML" | "MarkdownV2" | "Markdown"` in the params objects.

- [ ] **Step 2: Fix tool-executor.ts, settings.ts, sharing.ts**

```bash
bunx tsc --noEmit 2>&1 | grep -E "tool-executor|tool-handlers/settings|tool-handlers/sharing"
```

Apply targeted fixes per error above.

- [ ] **Step 3: Verify 0 errors in these files**

```bash
bunx tsc --noEmit 2>&1 | grep "src/services/ai/"
```

Expected: no output

---

### Task 6: Fix src/bot/ errors

**Files:**
- Modify: `src/bot/handlers/callback.handler.ts` (8 errors)
- Modify: `src/bot/handlers/message.handler.ts` (11 errors)
- Modify: `src/bot/index.ts` (6 errors)
- Modify: `src/bot/commands/share.ts` (2 errors)
- Modify: `src/bot/commands/month.ts` (2 errors)
- Modify: `src/bot/scenes/onboarding.scene.ts` (1 error)
- Modify: `src/bot/scenes/storage.ts` (1 error)

**Fix strategy:**

`callback.handler.ts`:
- `invitation` property missing from return type — update the return type of `acceptInvitation` (or wherever the result comes from) to include `invitation?`, or narrow the type check before accessing it.
- `lang` not defined (lines 760, 769, 772) — add `const lang = user.language` or similar before that block.
- `StressDictionary` mismatch — the object `{ lookup: (word: string) => string | null }` is missing required properties. Either cast or add the missing fields to the object.

`message.handler.ts` — 11 errors on line 206, 209, 218. These are array index accesses from `noUncheckedIndexedAccess`. Add `!` or destructure with defaults. Also `Partial<Pick<Intent, ...>>` mismatch — align the type of the update object with `Intent` column types.

`bot/index.ts`:
- Expected 1 arg, got 2 — remove the extra argument.
- `Storage<Record<string, any>>` vs `Storage` — cast or adjust generic.
- `string` → `"HTML" | "MarkdownV2"` — add `as "HTML"` or use the literal.
- `editMessageText` params mismatch — add required fields or cast with `as`.
- `EventService` type mismatch — align `createEvent`/`updateEvent`/`deleteEvent` return types. Read both the service and the expected type.
- `Promise<void | TelegramMessage>` → `Promise<void>` — add `.then(() => {})` to discard the result.

`share.ts` — `string | undefined` → `string`: add `!` or throw early.

`month.ts` — `"monthly-calendar"` not in union. The render type needs to include `"monthly-calendar"`. Check `src/services/image/` for the type definition and add it. Also `MonthlyCalendarData` needs to be added to the data union.

`onboarding.scene.ts` — `string | null` → `string | undefined`: replace `null` with `undefined`.

`scenes/storage.ts` — `Database` (bun:sqlite async) missing properties from `DatabaseSync`. Either import `DatabaseSync` instead of `Database`, or cast with `as unknown as DatabaseSync`.

- [ ] **Step 1: Fix callback.handler.ts**

```bash
bunx tsc --noEmit 2>&1 | grep "src/bot/handlers/callback.handler.ts"
```

- Find where `lang` is missing and add `const lang = ...`
- Fix `invitation` property: update return type or add type guard
- Fix `StressDictionary`: add missing fields or cast

- [ ] **Step 2: Fix message.handler.ts**

```bash
bunx tsc --noEmit 2>&1 | grep "src/bot/handlers/message.handler.ts"
```

Read lines 200–220. Add `!` on array accesses that are inside bounds-checked logic.

- [ ] **Step 3: Fix bot/index.ts**

```bash
bunx tsc --noEmit 2>&1 | grep "src/bot/index.ts"
```

Fix each error individually: argument count, parse_mode literal, editMessageText params, EventService return type alignment, Promise<void> discards.

- [ ] **Step 4: Fix month.ts (add monthly-calendar to render types)**

```bash
bunx tsc --noEmit 2>&1 | grep "src/bot/commands/month.ts"
```

Find the render type union (likely in `src/services/image/types.ts` or similar) and add `"monthly-calendar"` + `MonthlyCalendarData` to it.

- [ ] **Step 5: Fix share.ts, onboarding.scene.ts, scenes/storage.ts**

```bash
bunx tsc --noEmit 2>&1 | grep -E "src/bot/commands/share.ts|onboarding.scene|scenes/storage"
```

- `share.ts`: add `!` or throw on undefined strings
- `onboarding.scene.ts`: `null` → `undefined`
- `scenes/storage.ts`: use `DatabaseSync` import or cast

- [ ] **Step 6: Verify 0 errors in these files**

```bash
bunx tsc --noEmit 2>&1 | grep "src/bot/"
```

Expected: no output

---

### Task 7: Fix src/database/ and src/index.ts errors

**Files:**
- Modify: `src/database/repositories/intent.repository.ts` (1 error)
- Modify: `src/index.ts` (7 errors)

**Fix strategy:**

`intent.repository.ts` — `unknown[]` not assignable to SQL bindings union. Cast with `as SQLQueryBindings[]`.

`src/index.ts`:
- `Promise<{ message_id: number }>` → `Promise<void>`: `.then(() => {})` or `void` cast
- `Queue` generic type mismatch: align the Queue instantiation generics
- WebSocket `send(data: string)` vs `send(data: string | Buffer)`: add `| Buffer` to the type or cast
- `CallReminderJobData` mismatch: check the type definition and align field names
- Two more Promise<void> discards

- [ ] **Step 1: Fix intent.repository.ts**

```bash
bunx tsc --noEmit 2>&1 | grep "src/database/repositories/intent.repository.ts"
```

Add `as SQLQueryBindings[]` cast on the bindings array.

- [ ] **Step 2: Fix src/index.ts**

```bash
bunx tsc --noEmit 2>&1 | grep "^src/index.ts"
```

Fix each error: void discards, Queue generics, WebSocket send type, CallReminderJobData fields.

- [ ] **Step 3: Verify 0 errors in these files**

```bash
bunx tsc --noEmit 2>&1 | grep -E "^src/index.ts|src/database/"
```

Expected: no output

---

### Task 8: Fix all test/ errors

**Strategy:** Use `as unknown as T` and `!` freely. No real fixes — just make the compiler happy.

**Files (45 files, 185 errors):**

Group by error pattern:

**Pattern A — `Mock<...>` cast to `typeof fetch`** (8 occurrences across 5 files):
```ts
// before:
global.fetch = mock(...) as typeof fetch;
// after:
global.fetch = mock(...) as unknown as typeof fetch;
```
Files: `test/bot/handlers/voice-prompt.test.ts`, `message.handler.test.ts`, `intent-verification.test.ts`, `transcription-service.test.ts`

**Pattern B — `[] | undefined` cast to tuple** (7 occurrences):
```ts
// before:
mock.calls[0] as [string, { reply_markup: unknown }]
// after:
mock.calls[0] as unknown as [string, { reply_markup: unknown }]
```
Files: `share.test.ts`, `voice-prompt.test.ts`, `callback-invitation.test.ts`, `secretary.test.ts`, `feedback.test.ts`

**Pattern C — `null` cast to data type** (6 occurrences in `add.test.ts`):
```ts
null as unknown as CreateEventData
```

**Pattern D — `.mock` property missing on ctx.send/editText** (20 occurrences in `settings.test.ts`):
```ts
// ctx.send is typed as GramIO method, not a mock
// Cast ctx to have mock properties:
(ctx.send as unknown as Mock<any>).mock.calls
// Or cast the whole ctx at setup time
```
This is the biggest block. Read how `ctx` is constructed in `settings.test.ts` and add a proper cast at the top.

**Pattern E — `isGroup` missing from AgentContext** (4 files):
```ts
// Add isGroup: false to test context objects
{ ...existingContext, isGroup: false }
```
Files: `test/services/ai/tool-executor.test.ts`, `test/services/ai/tool-handlers/feedback.test.ts`, `test/services/ai/tool-handlers/settings.test.ts`, `test/services/sharing/shared-events.test.ts`

**Pattern F — `timezone` missing from CreateEventData** (2 occurrences in `proposals.test.ts`):
```ts
{ title: '...', start_at: '...', end_at: '...', timezone: 'UTC' }
```

**Pattern G — `Object is possibly undefined` in test assertions** (20+ occurrences):
```ts
// before:
expect(result[0].title).toBe(...)
// after:
expect(result[0]!.title).toBe(...)
```

**Pattern H — callback_data property missing** (`calendars.test.ts`):
```ts
(button as unknown as { callback_data: string }).callback_data
```

**Pattern I — Expected 1 arg, got 2** (`feedback-router-layer.test.ts` × 4, `pipeline.integration.test.ts` × 1):
Read the function signature and remove the extra argument.

**Pattern J — SceneAccess cast issues** (`add.test.ts`):
```ts
scene as unknown as { enter: Mock<...> }
```

**Pattern K — string[] assigned to string** (`intent.repository.test.ts` × 3):
Likely `JSON.parse` returns `string[]` but test expects `string`. Fix the assertion or add `JSON.stringify`.

**Pattern L — `InlineServiceLike` mock mismatch** (`inline.handler.test.ts` × 7):
```ts
{ parseQuery: mock(...), buildResults: mock(...) } as unknown as InlineServiceLike
```

**Pattern M — Tuple index out of bounds + casts** (`inline-debounce.test.ts` × 4, `callback-fallback.test.ts` × 8):
- `mock.calls[0]` → `(mock.calls as unknown as [...])[0]` or `mock.calls[0] as unknown as [...]`
- `undefined` cast to `{ text: string }` → `undefined as unknown as { text: string }`

**Pattern N — Sharing test mocks** (`shared-events.test.ts` × 17, `sharing-service.test.ts` × 8, `inline-service.test.ts` × 6, `share-session.test.ts` × 1):
- `isGroup` missing (see Pattern E) + other mock type mismatches → `as unknown as T`
- `.mock` on Redis client method → cast or use `vi.mocked()`

**Pattern O — Misc single-file errors** (remaining files):
- `test/bot/scenes/helpers.test.ts` (1): overload mismatch → `as unknown as T`
- `test/bot/scenes/timezone.scene.test.ts` (1): possibly undefined invocation → add `!`
- `test/worker/playwright-pool.test.ts` (1): `document` not found → `// @ts-expect-error`
- `test/database/repositories/call-log.repository.test.ts` (1), `feedback.repository.test.ts` (7), `secretary.repository.test.ts` (1): array index `undefined` → add `!`
- `test/services/voice/call-session.test.ts` (2): mock function signature mismatch → `as unknown as T`
- `test/services/voice-call/dh-exchange.test.ts` (2): cast issues → `as unknown as T`
- `test/services/notification/scheduler.test.ts` (2): `EnqueueCallData` mock → `as unknown as T`
- `test/services/feedback/admin-messenger.test.ts` (2): mock mismatch → `as unknown as T`
- `test/services/event/conflict-checker.test.ts` (3), `recurrence.test.ts` (1), `event-service.test.ts` (1): type mismatches → `as unknown as T` or add missing fields
- `test/services/ics/generator.test.ts` (1): `CalendarEvent` mismatch → `as unknown as CalendarEvent`
- `test/services/voice/tts-translation.test.ts` (5), `stress-dictionary.test.ts` (6), `transcription-service.test.ts` (4): mock/type casts → `as unknown as T`
- `test/services/ai/tool-handlers/sharing.test.ts` (6), `intent-learner.test.ts` (4), `intent-executor.test.ts` (1): mock mismatches → `as unknown as T`
- `test/services/image/data-mapper.test.ts` (7): type mismatches → `as unknown as T` or add missing fields
- `test/worker/templates/helpers.test.ts` (3), `weekly-overview.test.ts` (5): array index + type casts → `!` and `as unknown as T`

- [ ] **Step 1: Fix pattern E (isGroup) — these are real missing fields**

In `AgentContext` interface, check if `isGroup` was recently added. Add `isGroup: false` to all test context objects in:
- `test/services/ai/tool-executor.test.ts`
- `test/services/ai/tool-handlers/feedback.test.ts`
- `test/services/ai/tool-handlers/settings.test.ts`
- `test/services/sharing/shared-events.test.ts`

```bash
bunx tsc --noEmit 2>&1 | grep "isGroup"
```

- [ ] **Step 2: Fix pattern F (timezone) in proposals.test.ts**

Add `timezone: 'UTC'` to the two test event objects.

- [ ] **Step 3: Fix pattern I (wrong arg count)**

```bash
bunx tsc --noEmit 2>&1 | grep "Expected 1 arguments, but got 2"
```

Read the function signatures and remove the extra argument in test files.

- [ ] **Step 4: Fix pattern K (string[] vs string) in intent.repository.test.ts**

```bash
bunx tsc --noEmit 2>&1 | grep "intent.repository.test.ts"
```

Check what type the repository returns — probably needs `.join(',')` or the test data needs to be `string` not `string[]`.

- [ ] **Step 5: Fix pattern D (ctx.send .mock) in settings.test.ts**

```bash
bunx tsc --noEmit 2>&1 | grep "settings.test.ts" | head -5
```

Read how `ctx` is built, add a cast helper at top of file:
```ts
const sendMock = ctx.send as unknown as { mock: { calls: unknown[] } };
```
Or restructure: cast `ctx.send` at the point of access.

- [ ] **Step 6: Fix pattern L — inline.handler.test.ts**

```bash
bunx tsc --noEmit 2>&1 | grep "inline.handler.test.ts"
```

Add `as unknown as InlineServiceLike` to mock objects.

- [ ] **Step 7: Fix pattern M — inline-debounce.test.ts + callback-fallback.test.ts**

```bash
bunx tsc --noEmit 2>&1 | grep -E "inline-debounce|callback-fallback"
```

Use `as unknown as T` on all tuple/undefined casts.

- [ ] **Step 8: Fix pattern N — sharing test files**

```bash
bunx tsc --noEmit 2>&1 | grep "services/sharing/"
```

- `shared-events.test.ts`: isGroup already fixed in Step 1; apply `as unknown as T` to remaining
- `sharing-service.test.ts`, `inline-service.test.ts`, `share-session.test.ts`: all mock mismatches → `as unknown as T`

- [ ] **Step 9: Fix patterns A, B, C, G, H, J and pattern O (remaining files)**

```bash
bunx tsc --noEmit 2>&1 | grep "^test/"
```

Work through remaining files. Apply:
- `as unknown as typeof fetch` for fetch mock casts (pattern A)
- `as unknown as [...]` for tuple casts (pattern B)
- `null as unknown as T` (pattern C)
- `!` on array index assertions (pattern G)
- `as unknown as { callback_data: string }` (pattern H)
- `as unknown as SceneType` (pattern J)
- Pattern O files: `!`, `// @ts-expect-error`, `as unknown as T` per file description above

- [ ] **Step 10: Verify 0 test errors**

```bash
bunx tsc --noEmit 2>&1 | grep "^test/" | wc -l
```

Expected: 0

---

### Task 9: Final verification and commit

- [ ] **Step 1: Run tsc check for src/ and test/**

```bash
bunx tsc --noEmit 2>&1 | grep -E "^src/|^test/" | grep "error TS" | wc -l
```

Expected: `0` (scripts/ errors are out of scope — dev tools only)

- [ ] **Step 2: Run tests to confirm nothing is broken**

```bash
bun test 2>&1 | tail -5
```

Expected: all pass (currently ~1684 tests passing)

- [ ] **Step 3: Run biome**

```bash
bun run lint
```

Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add src/ test/ lefthook.yml package.json bun.lock
git commit -m "fix(types): resolve all 303 TypeScript strict-mode errors

- Fix src/ errors with proper null guards, optional chaining,
  and corrected type signatures
- Fix test/ errors with as-casts and non-null assertions
- Add lefthook pre-commit: biome check + tsc --noEmit"
```
