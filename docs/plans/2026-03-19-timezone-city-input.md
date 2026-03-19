# Timezone City Text Input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace region→city button pickers with free-text city input resolved via `city-timezones` library + Haiku AI fallback across all three timezone flows (onboarding, /settings, group settings).

**Architecture:** New `city-resolver.ts` module handles all resolution logic: library lookup first, then AI with up to 3 internal retries using validator feedback as context. Three scenes/handlers consume it identically. Old button keyboards and constants are deleted.

**Tech Stack:** `city-timezones` v1.3.3, `@anthropic-ai/sdk` (already in project, `new Anthropic()` reads `ANTHROPIC_API_KEY` from env), `Intl.supportedValuesOf`, `Intl.DateTimeFormat`, Bun test

**Spec:** `docs/specs/2026-03-19-timezone-city-input.md`

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/services/timezone/city-resolver.ts` | library + AI resolution, validation |
| Create | `test/services/timezone/city-resolver.test.ts` | unit tests |
| Modify | `src/bot/scenes/onboarding.scene.ts` | Step 1: text input + confirmation |
| Modify | `src/bot/scenes/timezone.scene.ts` | same flow as onboarding |
| Modify | `src/bot/handlers/callback.handler.ts` | group TZ: pending input instead of buttons |
| Modify | `src/bot/handlers/message.handler.ts` | handle pending group TZ city input |
| Modify | `src/bot/keyboards.ts` | delete 4 keyboard fns, update confirm button |
| Modify | `src/config/constants.ts` | delete TZ_REGIONS + ONBOARD_TZ_REGION, add ONBOARD_TZ_RETRY |
| Modify | `src/bot/commands/settings.ts` | export pendingGroupTzInput map |

---

## Task 1: Install city-timezones

**Files:**
- Modify: `package.json` (bun add)

- [ ] **Step 1: Install package**

```bash
bun add city-timezones
```

Expected: `city-timezones` added to `node_modules` and `package.json`.

- [ ] **Step 2: Verify types are available**

```bash
bun -e "import ct from 'city-timezones'; console.log(typeof ct.lookupViaCity)"
```

Expected: `function`

---

## Task 2: Create city-resolver module (TDD)

**Files:**
- Create: `src/services/timezone/city-resolver.ts`
- Create: `test/services/timezone/city-resolver.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// test/services/timezone/city-resolver.test.ts
import { describe, expect, mock, test } from 'bun:test';

// Mock Anthropic before importing resolver
const mockCreate = mock(async () => ({
  content: [{ type: 'text', text: 'Europe/Belgrade' }],
}));
mock.module('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: mockCreate };
  },
}));

const { resolveCity } = await import('../../../src/services/timezone/city-resolver.ts');

describe('resolveCity', () => {
  test('returns IANA key when user types it directly', async () => {
    expect(await resolveCity('Europe/Belgrade')).toBe('Europe/Belgrade');
  });

  test('resolves Latin city name via library', async () => {
    const result = await resolveCity('Belgrade');
    expect(result).toBe('Europe/Belgrade');
  });

  test('resolves partial/fuzzy city name', async () => {
    const result = await resolveCity('New Yor');
    expect(result).toBeTruthy();
    expect(result).toContain('America/');
  });

  test('falls back to AI for Cyrillic input', async () => {
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Europe/Belgrade' }] });
    const result = await resolveCity('Белград');
    expect(result).toBe('Europe/Belgrade');
  });

  test('retries AI when it returns invalid IANA key', async () => {
    mockCreate
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'Europe/Novi_Sad' }] })  // invalid
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'Europe/Belgrade' }] }); // valid
    const result = await resolveCity('Novi Sad');
    expect(result).toBe('Europe/Belgrade');
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  test('returns null after 3 exhausted AI attempts', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'Fake/Zone' }] });
    const result = await resolveCity('xyzxyzxyz');
    expect(result).toBeNull();
    expect(mockCreate).toHaveBeenCalledTimes(3);
  });

  test('returns null when AI returns UNKNOWN', async () => {
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'UNKNOWN' }] });
    const result = await resolveCity('asdfasdf');
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests — confirm they fail**

```bash
bun test test/services/timezone/city-resolver.test.ts
```

Expected: FAIL — `resolveCity` not found.

- [ ] **Step 3: Implement city-resolver.ts**

```ts
// src/services/timezone/city-resolver.ts
import Anthropic from '@anthropic-ai/sdk';
import cityTimezones from 'city-timezones';

const SYSTEM_PROMPT =
  'You are a timezone resolver. Given a city name in any language or format, ' +
  'return the IANA timezone key (e.g. Europe/Belgrade, America/New_York, Asia/Tokyo). ' +
  'Return only the key, nothing else. If you cannot determine it, return UNKNOWN.';

function validateTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function lookupLibrary(input: string): string | null {
  let results = cityTimezones.lookupViaCity(input);
  if (!results.length) results = cityTimezones.findFromCityStateProvince(input);
  if (!results.length) return null;
  results.sort((a, b) => ((b as { pop?: number }).pop ?? 0) - ((a as { pop?: number }).pop ?? 0));
  return (results[0] as { timezone?: string }).timezone ?? null;
}

function getSuggestions(tzPrefix: string): string {
  return Intl.supportedValuesOf('timeZone')
    .filter((z) => z.startsWith(tzPrefix + '/'))
    .slice(0, 15)
    .join(', ');
}

export async function resolveCity(input: string): Promise<string | null> {
  const trimmed = input.trim();

  // 1. Direct IANA input
  if (trimmed.includes('/') && validateTimezone(trimmed)) return trimmed;

  // 2. Library lookup
  const libResult = lookupLibrary(trimmed);
  if (libResult && validateTimezone(libResult)) return libResult;

  // 3. AI with retry loop (max 3 calls)
  const client = new Anthropic();
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: trimmed }];

  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 64,
      system: SYSTEM_PROMPT,
      messages,
    });

    const tz = (response.content[0] as { text: string }).text.trim();

    if (tz === 'UNKNOWN') return null;

    // Try library with AI result as city name
    const libFallback = lookupLibrary(tz);
    if (libFallback && validateTimezone(libFallback)) return libFallback;

    // Direct IANA from AI
    if (validateTimezone(tz)) return tz;

    // Build retry context
    const prefix = tz.split('/')[0] ?? '';
    const suggestions = prefix ? getSuggestions(prefix) : '';
    messages.push({ role: 'assistant', content: tz });
    messages.push({
      role: 'user',
      content: `"${tz}" is not a valid IANA timezone.${suggestions ? ` Valid zones in that region: ${suggestions}.` : ''} Return the correct IANA key for: "${trimmed}"`,
    });
  }

  return null;
}
```

- [ ] **Step 4: Run tests — confirm they pass**

```bash
bun test test/services/timezone/city-resolver.test.ts
```

Expected: all 7 pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/timezone/city-resolver.ts test/services/timezone/city-resolver.test.ts
git commit -m "feat(timezone): city-resolver module with library + AI fallback"
```

---

## Task 3: Update constants and keyboards

**Files:**
- Modify: `src/config/constants.ts`
- Modify: `src/bot/keyboards.ts`

- [ ] **Step 1: Add `ONBOARD_TZ_RETRY` to CB in constants.ts**

In `src/config/constants.ts`, find `ONBOARD_TZ_REGION: 'otr'` and replace the block:

```ts
// Before:
ONBOARD_TZ_REGION: 'otr',
ONBOARD_TZ: 'ot',

// After:
ONBOARD_TZ: 'ot',
ONBOARD_TZ_RETRY: 'otr',
```

Note: `ONBOARD_TZ_RETRY` reuses the `'otr'` string value so existing callback data in active sessions keeps working.

- [ ] **Step 2: Update `timezoneConfirmKeyboard` in keyboards.ts**

```ts
// Before:
export function timezoneConfirmKeyboard(lang: 'en' | 'ru'): InlineKeyboard {
  return new InlineKeyboard()
    .text(lang === 'ru' ? 'Да ✓' : 'Yes ✓', `${CB.ONBOARD_TZ}:confirm`)
    .text(lang === 'ru' ? 'Нет, вручную' : 'No, choose manually', `${CB.ONBOARD_TZ}:manual`);
}

// After:
export function timezoneConfirmKeyboard(lang: 'en' | 'ru'): InlineKeyboard {
  return new InlineKeyboard()
    .text(lang === 'ru' ? 'Да ✓' : 'Yes ✓', `${CB.ONBOARD_TZ}:confirm`)
    .text(lang === 'ru' ? 'Нет, другой город' : 'No, different city', `${CB.ONBOARD_TZ_RETRY}:`);
}
```

- [ ] **Step 3: Run lint**

```bash
bun run lint
```

Expected: no errors.

- [ ] **Step 4: Run all tests**

```bash
bun test
```

Expected: same pass count as before (constants/keyboard changes break nothing yet).

- [ ] **Step 5: Commit**

```bash
git add src/config/constants.ts src/bot/keyboards.ts
git commit -m "feat(timezone): add ONBOARD_TZ_RETRY, update confirm keyboard label"
```

---

## Task 4: Update onboarding scene

**Files:**
- Modify: `src/bot/scenes/onboarding.scene.ts`
- Modify: `test/bot/scenes/onboarding.test.ts` (if exists) or create tests inline

- [ ] **Step 1: Check if onboarding scene has existing tests**

```bash
ls test/bot/scenes/
```

- [ ] **Step 2: Update Step 1 in onboarding.scene.ts**

Replace the entire Step 1 `.step(['callback_query', 'location'], ...)` block with:

```ts
// Step 1: Timezone (message + location + callback)
.step(['message', 'location', 'callback_query'], async (context) => {
  const { lang } = context.scene.state;
  const l = lang ?? 'en';

  if (context.scene.step.firstTime) {
    const prompt =
      l === 'ru'
        ? '🌍 В каком городе вы находитесь?\n\nПримеры: Белград, Belgrade, Нью-Йорк, бангкок, Алматы, київ'
        : '🌍 What city are you in?\n\nExamples: Belgrade, New York, Bangkok, Almaty, Kyiv';
    await context.send(prompt, { reply_markup: timezoneMethodKeyboard(l) });
    return;
  }

  // Handle typed city name
  if (context.is('message')) {
    const text = (context as unknown as { text?: string }).text?.trim();
    if (!text) return;
    const tz = await resolveCity(text);
    if (tz) {
      await context.send(`✅ ${getTimezoneDisplay(tz)}`, {
        reply_markup: timezoneConfirmKeyboard(l),
      });
      await context.scene.update({ detectedTz: tz }, { step: undefined });
    } else {
      const msg =
        l === 'ru'
          ? 'Не удалось определить таймзону. Попробуйте ещё раз или:\n• Отправьте 📍 геолокацию\n• Введите код геолокации напрямую, например: <code>Europe/Belgrade</code>\n  Список кодов: https://en.wikipedia.org/wiki/List_of_tz_database_time_zones'
          : 'Could not determine timezone. Try again or:\n• Share 📍 location\n• Enter timezone code directly, e.g. <code>Europe/Belgrade</code>\n  Full list: https://en.wikipedia.org/wiki/List_of_tz_database_time_zones';
      await context.send(msg, { parse_mode: 'HTML' });
    }
    return;
  }

  // Handle location
  if (context.is('location')) {
    const { latitude, longitude } = (
      context as unknown as {
        eventLocation: { latitude: number; longitude: number };
      }
    ).eventLocation;
    const tz = resolveTimezone(latitude, longitude);
    const display = getTimezoneDisplay(tz);
    await context.send(t(l).tz_detected(tz, display), {
      ...removeKeyboard(),
      reply_markup: timezoneConfirmKeyboard(l),
    });
    await context.scene.update({ detectedTz: tz }, { step: undefined });
    return;
  }

  // Handle callback
  if (context.is('callback_query')) {
    const data = (context as unknown as { data: string }).data;
    if (!data) return;

    const parts = data.split(':');
    const action = parts[0];
    const payload = parts.slice(1).join(':');
    const cbCtx = context as unknown as {
      answer: (opts?: Record<string, unknown>) => Promise<unknown>;
      editText: (text: string, opts?: Record<string, unknown>) => Promise<unknown>;
    };

    if (action === CB.ONBOARD_TZ) {
      if (payload === 'confirm') {
        const tz = context.scene.state.detectedTz;
        if (!tz) return;
        db.users.update(context.from.id, {
          timezone: tz,
          country_code: guessCountryFromTimezone(tz),
        });
        await context.send(`✅ ${getTimezoneDisplay(tz)}`, removeKeyboard());
        await cbCtx.answer();
        await context.scene.update({ timezone: tz });
        return;
      }
    }

    if (action === CB.ONBOARD_TZ_RETRY) {
      await cbCtx.answer();
      const prompt =
        l === 'ru'
          ? '🌍 В каком городе вы находитесь?\n\nПримеры: Белград, Belgrade, Нью-Йорк, бангкок, Алматы, київ'
          : '🌍 What city are you in?\n\nExamples: Belgrade, New York, Bangkok, Almaty, Kyiv';
      await context.send(prompt, { reply_markup: timezoneMethodKeyboard(l) });
      return;
    }

    await cbCtx.answer();
  }
})
```

- [ ] **Step 3: Update imports in onboarding.scene.ts**

Add `resolveCity` import, remove old keyboard imports:

```ts
// Add:
import { resolveCity } from '../../services/timezone/city-resolver.ts';

// Remove from keyboards import:
// timezoneCitiesKeyboard, timezoneManualKeyboard
// Keep: countryKeyboard, languageKeyboard, removeKeyboard, timezoneConfirmKeyboard, timezoneMethodKeyboard
```

- [ ] **Step 4: Run lint**

```bash
bun run lint
```

- [ ] **Step 5: Run all tests**

```bash
bun test
```

Expected: pass. The onboarding scene tests (holidays.test.ts etc.) should be unaffected.

- [ ] **Step 6: Commit**

```bash
git add src/bot/scenes/onboarding.scene.ts
git commit -m "feat(onboarding): replace region/city buttons with text city input"
```

---

## Task 5: Update timezone scene (/settings)

**Files:**
- Modify: `src/bot/scenes/timezone.scene.ts`

- [ ] **Step 1: Rewrite timezone.scene.ts**

```ts
// src/bot/scenes/timezone.scene.ts
import { Scene } from '@gramio/scenes';
import { CB } from '../../config/constants.ts';
import type { DatabaseService } from '../../database/index.ts';
import { resolveCity } from '../../services/timezone/city-resolver.ts';
import { getTimezoneDisplay, resolveTimezone } from '../../services/timezone/timezone-service.ts';
import { removeKeyboard, timezoneConfirmKeyboard, timezoneMethodKeyboard } from '../keyboards.ts';
import { getSceneLang, getSceneUser } from './helpers.ts';

export function createTimezoneScene(db: DatabaseService) {
  return new Scene('timezone')
    .onEnter(async (context) => {
      const lang = getSceneLang(context);
      const user = getSceneUser(context);
      if (!user) return;

      const display = getTimezoneDisplay(user.timezone);
      const current =
        lang === 'ru'
          ? `🌍 Текущий: ${display}\n\n`
          : `🌍 Current: ${display}\n\n`;
      const prompt =
        lang === 'ru'
          ? `${current}В каком городе вы находитесь?\n\nПримеры: Белград, Belgrade, Нью-Йорк, бангкок, Алматы, київ`
          : `${current}What city are you in?\n\nExamples: Belgrade, New York, Bangkok, Almaty, Kyiv`;

      await context.send(prompt, { reply_markup: timezoneMethodKeyboard(lang) });
    })
    .step(['message', 'location', 'callback_query'], async (context) => {
      const user = getSceneUser(context);
      if (!user) {
        await context.scene.exit();
        return;
      }
      const lang = getSceneLang(context);

      // Handle typed city name
      if (context.is('message')) {
        const text = (context as unknown as { text?: string }).text?.trim();
        if (!text) return;
        const tz = await resolveCity(text);
        if (tz) {
          await context.send(`✅ ${getTimezoneDisplay(tz)}`, {
            reply_markup: timezoneConfirmKeyboard(lang),
          });
          // Store detected tz for confirmation — reuse scene state trick
          (context.scene as unknown as { _pendingTz?: string })._pendingTz = tz;
        } else {
          const msg =
            lang === 'ru'
              ? 'Не удалось определить таймзону. Попробуйте ещё раз или:\n• Отправьте 📍 геолокацию\n• Введите код напрямую, например: <code>Europe/Belgrade</code>\n  Список: https://en.wikipedia.org/wiki/List_of_tz_database_time_zones'
              : 'Could not determine timezone. Try again or:\n• Share 📍 location\n• Enter code directly, e.g. <code>Europe/Belgrade</code>\n  Full list: https://en.wikipedia.org/wiki/List_of_tz_database_time_zones';
          await context.send(msg, { parse_mode: 'HTML' });
        }
        return;
      }

      // Handle location
      if (context.is('location')) {
        const { latitude, longitude } = (
          context as unknown as {
            eventLocation: { latitude: number; longitude: number };
          }
        ).eventLocation;
        const tz = resolveTimezone(latitude, longitude);
        db.users.update(user.telegram_id, { timezone: tz });
        await context.scene.exit();
        await context.send(`✅ ${getTimezoneDisplay(tz)}`, {
          reply_markup: { remove_keyboard: true },
        });
        return;
      }

      // Handle callback
      if (context.is('callback_query')) {
        const data = (context as unknown as { data: string }).data;
        if (!data) return;
        const parts = data.split(':');
        const action = parts[0];
        const cbCtx = context as unknown as {
          answer: () => Promise<unknown>;
        };

        if (action === CB.ONBOARD_TZ) {
          const pendingTz = (context.scene as unknown as { _pendingTz?: string })._pendingTz;
          if (!pendingTz) { await cbCtx.answer(); return; }
          db.users.update(user.telegram_id, { timezone: pendingTz });
          await context.scene.exit();
          await context.send(`✅ ${getTimezoneDisplay(pendingTz)}`, removeKeyboard());
          await cbCtx.answer();
          return;
        }

        if (action === CB.ONBOARD_TZ_RETRY) {
          await cbCtx.answer();
          const prompt =
            lang === 'ru'
              ? '🌍 В каком городе вы находитесь?\n\nПримеры: Белград, Belgrade, Нью-Йорк, бангкок, Алматы, київ'
              : '🌍 What city are you in?\n\nExamples: Belgrade, New York, Bangkok, Almaty, Kyiv';
          await context.send(prompt, { reply_markup: timezoneMethodKeyboard(lang) });
          return;
        }

        await cbCtx.answer();
      }
    });
}
```

- [ ] **Step 2: Run lint**

```bash
bun run lint
```

- [ ] **Step 3: Run all tests**

```bash
bun test
```

- [ ] **Step 4: Commit**

```bash
git add src/bot/scenes/timezone.scene.ts
git commit -m "feat(timezone): replace region/city buttons with text city input in settings scene"
```

---

## Task 6: Update group timezone picker

**Files:**
- Modify: `src/bot/commands/settings.ts` — export `pendingGroupTzInput`
- Modify: `src/bot/handlers/callback.handler.ts` — GROUP_SETTINGS_TZ:select triggers pending input
- Modify: `src/bot/handlers/message.handler.ts` — handle pending group TZ input

- [ ] **Step 1: Add `pendingGroupTzInput` map to settings.ts**

After the existing `pendingDurationInput` line in `src/bot/commands/settings.ts`:

```ts
export const pendingDurationInput = new Map<number, number>(); // userId → timestamp
export const pendingGroupTzInput = new Map<number, number>(); // userId → group chatId
```

- [ ] **Step 2: Update GROUP_SETTINGS_TZ handler in callback.handler.ts**

Find the `if (action === CB.GROUP_SETTINGS_TZ && groupRepo)` block (around line 984) and replace it:

```ts
if (action === CB.GROUP_SETTINGS_TZ && groupRepo) {
  const chatId = (ctx as unknown as { chat?: { id: number } }).chat?.id;
  if (!chatId) { await ctx.answer(); return; }

  if (payload === 'select') {
    await ctx.answer();
    const prompt =
      user.language === 'ru'
        ? '🌍 Введите название города для группы:\n\nПримеры: Белград, Belgrade, Нью-Йорк, Bangkok'
        : '🌍 Enter city name for the group:\n\nExamples: Belgrade, New York, Bangkok';
    pendingGroupTzInput.set(user.telegram_id, chatId);
    await ctx.send(prompt);
    return;
  }

  // Timezone confirmed via text input (handled in message.handler, this branch unused now)
  await ctx.answer();
  return;
}
```

Add `pendingGroupTzInput` to imports at top of callback.handler.ts:
```ts
import { pendingDurationInput, pendingGroupTzInput } from '../commands/settings.ts';
```

- [ ] **Step 3: Add group TZ handler in message.handler.ts**

Find the `handleDurationInput` function pattern and add a similar function. Also import `pendingGroupTzInput` and `resolveCity`.

Add import near `pendingDurationInput` import:
```ts
import { pendingDurationInput, pendingGroupTzInput } from '../commands/settings.ts';
import { resolveCity } from '../../services/timezone/city-resolver.ts';
```

Add new function before `handleDurationInput`:
```ts
const GROUP_TZ_TTL_MS = 5 * 60 * 1000;

async function handleGroupTzInput(
  ctx: { send: (text: string, opts?: Record<string, unknown>) => Promise<unknown> },
  userId: number,
  text: string,
  groupRepo: GroupChatRepository,
): Promise<boolean> {
  const chatId = pendingGroupTzInput.get(userId);
  if (chatId === undefined) return false;

  if (Date.now() - (pendingGroupTzInput.get(userId) ?? 0) > GROUP_TZ_TTL_MS) {
    pendingGroupTzInput.delete(userId);
    return false;
  }

  const tz = await resolveCity(text.trim());
  pendingGroupTzInput.delete(userId);

  if (!tz) {
    await ctx.send(
      'Не удалось определить таймзону. Попробуйте ещё раз через /settings или введите код напрямую, например: Europe/Belgrade',
    );
    return true;
  }

  groupRepo.setTimezone(chatId, tz);
  const { getTimezoneDisplay } = await import('../../services/timezone/timezone-service.ts');
  await ctx.send(`✅ Таймзона группы: ${getTimezoneDisplay(tz)}`);
  return true;
}
```

Wire it into the message handler pipeline — find where `handleDurationInput` is called and add `handleGroupTzInput` before it:

```ts
// Before handleDurationInput check:
if (groupRepo && await handleGroupTzInput(ctx, userId, text, groupRepo)) return { handled: true };
```

Note: `pendingGroupTzInput` stores `userId → chatId` but the TTL check above is wrong — the map stores `chatId`, not a timestamp. Fix: use a separate TTL map or store `{ chatId, timestamp }`.

Correct implementation:

```ts
// In settings.ts:
export const pendingGroupTzInput = new Map<number, { chatId: number; ts: number }>();

// In callback.handler.ts when setting:
pendingGroupTzInput.set(user.telegram_id, { chatId, ts: Date.now() });

// In message.handler.ts:
async function handleGroupTzInput(...): Promise<boolean> {
  const entry = pendingGroupTzInput.get(userId);
  if (!entry) return false;
  if (Date.now() - entry.ts > GROUP_TZ_TTL_MS) {
    pendingGroupTzInput.delete(userId);
    return false;
  }
  const tz = await resolveCity(text.trim());
  pendingGroupTzInput.delete(userId);
  if (!tz) { await ctx.send('...'); return true; }
  groupRepo.setTimezone(entry.chatId, tz);
  await ctx.send(`✅ ${getTimezoneDisplay(tz)}`);
  return true;
}
```

- [ ] **Step 4: Run lint**

```bash
bun run lint
```

- [ ] **Step 5: Run all tests**

```bash
bun test
```

- [ ] **Step 6: Commit**

```bash
git add src/bot/commands/settings.ts src/bot/handlers/callback.handler.ts src/bot/handlers/message.handler.ts
git commit -m "feat(timezone): group timezone via text input using pending map"
```

---

## Task 7: Delete dead code

**Files:**
- Modify: `src/bot/keyboards.ts` — delete 4 functions
- Modify: `src/config/constants.ts` — delete `TZ_REGIONS`

- [ ] **Step 1: Delete from keyboards.ts**

Delete these four functions entirely:
- `timezoneManualKeyboard()`
- `timezoneCitiesKeyboard()`
- `groupTimezoneRegionKeyboard()`
- `groupTimezoneCitiesKeyboard()`

Also remove `TZ_REGIONS` from its import in keyboards.ts if it was imported there.

- [ ] **Step 2: Delete TZ_REGIONS from constants.ts**

Delete the `export const TZ_REGIONS: Record<string, string[]> = { ... }` block (lines 391-433).

- [ ] **Step 3: Run lint — must be clean**

```bash
bun run lint
```

Expected: zero errors. If any remaining references to deleted symbols, fix them now.

- [ ] **Step 4: Run all tests**

```bash
bun test
```

Expected: same pass count as start of this task.

- [ ] **Step 5: Commit**

```bash
git add src/bot/keyboards.ts src/config/constants.ts
git commit -m "chore(timezone): delete TZ_REGIONS and button keyboard functions"
```

---

## Final Verification

- [ ] **Run full test suite**

```bash
bun test
```

Expected: all tests pass, 0 fail.

- [ ] **Run lint**

```bash
bun run lint
```

Expected: zero errors.

- [ ] **Smoke check: confirm deleted symbols are gone**

```bash
grep -r "TZ_REGIONS\|timezoneManualKeyboard\|timezoneCitiesKeyboard\|groupTimezoneRegionKeyboard\|groupTimezoneCitiesKeyboard\|ONBOARD_TZ_REGION" src/
```

Expected: no output.
