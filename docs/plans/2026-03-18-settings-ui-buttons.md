# Settings UI Buttons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace text instructions in settings with interactive buttons; fix AI tool coverage for language/country changes.

**Architecture:** All changes are self-contained within `settings.ts`, `keyboards.ts`, `callback.handler.ts`, `index.ts`, and the AI tool handler. No new scenes — timezone reuses the existing scene entered from a callback; language and country are pure inline flows within the `stg:*` callback space.

**Tech Stack:** TypeScript, GramIO `InlineKeyboard`, `bun:sqlite`, existing `NotificationPreferencesService`.

---

## Files

| File | Change |
|------|--------|
| `src/bot/commands/settings.ts` | General view buttons, language/country handlers, close handler, reminder intervals view |
| `src/bot/keyboards.ts` | Add `countryPickerKeyboard()`, `reminderIntervalsKeyboard()` |
| `src/bot/handlers/callback.handler.ts` | Add `timezoneScene` param, handle `stg:change_tz` |
| `src/bot/index.ts` | Pass `timezoneScene` to `createCallbackHandler`; remove `/timezone` command |
| `src/services/ai/tool-handlers/settings.ts` | Add `country_code` to `updateGeneral` |
| `src/services/ai/tools.ts` | Fix `manage_settings` description to mention language persistence |
| `test/bot/commands/settings.test.ts` | Tests for new callbacks |
| `test/services/ai/tool-handlers/settings.test.ts` | Test for country_code update |

---

## Task 1: Fix AI tool — country_code and manage_settings description

**Files:**
- Modify: `src/services/ai/tool-handlers/settings.ts:83-99`
- Modify: `src/services/ai/tools.ts:261-262`
- Test: `test/services/ai/tool-handlers/settings.test.ts`

- [ ] **Step 1: Write failing test for country_code update**

Add inside the existing `describe('update general settings', ...)` block in `test/services/ai/tool-handlers/settings.test.ts`:

```typescript
  test('updates country_code', () => {
    const result = handleManageSettings(ctx, {
      action: 'update',
      category: 'general',
      updates: { country_code: 'DE' },
    });
    expect(result.success).toBe(true);
    const updated = ctx.userRepo.findByTelegramId(USER_ID);
    expect(updated?.country_code).toBe('DE');
  });

  test('updates language', () => {
    const result = handleManageSettings(ctx, {
      action: 'update',
      category: 'general',
      updates: { language: 'ru' },
    });
    expect(result.success).toBe(true);
    const updated = ctx.userRepo.findByTelegramId(USER_ID);
    expect(updated?.language).toBe('ru');
  });
```

- [ ] **Step 2: Run test — confirm it fails**

```bash
bun test test/services/ai/tool-handlers/settings.test.ts
```

Expected: `updates country_code` fails — country_code not handled.

- [ ] **Step 3: Fix `updateGeneral` in `tool-handlers/settings.ts`**

In `updateGeneral`, add `country_code` support after the `language` line:

```typescript
if (updates.country_code !== undefined) patch.country_code = updates.country_code as string;
```

Also update the `updates` field `description` in `tools.ts` to include `country_code (ISO 3166-1 alpha-2 string)` in the general section list.

- [ ] **Step 4: Fix `manage_settings` description in `tools.ts:262`**

Replace the `description` string:

```typescript
description:
  'Get or update user settings. ' +
  'IMPORTANT: When user asks to change language (e.g. "switch to English", "speak Russian"), ' +
  'you MUST call this tool with action=update, category=general, updates={language: "en"/"ru"} ' +
  'BEFORE responding in the new language. Do not just say you switched — persist it. ' +
  'Categories: general (timezone, language, country_code), ' +
  'notifications (morning agenda, evening review, quiet hours, reminders), ' +
  'calls (enabled, language), privacy (default visibility, inline mode, invitations), ' +
  'voice (voice response enabled/disabled). Use action "get" without category to return all settings.',
```

Also update the `updates` field description to include `country_code (ISO 3166-1 alpha-2 string)` in the general section.

- [ ] **Step 5: Run tests — confirm both pass**

```bash
bun test test/services/ai/tool-handlers/settings.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/services/ai/tool-handlers/settings.ts src/services/ai/tools.ts test/services/ai/tool-handlers/settings.test.ts
git commit -m "fix(settings): add country_code to AI updateGeneral; fix manage_settings description for language persistence"
```

---

## Task 2: Add keyboard helpers — country picker and reminder intervals

**Files:**
- Modify: `src/bot/keyboards.ts`
- Test: (tested implicitly via settings.test.ts in task 3)

- [ ] **Step 1: Add `countryPickerKeyboard` to `keyboards.ts`**

Add after the existing timezone keyboard functions:

```typescript
const TOP_COUNTRIES: [string, string][] = [
  ['RU', '🇷🇺 Россия'],
  ['US', '🇺🇸 США'],
  ['DE', '🇩🇪 Германия'],
  ['GB', '🇬🇧 Великобритания'],
  ['FR', '🇫🇷 Франция'],
  ['UA', '🇺🇦 Украина'],
  ['BY', '🇧🇾 Беларусь'],
  ['KZ', '🇰🇿 Казахстан'],
  ['PL', '🇵🇱 Польша'],
  ['RS', '🇷🇸 Сербия'],
  ['TR', '🇹🇷 Турция'],
  ['IL', '🇮🇱 Израиль'],
  ['ES', '🇪🇸 Испания'],
  ['IT', '🇮🇹 Италия'],
  ['NL', '🇳🇱 Нидерланды'],
  ['SE', '🇸🇪 Швеция'],
  ['NO', '🇳🇴 Норвегия'],
  ['FI', '🇫🇮 Финляндия'],
  ['CZ', '🇨🇿 Чехия'],
  ['AT', '🇦🇹 Австрия'],
  ['CH', '🇨🇭 Швейцария'],
  ['PT', '🇵🇹 Португалия'],
  ['GR', '🇬🇷 Греция'],
  ['RO', '🇷🇴 Румыния'],
  ['HU', '🇭🇺 Венгрия'],
  ['CA', '🇨🇦 Канада'],
  ['AU', '🇦🇺 Австралия'],
  ['JP', '🇯🇵 Япония'],
  ['CN', '🇨🇳 Китай'],
  ['IN', '🇮🇳 Индия'],
];

export function countryPickerKeyboard(currentCode?: string | null): InlineKeyboard {
  const kb = new InlineKeyboard();
  TOP_COUNTRIES.forEach(([code, label], i) => {
    const mark = code === currentCode ? '✅ ' : '';
    kb.text(`${mark}${label}`, `stg:set_country:${code}`);
    if (i % 2 === 1) kb.row();
  });
  return kb.row().text('🔙 Назад', 'stg:general');
}
```

- [ ] **Step 2: Add `reminderIntervalsKeyboard` to `keyboards.ts`**

```typescript
const REMINDER_PRESETS = [0, 5, 10, 15, 30, 60, 120] as const;

function fmtReminderPreset(m: number): string {
  if (m === 0) return 'в начале';
  if (m >= 60) return `${m / 60}ч`;
  return `${m}мин`;
}

export function reminderIntervalsKeyboard(activeIntervals: number[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  REMINDER_PRESETS.forEach((m, i) => {
    const active = activeIntervals.includes(m);
    kb.text(`${active ? '✅' : '☐'} ${fmtReminderPreset(m)}`, `stg:toggle_reminder:${m}`);
    if (i % 2 === 1) kb.row();
  });
  return kb.row().text('🔙 Назад', 'stg:notifications');
}
```

- [ ] **Step 3: Commit keyboards**

```bash
git add src/bot/keyboards.ts
git commit -m "feat(settings): add countryPickerKeyboard and reminderIntervalsKeyboard"
```

---

## Task 3: Settings general view — buttons + handlers

**Files:**
- Modify: `src/bot/commands/settings.ts:11-20` (settingsCategoryKeyboard)
- Modify: `src/bot/commands/settings.ts:175-191` (general subAction)
- Modify: `src/bot/commands/settings.ts:160-173` (handleSettingsCallback signature)
- Test: `test/bot/commands/settings.test.ts`

- [ ] **Step 1: Write failing tests**

Note: `await import(...)` inside test bodies is the established pattern in this test file (used for module isolation). Keep it consistent.

Add to `test/bot/commands/settings.test.ts`:

```typescript
describe('stg:general with buttons', () => {
  test('renders timezone, language, country without /timezone text', async () => {
    const { handleSettingsCallback } = await import('../../../src/bot/commands/settings.ts');
    const ctx = makeCallbackCtx();
    const prefs = makePrefsService();

    await handleSettingsCallback(ctx, makeUser() as never, 'general', prefs as never);

    const [text] = ctx.editText.mock.calls[0] as [string, unknown];
    expect(text).not.toContain('/timezone');
    expect(text).toContain('Часовой пояс');
    expect(text).toContain('Язык');
    expect(text).toContain('Страна');
  });
});

describe('stg:set_lang', () => {
  test('updates language and re-renders general view', async () => {
    const { handleSettingsCallback } = await import('../../../src/bot/commands/settings.ts');
    const ctx = makeCallbackCtx();
    const prefs = makePrefsService();
    const userRepo = { update: mock(() => ({ ...makeUser(), language: 'en' })), findByTelegramId: mock(() => makeUser()) };

    await handleSettingsCallback(ctx, makeUser() as never, 'set_lang:en', prefs as never, undefined, undefined, userRepo as never);

    expect(userRepo.update).toHaveBeenCalledWith(100, { language: 'en' });
    expect(ctx.editText).toHaveBeenCalled();
  });
});

describe('stg:set_country', () => {
  test('updates country_code and re-renders general view', async () => {
    const { handleSettingsCallback } = await import('../../../src/bot/commands/settings.ts');
    const ctx = makeCallbackCtx();
    const prefs = makePrefsService();
    const userRepo = { update: mock(() => ({ ...makeUser(), country_code: 'DE' })), findByTelegramId: mock(() => makeUser()) };

    await handleSettingsCallback(ctx, makeUser() as never, 'set_country:DE', prefs as never, undefined, undefined, userRepo as never);

    expect(userRepo.update).toHaveBeenCalledWith(100, { country_code: 'DE' });
    expect(ctx.editText).toHaveBeenCalled();
  });
});

describe('stg:close', () => {
  test('deletes the message', async () => {
    const { handleSettingsCallback } = await import('../../../src/bot/commands/settings.ts');
    const deleteFn = mock(() => Promise.resolve());
    const ctx = {
      ...makeCallbackCtx(),
      message: { delete: deleteFn },
    } as unknown as BotCallbackContext;
    const prefs = makePrefsService();

    await handleSettingsCallback(ctx, makeUser() as never, 'close', prefs as never);

    expect(deleteFn).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests — confirm they fail**

```bash
bun test test/bot/commands/settings.test.ts
```

- [ ] **Step 3: Update existing test for `stg:general` — it will fail after Step 4**

The existing test at `test/bot/commands/settings.test.ts` line 97 asserts `expect(text).toContain('ru')`.
After the change the view shows `🇷🇺 Русский` not `ru`. Update it:

```typescript
// Before:
expect(text).toContain('ru');
// After:
expect(text).toContain('Русский');
```

- [ ] **Step 4: Update `settingsCategoryKeyboard` — add Close button**

```typescript
export function settingsCategoryKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🌍 Основные', 'stg:general')
    .text('🔔 Уведомления', 'stg:notifications')
    .row()
    .text('📞 Звонки', 'stg:calls')
    .text('🔒 Приватность', 'stg:privacy')
    .row()
    .text('🎤 Голос', 'stg:voice')
    .row()
    .text('✖️ Закрыть', 'stg:close');
}
```

- [ ] **Step 5: Rewrite `stg:general` block in `handleSettingsCallback`**

Add static imports at top of `settings.ts`:
```typescript
import { countryPickerKeyboard, reminderIntervalsKeyboard } from '../keyboards.ts';
```

Replace lines 175-191 with the final code using `currentUser` throughout (following the existing pattern from the `voice` block):

```typescript
if (subAction === 'general' || subAction.startsWith('set_lang:') || subAction.startsWith('set_country:') || subAction === 'show_countries') {
  let currentUser = user;

  if (subAction.startsWith('set_lang:') && userRepo) {
    const lang = subAction.split(':')[1] as 'en' | 'ru';
    const updated = userRepo.update(currentUser.telegram_id, { language: lang });
    if (updated) currentUser = updated;
  }
  if (subAction.startsWith('set_country:') && userRepo) {
    const code = subAction.split(':')[1]!;
    const updated = userRepo.update(currentUser.telegram_id, { country_code: code });
    if (updated) currentUser = updated;
  }

  if (subAction === 'show_countries') {
    await ctx.answer();
    await ctx.editText('🏳️ Выберите страну:', {
      reply_markup: countryPickerKeyboard(currentUser.country_code),
    });
    return;
  }

  const tzDisplay = getTimezoneDisplay(currentUser.timezone);
  const lang = currentUser.language ?? 'en';
  const country = currentUser.country_code ?? '—';
  const text = [
    '🌍 Основные настройки',
    '',
    `Часовой пояс: ${tzDisplay}`,
    `Язык: ${lang === 'ru' ? '🇷🇺 Русский' : '🇬🇧 English'}`,
    `Страна: ${country}`,
  ].join('\n');

  const kb = new InlineKeyboard()
    .text('🕐 Часовой пояс', 'stg:change_tz')
    .row()
    .text(lang === 'ru' ? '✅ 🇷🇺 Русский' : '🇷🇺 Русский', 'stg:set_lang:ru')
    .text(lang === 'en' ? '✅ 🇬🇧 English' : '🇬🇧 English', 'stg:set_lang:en')
    .row()
    .text('🏳️ Страна', 'stg:show_countries')
    .row()
    .text('🔙 Назад', 'stg:back');

  await ctx.answer();
  await ctx.editText(text, { reply_markup: kb });
  return;
}
```

Note: `stg:change_tz` is intercepted in `callback.handler.ts` (Task 5) before reaching `handleSettingsCallback`.

- [ ] **Step 6: Add `stg:close` handler** (add before the `stg:back` handler):

```typescript
if (subAction === 'close') {
  await ctx.answer();
  await (ctx as unknown as { message?: { delete: () => Promise<void> } }).message?.delete();
  return;
}
```

- [ ] **Step 7: Run tests**

```bash
bun test test/bot/commands/settings.test.ts
```

- [ ] **Step 8: Commit**

```bash
git add src/bot/commands/settings.ts src/bot/keyboards.ts test/bot/commands/settings.test.ts
git commit -m "feat(settings): general view buttons for timezone/language/country; close button"
```

---

## Task 4: Notifications — reminder intervals view

**Files:**
- Modify: `src/bot/commands/settings.ts:36-75` (buildNotificationsView + its handler block)
- Test: `test/bot/commands/settings.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
describe('stg:notifications', () => {
  test('does not contain "напишите AI" text', async () => {
    const { handleSettingsCallback } = await import('../../../src/bot/commands/settings.ts');
    const ctx = makeCallbackCtx();
    const prefs = makePrefsService();

    await handleSettingsCallback(ctx, makeUser() as never, 'notifications', prefs as never);

    const [text] = ctx.editText.mock.calls[0] as [string, unknown];
    expect(text).not.toContain('напишите AI');
    expect(text).not.toContain('Чтобы изменить');
  });
});

describe('stg:edit_reminders', () => {
  test('shows reminder intervals view', async () => {
    const { handleSettingsCallback } = await import('../../../src/bot/commands/settings.ts');
    const ctx = makeCallbackCtx();
    const prefs = makePrefsService({ default_reminder_intervals: '[15, 30]' });

    await handleSettingsCallback(ctx, makeUser() as never, 'edit_reminders', prefs as never);

    expect(ctx.editText).toHaveBeenCalled();
    const [text] = ctx.editText.mock.calls[0] as [string, unknown];
    expect(text).toContain('Интервалы');
  });
});

describe('stg:toggle_reminder', () => {
  test('adds interval when not present', async () => {
    const { handleSettingsCallback } = await import('../../../src/bot/commands/settings.ts');
    const ctx = makeCallbackCtx();
    const updateFn = mock(() => {});
    const prefs = {
      ...makePrefsService({ default_reminder_intervals: '[30]' }),
      updateDefaultIntervals: updateFn,
    };

    await handleSettingsCallback(ctx, makeUser() as never, 'toggle_reminder:15', prefs as never);

    expect(updateFn).toHaveBeenCalledWith(100, expect.arrayContaining([15, 30]));
  });

  test('removes interval when present', async () => {
    const { handleSettingsCallback } = await import('../../../src/bot/commands/settings.ts');
    const ctx = makeCallbackCtx();
    const updateFn = mock(() => {});
    const prefs = {
      ...makePrefsService({ default_reminder_intervals: '[15, 30]' }),
      updateDefaultIntervals: updateFn,
    };

    await handleSettingsCallback(ctx, makeUser() as never, 'toggle_reminder:15', prefs as never);

    expect(updateFn).toHaveBeenCalledWith(100, [30]);
  });
});
```

Before writing these tests, update `makePrefsService` in `settings.test.ts` to add missing methods:

```typescript
function makePrefsService(overrides: Record<string, unknown> = {}) {
  return {
    getOrCreate: mock(() => ({
      // ... existing fields ...
      default_reminder_intervals: '[30]',
      ...overrides,
    })),
    toggleMorningAgenda: mock(() => {}),
    toggleEveningReview: mock(() => {}),
    toggleQuietHours: mock(() => {}),
    updateDefaultIntervals: mock(() => {}),  // ← add this
  };
}
```

- [ ] **Step 2: Run tests — confirm they fail**

```bash
bun test test/bot/commands/settings.test.ts
```

- [ ] **Step 3: Update `buildNotificationsView`**

Remove the two lines:
```
'  За сколько до события бот присылает напоминание.',
'  Чтобы изменить — напишите AI: «напомни за 10 и 30 минут».',
```

Replace with single line:
```
'  За сколько до события бот присылает напоминание.',
```

Add `⏰ Интервалы` button to `kb` in `buildNotificationsView`:

```typescript
const kb = backRow(
  new InlineKeyboard()
    .text(`${morningEnabled ? '✅' : '❌'} Утренняя сводка`, 'stg:toggle_morning')
    .row()
    .text(`${eveningEnabled ? '✅' : '❌'} Вечерний обзор`, 'stg:toggle_evening')
    .row()
    .text(`${quietEnabled ? '✅' : '❌'} Тихие часы`, 'stg:toggle_quiet')
    .row()
    .text('⏰ Интервалы напоминаний', 'stg:edit_reminders'),
);
```

- [ ] **Step 4: Add `edit_reminders` and `toggle_reminder` handlers**

Add a new sub-function:

```typescript
function buildReminderIntervalsView(intervals: number[]): { text: string; kb: InlineKeyboard } {
  const fmtInterval = (m: number) => (m === 0 ? 'в начале' : m >= 60 ? `${m / 60}ч` : `${m}мин`);
  const text = [
    '⏰ Интервалы напоминаний',
    '',
    `Активные: ${intervals.length > 0 ? intervals.map(fmtInterval).join(', ') : 'не заданы'}`,
    '  Выберите за сколько до события отправлять напоминание.',
  ].join('\n');
  return { text, kb: reminderIntervalsKeyboard(intervals) };
}
```

In `handleSettingsCallback`, add handling for `edit_reminders` and `toggle_reminder:N`:

Add these cases to the notifications block (after the `toggle_quiet` handler):

```typescript
if (subAction === 'edit_reminders' || subAction.startsWith('toggle_reminder:')) {
  const prefs = prefsService.getOrCreate(user.telegram_id);
  let intervals = JSON.parse(prefs.default_reminder_intervals) as number[];

  if (subAction.startsWith('toggle_reminder:')) {
    const val = Number.parseInt(subAction.split(':')[1]!, 10);
    if (intervals.includes(val)) {
      intervals = intervals.filter((x) => x !== val);
    } else {
      intervals = [...intervals, val].sort((a, b) => a - b);  // ascending: 0, 5, 15, 30...
    }
    prefsService.updateDefaultIntervals(user.telegram_id, intervals);
  }

  const { text, kb } = buildReminderIntervalsView(intervals);
  await ctx.answer();
  await ctx.editText(text, { reply_markup: kb });
  return;
}
```

Note: `getOrCreate` internally calls `ensureDefaults` — do NOT call `prefsService.ensureDefaults` (it doesn't exist on the service).

- [ ] **Step 5: Run tests**

```bash
bun test test/bot/commands/settings.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/bot/commands/settings.ts test/bot/commands/settings.test.ts
git commit -m "feat(settings): reminder intervals toggle UI; remove AI text instructions from notifications"
```

---

## Task 5: Wire timezone scene into callback handler; remove /timezone command

**Files:**
- Modify: `src/bot/handlers/callback.handler.ts:63-122` (add `timezoneScene` param)
- Modify: `src/bot/handlers/callback.handler.ts:990-999` (handle `stg:change_tz`)
- Modify: `src/bot/index.ts` (pass scene, remove `/timezone` command)

- [ ] **Step 1: Add `timezoneScene?: AnyScene` to `createCallbackHandler`**

In `callback.handler.ts`, add after `contactRepo?: ContactRepository,` (last current param, line ~121):

```typescript
timezoneScene?: AnyScene,
```

- [ ] **Step 2: Handle `stg:change_tz` in the `action === 'stg'` block**

Replace lines ~990-999:

```typescript
if (action === 'stg') {
  if (payload === 'change_tz' && timezoneScene) {
    await ctx.answer();
    await ctx.scene.enter(timezoneScene);
    return;
  }
  return handleSettingsCallback(
    ctx,
    user,
    payload,
    prefsService,
    callSettingsRepo,
    sharingSettingsRepo,
    userRepo,
  );
}
```

- [ ] **Step 3: Pass `timezoneScene` in `index.ts`**

In the `createCallbackHandler(...)` call in `index.ts`, add after `db.contacts`:

```typescript
db.contacts,
scenesSetup.scenes.timezoneScene,
```

- [ ] **Step 4: Remove `/timezone` command registration from `index.ts`**

Remove:
```typescript
.command('timezone', (ctx) => handleTimezone(ctx as unknown as BotCommandContext, scenesSetup.scenes.timezoneScene))
```

Also remove the `handleTimezone` import from `index.ts` if it becomes unused.

- [ ] **Step 5: Verify lint passes**

```bash
bun run lint
```

Fix any issues. Common: unused import of `handleTimezone`.

- [ ] **Step 6: Run full test suite**

```bash
bun test
```

- [ ] **Step 7: Commit**

```bash
git add src/bot/handlers/callback.handler.ts src/bot/index.ts
git commit -m "feat(settings): wire timezone scene into settings callback; remove /timezone command"
```

---

## Task 6: Final verification

- [ ] **Step 1: Run full test suite with coverage**

```bash
bun test --coverage
```

Verify coverage stays at ~93%+.

- [ ] **Step 2: Run lint**

```bash
bun run lint
```

Zero warnings/errors.

- [ ] **Step 3: Manual test checklist**

After restarting the bot:
- `/settings` → shows ✖️ Закрыть button
- Click ✖️ → message deleted
- Click Основные → shows 3 buttons (Часовой пояс, Язык RU/EN, Страна)
- Click Часовой пояс → timezone scene opens (region picker)
- Click 🇬🇧 English → language updates immediately, re-renders general view
- Click Страна → country picker with top-30 list
- Click any country → saves, returns to general view
- Click Уведомления → no "напишите AI" text; shows "⏰ Интервалы" button
- Click Интервалы → shows preset toggles
- Toggle an interval → saves and re-renders intervals view
- Tell AI "switch to English" → language persists (call manage_settings)
