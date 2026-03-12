# Sessions & FSM Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the in-memory session Map with `@gramio/scenes` + `@gramio/storage-sqlite` so multi-step flows survive bot restarts.

**Architecture:** Each multi-step flow (onboarding, /add wizard, /edit field input, /timezone, /import) becomes a `Scene` with typed state, persisted in SQLite via `@gramio/storage-sqlite`. The `scenes()` plugin intercepts ALL GramIO events for users in active scenes, routing them to the scene step handler. Command handlers enter scenes via `ctx.scene.enter(sceneRef)`. The in-memory session Map (`types.ts`) is removed entirely after migration.

**Tech Stack:** `@gramio/scenes@0.5.1`, `@gramio/storage-sqlite@0.0.2`, `bun:sqlite` (reuse main DB)

---

## Key API Reference

```typescript
// Scene creation
const myScene = new Scene("name")
  .state<{ field: string }>()
  .step("message", async (ctx) => {
    if (ctx.scene.step.firstTime) { await ctx.send("prompt"); return; }
    await ctx.scene.update({ field: ctx.text }); // saves state + advances
  })
  .step(["message", "callback_query"], async (ctx) => {
    // Mixed step — check ctx.is("callback_query") or ctx.is("message")
  });

// Entering a scene (available on message/callback_query contexts)
await ctx.scene.enter(myScene);
await ctx.scene.enter(myScene, params); // with typed params

// State update WITHOUT advancing
await ctx.scene.update({ key: val }, { step: undefined });

// Navigation
await ctx.scene.step.next();      // advance
await ctx.scene.step.previous();  // go back
await ctx.scene.step.go(2);       // jump to step index
await ctx.scene.exit();           // exit scene, delete storage

// Scenes plugin registration (AFTER .derive, BEFORE .command)
bot.extend(scenes([scene1, scene2], { storage }));
```

### CRITICAL: `firstTime` and entry context type mismatch

When `scene.enter()` is called, `scene.compose(context)` runs immediately with the CURRENT context. If the first step's event type doesn't match the entry context type, the step handler **won't fire** and `firstTime` is silently set to `false`. The prompt is never shown.

**Affected scenes and fix:**

- `edit_value`: entered from callback → step 0 is `"message"` → use `onEnter()` for prompt
- `onboarding`: entered from `/start` (message) → step 0 is `"callback_query"` → use `onEnter()` for prompt
- `timezone`: entered from `/timezone` (message) → step 0 is `["callback_query", "location"]` → use `onEnter()` for prompt

**Unaffected scenes:**

- `add_event`: entered from `/add` (message) → step 0 is `"message"` → `firstTime` works
- `import`: entered from `/import` (message) → step 0 is `"message"` → `firstTime` works

The `onEnter()` handler fires during `scene.enter()` regardless of context type, BEFORE `compose()`. On bot restart, `onEnter` does NOT re-fire — the keyboard/prompt from the initial entry is still in chat history.

### Verified: `"location"` IS a valid step event type

Confirmed from `@gramio/scenes@0.5.1` source: the internal `events` array includes `"location"`. The `scenes()` plugin intercepts ALL events in this array for users in active scenes. `step("location", handler)` works correctly.

## File Structure

**New files:**

- `src/bot/scenes/storage.ts` — SQLite storage singleton factory
- `src/bot/scenes/helpers.ts` — Command escape middleware, shared scene utilities
- `src/bot/scenes/add-event.scene.ts` — /add wizard (3 steps: title → time → duration)
- `src/bot/scenes/edit-value.scene.ts` — Edit field value (1 step, entered from callback handler)
- `src/bot/scenes/import.scene.ts` — /import file wait (1 step, document upload)
- `src/bot/scenes/timezone.scene.ts` — /timezone prompt (1 step, callback + location)
- `src/bot/scenes/onboarding.scene.ts` — /start onboarding (4 steps: lang → tz → country → agenda)
- `src/bot/scenes/index.ts` — Re-exports + factory that creates all scenes with dependencies
- `test/bot/scenes/add-event.scene.test.ts`
- `test/bot/scenes/helpers.test.ts`

**Modified files:**

- `package.json` — Add `@gramio/scenes`, `@gramio/storage-sqlite`
- `src/bot/types.ts` — Remove in-memory session Map; add `SceneAccess` to context types
- `src/bot/index.ts` — Wire scenes plugin, remove session-based routing
- `src/bot/commands/add.ts` — Enter scene instead of setSession; keep handleQuickAdd
- `src/bot/commands/edit.ts` — Enter scene from handleEditFieldCallback
- `src/bot/commands/start.ts` — Enter onboarding scene; remove handleOnboardingCallback
- `src/bot/commands/timezone.ts` — Enter timezone scene
- `src/bot/commands/import.ts` — Enter import scene
- `src/bot/handlers/message.handler.ts` — Remove wizard routing, simplify to fallback only
- `src/bot/handlers/callback.handler.ts` — Remove onboarding callback routing

---

## Chunk 1: Infrastructure

### Task 1.1: Install dependencies

**Files:**

- Modify: `package.json`

- [ ] **Step 1: Install packages**

Run: `bun add @gramio/scenes@0.5.1 @gramio/storage-sqlite@0.0.2`

- [ ] **Step 2: Verify installation**

Run: `bun pm ls | grep gramio`
Expected: `@gramio/scenes@0.5.1` and `@gramio/storage-sqlite@0.0.2` in output

### Task 1.2: Create storage factory

**Files:**

- Create: `src/bot/scenes/storage.ts`

- [ ] **Step 1: Write storage.ts**

```typescript
// src/bot/scenes/storage.ts
import type { Database } from 'bun:sqlite';
import { sqliteStorage } from '@gramio/storage-sqlite';

export function createSceneStorage(db: Database) {
  return sqliteStorage({
    db,
    tableName: 'gramio_scenes',
    $ttl: 30 * 60, // 30 min TTL (in seconds) for scene data
  });
}
```

Note: `@gramio/storage-sqlite` auto-creates the table. The `$ttl` option sets expiration for abandoned scenes.

### Task 1.3: Create scene helpers

**Files:**

- Create: `src/bot/scenes/helpers.ts`
- Create: `test/bot/scenes/helpers.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/bot/scenes/helpers.test.ts
import { describe, expect, test } from 'bun:test';
import { isCommandEscape } from '../../src/bot/scenes/helpers.ts';

describe('isCommandEscape', () => {
  test('returns true for /cancel', () => {
    expect(isCommandEscape('/cancel')).toBe(true);
  });

  test('returns true for /cancel with extra text', () => {
    expect(isCommandEscape('/cancel something')).toBe(true);
  });

  test('returns true for other commands', () => {
    expect(isCommandEscape('/help')).toBe(true);
    expect(isCommandEscape('/add')).toBe(true);
  });

  test('returns false for regular text', () => {
    expect(isCommandEscape('hello')).toBe(false);
    expect(isCommandEscape('meeting tomorrow')).toBe(false);
  });

  test('returns false for empty/undefined', () => {
    expect(isCommandEscape(undefined)).toBe(false);
    expect(isCommandEscape('')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/bot/scenes/helpers.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```typescript
// src/bot/scenes/helpers.ts
import type { User } from '../../database/types.ts';
import { t } from '../../config/constants.ts';

/**
 * Check if the text is a bot command that should exit the current scene.
 */
export function isCommandEscape(text: string | undefined | null): boolean {
  if (!text) return false;
  return text.startsWith('/');
}

/**
 * Get user language from derived context.
 * Scenes don't have DerivedProps typing, so this helper extracts dbUser safely.
 */
export function getSceneUser(context: unknown): User | undefined {
  const ctx = context as { dbUser?: User };
  return ctx.dbUser;
}

/**
 * Get user language shorthand.
 */
export function getSceneLang(context: unknown): 'en' | 'ru' {
  const user = getSceneUser(context);
  return (user?.language ?? 'en') as 'en' | 'ru';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/bot/scenes/helpers.test.ts`
Expected: PASS

### Task 1.4: Create scenes index with factory

**Files:**

- Create: `src/bot/scenes/index.ts`

- [ ] **Step 1: Write the initial index (empty scene list — populated in later chunks)**

```typescript
// src/bot/scenes/index.ts
import type { Database } from 'bun:sqlite';
import type { EventService } from '../../services/event/event-service.ts';
import type { DatabaseService } from '../../database/index.ts';
import { scenes } from '@gramio/scenes';
import { createSceneStorage } from './storage.ts';

export function createScenesPlugin(db: DatabaseService, eventService: EventService, botToken: string) {
  const storage = createSceneStorage(db.db);

  // Scenes will be added here as they are implemented
  const allScenes: [] = [];

  return {
    plugin: scenes(allScenes, { storage }),
    storage,
    scenes: {},
  };
}
```

### Task 1.5: Update context types

**Files:**

- Modify: `src/bot/types.ts`

- [ ] **Step 1: Add SceneAccess interface to types.ts**

Add after `GramIOMessageExtras` interface (do NOT remove session code yet — that happens in Chunk 5):

```typescript
import type { AnyScene } from '@gramio/scenes';

/**
 * Scene access derived by @gramio/scenes plugin.
 * Available on message and callback_query contexts.
 */
export interface SceneAccess {
  enter: (scene: AnyScene, ...args: unknown[]) => Promise<void>;
}
```

Update `BotCommandContext` and `BotCallbackContext` to include `SceneAccess`:

```typescript
export type BotCommandContext = MessageContext<AnyBot> & DerivedProps & GramIOMessageExtras & {
  scene: SceneAccess;
};

export type BotCallbackContext = CallbackQueryContext<AnyBot> & DerivedProps & {
  scene: SceneAccess;
};
```

### Task 1.6: Wire scenes plugin into bot factory

**Files:**

- Modify: `src/bot/index.ts`

- [ ] **Step 1: Import and extend bot with scenes plugin**

Add import at top:

```typescript
import { createScenesPlugin } from './scenes/index.ts';
```

In `createBot`, after creating `rateLimiter`, before `const bot = new Bot(token)`:

```typescript
const scenesSetup = createScenesPlugin(db, eventService, token);
```

In the bot chain, add `.extend(scenesSetup.plugin)` AFTER `.derive(createUserResolver(db))` and the rate limiter `.use(...)`, but BEFORE `.command(...)` handlers.

- [ ] **Step 2: Verify bot still starts**

Run: `bun run src/index.ts` (manually, quick smoke test — Ctrl+C after startup log)
Expected: Bot starts without errors, `gramio_scenes` table created in SQLite

- [ ] **Step 3: Run existing tests**

Run: `bun test`
Expected: All existing tests pass (no regressions)

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: add @gramio/scenes infrastructure with SQLite storage"
```

---

## Chunk 2: Add Event Scene

### Task 2.1: Create add event scene

**Files:**

- Create: `src/bot/scenes/add-event.scene.ts`
- Create: `test/bot/scenes/add-event.scene.test.ts`
- Modify: `src/bot/scenes/index.ts`

The add wizard has 3 steps: title → time → duration → create event.

- [ ] **Step 1: Write test for scene step logic helpers**

The scene handlers call business logic that we can test independently. Extract parseable logic:

```typescript
// test/bot/scenes/add-event.scene.test.ts
import { describe, expect, test } from 'bun:test';

// We test the existing parseSimpleDate and parseDuration (already tested elsewhere).
// For the scene, we verify the scene object is created correctly.
import { createAddEventScene } from '../../src/bot/scenes/add-event.scene.ts';

describe('createAddEventScene', () => {
  test('creates scene with name "add_event"', () => {
    const mockEventService = {} as unknown as EventService;
    const scene = createAddEventScene(mockEventService);
    expect(scene.name).toBe('add_event');
    expect(scene.stepsCount).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/bot/scenes/add-event.scene.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write scene implementation**

```typescript
// src/bot/scenes/add-event.scene.ts
import { addMinutes } from 'date-fns';
import { Scene } from '@gramio/scenes';
import { t } from '../../config/constants.ts';
import type { EventService } from '../../services/event/event-service.ts';
import { formatEventDetail } from '../../services/event/formatters.ts';
import { parseDuration, parseSimpleDate } from '../../utils/date.ts';
import { eventActionsKeyboard } from '../keyboards.ts';
import { getSceneLang, getSceneUser, isCommandEscape } from './helpers.ts';

interface AddEventState {
  title?: string;
  startAt?: string;
}

export function createAddEventScene(eventService: EventService) {
  return new Scene('add_event')
    .state<AddEventState>()
    .on('message', async (context, next) => {
      const text = (context as unknown as { text?: string }).text;
      if (isCommandEscape(text)) {
        await context.scene.exit();
        const lang = getSceneLang(context);
        if (text === '/cancel') {
          await context.send(lang === 'ru' ? 'Отменено.' : 'Cancelled.');
        } else {
          await context.send(
            lang === 'ru'
              ? 'Сессия прервана. Повторите команду.'
              : 'Session cancelled. Please resend your command.',
          );
        }
        return;
      }
      return next();
    })
    // Step 0: Title
    .step('message', async (context) => {
      const lang = getSceneLang(context);
      if (context.scene.step.firstTime) {
        await context.send(t(lang).add_title_prompt);
        return;
      }
      const text = (context as unknown as { text?: string }).text;
      if (!text?.trim()) {
        await context.send(t(lang).add_title_prompt);
        return;
      }
      await context.scene.update({ title: text.trim() });
    })
    // Step 1: Date/Time
    .step('message', async (context) => {
      const lang = getSceneLang(context);
      const user = getSceneUser(context);
      if (context.scene.step.firstTime) {
        await context.send(t(lang).add_time_prompt);
        return;
      }
      const text = (context as unknown as { text?: string }).text;
      if (!text) return;
      const parsed = parseSimpleDate(text, user?.timezone ?? 'UTC');
      if (!parsed) {
        await context.send(
          lang === 'ru'
            ? 'Не могу разобрать дату. Попробуйте: "завтра 15:00"'
            : 'Can\'t parse that date. Try: "tomorrow 15:00"',
        );
        return;
      }
      await context.scene.update({ startAt: parsed.toISOString() });
    })
    // Step 2: Duration
    .step('message', async (context) => {
      const lang = getSceneLang(context);
      const user = getSceneUser(context);
      if (context.scene.step.firstTime) {
        await context.send(t(lang).add_duration_prompt);
        return;
      }
      if (!user) return;
      const text = (context as unknown as { text?: string }).text;
      if (!text) return;

      const { title, startAt } = context.scene.state;
      if (!title || !startAt) {
        await context.scene.exit();
        return;
      }

      let endAt: string | undefined;
      if (text.toLowerCase() !== 'skip' && text.toLowerCase() !== 'пропустить') {
        const mins = parseDuration(text);
        if (mins) {
          endAt = addMinutes(new Date(startAt), mins).toISOString();
        }
      }

      const event = eventService.createEvent({
        user_id: user.telegram_id,
        title,
        start_at: startAt,
        end_at: endAt,
        timezone: user.timezone,
      });

      await context.scene.exit();
      const detail = formatEventDetail(event, user.timezone, lang);
      await context.send(`${t(lang).event_created(title)}\n\n${detail}`, {
        parse_mode: 'HTML',
        reply_markup: eventActionsKeyboard(event.id, lang),
      });
    });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/bot/scenes/add-event.scene.test.ts`
Expected: PASS

### Task 2.2: Register scene and update command handler

**Files:**

- Modify: `src/bot/scenes/index.ts`
- Modify: `src/bot/commands/add.ts`

- [ ] **Step 1: Register add event scene in index.ts**

Update `createScenesPlugin`:

```typescript
import { createAddEventScene } from './add-event.scene.ts';

export function createScenesPlugin(db: DatabaseService, eventService: EventService, botToken: string) {
  const storage = createSceneStorage(db.db);

  const addEventScene = createAddEventScene(eventService);
  const allScenes = [addEventScene];

  return {
    plugin: scenes(allScenes, { storage }),
    storage,
    scenes: { addEventScene },
  };
}
```

- [ ] **Step 2: Update bot/index.ts to pass scene to add command**

In the `.command('add', ...)` handler, change from:

```typescript
.command('add', (ctx) => handleAdd(ctx as unknown as BotCommandContext, eventService))
```

to:

```typescript
.command('add', (ctx) => handleAdd(ctx as unknown as BotCommandContext, eventService, scenesSetup.scenes.addEventScene))
```

- [ ] **Step 3: Update add.ts — enter scene instead of setSession**

Modify `handleAdd` signature to accept scene reference. Remove `setSession`/`getSession`/`clearSession` imports. Replace session logic with scene entry:

```typescript
import type { AnyScene } from '@gramio/scenes';

export async function handleAdd(
  ctx: BotCommandContext,
  eventService: EventService,
  addEventScene: AnyScene,
): Promise<void> {
  const user = ctx.dbUser as User;
  const lang = user.language as 'en' | 'ru';
  const args = ctx.args as string | undefined;

  if (args && args.trim().length > 0) {
    return handleQuickAdd(ctx, eventService, user, args.trim());
  }

  await ctx.scene.enter(addEventScene);
}
```

Remove `handleAddWizardStep` function entirely — the scene handles it now.

- [ ] **Step 4: Update message.handler.ts — remove add wizard routing**

In `createMessageHandler`, remove the line:

```typescript
if (await handleAddWizardStep(ctx, eventService, user, text)) return;
```

And remove the import of `handleAddWizardStep`.

- [ ] **Step 5: Run tests**

Run: `bun test`
Expected: All tests pass. If any test imported `handleAddWizardStep`, update it.

- [ ] **Step 6: Lint**

Run: `bun run lint`
Expected: No errors (unused imports cleaned up)

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: migrate /add wizard to @gramio/scenes"
```

---

## Chunk 3: Edit Value + Import + Timezone Scenes

### Task 3.1: Create edit value scene

**Files:**

- Create: `src/bot/scenes/edit-value.scene.ts`

Single-step scene. Entered from callback handler with params `{ eventId, field }`. Collects one text message and applies the edit.

- [ ] **Step 1: Write scene**

```typescript
// src/bot/scenes/edit-value.scene.ts
import { Scene } from '@gramio/scenes';
import { t } from '../../config/constants.ts';
import type { EventService } from '../../services/event/event-service.ts';
import { formatEventDetail } from '../../services/event/formatters.ts';
import { parseSimpleDate } from '../../utils/date.ts';
import { getSceneLang, getSceneUser, isCommandEscape } from './helpers.ts';

interface EditValueParams {
  eventId: number;
  field: string;
}

const EDIT_PROMPTS: Record<string, Record<string, string>> = {
  title: { en: 'Send new title:', ru: 'Отправьте новое название:' },
  time: { en: 'Send new date/time (e.g., "tomorrow 15:00"):', ru: 'Отправьте новую дату/время:' },
  description: {
    en: 'Send new description (or "clear" to remove):',
    ru: 'Отправьте описание (или "clear" для удаления):',
  },
  location: {
    en: 'Send new location (or "clear" to remove):',
    ru: 'Отправьте место (или "clear" для удаления):',
  },
};

export function createEditValueScene(eventService: EventService) {
  return new Scene('edit_value')
    .params<EditValueParams>()
    // onEnter sends prompt — because scene is entered from callback_query
    // but step 0 is "message", so firstTime won't fire on entry
    .onEnter(async (context) => {
      const lang = getSceneLang(context);
      const params = (context as unknown as { scene: { params: EditValueParams } }).scene.params;
      await context.send(EDIT_PROMPTS[params.field]?.[lang] ?? 'Send new value:');
    })
    .on('message', async (context, next) => {
      const text = (context as unknown as { text?: string }).text;
      if (isCommandEscape(text)) {
        await context.scene.exit();
        const lang = getSceneLang(context);
        await context.send(lang === 'ru' ? 'Отменено.' : 'Cancelled.');
        return;
      }
      return next();
    })
    .step('message', async (context) => {
      const lang = getSceneLang(context);
      const user = getSceneUser(context);
      if (!user) { await context.scene.exit(); return; }

      const { eventId, field } = context.scene.params;
      const text = (context as unknown as { text?: string }).text;
      if (!text) return;

      const updateData: Record<string, unknown> = {};

      if (field === 'title') {
        updateData.title = text;
      } else if (field === 'time') {
        const parsed = parseSimpleDate(text, user.timezone);
        if (!parsed) {
          await context.send(lang === 'ru' ? 'Не могу разобрать дату.' : "Can't parse that date.");
          return;
        }
        updateData.start_at = parsed.toISOString();
      } else if (field === 'description') {
        updateData.description = text.toLowerCase() === 'clear' ? null : text;
      } else if (field === 'location') {
        updateData.location = text.toLowerCase() === 'clear' ? null : text;
      }

      const updated = eventService.updateEvent(eventId, user.telegram_id, updateData);
      await context.scene.exit();

      if (updated) {
        const detail = formatEventDetail(updated, user.timezone, lang);
        await context.send(`${t(lang).event_updated(updated.title)}\n\n${detail}`, { parse_mode: 'HTML' });
      } else {
        await context.send(t(lang).something_wrong);
      }
    });
}
```

### Task 3.2: Create import scene

**Files:**

- Create: `src/bot/scenes/import.scene.ts`

Single-step scene. Waits for a document upload.

- [ ] **Step 1: Write scene**

```typescript
// src/bot/scenes/import.scene.ts
import { Scene } from '@gramio/scenes';
import type { EventService } from '../../services/event/event-service.ts';
import { parseIcs } from '../../services/ics/parser.ts';
import { getSceneLang, getSceneUser, isCommandEscape } from './helpers.ts';

export function createImportScene(eventService: EventService, botToken: string) {
  return new Scene('import')
    .on('message', async (context, next) => {
      const text = (context as unknown as { text?: string }).text;
      if (isCommandEscape(text)) {
        await context.scene.exit();
        const lang = getSceneLang(context);
        await context.send(lang === 'ru' ? 'Отменено.' : 'Cancelled.');
        return;
      }
      return next();
    })
    .step('message', async (context) => {
      const lang = getSceneLang(context);
      const user = getSceneUser(context);
      if (!user) { await context.scene.exit(); return; }

      if (context.scene.step.firstTime) {
        await context.send(lang === 'ru' ? 'Отправьте .ics файл.' : 'Send an .ics file.');
        return;
      }

      // Check for document
      const ctx = context as unknown as {
        document?: { file_id: string; file_name?: string };
        getFile(): Promise<{ file_path: string }>;
        text?: string;
      };

      if (!ctx.document) {
        await context.send(
          lang === 'ru' ? 'Ожидаю .ics файл. Отправьте файл или /cancel.' : 'Expecting .ics file. Send a file or /cancel.',
        );
        return;
      }

      try {
        const file = await ctx.getFile();
        const response = await fetch(`https://api.telegram.org/file/bot${botToken}/${file.file_path}`);
        const content = await response.text();
        const parsed = parseIcs(content);

        if (parsed.length === 0) {
          await context.send(lang === 'ru' ? 'Не найдено событий в файле.' : 'No events found in file.');
          await context.scene.exit();
          return;
        }

        let imported = 0;
        for (const icsEvent of parsed) {
          eventService.createEvent({
            user_id: user.telegram_id,
            title: icsEvent.title,
            start_at: icsEvent.start_at,
            end_at: icsEvent.end_at,
            description: icsEvent.description,
            location: icsEvent.location,
            timezone: user.timezone,
            recurrence_rule: icsEvent.recurrence_rule,
          });
          imported++;
        }

        await context.send(lang === 'ru' ? `\u2705 Импортировано ${imported} событий.` : `\u2705 Imported ${imported} events.`);
      } catch {
        await context.send(lang === 'ru' ? 'Не удалось прочитать файл.' : 'Failed to read file.');
      }

      await context.scene.exit();
    });
}
```

### Task 3.3: Create timezone scene

**Files:**

- Create: `src/bot/scenes/timezone.scene.ts`

Single-step scene. Handles both callback (manual region/city selection) and location (geo-resolve).

- [ ] **Step 1: Write scene**

```typescript
// src/bot/scenes/timezone.scene.ts
import { Scene } from '@gramio/scenes';
import type { DatabaseService } from '../../database/index.ts';
import { CB } from '../../config/constants.ts';
import {
  getTimezoneDisplay,
  resolveTimezone,
} from '../../services/timezone/timezone-service.ts';
import {
  timezoneManualKeyboard,
  timezoneCitiesKeyboard,
  timezoneMethodKeyboard,
} from '../keyboards.ts';
import { getSceneLang, getSceneUser } from './helpers.ts';

export function createTimezoneScene(db: DatabaseService) {
  return new Scene('timezone')
    // onEnter sends prompts — because scene is entered from /timezone (message)
    // but step 0 is ["callback_query", "location"], so firstTime won't fire on entry
    .onEnter(async (context) => {
      const lang = getSceneLang(context);
      const user = getSceneUser(context);
      if (!user) return;

      const display = getTimezoneDisplay(user.timezone);
      const text = lang === 'ru'
        ? `\ud83c\udf0d Текущий часовой пояс: ${display}\n\nИзменить?`
        : `\ud83c\udf0d Current timezone: ${display}\n\nChange it?`;

      await context.send(text, { reply_markup: timezoneManualKeyboard() });
      await context.send(
        lang === 'ru' ? 'Или отправьте геолокацию:' : 'Or share your location:',
        { reply_markup: timezoneMethodKeyboard(lang) },
      );
    })
    .on('message', async (context, next) => {
      const text = (context as unknown as { text?: string }).text;
      if (text?.startsWith('/')) {
        await context.scene.exit();
        const lang = getSceneLang(context);
        await context.send(lang === 'ru' ? 'Отменено.' : 'Cancelled.', {
          reply_markup: { remove_keyboard: true },
        });
        return;
      }
      return next();
    })
    .step(['callback_query', 'location'], async (context) => {
      const lang = getSceneLang(context);
      const user = getSceneUser(context);
      if (!user) { await context.scene.exit(); return; }

      // Handle location
      if (context.is('location')) {
        const { latitude, longitude } = (context as unknown as { eventLocation: { latitude: number; longitude: number } }).eventLocation;
        const tz = resolveTimezone(latitude, longitude);
        db.users.update(user.telegram_id, { timezone: tz });
        await context.scene.exit();
        await context.send(`\u2705 ${getTimezoneDisplay(tz)}`, {
          reply_markup: { remove_keyboard: true },
        });
        return;
      }

      // Handle callback_query
      if (context.is('callback_query')) {
        const data = (context as unknown as { data: string }).data;
        if (!data) return;

        const parts = data.split(':');
        const action = parts[0];
        const payload = parts.slice(1).join(':');

        // Region selected → show cities
        if (action === CB.ONBOARD_TZ_REGION) {
          await (context as unknown as { editText: (text: string, opts?: Record<string, unknown>) => Promise<unknown> }).editText('Select city:', {
            reply_markup: timezoneCitiesKeyboard(payload),
          });
          await (context as unknown as { answer: (opts?: Record<string, unknown>) => Promise<unknown> }).answer();
          return; // Stay on same step
        }

        // Timezone selected
        if (action === CB.ONBOARD_TZ) {
          db.users.update(user.telegram_id, { timezone: payload });
          await context.scene.exit();
          await context.send(`\u2705 ${getTimezoneDisplay(payload)}`, {
            reply_markup: { remove_keyboard: true },
          });
          await (context as unknown as { answer: (opts?: Record<string, unknown>) => Promise<unknown> }).answer();
          return;
        }

        await (context as unknown as { answer: (opts?: Record<string, unknown>) => Promise<unknown> }).answer();
      }
    });
}
```

### Task 3.4: Register scenes and update command handlers

**Files:**

- Modify: `src/bot/scenes/index.ts`
- Modify: `src/bot/commands/edit.ts`
- Modify: `src/bot/commands/import.ts`
- Modify: `src/bot/commands/timezone.ts`
- Modify: `src/bot/index.ts`
- Modify: `src/bot/handlers/message.handler.ts`

- [ ] **Step 1: Update scenes/index.ts — add all three scenes**

```typescript
import { createAddEventScene } from './add-event.scene.ts';
import { createEditValueScene } from './edit-value.scene.ts';
import { createImportScene } from './import.scene.ts';
import { createTimezoneScene } from './timezone.scene.ts';

export function createScenesPlugin(db: DatabaseService, eventService: EventService, botToken: string) {
  const storage = createSceneStorage(db.db);

  const addEventScene = createAddEventScene(eventService);
  const editValueScene = createEditValueScene(eventService);
  const importScene = createImportScene(eventService, botToken);
  const timezoneScene = createTimezoneScene(db);
  const allScenes = [addEventScene, editValueScene, importScene, timezoneScene];

  return {
    plugin: scenes(allScenes, { storage }),
    storage,
    scenes: { addEventScene, editValueScene, importScene, timezoneScene },
  };
}
```

- [ ] **Step 2: Update edit.ts — enter scene from callback handler**

Modify `handleEditFieldCallback` to enter the edit_value scene instead of `setSession`:

```typescript
import type { AnyScene } from '@gramio/scenes';

export async function handleEditFieldCallback(
  ctx: BotCallbackContext,
  user: User,
  eventId: number,
  field: string,
  editValueScene: AnyScene,
): Promise<void> {
  const lang = user.language as 'en' | 'ru';

  if (field === 'cancel') {
    await ctx.editText(lang === 'ru' ? 'Отменено.' : 'Cancelled.');
    return;
  }

  await ctx.answer();
  await ctx.scene.enter(editValueScene, { eventId, field });
}
```

Remove `handleEditWizardStep` function entirely — the scene handles it now.

- [ ] **Step 3: Update import.ts — enter scene**

```typescript
import type { AnyScene } from '@gramio/scenes';

export async function handleImport(ctx: BotCommandContext, importScene: AnyScene): Promise<void> {
  await ctx.scene.enter(importScene);
}
```

Remove `handleImportFile` function — the scene handles it now.

- [ ] **Step 4: Update timezone.ts — enter scene**

```typescript
import type { AnyScene } from '@gramio/scenes';

export async function handleTimezone(ctx: BotCommandContext, timezoneScene: AnyScene): Promise<void> {
  await ctx.scene.enter(timezoneScene);
}
```

Remove old session and keyboard imports.

- [ ] **Step 5: Update bot/index.ts — pass scene references to commands**

Update command registrations:

```typescript
.command('edit', (ctx) => handleEdit(ctx as unknown as BotCommandContext, eventService))
// edit itself unchanged — field callback enters the scene

.command('import', (ctx) => handleImport(ctx as unknown as BotCommandContext, scenesSetup.scenes.importScene))
.command('timezone', (ctx) => handleTimezone(ctx as unknown as BotCommandContext, scenesSetup.scenes.timezoneScene))
```

Update callback handler creation to pass editValueScene:

```typescript
.on('callback_query', (ctx) =>
  createCallbackHandler(db, eventService, scenesSetup.scenes.editValueScene)(ctx as unknown as BotCallbackContext))
```

- [ ] **Step 6: Update callback.handler.ts — pass scene to edit field callback**

Update `createCallbackHandler` signature to accept `editValueScene`:

```typescript
export function createCallbackHandler(db: DatabaseService, eventService: EventService, editValueScene: AnyScene) {
```

Update the EDIT_FIELD case:

```typescript
if (action === CB.EDIT_FIELD) {
  const [eidStr, field] = payload.split(':');
  if (field === 'cancel' || eidStr === 'cancel') return ctx.editText('OK');
  return handleEditFieldCallback(ctx, user, Number(eidStr), field!, editValueScene);
}
```

- [ ] **Step 7: Update message.handler.ts — remove wizard routing**

Remove these lines from `createMessageHandler`:

```typescript
if (await handleAddWizardStep(ctx, eventService, user, text)) return;
if (await handleEditWizardStep(ctx, eventService, user, text)) return;
```

Remove the document handling block (import scene handles it now).

Remove `db` parameter from `createMessageHandler` if not used elsewhere.

Also remove `eventService` parameter from `createMessageHandler` if only used by wizard routing. The message handler becomes a simple fallback:

```typescript
export function createMessageHandler() {
  return async (ctx: BotCommandContext) => {
    const user = ctx.dbUser as User | undefined;
    if (!user) return;

    const text = ctx.text as string | undefined;
    if (!text) return;

    const lang = user.language as 'en' | 'ru';
    await ctx.send(
      lang === 'ru'
        ? 'Не понимаю. Используйте /help для списка команд.'
        : "I don't understand. Use /help for commands.",
    );
  };
}
```

- [ ] **Step 8: Update bot/index.ts — simplify message/location handlers**

For `.on('message')`:

```typescript
.on('message', (ctx) => createMessageHandler()(ctx as unknown as BotCommandContext))
```

Remove `.on('location')` handler entirely — timezone and onboarding scenes handle location events. (The scenes plugin intercepts location events for users in scenes; unsolicited locations from users NOT in scenes are safely ignored.)

- [ ] **Step 9: Run tests and lint**

Run: `bun test && bun run lint`
Expected: All tests pass, no lint errors. Fix any broken imports.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: migrate /edit, /import, /timezone to @gramio/scenes"
```

---

## Chunk 4: Onboarding Scene

The most complex scene. 4 steps: language → timezone → country → agenda.
Steps use `["callback_query", "location"]` for timezone and `"callback_query"` for others.

### Task 4.1: Create onboarding scene

**Files:**

- Create: `src/bot/scenes/onboarding.scene.ts`

- [ ] **Step 1: Write scene**

```typescript
// src/bot/scenes/onboarding.scene.ts
import { InlineKeyboard } from 'gramio';
import { Scene } from '@gramio/scenes';
import { CB, t } from '../../config/constants.ts';
import type { DatabaseService } from '../../database/index.ts';
import {
  getTimezoneDisplay,
  guessCountryFromTimezone,
  resolveTimezone,
} from '../../services/timezone/timezone-service.ts';
import {
  countryKeyboard,
  languageKeyboard,
  removeKeyboard,
  timezoneCitiesKeyboard,
  timezoneConfirmKeyboard,
  timezoneManualKeyboard,
  timezoneMethodKeyboard,
} from '../keyboards.ts';
import { getSceneLang, isCommandEscape } from './helpers.ts';

interface OnboardingState {
  lang?: 'en' | 'ru';
  detectedTz?: string;
  timezone?: string;
  country?: string;
}

export function createOnboardingScene(db: DatabaseService) {
  return new Scene('onboarding')
    .state<OnboardingState>()
    // onEnter sends welcome — because scene is entered from /start (message)
    // but step 0 is "callback_query", so firstTime won't fire on entry
    .onEnter(async (context) => {
      await context.send(t('en').welcome, { reply_markup: languageKeyboard() });
    })
    // Command escape for text messages during callback-only steps
    .on('message', async (context, next) => {
      const text = (context as unknown as { text?: string }).text;
      if (isCommandEscape(text)) {
        await context.scene.exit();
        const lang = getSceneLang(context);
        await context.send(lang === 'ru' ? 'Отменено.' : 'Cancelled.', {
          reply_markup: { remove_keyboard: true },
        });
        return;
      }
      return next();
    })

    // Step 0: Language selection (callback only)
    .step('callback_query', async (context) => {
      // No firstTime — prompt sent in onEnter
      const data = (context as unknown as { data: string }).data;
      if (!data) return;
      const parts = data.split(':');
      if (parts[0] !== CB.ONBOARD_LANG) return;

      const lang = parts[1] as 'en' | 'ru';
      db.users.update(context.from.id, { language: lang });

      await (context as unknown as { editText: (text: string, opts?: Record<string, unknown>) => Promise<unknown> }).editText(
        `${lang === 'ru' ? 'Язык: Русский' : 'Language: English'} ✅`,
      );
      await (context as unknown as { answer: (opts?: Record<string, unknown>) => Promise<unknown> }).answer();
      await context.scene.update({ lang });
    })

    // Step 1: Timezone (callback + location)
    .step(['callback_query', 'location'], async (context) => {
      const { lang } = context.scene.state;
      const l = lang ?? 'en';

      if (context.scene.step.firstTime) {
        await context.send(t(l).tz_prompt, {
          reply_markup: timezoneManualKeyboard(),
        });
        await context.send(t(l).tz_prompt, {
          reply_markup: timezoneMethodKeyboard(l),
        });
        return;
      }

      // Handle location
      if (context.is('location')) {
        const { latitude, longitude } = (context as unknown as {
          eventLocation: { latitude: number; longitude: number };
        }).eventLocation;
        const tz = resolveTimezone(latitude, longitude);
        const display = getTimezoneDisplay(tz);

        // Show confirmation buttons, stay on this step
        await context.send(t(l).tz_detected(tz, display), {
          ...removeKeyboard(),
          reply_markup: timezoneConfirmKeyboard(l),
        });
        // Save detected TZ in state without advancing
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
        const answer = () => cbCtx.answer();
        const editText = (text: string, opts?: Record<string, unknown>) => cbCtx.editText(text, opts);

        // Region selection
        if (action === CB.ONBOARD_TZ_REGION) {
          await editText('Select city:', { reply_markup: timezoneCitiesKeyboard(payload) });
          await answer();
          return; // Stay on same step
        }

        // Timezone confirm/manual/city
        if (action === CB.ONBOARD_TZ) {
          if (payload === 'confirm') {
            const tz = context.scene.state.detectedTz;
            if (!tz) return;
            db.users.update(context.from.id, { timezone: tz });
            const country = guessCountryFromTimezone(tz);
            await context.send(`✅ ${getTimezoneDisplay(tz)}`, removeKeyboard());
            await answer();
            await context.scene.update({ timezone: tz });
            return;
          }

          if (payload === 'manual') {
            await editText('Select region:', {
              reply_markup: timezoneManualKeyboard(),
            });
            await answer();
            return; // Stay on same step
          }

          // City selected directly
          db.users.update(context.from.id, { timezone: payload });
          await context.send(`✅ ${getTimezoneDisplay(payload)}`, removeKeyboard());
          await answer();
          await context.scene.update({ timezone: payload });
          return;
        }

        await answer();
      }
    })

    // Step 2: Country selection (callback)
    .step('callback_query', async (context) => {
      const { lang, timezone } = context.scene.state;
      const l = lang ?? 'en';

      if (context.scene.step.firstTime) {
        const country = guessCountryFromTimezone(timezone ?? 'UTC');
        await context.send(t(l).country_prompt, {
          reply_markup: countryKeyboard(country, l),
        });
        return;
      }

      const data = (context as unknown as { data: string }).data;
      if (!data) return;
      const parts = data.split(':');
      if (parts[0] !== CB.ONBOARD_COUNTRY) return;

      const payload = parts.slice(1).join(':');
      if (payload !== 'skip') {
        db.users.update(context.from.id, { country_code: payload });
      }

      await (context as unknown as { answer: (opts?: Record<string, unknown>) => Promise<unknown> }).answer();
      await context.scene.update({ country: payload });
    })

    // Step 3: Morning agenda prompt (callback)
    .step('callback_query', async (context) => {
      const { lang } = context.scene.state;
      const l = lang ?? 'en';

      if (context.scene.step.firstTime) {
        const agendaKb = new InlineKeyboard()
          .text(l === 'ru' ? 'Да, 08:00' : 'Yes, 08:00', `${CB.ONBOARD_AGENDA}:yes`)
          .text(l === 'ru' ? 'Нет' : 'No thanks', `${CB.ONBOARD_AGENDA}:no`);
        await context.send(t(l).agenda_prompt, { reply_markup: agendaKb });
        return;
      }

      const data = (context as unknown as { data: string }).data;
      if (!data) return;
      const parts = data.split(':');
      if (parts[0] !== CB.ONBOARD_AGENDA) return;

      // Complete onboarding
      db.users.update(context.from.id, { onboarding_completed: 1 });
      await (context as unknown as { answer: (opts?: Record<string, unknown>) => Promise<unknown> }).answer();

      await context.send(t(l).onboard_done);
      await context.scene.exit();
    });
}
```

### Task 4.2: Register onboarding scene and update handlers

**Files:**

- Modify: `src/bot/scenes/index.ts`
- Modify: `src/bot/commands/start.ts`
- Modify: `src/bot/handlers/callback.handler.ts`
- Modify: `src/bot/index.ts`

- [ ] **Step 1: Add onboarding scene to scenes/index.ts**

```typescript
import { createOnboardingScene } from './onboarding.scene.ts';

// In createScenesPlugin:
const onboardingScene = createOnboardingScene(db);
const allScenes = [addEventScene, editValueScene, importScene, timezoneScene, onboardingScene];

return {
  plugin: scenes(allScenes, { storage }),
  storage,
  scenes: { addEventScene, editValueScene, importScene, timezoneScene, onboardingScene },
};
```

- [ ] **Step 2: Update start.ts — enter scene instead of setSession**

Simplify `handleStart`:

```typescript
import type { AnyScene } from '@gramio/scenes';

export async function handleStart(ctx: BotCommandContext, onboardingScene: AnyScene): Promise<void> {
  const user = ctx.dbUser as User;

  if (user.onboarding_completed) {
    const lang = user.language as 'en' | 'ru';
    await ctx.send(t(lang).welcome_back);
    return;
  }

  await ctx.scene.enter(onboardingScene);
}
```

Remove `handleOnboardingCallback` and `handleOnboardingLocation` — the scene handles these now.

Keep the keyboard imports (they're used by the scene, but imported from scene file not start.ts).

- [ ] **Step 3: Update callback.handler.ts — remove onboarding callback routing**

Remove the entire onboarding callback block:

```typescript
// REMOVE THIS:
if (([CB.ONBOARD_LANG, CB.ONBOARD_TZ_REGION, CB.ONBOARD_TZ, CB.ONBOARD_COUNTRY, CB.ONBOARD_AGENDA] as string[]).includes(action)) {
  return handleOnboardingCallback(ctx, db, action, payload);
}
```

Remove the import of `handleOnboardingCallback` from start.ts.

These callbacks are now handled by the onboarding scene's step handlers.

- [ ] **Step 4: Update bot/index.ts — pass onboarding scene to start command**

```typescript
.command('start', (ctx) => handleStart(ctx as unknown as BotCommandContext, scenesSetup.scenes.onboardingScene))
```

- [ ] **Step 5: Run tests and lint**

Run: `bun test && bun run lint`
Expected: Pass. Fix any broken imports/references.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: migrate onboarding flow to @gramio/scenes"
```

---

## Chunk 5: Cleanup

### Task 5.1: Remove in-memory session system

**Files:**

- Modify: `src/bot/types.ts`
- Verify: all files that imported session functions

- [ ] **Step 1: Remove session code from types.ts**

Delete:

- `UserSession` interface
- `sessions` Map
- `getSession` function
- `setSession` function
- `clearSession` function

Keep: `DerivedProps`, `GramIOMessageExtras`, `BotCommandContext`, `BotCallbackContext`, `SceneAccess`

- [ ] **Step 2: Remove any remaining session imports**

Search for any remaining imports of `getSession`, `setSession`, `clearSession` across the codebase and remove them:

Run: `grep -r 'getSession\|setSession\|clearSession' src/`
Expected: No matches

- [ ] **Step 3: Clean up message handler**

Verify `createMessageHandler` has no session references, no wizard routing, and is a simple fallback.

Also verify that `createLocationHandler` is removed from `message.handler.ts` (or the entire file simplified).

If `createLocationHandler` still exists, remove it — timezone and onboarding scenes handle location events now.

- [ ] **Step 4: Clean up bot/index.ts**

Verify:

- No `.on('location', ...)` handler (scenes handle it)
- `.on('message', ...)` uses simplified `createMessageHandler()`
- No session-related imports
- `createMessageHandler` parameters are minimal (no eventService, no botToken unless needed)

- [ ] **Step 5: Run all tests**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 6: Lint and format**

Run: `bun run lint:fix && bun run format`
Expected: Clean

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: remove in-memory session system, scenes handle all flows"
```

### Task 5.2: Verify end-to-end

- [ ] **Step 1: Start bot**

Run: `bun run src/index.ts`

- [ ] **Step 2: Manual smoke test**

Test these flows:

1. `/start` — should begin onboarding (language selection keyboard)
2. `/add` — should start add wizard (title prompt)
3. `/add Meeting tomorrow at 15:00` — should create event directly (no wizard)
4. `/edit` — should show event picker
5. `/timezone` — should show timezone selection
6. `/import` — should ask for .ics file
7. Send a command during a wizard (e.g., `/help` during /add) — should exit scene with message
8. Restart bot during a wizard — after restart, continue from where left off (THIS is the key test)

- [ ] **Step 3: Verify persistence**

1. Send `/add` to start wizard
2. Enter title
3. Kill bot (Ctrl+C)
4. Restart bot
5. Send a date/time — should continue from step 2 (time prompt), not start fresh

If this works, sessions are persistent. If not, debug the storage layer.

---

## Post-Implementation Notes

### Migration risks

- **Scene intercepts ALL events for users in scenes.** If a user clicks an old inline button (from a previous message) while in a scene, the scene step handler receives it. Step handlers should gracefully ignore unrecognized callback data.
- **Command escape pattern.** Every scene has `.on('message', ...)` middleware that checks `isCommandEscape()`. This exits the scene when user types any `/command`. The command itself is NOT re-dispatched — user must resend it.
- **Location event handling.** The `scenes()` plugin intercepts `location` events for users in scenes. The `.on('location')` bot handler is no longer needed.

### What stays in-memory (not migrated)

- **Rate limiter** — sliding window counters. Reset on restart is fine.
- **Callback data overflow map** — if used for long callback data strings. Inline keyboards are regenerated on restart.

### Testing limitations

- Scene step handlers are hard to unit test (require full GramIO context). The plan tests scene structure (name, stepsCount) and helper functions. Integration testing is manual.
- Future improvement: write a `SceneTestHarness` utility that simulates context objects for automated scene testing.
