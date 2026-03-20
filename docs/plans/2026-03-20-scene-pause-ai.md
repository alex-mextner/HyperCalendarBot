# Scene Pause + AI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When users get stuck in wizard scenes, they can invoke AI for help. AI receives full scene context and ends the pause via `resume_scene` or `cancel_scene` tool.

**Architecture:**
- Pause state stored in existing `gramio_scenes` SQLite KV table, key: `scene-pause:${userId}`
- ScenePauseService wraps sceneStorage with typed get/save/clear
- Two pause triggers: (1) user clicks "Позвать на помощь" after validation error, (2) scene active but step is callback-only and user types
- Two new AI tools: `resume_scene` (clears pause, wizard continues), `cancel_scene` (clears pause + scene)
- `AgentContext.scenePauseState` → injected into system-prompt as extra section

**Tech Stack:** Bun, TypeScript, @gramio/scenes, SQLite (@gramio/storage-sqlite), GramIO InlineKeyboard

---

### Task 1: ScenePauseService

**Files:**
- Create: `src/services/scene-pause.ts`
- Test: `test/services/scene-pause.test.ts`

```ts
// src/services/scene-pause.ts
export interface ScenePauseState {
  sceneName: string;   // e.g. 'add_event'
  step: number;        // current step index
  sceneState: Record<string, unknown>; // all collected data so far
}

type KvStorage = {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
};

const PAUSE_KEY = (userId: number) => `scene-pause:${userId}`;

export class ScenePauseService {
  constructor(private storage: KvStorage) {}

  async save(userId: number, state: ScenePauseState): Promise<void> {
    await this.storage.set(PAUSE_KEY(userId), JSON.stringify(state));
  }

  async get(userId: number): Promise<ScenePauseState | null> {
    const raw = await this.storage.get(PAUSE_KEY(userId));
    if (!raw) return null;
    try {
      return JSON.parse(raw as string) as ScenePauseState;
    } catch {
      return null;
    }
  }

  async clear(userId: number): Promise<void> {
    await this.storage.delete(PAUSE_KEY(userId));
  }
}
```

- [ ] Write failing tests (save → get returns state; clear → get returns null; malformed JSON → get returns null)
- [ ] Run tests — confirm they fail
- [ ] Implement ScenePauseService
- [ ] Run tests — confirm they pass
- [ ] Commit: `feat(scene-pause): add ScenePauseService`

---

### Task 2: "Позвать на помощь" button in scenes

**Files:**
- Modify: `src/config/constants.ts` — add `CB.SCENE_HELP = 'scene_help'` and i18n strings
- Modify: `src/bot/scenes/add-event.scene.ts` — button on validation errors
- Modify: `src/bot/scenes/edit-value.scene.ts` — button on validation errors
- Test: `test/bot/scenes/scene-help-button.test.ts`

**Constants to add:**

```ts
// in CB object:
SCENE_HELP: 'scene_help',

// in MSG.en:
scene_help_btn: '🆘 Ask AI for help',
scene_help_prompt: 'Not sure what to enter?',

// in MSG.ru:
scene_help_btn: '🆘 Позвать на помощь',
scene_help_prompt: 'Не знаешь что ввести?',
```

**Button helper** (add to `src/bot/keyboards.ts`):
```ts
import { CB, t } from '../config/constants.ts';
export function sceneHelpKeyboard(lang: string): InlineKeyboard {
  return new InlineKeyboard().text(t(lang).scene_help_btn, CB.SCENE_HELP);
}
```

**add-event.scene.ts** — add button after each validation error `context.send(...)`:

Step 1 (date parse error):
```ts
await context.send(
  lang === 'ru'
    ? 'Не могу разобрать дату. Попробуйте: "завтра 15:00"'
    : 'Can\'t parse that date. Try: "tomorrow 15:00"',
  { reply_markup: sceneHelpKeyboard(lang) },
);
```

Step 2 (duration parse error):
```ts
await context.send(
  lang === 'ru'
    ? 'Не понял. Примеры: 1ч, 30м, 1ч30м, 1 час 30 минут.'
    : "Can't parse. Examples: 1h, 30m, 1h30m, 1 hour 30 min.",
  { reply_markup: sceneHelpKeyboard(lang) },
);
```

**edit-value.scene.ts** — button on time/duration parse errors.

- [ ] Write failing test: `ctx.send` called with `reply_markup` containing `CB.SCENE_HELP` button when date parse fails
- [ ] Run test — confirm fail
- [ ] Add `CB.SCENE_HELP` and i18n strings to constants.ts
- [ ] Add `sceneHelpKeyboard()` to keyboards.ts
- [ ] Add button to add-event.scene.ts error messages
- [ ] Add button to edit-value.scene.ts error messages
- [ ] Run tests — confirm pass
- [ ] Commit: `feat(scenes): add "Позвать на помощь" button on validation errors`

---

### Task 3: scene_help callback handler

**Files:**
- Modify: `src/bot/handlers/callback.handler.ts` — add `scenePauseDeps` param, handle `CB.SCENE_HELP`
- Test: `test/bot/handlers/callback.handler.test.ts` — add `scene_help` test cases

**New parameter at end of `createCallbackHandler`:**
```ts
scenePauseDeps?: {
  sceneStorage: KvStorage;
  scenePauseService: ScenePauseService;
}
```

**Handler logic** (inside the main switch/routing block, add after other `data === ...` checks):

```ts
if (data === CB.SCENE_HELP) {
  await ctx.answer();
  const userId = ctx.dbUser?.telegram_id;
  if (!userId || !scenePauseDeps) return;

  // Read current scene state from @gramio/scenes storage
  const sceneKey = `@gramio/scenes:${userId}`;
  const rawScene = await scenePauseDeps.sceneStorage.get(sceneKey);
  if (!rawScene) return;

  let sceneName = 'unknown';
  let step = 0;
  let sceneState: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(rawScene as string) as Record<string, unknown>;
    sceneName = (parsed.name as string) ?? 'unknown';
    step = (parsed.step as number) ?? 0;
    sceneState = (parsed.state as Record<string, unknown>) ?? {};
  } catch {
    // proceed with defaults
  }

  await scenePauseDeps.scenePauseService.save(userId, { sceneName, step, sceneState });

  const lang = ctx.dbUser?.language ?? 'en';
  await ctx.send(lang === 'ru'
    ? 'AI поможет. Просто напиши — что затрудняет?'
    : 'AI will help. Just describe what you need.');
  return;
}
```

- [ ] Write failing tests: scene_help callback saves pause state and sends confirmation message; scene_help without sceneStorage is no-op
- [ ] Run tests — confirm fail
- [ ] Add `scenePauseDeps` parameter to `createCallbackHandler`
- [ ] Add `CB.SCENE_HELP` handler
- [ ] Run tests — confirm pass
- [ ] Commit: `feat(callback): handle scene_help, save pause state`

---

### Task 4: Message handler pause routing

**Files:**
- Modify: `src/bot/handlers/message.handler.ts` — check pause before early return
- Modify: `src/services/ai/types.ts` — add `scenePauseState?` and `scenePauseService?` to AgentContext
- Test: `test/bot/handlers/message.handler.test.ts` — add pause routing test

**MessageHandlerDeps** — add:
```ts
scenePauseService?: ScenePauseService;
```

**Pause check** in message handler (lines 790-793), replace:
```ts
// Before (lines 790-793):
const sceneKey = `@gramio/scenes:${user.telegram_id}`;
const activeScene = await deps.sceneStorage.get(sceneKey);
if (activeScene) return;
```

With:
```ts
const sceneKey = `@gramio/scenes:${user.telegram_id}`;
const activeScene = await deps.sceneStorage.get(sceneKey);
if (activeScene) {
  // Trigger 2: scene is active but step is callback-only (user typed a message)
  // If the scene has no pause yet, auto-pause and route to AI
  const pauseState = deps.scenePauseService
    ? await deps.scenePauseService.get(user.telegram_id)
    : null;
  if (!pauseState) {
    // Check if current step accepts 'message' — if not, trigger auto-pause
    const rawScene = await deps.sceneStorage.get(sceneKey);
    let stepAcceptsMessage = true; // default: assume step accepts message
    if (rawScene) {
      try {
        const parsed = JSON.parse(rawScene as string) as Record<string, unknown>;
        const sceneName = parsed.name as string;
        const stepIndex = (parsed.step as number) ?? 0;
        stepAcceptsMessage = sceneStepAcceptsMessage(sceneName, stepIndex);
      } catch {
        stepAcceptsMessage = true;
      }
    }
    if (stepAcceptsMessage) return; // Let @gramio/scenes handle it
    // Auto-pause: step doesn't accept message
    if (deps.scenePauseService && rawScene) {
      try {
        const parsed = JSON.parse(rawScene as string) as Record<string, unknown>;
        await deps.scenePauseService.save(user.telegram_id, {
          sceneName: (parsed.name as string) ?? 'unknown',
          step: (parsed.step as number) ?? 0,
          sceneState: (parsed.state as Record<string, unknown>) ?? {},
        });
      } catch {
        return; // fallback: ignore
      }
    }
  }
  // Scene is paused — inject pause state into agent context and fall through to AI
  const agentPauseState = deps.scenePauseService
    ? await deps.scenePauseService.get(user.telegram_id)
    : null;
  // ... (passed to buildAgentContextFactory below)
  // Store in local variable for use when building agent context:
  const scenePauseForAgent = agentPauseState;
  // NOTE: the agent context factory needs to receive this — done below
}
```

**sceneStepAcceptsMessage** helper (add near top of message.handler.ts):
```ts
// Registry of scenes where specific steps are callback-only (don't accept 'message').
// Add entries when adding callback-only steps to scenes.
const CALLBACK_ONLY_STEPS: Record<string, number[]> = {
  // Example: 'some_scene': [1, 3] means steps 1 and 3 are callback-only
};

function sceneStepAcceptsMessage(sceneName: string, step: number): boolean {
  return !CALLBACK_ONLY_STEPS[sceneName]?.includes(step);
}
```

**AgentContext** (in `types.ts`) — add:
```ts
scenePauseState?: ScenePauseState;
scenePauseService?: ScenePauseService;
```

**AgentContextFactory** — pass `scenePauseState` when building context (needs to be threaded through).

- [ ] Write failing test: when pause state exists, message routes to AI pipeline instead of returning early
- [ ] Run test — confirm fail
- [ ] Add `scenePauseState` / `scenePauseService` to AgentContext in types.ts
- [ ] Add `scenePauseService` to MessageHandlerDeps
- [ ] Add `sceneStepAcceptsMessage` helper
- [ ] Replace early-return block with pause routing logic
- [ ] Thread `scenePauseState` through to agent context factory
- [ ] Run tests — confirm pass
- [ ] Commit: `feat(message-handler): route paused scenes to AI pipeline`

---

### Task 5: AI tools resume_scene and cancel_scene

**Files:**
- Create: `src/services/ai/tool-handlers/scenes.ts`
- Modify: `src/services/ai/tools.ts` — 2 new tool definitions
- Modify: `src/services/ai/tool-executor.ts` — dispatch new tools
- Test: `test/services/ai/tool-handlers/scenes.test.ts`

**Tool definitions** (add to `toolDefinitions` array in tools.ts):
```ts
{
  name: 'resume_scene',
  description: 'Resume the wizard the user was filling in before asking for AI help. Call this when you have answered the user\'s question and they should continue the wizard from where they left off.',
  input_schema: { type: 'object' as const, properties: {}, required: [] },
},
{
  name: 'cancel_scene',
  description: 'Cancel and discard the wizard the user was filling in. Call this when you have completed the action via AI tools (e.g., created the event directly) and the wizard is no longer needed, OR if the user wants to abort.',
  input_schema: { type: 'object' as const, properties: {}, required: [] },
},
```

**Tool handlers** (new file `src/services/ai/tool-handlers/scenes.ts`):
```ts
import type { ScenePauseService } from '../../scene-pause.ts';
import type { AgentContext, ToolResult } from '../types.ts';

type SceneDeps = {
  sceneStorage: {
    delete(key: string): Promise<void>;
  };
  scenePauseService: ScenePauseService;
};

export async function handleResumeScene(ctx: AgentContext, deps: SceneDeps): Promise<ToolResult> {
  await deps.scenePauseService.clear(ctx.user.telegram_id);
  return {
    success: true,
    output: ctx.user.language === 'ru'
      ? 'Продолжай заполнение с того места, где остановился.'
      : 'You can continue the wizard from where you left off.',
  };
}

export async function handleCancelScene(ctx: AgentContext, deps: SceneDeps): Promise<ToolResult> {
  await deps.scenePauseService.clear(ctx.user.telegram_id);
  const sceneKey = `@gramio/scenes:${ctx.user.telegram_id}`;
  await deps.sceneStorage.delete(sceneKey);
  return {
    success: true,
    output: ctx.user.language === 'ru'
      ? 'Мастер отменён.'
      : 'Wizard cancelled.',
  };
}
```

**tool-executor.ts** — add cases:
```ts
case 'resume_scene':
  return handleResumeScene(ctx, { sceneStorage: ctx.scenePauseService!... });
case 'cancel_scene':
  return handleCancelScene(ctx, { ... });
```

Note: `ctx` needs `scenePauseService` and scene storage access — pass via AgentContext.

- [ ] Write failing tests: resume_scene clears pause state; cancel_scene clears pause + scene state
- [ ] Run tests — confirm fail
- [ ] Add tool definitions to tools.ts
- [ ] Create tool-handlers/scenes.ts
- [ ] Add dispatch cases to tool-executor.ts
- [ ] Run tests — confirm pass
- [ ] Commit: `feat(ai-tools): add resume_scene and cancel_scene tools`

---

### Task 6: Scene context in system prompt

**Files:**
- Modify: `src/services/ai/system-prompt.ts` — append scene context section when `ctx.scenePauseState` set

**Addition to buildSystemPrompt:**
```ts
// After the main prompt body, if scene is paused:
if (ctx.scenePauseState) {
  const { sceneName, step, sceneState } = ctx.scenePauseState;
  const stateStr = Object.entries(sceneState)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)
    .join('\n');
  prompt += `\n\n## Scene Paused
The user was filling in the "${sceneName}" wizard (step ${step}) and asked for AI help.
Data collected so far:
${stateStr || '  (none yet)'}
You MUST help the user complete the action. When done:
- Call resume_scene if the user should continue the wizard (you only clarified something)
- Call cancel_scene if you completed everything via tools (e.g., created the event directly)`;
}
```

- [ ] Write failing test: buildSystemPrompt includes scene context section when scenePauseState is set; omits it otherwise
- [ ] Run test — confirm fail
- [ ] Add scene context section to buildSystemPrompt
- [ ] Run tests — confirm pass
- [ ] Commit: `feat(system-prompt): inject paused scene context for AI`

---

### Task 7: Wiring in bot/index.ts

**Files:**
- Modify: `src/bot/index.ts` — instantiate ScenePauseService, pass to callback handler + message handler

Key wiring:
1. After `createScenesPlugin(...)`: instantiate `ScenePauseService` with `scenesSetup.storage`
2. Pass `scenePauseDeps` to `createCallbackHandler`
3. Pass `scenePauseService` to `createMessageHandler`
4. Pass `sceneStorage` (for cancel_scene tool) to agent context via `AgentContext.sceneStorage`
   - Add `sceneStorage` optional field to `AgentContext` or pass via tool-executor deps

Run full test suite. Fix any wiring errors.

- [ ] Wire ScenePauseService in bot/index.ts
- [ ] Pass to callback handler
- [ ] Pass to message handler
- [ ] Thread sceneStorage to AI tool executor
- [ ] Run `bun test` — fix all failures
- [ ] Commit: `feat(bot): wire ScenePauseService into bot pipeline`
