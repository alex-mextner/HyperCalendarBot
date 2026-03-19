# Default Event Duration Setting — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users configure a default meeting duration (in minutes) that the AI agent and add-event wizard use when creating events without an explicit end time.

**Architecture:** New column `default_event_duration_minutes` in `users` table. UI sub-screen in "Основные" settings with preset buttons (15/30/60) and free-text input via in-memory pending state. AI tool `manage_settings` and `system-prompt.ts` updated so the agent reads and writes the setting and applies it during event creation.

**Tech Stack:** Bun, bun:sqlite, GramIO, TypeScript, Biome (zero warnings)

---

## File Map

| File | Change |
|------|--------|
| `src/database/migrations.ts` | Add migration `027_default_event_duration` |
| `src/database/types.ts` | Add field to `User` and `UpdateUserData` |
| `src/database/repositories/user.repository.ts` | Already handles dynamic `UPDATE` — no change needed if `UpdateUserData` is updated |
| `src/bot/commands/settings.ts` | Add duration sub-screen, update General view |
| `src/bot/handlers/message.handler.ts` | Add `pendingDurationInput` Map + interceptor |
| `src/services/ai/tool-handlers/settings.ts` | Read/write `default_event_duration_minutes` in `general` category |
| `src/services/ai/tools.ts` | Update `manage_settings` description and `updates` schema |
| `src/services/ai/system-prompt.ts` | Inject default duration rule when set |
| `src/bot/scenes/add-event.scene.ts` | Pre-fill `end_at` from default duration when step 2 is skipped |

---

## Task 1: DB migration + types

**Files:**
- Modify: `src/database/migrations.ts`
- Modify: `src/database/types.ts`
- Test: `test/database/migrations.test.ts` (if exists) or add to `test/database/`

- [ ] **Step 1: Write failing test**

Create `test/database/user-default-duration.test.ts`:

```ts
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { runMigrations } from '../../src/database/migrations.ts';
import { UserRepository } from '../../src/database/repositories/user.repository.ts';

let db: Database;
let repo: UserRepository;

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  repo = new UserRepository(db);
});

afterEach(() => db.close());

test('users.default_event_duration_minutes defaults to 60', () => {
  repo.create({ telegram_id: 1, language: 'ru', timezone: 'UTC' });
  const user = repo.findByTelegramId(1)!;
  expect(user.default_event_duration_minutes).toBe(60);
});

test('UserRepository.update persists default_event_duration_minutes', () => {
  repo.create({ telegram_id: 2, language: 'ru', timezone: 'UTC' });
  const updated = repo.update(2, { default_event_duration_minutes: 30 });
  expect(updated?.default_event_duration_minutes).toBe(30);
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
bun test test/database/user-default-duration.test.ts
```

Expected: FAIL — `user.default_event_duration_minutes` is `undefined`.

- [ ] **Step 3: Add migration**

In `src/database/migrations.ts`, after migration `026_group_chats_timezone_country`, add:

```ts
{
  name: '027_default_event_duration',
  up: (db) => {
    db.exec(
      `ALTER TABLE users ADD COLUMN default_event_duration_minutes INTEGER NOT NULL DEFAULT 60`,
    );
  },
},
```

- [ ] **Step 4: Update types**

In `src/database/types.ts`:

```ts
// In User interface, after voice_response_enabled:
default_event_duration_minutes: number;

// In UpdateUserData, after voice_response_enabled:
default_event_duration_minutes?: number;
```

- [ ] **Step 5: Run to verify tests pass**

```bash
bun test test/database/user-default-duration.test.ts
```

Expected: PASS (both tests).

- [ ] **Step 6: Run full test suite**

```bash
bun test
```

Expected: all previously passing tests still pass.

- [ ] **Step 7: Lint**

```bash
bun run lint
```

Expected: zero warnings/errors.

- [ ] **Step 8: Commit**

```bash
git add src/database/migrations.ts src/database/types.ts test/database/user-default-duration.test.ts
git commit -m "feat(db): add default_event_duration_minutes to users table"
```

---

## Task 2: Settings UI — General view + duration sub-screen

**Files:**
- Modify: `src/bot/commands/settings.ts`
- Test: `test/bot/commands/settings-duration.test.ts`

- [ ] **Step 1: Write failing tests**

Create `test/bot/commands/settings-duration.test.ts`:

```ts
import { test, expect } from 'bun:test';
import { buildGeneralText, buildDurationView } from '../../src/bot/commands/settings.ts';

test('buildGeneralText shows default duration', () => {
  const text = buildGeneralText('UTC', 'ru', 'RU', 45);
  expect(text).toContain('45 мин');
});

test('buildDurationView shows current duration', () => {
  const { text, kb } = buildDurationView(30);
  expect(text).toContain('30 мин');
  // keyboard should have 15/30/60 buttons
  expect(JSON.stringify(kb)).toContain('stg:set_duration:15');
  expect(JSON.stringify(kb)).toContain('stg:set_duration:30');
  expect(JSON.stringify(kb)).toContain('stg:set_duration:60');
});

test('buildDurationView marks active duration with checkmark', () => {
  const { kb } = buildDurationView(60);
  expect(JSON.stringify(kb)).toContain('✅');
});
```

Note: you'll need to export `buildGeneralText` and `buildDurationView` from `settings.ts` — they don't exist yet, so tests will fail to import.

- [ ] **Step 2: Run to confirm fail**

```bash
bun test test/bot/commands/settings-duration.test.ts
```

Expected: FAIL — imports don't exist.

- [ ] **Step 3: Implement in settings.ts**

**3a.** Extract the General view text into an exported helper. In `src/bot/commands/settings.ts`, the inline text block inside `stg:general` handler should become:

```ts
export function buildGeneralText(
  tzDisplay: string,
  lang: string,
  country: string,
  defaultDurationMinutes: number,
): string {
  const durationLabel = defaultDurationMinutes >= 60
    ? `${defaultDurationMinutes / 60}ч`
    : `${defaultDurationMinutes} мин`;
  return [
    '🌍 Основные настройки',
    '',
    `Часовой пояс: ${tzDisplay}`,
    `Язык: ${lang === 'ru' ? '🇷🇺 Русский' : '🇬🇧 English'}`,
    `Страна: ${country}`,
    `Длительность встреч: ${durationLabel}`,
    '  По умолчанию, если не указано время окончания.',
  ].join('\n');
}
```

**3b.** Add exported duration sub-screen builder:

```ts
export function buildDurationView(currentMinutes: number): { text: string; kb: InlineKeyboard } {
  const fmt = (m: number) => (m >= 60 ? `${m / 60}ч` : `${m} мин`);
  const mark = (m: number) => (m === currentMinutes ? `✅ ${fmt(m)}` : fmt(m));
  const text = [
    '⏱ Длительность встреч по умолчанию',
    '',
    `Текущая: ${fmt(currentMinutes)}`,
    'Выберите или введите число минут:',
  ].join('\n');
  const kb = new InlineKeyboard()
    .text(mark(15), 'stg:set_duration:15')
    .text(mark(30), 'stg:set_duration:30')
    .text(mark(60), 'stg:set_duration:60')
    .row()
    .text('🔙 Назад', 'stg:general');
  return { text, kb };
}
```

**3c.** Update the `stg:general` handler to:
- Accept `userRepo` (already optional in function signature)
- Read `user.default_event_duration_minutes ?? 60`
- Call `buildGeneralText(tzDisplay, lang, country, duration)` instead of the inline block
- Add `⏱ Длительность встреч` button to the General keyboard:

```ts
.row()
.text(`⏱ Длительность: ${durationLabel}`, 'stg:edit_duration')
```

**3d.** Add handlers for `stg:edit_duration` and `stg:set_duration:N`:

In `handleSettingsCallback`, add before the final `await ctx.answer()`:

```ts
if (subAction === 'edit_duration') {
  const duration = user.default_event_duration_minutes ?? 60;
  const { text, kb } = buildDurationView(duration);
  // Set pending state so next text message is treated as duration input
  pendingDurationInput.set(user.telegram_id, Date.now());
  await ctx.answer();
  await ctx.editText(text, { reply_markup: kb });
  return;
}

if (subAction.startsWith('set_duration:') && userRepo) {
  const mins = Number.parseInt(subAction.split(':')[1]!, 10);
  if (mins > 0) {
    userRepo.update(user.telegram_id, { default_event_duration_minutes: mins });
    pendingDurationInput.delete(user.telegram_id);
  }
  const updated = userRepo.findByTelegramId(user.telegram_id) ?? user;
  const { text, kb } = buildDurationView(updated.default_event_duration_minutes ?? 60);
  await ctx.answer();
  await ctx.editText(text, { reply_markup: kb });
  return;
}
```

**3e.** Export the `pendingDurationInput` map so the message handler can use it:

```ts
// At module level in settings.ts:
export const pendingDurationInput = new Map<number, number>(); // userId → timestamp
```

- [ ] **Step 4: Run tests**

```bash
bun test test/bot/commands/settings-duration.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run full suite + lint**

```bash
bun test && bun run lint
```

Expected: all pass, zero lint warnings.

- [ ] **Step 6: Commit**

```bash
git add src/bot/commands/settings.ts test/bot/commands/settings-duration.test.ts
git commit -m "feat(settings): add default event duration UI to General settings"
```

---

## Task 3: Free-text duration input interceptor in message handler

**Files:**
- Modify: `src/bot/handlers/message.handler.ts`
- Test: `test/bot/handlers/duration-input.test.ts`

The message handler currently runs pipeline layers. We need to intercept a plain number message when `pendingDurationInput` has an entry for the user, before the AI pipeline runs.

- [ ] **Step 1: Write failing test**

Create `test/bot/handlers/duration-input.test.ts`:

```ts
import { test, expect } from 'bun:test';
import { tryHandleDurationInput } from '../../src/bot/handlers/message.handler.ts';
import { pendingDurationInput } from '../../src/bot/commands/settings.ts';

function makeUserRepo(store: Record<number, number>) {
  return {
    update: (id: number, data: { default_event_duration_minutes?: number }) => {
      if (data.default_event_duration_minutes !== undefined) {
        store[id] = data.default_event_duration_minutes;
      }
      return { telegram_id: id, default_event_duration_minutes: store[id] ?? 60 };
    },
    findByTelegramId: (id: number) => ({ telegram_id: id, default_event_duration_minutes: store[id] ?? 60 }),
  };
}

test('intercepts plain number when pending, updates setting', async () => {
  const store: Record<number, number> = {};
  const userRepo = makeUserRepo(store);
  pendingDurationInput.set(100, Date.now());

  const sent: string[] = [];
  const ctx = { send: async (text: string) => { sent.push(text); } };

  const handled = await tryHandleDurationInput(ctx as never, 100, '45', userRepo as never);
  expect(handled).toBe(true);
  expect(store[100]).toBe(45);
  expect(sent.length).toBe(1);
  expect(sent[0]).toContain('45');
  expect(pendingDurationInput.has(100)).toBe(false);
});

test('does not intercept when no pending state', async () => {
  const userRepo = makeUserRepo({});
  pendingDurationInput.delete(200);

  const handled = await tryHandleDurationInput({} as never, 200, '45', userRepo as never);
  expect(handled).toBe(false);
});

test('intercepts invalid text when pending, shows error, keeps pending', async () => {
  const userRepo = makeUserRepo({});
  pendingDurationInput.set(300, Date.now());

  const sent: string[] = [];
  const ctx = { send: async (text: string) => { sent.push(text); } };

  for (const bad of ['hello', '-5', '1.5', '99999', '4 5', '0']) {
    sent.length = 0;
    pendingDurationInput.set(300, Date.now());
    const handled = await tryHandleDurationInput(ctx as never, 300, bad, userRepo as never);
    expect(handled).toBe(true);                          // intercepted
    expect(sent[0]).toContain('1 до 1440');              // error shown
    expect(pendingDurationInput.has(300)).toBe(true);    // still waiting
  }

  pendingDurationInput.delete(300);
});

test('clears expired pending state (> 5 min)', async () => {
  const userRepo = makeUserRepo({});
  pendingDurationInput.set(400, Date.now() - 6 * 60 * 1000); // 6 min ago

  const handled = await tryHandleDurationInput({} as never, 400, '30', userRepo as never);
  expect(handled).toBe(false);
  expect(pendingDurationInput.has(400)).toBe(false);
});
```

- [ ] **Step 2: Run to confirm fail**

```bash
bun test test/bot/handlers/duration-input.test.ts
```

Expected: FAIL — `tryHandleDurationInput` doesn't exist.

- [ ] **Step 3: Implement `tryHandleDurationInput` in message.handler.ts**

Add to `src/bot/handlers/message.handler.ts`:

```ts
import { pendingDurationInput } from '../commands/settings.ts';
import type { UserRepository } from '../../database/repositories/user.repository.ts';

const DURATION_TTL_MS = 5 * 60 * 1000;

export async function tryHandleDurationInput(
  ctx: BotCommandContext,
  userId: number,
  text: string,
  userRepo: UserRepository,
): Promise<boolean> {
  const ts = pendingDurationInput.get(userId);
  if (ts === undefined) return false;

  // Expire stale entries
  if (Date.now() - ts > DURATION_TTL_MS) {
    pendingDurationInput.delete(userId);
    return false;
  }

  const trimmed = text.trim();
  const mins = Number.parseInt(trimmed, 10);
  const valid = Number.isInteger(mins) && mins > 0 && mins <= 1440 && trimmed === String(mins);

  if (!valid) {
    await ctx.send('Введите число минут от 1 до 1440 (например: 45)');
    return true;
  }

  pendingDurationInput.delete(userId);
  userRepo.update(userId, { default_event_duration_minutes: mins });
  const label = mins >= 60 ? `${mins / 60}ч` : `${mins} мин`;
  await ctx.send(`✅ Длительность встреч по умолчанию: ${label}`);
  return true;
}
```

**3b.** In `createMessageHandler`, early in the handler body (after `dbUser` is resolved, before pipeline), add:

```ts
if (messageText && deps.userRepo) {
  const handled = await tryHandleDurationInput(ctx, dbUser.telegram_id, messageText, deps.userRepo);
  if (handled) return;
}
```

- [ ] **Step 4: Run tests**

```bash
bun test test/bot/handlers/duration-input.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run full suite + lint**

```bash
bun test && bun run lint
```

Expected: all pass, zero warnings.

- [ ] **Step 6: Commit**

```bash
git add src/bot/handlers/message.handler.ts test/bot/handlers/duration-input.test.ts
git commit -m "feat(settings): intercept free-text duration input from message handler"
```

---

## Task 4: AI tool — manage_settings general category

**Files:**
- Modify: `src/services/ai/tool-handlers/settings.ts`
- Modify: `src/services/ai/tools.ts`
- Test: `test/services/ai/tool-handlers/settings-duration.test.ts`

- [ ] **Step 1: Write failing test**

Create `test/services/ai/tool-handlers/settings-duration.test.ts`:

```ts
import { test, expect } from 'bun:test';
import { handleManageSettings } from '../../../../src/services/ai/tool-handlers/settings.ts';
import type { AgentContext } from '../../../../src/services/ai/types.ts';

function makeCtx(duration = 60): Partial<AgentContext> {
  const store = { default_event_duration_minutes: duration };
  return {
    user: { telegram_id: 1, timezone: 'UTC', language: 'ru', default_event_duration_minutes: duration } as never,
    userRepo: {
      update: (_id: number, data: Record<string, unknown>) => {
        Object.assign(store, data);
        return { ...store, telegram_id: 1 };
      },
    } as never,
  };
}

test('get general includes default_event_duration_minutes', () => {
  const ctx = makeCtx(45);
  const result = handleManageSettings(ctx as never, { action: 'get', category: 'general' });
  expect(result.success).toBe(true);
  const data = JSON.parse(result.output as string);
  expect(data.default_event_duration_minutes).toBe(45);
});

test('update general persists default_event_duration_minutes', () => {
  const ctx = makeCtx(60);
  const result = handleManageSettings(ctx as never, {
    action: 'update',
    category: 'general',
    updates: { default_event_duration_minutes: 30 },
  });
  expect(result.success).toBe(true);
  expect(result.output).toContain('30');
});

test('update general rejects invalid duration', () => {
  const ctx = makeCtx(60);
  const result = handleManageSettings(ctx as never, {
    action: 'update',
    category: 'general',
    updates: { default_event_duration_minutes: -5 },
  });
  expect(result.success).toBe(false);
});
```

- [ ] **Step 2: Run to confirm fail**

```bash
bun test test/services/ai/tool-handlers/settings-duration.test.ts
```

Expected: FAIL — `default_event_duration_minutes` not in get output, update ignores it.

- [ ] **Step 3: Update tool handler**

In `src/services/ai/tool-handlers/settings.ts`:

**In `handleGet` / `general` section**, add:
```ts
default_event_duration_minutes: ctx.user.default_event_duration_minutes ?? 60,
```

**In `updateGeneral`**, add after `country_code` handling:
```ts
if (updates.default_event_duration_minutes !== undefined) {
  const mins = updates.default_event_duration_minutes as number;
  if (!Number.isInteger(mins) || mins <= 0) {
    return { success: false, error: 'default_event_duration_minutes must be a positive integer.' };
  }
  patch.default_event_duration_minutes = mins;
}
```

- [ ] **Step 4: Update tools.ts description**

In `src/services/ai/tools.ts`, find the `manage_settings` tool. Update the `description` to add `default_event_duration_minutes` to the general category list:

```ts
'Categories: general (timezone, language, country_code, default_event_duration_minutes), ' +
```

Also update the `updates` property description in `input_schema` to mention the new field.

- [ ] **Step 5: Run tests**

```bash
bun test test/services/ai/tool-handlers/settings-duration.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run full suite + lint**

```bash
bun test && bun run lint
```

Expected: all pass, zero warnings.

- [ ] **Step 7: Commit**

```bash
git add src/services/ai/tool-handlers/settings.ts src/services/ai/tools.ts \
  test/services/ai/tool-handlers/settings-duration.test.ts
git commit -m "feat(ai): expose default_event_duration_minutes in manage_settings tool"
```

---

## Task 5: System prompt — inject default duration rule

**Files:**
- Modify: `src/services/ai/system-prompt.ts`
- Test: `test/services/ai/system-prompt.test.ts`

- [ ] **Step 1: Write failing test**

Find (or create) `test/services/ai/system-prompt.test.ts`. Add:

```ts
import { test, expect } from 'bun:test';
import { buildSystemPrompt } from '../../src/services/ai/system-prompt.ts';

function makeCtx(duration: number) {
  return {
    user: {
      first_name: 'Test',
      language: 'ru',
      timezone: 'UTC',
      timezone_updated_at: null,
      default_event_duration_minutes: duration,
    },
    isVoiceMessage: false,
    isGroup: false,
    secretaryForLine: null,
  };
}

test('system prompt includes default duration when set', () => {
  const prompt = buildSystemPrompt(makeCtx(45) as never);
  expect(prompt).toContain('Default event duration: 45 minutes');
});

test('system prompt includes 60 min default', () => {
  const prompt = buildSystemPrompt(makeCtx(60) as never);
  expect(prompt).toContain('Default event duration: 60 minutes');
});
```

- [ ] **Step 2: Run to confirm fail**

```bash
bun test test/services/ai/system-prompt.test.ts
```

Expected: FAIL — no mention of duration in prompt.

- [ ] **Step 3: Update system-prompt.ts**

In `buildSystemPrompt`, add to the `## Rules` section (after the recurring events line):

```ts
const durationMins = ctx.user.default_event_duration_minutes ?? 60;
```

And in the returned template literal, add a rule line:

```
- Default event duration: ${durationMins} minutes. When creating an event with no explicit end time or duration, set end_at = start_at + ${durationMins} minutes.
```

- [ ] **Step 4: Run tests**

```bash
bun test test/services/ai/system-prompt.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run full suite + lint**

```bash
bun test && bun run lint
```

Expected: all pass, zero warnings.

- [ ] **Step 6: Commit**

```bash
git add src/services/ai/system-prompt.ts test/services/ai/system-prompt.test.ts
git commit -m "feat(ai): inject default event duration into system prompt"
```

---

## Task 6: Wizard — pre-fill end time from default duration

**Files:**
- Modify: `src/bot/scenes/add-event.scene.ts`
- Test: `test/bot/scenes/add-event-duration.test.ts`

In Step 2 of the add-event scene (duration input), when the user clicks "Пропустить", `endAt` is left undefined. We need to read `user.default_event_duration_minutes` and compute `endAt = startAt + N minutes`.

- [ ] **Step 1: Write failing test**

Create `test/bot/scenes/add-event-duration.test.ts`:

```ts
import { test, expect } from 'bun:test';
import { applyDefaultDuration } from '../../src/bot/scenes/add-event.scene.ts';
import { addMinutes } from 'date-fns';

test('applyDefaultDuration computes end from start + default', () => {
  const start = '2026-03-20T10:00:00.000Z';
  const result = applyDefaultDuration(start, 45);
  const expected = addMinutes(new Date(start), 45).toISOString();
  expect(result).toBe(expected);
});
```

- [ ] **Step 2: Run to confirm fail**

```bash
bun test test/bot/scenes/add-event-duration.test.ts
```

Expected: FAIL — `applyDefaultDuration` not exported.

- [ ] **Step 3: Implement**

In `src/bot/scenes/add-event.scene.ts`, add exported helper:

```ts
export function applyDefaultDuration(startAt: string, defaultMinutes: number): string {
  return addMinutes(new Date(startAt), defaultMinutes).toISOString();
}
```

In Step 2 (duration step), in the "Handle skip callback" branch (where `data === \`${CB.ADD_SKIP}:2\``), after `await answerCallback(context)`:

```ts
// Pre-fill end_at from user's default duration
const sceneUser = getSceneUser(context);
const defaultMins = sceneUser?.default_event_duration_minutes ?? 60;
const { startAt } = context.scene.state;
if (startAt) {
  await context.scene.update({ endAt: applyDefaultDuration(startAt, defaultMins) });
} else {
  await context.scene.update({});
}
return;
```

- [ ] **Step 4: Run tests**

```bash
bun test test/bot/scenes/add-event-duration.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run full suite + lint**

```bash
bun test && bun run lint
```

Expected: all pass, zero warnings.

- [ ] **Step 6: Commit**

```bash
git add src/bot/scenes/add-event.scene.ts test/bot/scenes/add-event-duration.test.ts
git commit -m "feat(wizard): pre-fill end_at from default event duration when step skipped"
```

---

## Final Verification

- [ ] Run full test suite: `bun test`
- [ ] Run coverage: `bun test --coverage` (should stay ≥ 80%)
- [ ] Run lint: `bun run lint`
- [ ] Restart bot manually, test the full flow:
  1. `/settings` → Основные → tap "⏱ Длительность" → tap "30 мин"
  2. `/settings` → Основные → tap "⏱ Длительность" → type "45" → confirm message
  3. Tell AI "добавь встречу завтра в 15:00" — confirm end is 15:45
  4. `/add` wizard → skip duration step — confirm end = start + default
