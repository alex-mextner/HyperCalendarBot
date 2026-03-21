# Intent Supplement Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After an intent auto-response fires, the main AI agent also runs in "supplement mode" to review and optionally enrich the response or offer corrections — combining automation speed with AI context awareness.

**Architecture:** `IntentMatcherLayer` returns `{ handled: true, needsSupplement: true }` on successful completion; `runPipeline` continues to `AiAgentLayer` with `supplementMode: true`; the agent uses a no-op sender (no streaming to Telegram), and `AiAgentLayer` sends `responseText` only if the AI didn't call `supplement_skip`.

**Tech Stack:** Bun, TypeScript, existing `CalendarBotAgent`, `TelegramStreamWriter`, `bun:test`

**Spec:** `docs/specs/2026-03-20-intent-supplement-mode.md`

---

## File Map

### Modified files
| File | Change |
|------|--------|
| `src/bot/pipeline/types.ts` | Add `{ handled: true; needsSupplement: true }` union; add `supplementMode?` to layer extra |
| `src/bot/pipeline/pipeline.ts` | Continue on `needsSupplement`; pass `supplementMode` in extra |
| `src/bot/pipeline/intent-matcher-layer.ts` | Return `needsSupplement: true` on success; save user message before auto-response |
| `src/bot/pipeline/ai-agent-layer.ts` | Read `supplementMode`, set on context, suppress/send `responseText`, silent error handling |
| `src/services/ai/types.ts` | Add `supplementMode?: boolean` to `AgentContext` |
| `src/services/ai/system-prompt.ts` | Append supplement section when `ctx.supplementMode` |
| `src/services/ai/tools.ts` | Add `supplementMode?` param; append `supplement_skip` tool when true |
| `src/services/ai/tool-executor.ts` | Handle `supplement_skip` → `{ success: true, stopLoop: true }` |
| `src/services/ai/agent.ts` | No-op sender in supplement mode; skip `saveUserMessage`; skip final message append in `buildMessages`; pass `supplementMode` to `getToolDefinitions` |

### Test files
| File | What it tests |
|------|--------------|
| `test/bot/pipeline/pipeline.test.ts` | `needsSupplement` → continues; `supplementMode` passed to next layers |
| `test/bot/pipeline/intent-matcher-layer.test.ts` | Success → `needsSupplement: true`; suspended → plain `handled: true` |
| `test/bot/pipeline/ai-agent-layer.test.ts` | Supplement mode: `supplement_skip` suppresses text; no skip → text sent with HTML; error → warn+silent |
| `test/services/ai/system-prompt.test.ts` | Supplement section present iff `supplementMode: true` |
| `test/services/ai/tools.test.ts` | `supplement_skip` present iff `supplementMode: true` |
| `test/services/ai/agent.test.ts` | `saveUserMessage` skipped; no-op sender used; `buildMessages` skips final append |

---

## Task 1: Foundation types

**Files:**
- Modify: `src/bot/pipeline/types.ts`
- Modify: `src/services/ai/types.ts`
- Test: `test/bot/pipeline/pipeline.test.ts`

- [ ] **Step 1: Add `needsSupplement` to `PipelineResult` and `supplementMode` to layer extra**

In `src/bot/pipeline/types.ts`:

```typescript
export type PipelineResult =
  | { handled: true }
  | { handled: true; needsSupplement: true }   // ← new
  | { handled: false }
  | { handled: false; feedbackContext: FeedbackThreadContext };

export type PipelineLayer = (
  ctx: BotCommandContext,
  messageText: string,
  extra?: {
    feedbackContext?: FeedbackThreadContext;
    groupContext?: GroupContext;
    supplementMode?: boolean;                  // ← new
  },
) => Promise<PipelineResult>;
```

- [ ] **Step 2: Add `supplementMode` to `AgentContext`**

In `src/services/ai/types.ts`, add after `inputMode`:

```typescript
supplementMode?: boolean;
```

- [ ] **Step 3: Run tsc to verify no type errors**

```bash
bun run tsc --noEmit 2>&1 | head -30
```

Expected: no errors (or only pre-existing ones unrelated to our changes)

- [ ] **Step 4: Commit**

```bash
git add src/bot/pipeline/types.ts src/services/ai/types.ts
git commit -m "feat(supplement): add supplementMode types to pipeline and AgentContext"
```

---

## Task 2: Pipeline continuation

**Files:**
- Modify: `src/bot/pipeline/pipeline.ts`
- Test: `test/bot/pipeline/pipeline.test.ts`

- [ ] **Step 1: Write failing tests for `needsSupplement` behavior**

Add to `test/bot/pipeline/pipeline.test.ts`:

```typescript
test('continues past layer that returns needsSupplement:true', async () => {
  const calls: string[] = [];

  const layer1: PipelineLayer = async () => {
    calls.push('layer1');
    return { handled: true, needsSupplement: true };
  };
  const layer2: PipelineLayer = async () => {
    calls.push('layer2');
    return { handled: true };
  };

  await runPipeline(makeCtx(), 'hello', [layer1, layer2]);
  expect(calls).toEqual(['layer1', 'layer2']);
});

test('passes supplementMode:true to layers after needsSupplement', async () => {
  let receivedSupplementMode: boolean | undefined;

  const layer1: PipelineLayer = async () => ({ handled: true, needsSupplement: true });
  const layer2: PipelineLayer = async (_ctx, _text, extra) => {
    receivedSupplementMode = extra?.supplementMode;
    return { handled: true };
  };

  await runPipeline(makeCtx(), 'hello', [layer1, layer2]);
  expect(receivedSupplementMode).toBe(true);
});

test('does not pass supplementMode:true before needsSupplement fires', async () => {
  let receivedBeforeIntent: boolean | undefined;

  const layer1: PipelineLayer = async (_ctx, _text, extra) => {
    receivedBeforeIntent = extra?.supplementMode;
    return { handled: true, needsSupplement: true };
  };

  await runPipeline(makeCtx(), 'hello', [layer1]);
  expect(receivedBeforeIntent).toBeFalsy();
});

test('plain handled:true still stops the pipeline', async () => {
  const calls: string[] = [];

  const layer1: PipelineLayer = async () => {
    calls.push('layer1');
    return { handled: true };
  };
  const layer2: PipelineLayer = async () => {
    calls.push('layer2');
    return { handled: true };
  };

  await runPipeline(makeCtx(), 'hello', [layer1, layer2]);
  expect(calls).toEqual(['layer1']); // layer2 not reached
});
```

- [ ] **Step 2: Run tests — confirm they fail**

```bash
bun test test/bot/pipeline/pipeline.test.ts 2>&1 | tail -20
```

Expected: tests about `needsSupplement` fail with type errors or wrong behavior

- [ ] **Step 3: Update `runPipeline` to handle `needsSupplement`**

Replace the body of `runPipeline` in `src/bot/pipeline/pipeline.ts`:

```typescript
export async function runPipeline(
  ctx: BotCommandContext,
  messageText: string,
  layers: PipelineLayer[],
  groupContext?: GroupContext,
): Promise<void> {
  let feedbackContext: FeedbackThreadContext | undefined;
  let supplementMode = false;

  for (const layer of layers) {
    const result = await layer(ctx, messageText, { feedbackContext, groupContext, supplementMode });
    if (result.handled) {
      if ('needsSupplement' in result) {
        supplementMode = true;
        continue;
      }
      return;
    }
    if ('feedbackContext' in result) {
      feedbackContext = result.feedbackContext;
    }
  }
}
```

- [ ] **Step 4: Run tests — confirm all pass**

```bash
bun test test/bot/pipeline/pipeline.test.ts 2>&1 | tail -10
```

Expected: all tests pass

- [ ] **Step 5: Commit**

```bash
git add src/bot/pipeline/pipeline.ts test/bot/pipeline/pipeline.test.ts
git commit -m "feat(supplement): pipeline continues on needsSupplement, passes supplementMode"
```

---

## Task 3: IntentMatcherLayer — return `needsSupplement` + save user message

**Files:**
- Modify: `src/bot/pipeline/intent-matcher-layer.ts`
- Test: `test/bot/pipeline/intent-matcher-layer.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `test/bot/pipeline/intent-matcher-layer.test.ts`. First read the existing file to find a good insertion point — place these after existing success tests.

```typescript
describe('needsSupplement', () => {
  test('successful completed intent returns needsSupplement:true', async () => {
    const matcher = makeMatcher({ intentId: 1, captures: {} });
    const repo = makeIntentRepo({ id: 1, workflow: '{"steps":[]}', format: 'text', canonical_name: 'test' });
    const executor = makeExecutor({ success: true, response: 'done' });

    const layer = createIntentMatcherLayer(matcher, repo, executor, mock(() => ({ success: true })), makeWorkflowStore());
    const result = await layer(makeCtx(), 'покажи события');

    expect(result.handled).toBe(true);
    expect('needsSupplement' in result).toBe(true);
  });

  test('suspended intent (ask_user) does NOT return needsSupplement', async () => {
    const matcher = makeMatcher({ intentId: 1, captures: {} });
    const repo = makeIntentRepo({ id: 1, workflow: '{"steps":[]}', format: 'text', canonical_name: 'test' });
    const executor = makeExecutor({ success: true, suspended: true, suspendedAt: 0, response: 'Утро или вечер?' });

    const layer = createIntentMatcherLayer(matcher, repo, executor, mock(() => ({ success: true })), makeWorkflowStore());
    const result = await layer(makeCtx(), 'добавь встречу в 8');

    expect(result.handled).toBe(true);
    expect('needsSupplement' in result).toBe(false);
  });

  test('session resume does NOT return needsSupplement', async () => {
    const sessionStore = makeWorkflowStore();
    sessionStore.set(1, 1, {
      intentId: 1,
      stepIndex: 1,
      stepResults: {},
      workflow: { steps: [] },
      captures: {},
      createdAt: Date.now(),
    });
    const repo = makeIntentRepo({ id: 1, workflow: '{"steps":[]}', format: 'text', canonical_name: 'test' });
    const executor = makeExecutor({ success: true, response: 'done' });

    const layer = createIntentMatcherLayer(makeMatcher(), repo, executor, mock(() => ({ success: true })), sessionStore);
    const result = await layer(makeCtx(), 'утро');

    expect(result.handled).toBe(true);
    expect('needsSupplement' in result).toBe(false);
  });
});

test('saves user message to chatHistory before auto-response', async () => {
  const saveCalls: { role: string; text: string }[] = [];
  const chatHistoryRepo = {
    save: mock((userId: number, role: string, text: string) => saveCalls.push({ role, text })),
  };

  const matcher = makeMatcher({ intentId: 1, captures: {} });
  const repo = makeIntentRepo({ id: 1, workflow: '{"steps":[]}', format: 'text', canonical_name: 'test' });
  const executor = makeExecutor({ success: true, response: 'ок, добавил' });

  const layer = createIntentMatcherLayer(
    matcher, repo, executor,
    mock(() => ({ success: true })),
    makeWorkflowStore(),
    chatHistoryRepo as never,
  );
  await layer(makeCtx(), 'добавь встречу');

  expect(saveCalls[0]?.role).toBe('user');
  expect(saveCalls[1]?.role).toBe('assistant');
});
```

You'll need to check `makeExecutor` in the existing test file — it may be named differently. Read lines 60–100 of `test/bot/pipeline/intent-matcher-layer.test.ts` to find the executor factory function and adapt accordingly.

- [ ] **Step 2: Run tests — confirm they fail**

```bash
bun test test/bot/pipeline/intent-matcher-layer.test.ts 2>&1 | tail -20
```

Expected: new tests fail

- [ ] **Step 3: Update `createIntentMatcherLayer` — step 8 (response section)**

In `src/bot/pipeline/intent-matcher-layer.ts`, find the response section (around line 160–172) and update:

```typescript
// 8. Format and send response
if (result.response) {
  const formatted =
    intent.format !== 'text'
      ? formatResponse(intent.format, result.response, user.timezone, user.language)
      : result.response;
  // Save to history BEFORE sending — supplement agent calls getRecent() right after this
  if (chatHistoryRepo) {
    chatHistoryRepo.save(userId, 'user', messageText);          // ← new: user msg first
    chatHistoryRepo.save(userId, 'assistant', JSON.stringify({ kind: 'bot', text: formatted }));
  }
  await ctx.send(formatted);
  return { handled: true, needsSupplement: true };              // ← supplement fires when response sent
}

return { handled: true };                                       // ← no response → no supplement
```

- [ ] **Step 4: Run tests — confirm all pass**

```bash
bun test test/bot/pipeline/intent-matcher-layer.test.ts 2>&1 | tail -10
```

Expected: all pass

- [ ] **Step 5: Run full test suite — no regressions**

```bash
bun test 2>&1 | tail -15
```

- [ ] **Step 6: Commit**

```bash
git add src/bot/pipeline/intent-matcher-layer.ts test/bot/pipeline/intent-matcher-layer.test.ts
git commit -m "feat(supplement): intent matcher returns needsSupplement, saves user msg before auto-response"
```

---

## Task 4: `supplement_skip` tool

**Files:**
- Modify: `src/services/ai/tools.ts`
- Modify: `src/services/ai/tool-executor.ts`

- [ ] **Step 1: Write failing tests for tools.ts**

Create/find `test/services/ai/tools.test.ts` (check if it exists first with `ls test/services/ai/`). Add:

```typescript
import { describe, expect, test } from 'bun:test';
import { getToolDefinitions } from '../../../src/services/ai/tools.ts';

describe('getToolDefinitions supplement_skip', () => {
  test('supplement_skip is absent when supplementMode is false', () => {
    const tools = getToolDefinitions(undefined, false);
    expect(tools.some(t => t.name === 'supplement_skip')).toBe(false);
  });

  test('supplement_skip is absent when supplementMode is undefined', () => {
    const tools = getToolDefinitions();
    expect(tools.some(t => t.name === 'supplement_skip')).toBe(false);
  });

  test('supplement_skip is present when supplementMode is true', () => {
    const tools = getToolDefinitions(undefined, true);
    const tool = tools.find(t => t.name === 'supplement_skip');
    expect(tool).toBeDefined();
    expect(tool?.input_schema?.properties).toEqual({});
  });

  test('supplement_skip does not appear in normal text mode', () => {
    const tools = getToolDefinitions('text', false);
    expect(tools.some(t => t.name === 'supplement_skip')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests — confirm they fail**

```bash
bun test test/services/ai/tools.test.ts 2>&1 | tail -20
```

- [ ] **Step 3: Update `getToolDefinitions` signature and add `supplement_skip`**

The current function (line 965) returns an inline `filter()` result — there is no mutable `tools` variable to `.push()` onto. Replace the whole function:

```typescript
// src/services/ai/tools.ts — replace getToolDefinitions (line 965–970)
export function getToolDefinitions(inputMode?: string, supplementMode?: boolean): ToolDefinition[] {
  let tools: ToolDefinition[];
  if (inputMode === 'live_call') {
    tools = toolDefinitions.filter((t) => !CALL_EXCLUDED_TOOLS.has(t.name));
  } else {
    tools = toolDefinitions.filter((t) => !CALL_ONLY_TOOLS.has(t.name));
  }
  if (supplementMode) {
    tools = [
      ...tools,
      {
        name: 'supplement_skip',
        description: 'Call when the automatic response was correct and complete. Suppresses your response.',
        input_schema: {
          type: 'object' as const,
          properties: {},
          required: [],
        },
      },
    ];
  }
  return tools;
}
```

- [ ] **Step 4: Add handler in `tool-executor.ts`**

In `src/services/ai/tool-executor.ts`, find the switch/if-else that dispatches tool names. Add a case for `supplement_skip`:

```typescript
case 'supplement_skip':
  return { success: true, stopLoop: true };
```

Place it early in the switch (before any domain-specific tools) so it's easy to find.

- [ ] **Step 5: Run tests**

```bash
bun test test/services/ai/tools.test.ts 2>&1 | tail -10
```

Expected: all pass

- [ ] **Step 6: Run full test suite**

```bash
bun test 2>&1 | tail -15
```

- [ ] **Step 7: Commit**

```bash
git add src/services/ai/tools.ts src/services/ai/tool-executor.ts test/services/ai/tools.test.ts
git commit -m "feat(supplement): add supplement_skip tool, handler returns stopLoop:true"
```

---

## Task 5: System prompt supplement section

**Files:**
- Modify: `src/services/ai/system-prompt.ts`
- Test: `test/services/ai/system-prompt.test.ts`

- [ ] **Step 1: Write failing test**

Find `test/services/ai/system-prompt.test.ts` (check it exists; if not, create it). Add:

```typescript
import { describe, expect, test } from 'bun:test';
import { buildSystemPrompt } from '../../../src/services/ai/system-prompt.ts';
import type { AgentContext } from '../../../src/services/ai/types.ts';

function makeCtx(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    user: {
      telegram_id: 1,
      language: 'ru',
      timezone: 'UTC',
      first_name: 'Alex',
      default_event_duration_minutes: 60,
      timezone_updated_at: null,
    },
    chatId: 1,
    messageText: 'test',
    isGroup: false,
    recentEventsWindow: [],
    eventService: {} as never,
    holidayService: {} as never,
    chatHistory: {} as never,
    userRepo: {} as never,
    reminderRepo: {} as never,
    ...overrides,
  } as AgentContext;
}

describe('buildSystemPrompt supplement section', () => {
  test('supplement section absent when supplementMode is not set', () => {
    const prompt = buildSystemPrompt(makeCtx());
    expect(prompt).not.toContain('Supplement Mode');
  });

  test('supplement section absent when supplementMode is false', () => {
    const prompt = buildSystemPrompt(makeCtx({ supplementMode: false }));
    expect(prompt).not.toContain('Supplement Mode');
  });

  test('supplement section present when supplementMode is true', () => {
    const prompt = buildSystemPrompt(makeCtx({ supplementMode: true }));
    expect(prompt).toContain('Supplement Mode');
    expect(prompt).toContain('supplement_skip');
    expect(prompt).toContain('automatic rule-based response');
  });
});
```

- [ ] **Step 2: Run tests — confirm they fail**

```bash
bun test test/services/ai/system-prompt.test.ts 2>&1 | tail -20
```

- [ ] **Step 3: Add supplement section to `buildSystemPrompt`**

In `src/services/ai/system-prompt.ts`, find the `buildSystemPrompt` function and add before the final return:

```typescript
const supplementSection = ctx.supplementMode
  ? `\n## Supplement Mode

An automatic rule-based response was already sent to the user (visible in the conversation
history above). The response may be correct, incomplete, or inappropriate given the
conversational context.

Your job:
- If the auto-response was correct and complete: call supplement_skip. Send nothing.
- If you can add useful context, commentary, a relevant follow-up, or spot a pattern
  worth mentioning: send a concise message.
- If the auto-response was wrong or clearly inappropriate given the conversation:
  say so directly. If the action can be undone (event created/deleted/updated),
  offer to undo it using the appropriate tool.

Rules:
- Be concise. You are supplementing, not repeating.
- Do not summarize or echo what the auto-response already said.
- Do not add empty affirmations ("Great!", "Sure!").
- Calling tools (to fix, undo, or enrich) is allowed and encouraged when appropriate.
- Do not call ask_user or pick_users in supplement mode.`
  : '';
```

Then include `${supplementSection}` at the end of the template literal that `buildSystemPrompt` returns, e.g.:

```typescript
return `...existing prompt content...
${eventsWindowSection}${supplementSection}`;
```

- [ ] **Step 4: Run tests**

```bash
bun test test/services/ai/system-prompt.test.ts 2>&1 | tail -10
```

- [ ] **Step 5: Commit**

```bash
git add src/services/ai/system-prompt.ts test/services/ai/system-prompt.test.ts
git commit -m "feat(supplement): add supplement section to system prompt"
```

---

## Task 6: agent.ts — no-op sender, skip saveUserMessage, skip buildMessages append

**Files:**
- Modify: `src/services/ai/agent.ts`
- Test: `test/services/ai/agent.test.ts`

- [ ] **Step 1: Write failing tests**

The existing `test/services/ai/agent.test.ts` uses a real in-memory SQLite database and `ChatHistoryRepository`. The test constructs a full `AgentContext` in `beforeEach`. Tests of `buildMessages` (lines 65–103) call the method directly without needing an Anthropic API mock.

Add these tests inside the existing `describe('CalendarBotAgent', ...)` block — they test `buildMessages` and `saveUserMessage` directly, no API mock needed:

```typescript
describe('supplement mode', () => {
  test('buildMessages does not append current user message when supplementMode is true', () => {
    const agent = new CalendarBotAgent(config, sender);
    const supplementCtx = { ...ctx, supplementMode: true };
    const { messages } = agent.buildMessages(supplementCtx, []);
    // In supplement mode, user message is already in history — no extra append
    expect(messages.length).toBe(0);
  });

  test('buildMessages appends current user message when supplementMode is false', () => {
    const agent = new CalendarBotAgent(config, sender);
    const { messages } = agent.buildMessages(ctx, []);
    // Normal mode: message is appended
    expect(messages.length).toBe(1);
    expect(messages[0]!.role).toBe('user');
  });

  test('saveUserMessage is not called when supplementMode is true (no user row in history)', () => {
    const agent = new CalendarBotAgent(config, sender);
    const supplementCtx = { ...ctx, supplementMode: true };
    // saveUserMessage is public — call it and verify nothing saved
    agent.saveUserMessage(supplementCtx);
    const history = supplementCtx.chatHistory.getRecent(USER_ID);
    expect(history.filter(h => h.role === 'user').length).toBe(0);
  });

  test('saveUserMessage saves when supplementMode is false', () => {
    const agent = new CalendarBotAgent(config, sender);
    agent.saveUserMessage(ctx);
    const history = ctx.chatHistory.getRecent(USER_ID);
    expect(history.filter(h => h.role === 'user').length).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests — confirm new tests fail**

```bash
bun test test/services/ai/agent.test.ts 2>&1 | tail -20
```

- [ ] **Step 3: Add no-op sender in `agent.run()`**

In `src/services/ai/agent.ts`, find the writer construction block (around line 113):

```typescript
// Before:
ctx.sender = this.sender;
const writer = new TelegramStreamWriter(this.sender, ctx.chatId, ctx.user.language, {
  userTranscript: ctx.inputMode === 'live_call' ? ctx.messageText : undefined,
});
await writer.init();

// After:
const effectiveSender: TelegramSender = ctx.supplementMode
  ? {
      sendMessage: async () => ({ message_id: 0 }),
      editMessageText: async () => {},
      sendMessageWithKeyboard: async () => ({ message_id: 0 }),
      sendButtons: async () => ({ message_id: 0 }),
      sendUserPicker: async () => ({ message_id: 0 }),
      sendPhoto: async () => {},
      sendInvitation: async () => null,
      sendEditProposal: async () => null,
      sendAsUser: async () => false,
      deleteMessage: async () => {},
    }
  : this.sender;
ctx.sender = effectiveSender;
const writer = new TelegramStreamWriter(effectiveSender, ctx.chatId, ctx.user.language, {
  userTranscript: ctx.inputMode === 'live_call' ? ctx.messageText : undefined,
});
await writer.init();
```

- [ ] **Step 4: Skip `saveUserMessage` in supplement mode**

Find line 118 (`this.saveUserMessage(ctx);`) and wrap it:

```typescript
if (!ctx.supplementMode) {
  this.saveUserMessage(ctx);
}
```

- [ ] **Step 5: Skip final message append in `buildMessages`**

In the `buildMessages` method, find line 88:

```typescript
messages.push({ role: 'user', content: `[${nowUtc}] ${ctx.messageText}` });
```

Wrap it:

```typescript
if (!ctx.supplementMode) {
  messages.push({ role: 'user', content: `[${nowUtc}] ${ctx.messageText}` });
}
```

- [ ] **Step 6: Pass `supplementMode` to `getToolDefinitions`**

Find the `streamRequest` function inside `run()` (around line 138–151). Change:

```typescript
tools: getToolDefinitions(ctx.inputMode),
```

to:

```typescript
tools: getToolDefinitions(ctx.inputMode, ctx.supplementMode),
```

- [ ] **Step 7: Run tests**

```bash
bun test test/services/ai/agent.test.ts 2>&1 | tail -10
```

- [ ] **Step 8: Run full test suite**

```bash
bun test 2>&1 | tail -15
```

- [ ] **Step 9: Commit**

```bash
git add src/services/ai/agent.ts test/services/ai/agent.test.ts
git commit -m "feat(supplement): agent uses no-op sender, skips user message save in supplement mode"
```

---

## Task 7: AiAgentLayer — supplement mode handling

**Files:**
- Modify: `src/bot/pipeline/ai-agent-layer.ts`
- Test: `test/bot/pipeline/ai-agent-layer.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `test/bot/pipeline/ai-agent-layer.test.ts`:

```typescript
describe('supplement mode', () => {
  test('sends responseText with parse_mode HTML when supplement_skip not called', async () => {
    const agent = {
      run: mock(() => Promise.resolve({
        responseText: '<b>Кстати</b>, событие повторяется каждую неделю.',
        toolCalls: [],
        toolResults: [],
      })),
    } as unknown as CalendarBotAgent;
    const ctx = makeCtx();

    const layer = createAiAgentLayer({ agent, agentContextBuilder: makeContextBuilder() });
    await layer(ctx, 'покажи события', { supplementMode: true });

    expect(ctx.send).toHaveBeenCalledTimes(1);
    const [text, opts] = (ctx.send as ReturnType<typeof mock>).mock.calls[0] as [string, Record<string, unknown>];
    expect(text).toBe('<b>Кстати</b>, событие повторяется каждую неделю.');
    expect(opts?.parse_mode).toBe('HTML');
  });

  test('does NOT send when supplement_skip was called', async () => {
    const agent = {
      run: mock(() => Promise.resolve({
        responseText: 'some text',
        toolCalls: [{ name: 'supplement_skip', input: {} }],
        toolResults: [{ success: true }],
      })),
    } as unknown as CalendarBotAgent;
    const ctx = makeCtx();

    const layer = createAiAgentLayer({ agent, agentContextBuilder: makeContextBuilder() });
    await layer(ctx, 'покажи события', { supplementMode: true });

    expect(ctx.send).not.toHaveBeenCalled();
  });

  test('does NOT send when responseText is empty', async () => {
    const agent = {
      run: mock(() => Promise.resolve({
        responseText: '',
        toolCalls: [],
        toolResults: [],
      })),
    } as unknown as CalendarBotAgent;
    const ctx = makeCtx();

    const layer = createAiAgentLayer({ agent, agentContextBuilder: makeContextBuilder() });
    await layer(ctx, 'покажи события', { supplementMode: true });

    expect(ctx.send).not.toHaveBeenCalled();
  });

  test('IntentLearner is NOT called in supplement mode', async () => {
    const analyzeFn = mock(() => Promise.resolve(null));
    const toolCalls = [{ name: 'create_event', input: {} }];
    const agent = {
      run: mock(() => Promise.resolve({ responseText: 'ok', toolCalls, toolResults: [] })),
    } as unknown as CalendarBotAgent;

    const layer = createAiAgentLayer({
      agent,
      agentContextBuilder: makeContextBuilder(),
      intentLearner: makeIntentLearner(analyzeFn),
    });

    await layer(makeCtx(), 'добавь встречу', { supplementMode: true });
    await Bun.sleep(10);

    expect(analyzeFn).not.toHaveBeenCalled();
  });

  test('agent error in supplement mode: warns, stays silent, returns handled:true', async () => {
    const agent = {
      run: mock(() => Promise.reject(new Error('agent boom'))),
    } as unknown as CalendarBotAgent;
    const ctx = makeCtx();

    const layer = createAiAgentLayer({ agent, agentContextBuilder: makeContextBuilder() });
    const result = await layer(ctx, 'покажи события', { supplementMode: true });

    expect(result.handled).toBe(true);
    expect(ctx.send).not.toHaveBeenCalled(); // no error message to user
  });

  test('sets supplementMode on agentContext', async () => {
    let capturedContext: AgentContext | undefined;
    const agent = {
      run: mock((ctx: AgentContext) => {
        capturedContext = ctx;
        return Promise.resolve({ responseText: '', toolCalls: [], toolResults: [] });
      }),
    } as unknown as CalendarBotAgent;

    const layer = createAiAgentLayer({ agent, agentContextBuilder: makeContextBuilder() });
    await layer(makeCtx(), 'hello', { supplementMode: true });

    expect(capturedContext?.supplementMode).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests — confirm they fail**

```bash
bun test test/bot/pipeline/ai-agent-layer.test.ts 2>&1 | tail -20
```

- [ ] **Step 3: Update `createAiAgentLayer`**

In `src/bot/pipeline/ai-agent-layer.ts`, update the layer function:

```typescript
export function createAiAgentLayer(deps: AgentLayerDeps) {
  return async (
    ctx: BotCommandContext,
    messageText: string,
    extra?: { feedbackContext?: FeedbackThreadContext; groupContext?: GroupContext; supplementMode?: boolean },
  ): Promise<PipelineResult> => {
    const user = ctx.dbUser as User;
    const chatId = ctx.chatId;
    if (!chatId) return { handled: false };

    const agentContext = deps.agentContextBuilder(user, Number(chatId), messageText, extra?.groupContext);

    if (extra?.feedbackContext) {
      agentContext.feedbackContext = extra.feedbackContext;
    }

    if (extra?.supplementMode) {
      agentContext.supplementMode = true;
    }

    cmdLogger.info({ userId: user.telegram_id, messageText, supplementMode: extra?.supplementMode }, 'Routing to AI agent');

    try {
      const result = await deps.agent.run(agentContext);

      if (extra?.supplementMode) {
        const skipped = result.toolCalls.some((tc) => tc.name === 'supplement_skip');
        if (!skipped && result.responseText) {
          await ctx.send(result.responseText, { parse_mode: 'HTML' });
        }
        return { handled: true };
      }

      if (deps.intentLearner && result.toolCalls.length > 0) {
        deps.intentLearner.analyze(messageText, result.toolCalls, result.toolResults).catch((err: unknown) => {
          cmdLogger.error({ err: err }, 'IntentLearner error');
        });
      }
    } catch (error) {
      if (extra?.supplementMode) {
        cmdLogger.warn({ err: error, userId: user.telegram_id }, 'AI supplement error (suppressed)');
        return { handled: true };
      }
      cmdLogger.error({ err: error, userId: user.telegram_id }, 'AI agent error');
      const lang = user.language as 'en' | 'ru';
      await ctx.send(t(lang).something_wrong);
    }

    return { handled: true };
  };
}
```

- [ ] **Step 4: Run tests**

```bash
bun test test/bot/pipeline/ai-agent-layer.test.ts 2>&1 | tail -10
```

- [ ] **Step 5: Run full test suite**

```bash
bun test 2>&1 | tail -15
```

- [ ] **Step 6: Commit**

```bash
git add src/bot/pipeline/ai-agent-layer.ts test/bot/pipeline/ai-agent-layer.test.ts
git commit -m "feat(supplement): AiAgentLayer handles supplement mode — sends with HTML, silent on skip/error"
```

---

## Task 8: Integration smoke test + final verification

**Files:**
- Test: `test/bot/handlers/message.handler.test.ts`

- [ ] **Step 1: Write integration test**

Add to `test/bot/handlers/message.handler.test.ts`:

```typescript
describe('intent supplement integration', () => {
  test('AI agent runs after successful intent match (supplement mode)', async () => {
    const agentRun = mock(() => Promise.resolve({
      responseText: '',
      toolCalls: [{ name: 'supplement_skip', input: {} }],
      toolResults: [{ success: true }],
    }));

    const intentMatcher = {
      match: mock(() => ({ intentId: 1, captures: {} })),
      load: mock(() => {}),
    };
    const intentRepo = {
      getById: mock(() => ({
        id: 1,
        workflow: JSON.stringify({ steps: [] }),
        format: 'text',
        canonical_name: 'test_intent',
        phrases: '[]',
        trigger_words: '[]',
        pattern: null,
      })),
    };
    const intentExecutor = {
      run: mock(() => Promise.resolve({ success: true, response: 'Вот твои события.' })),
    };

    const workflowSessions = {
      get: mock(() => null),
      set: mock(() => {}),
      delete: mock(() => {}),
      deleteByUser: mock(() => {}),
    };

    const deps = makeDeps({
      agent: { run: agentRun, getSender: mock(() => ({})) },
      intentMatcher,
      intentRepo,
      intentExecutor,
      workflowSessions,
    });

    const ctx = makeCtx({ text: 'покажи события' });
    await createMessageHandler(deps as never)(ctx as never);

    // auto-response was sent
    expect(ctx.send).toHaveBeenCalledWith('Вот твои события.');
    // AI supplement also ran
    expect(agentRun).toHaveBeenCalledTimes(1);
    // supplement_skip was called so no second ctx.send for supplement text
    expect(ctx.send).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run tests — confirm the test passes**

```bash
bun test test/bot/handlers/message.handler.test.ts 2>&1 | tail -15
```

- [ ] **Step 3: Run full test suite — zero regressions**

```bash
bun test 2>&1 | tail -20
```

Expected: all tests pass, same count as before (plus new ones)

- [ ] **Step 4: Check for lint errors**

```bash
bun run lint 2>&1 | tail -20
```

Fix any lint errors before committing.

- [ ] **Step 5: Final commit**

```bash
git add test/bot/handlers/message.handler.test.ts
git commit -m "test(supplement): integration test — AI supplement runs after intent match"
```

---

## Verification

After all tasks complete:

```bash
bun test --coverage 2>&1 | tail -30
```

Check coverage for new/modified files — aim for >80% on each.

```bash
bun run lint
```

Zero warnings expected.
