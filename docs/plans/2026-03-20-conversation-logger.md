# ConversationLogger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace all scattered `chatHistory.save()` calls with a single `ConversationLogger` service that captures every message — incoming user messages, bot responses, AI turns, tool results, button presses, commands, and edited messages. Most saves become automatic via middleware interception; AI assistant turns and tool results are saved by explicit `ConversationLogger` calls from `agent.ts` (they flow through `TelegramSender`, not `ctx.send()`, so middleware cannot intercept them).

**Architecture:** A `ConversationLogger` class wraps `ChatHistoryRepository` write operations with typed log methods. A GramIO middleware (registered before all handlers, runs for ALL update types) intercepts incoming messages, callback queries, and edited messages — and wraps `ctx.send()` so every outgoing bot response is auto-logged. This covers `message`, `callback_query`, `edited_message` updates universally — no per-handler ad hoc logging. `callback.handler.ts` removes ALL logging. The AI agent removes `saveUserMessage()` since the middleware persists user messages before the pipeline runs; `buildMessages` is updated to read the current message from history instead of appending it manually. `chatHistoryRepo` is kept in `callback.handler.ts` only for the `voice_prompt` READ operation; only writes are replaced by ConversationLogger.

**Tech Stack:** TypeScript, Bun, bun:sqlite, GramIO middleware

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/services/conversation-logger.ts` | **CREATE** | ConversationLogger class — typed write methods |
| `src/services/ai/activity-event.ts` | **MODIFY** | Add `{ kind: 'edited'; text: string }` to ActivityEvent union |
| `src/bot/index.ts` | **MODIFY** | Remove old command middleware; add universal middleware for all update types |
| `src/services/ai/agent.ts` | **MODIFY** | Remove `saveUserMessage()`; update `buildMessages` to not re-append current message; limit 10 → 30; use ConversationLogger for writes |
| `src/bot/pipeline/intent-matcher-layer.ts` | **MODIFY** | Remove manual `chatHistoryRepo.save()` — covered by ctx.send wrap |
| `src/bot/handlers/callback.handler.ts` | **MODIFY** | Remove ALL write logging; add `conversationLogger` parameter after `chatHistoryRepo`; keep `chatHistoryRepo` for voice_prompt read |
| `src/bot/handlers/message.handler.ts` | **MODIFY** | Add `conversationLogger` to `MessageHandlerDeps`; thread through `buildAgentContextFactory`; update `createIntentMatcherLayer` call site |
| `src/services/ai/types.ts` | **MODIFY** | Add `conversationLogger: ConversationLogger` to `AgentContext` |
| `test/services/conversation-logger.test.ts` | **CREATE** | Unit tests for ConversationLogger + get_history format compatibility |
| `test/services/ai/agent.test.ts` | **MODIFY** | Update 3 broken buildMessages tests; add limit-30 group test; add no-duplicate test |
| `test/services/ai/activity-event.test.ts` | **MODIFY** | Add test for `edited` kind in `formatActivityEvent` |

---

## Task 1: Create ConversationLogger class

**Files:**
- Create: `src/services/conversation-logger.ts`
- Create: `test/services/conversation-logger.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// test/services/conversation-logger.test.ts
import { describe, test, expect } from 'bun:test';
import { ConversationLogger } from '../../src/services/conversation-logger.ts';
import { formatActivityEvent } from '../../src/services/ai/activity-event.ts';
import type { ChatHistoryRepository } from '../../src/database/repositories/chat-history.repository.ts';

function makeRepo() {
  const calls: unknown[][] = [];
  const repo = {
    save: (...args: unknown[]) => { calls.push(args); },
    _calls: calls,
  } as unknown as ChatHistoryRepository & { _calls: unknown[][] };
  return repo;
}

describe('ConversationLogger', () => {
  test('logUserMessage saves plain text as user role without chatId', () => {
    const repo = makeRepo();
    new ConversationLogger(repo).logUserMessage(123, 'hello');
    expect(repo._calls).toHaveLength(1);
    expect(repo._calls[0]).toEqual([123, 'user', 'hello', undefined]);
  });

  test('logUserMessage passes chatId when provided', () => {
    const repo = makeRepo();
    new ConversationLogger(repo).logUserMessage(123, 'hi', 456);
    expect(repo._calls[0]).toEqual([123, 'user', 'hi', 456]);
  });

  test('logBotResponse saves assistant role with kind:bot wrapper', () => {
    const repo = makeRepo();
    new ConversationLogger(repo).logBotResponse(123, 'Done!');
    expect(repo._calls[0]![1]).toBe('assistant');
    expect(JSON.parse(repo._calls[0]![2] as string)).toEqual({ kind: 'bot', text: 'Done!' });
  });

  test('logCommand saves user role with kind:command wrapper', () => {
    const repo = makeRepo();
    new ConversationLogger(repo).logCommand(123, '/start');
    expect(JSON.parse(repo._calls[0]![2] as string)).toEqual({ kind: 'command', name: '/start' });
  });

  test('logButtonPress saves user role with kind:button wrapper', () => {
    const repo = makeRepo();
    new ConversationLogger(repo).logButtonPress(123, 'accept', 'id:42');
    expect(JSON.parse(repo._calls[0]![2] as string)).toEqual({ kind: 'button', label: 'accept', detail: 'id:42' });
  });

  test('logButtonPress passes chatId', () => {
    const repo = makeRepo();
    new ConversationLogger(repo).logButtonPress(123, 'ok', undefined, 999);
    expect(repo._calls[0]![3]).toBe(999);
  });

  test('logEditedMessage saves user role with kind:edited wrapper', () => {
    const repo = makeRepo();
    new ConversationLogger(repo).logEditedMessage(123, 'corrected');
    expect(JSON.parse(repo._calls[0]![2] as string)).toEqual({ kind: 'edited', text: 'corrected' });
  });

  test('logAiTurn saves assistant role with JSON-stringified blocks', () => {
    const repo = makeRepo();
    const blocks = [{ type: 'text', text: 'hello' }];
    new ConversationLogger(repo).logAiTurn(123, blocks as never);
    expect(repo._calls[0]![1]).toBe('assistant');
    expect(JSON.parse(repo._calls[0]![2] as string)).toEqual(blocks);
  });

  test('logToolResults saves tool role', () => {
    const repo = makeRepo();
    new ConversationLogger(repo).logToolResults(123, [] as never);
    expect(repo._calls[0]![1]).toBe('tool');
  });
});

// Verify every format written by ConversationLogger is readable by get_history's formatContent.
// formatContent is module-private; test via formatActivityEvent which it delegates to for kind objects.
describe('ConversationLogger — get_history format compatibility', () => {
  test('logBotResponse format renders via formatActivityEvent', () => {
    expect(formatActivityEvent({ kind: 'bot', text: 'Hello!' })).toBe('[Bot: Hello!]');
  });

  test('logCommand format renders via formatActivityEvent', () => {
    expect(formatActivityEvent({ kind: 'command', name: '/agenda' })).toBe('[Command: /agenda]');
  });

  test('logButtonPress format renders via formatActivityEvent', () => {
    expect(formatActivityEvent({ kind: 'button', label: 'accept', detail: '42' }))
      .toBe('[Button: "accept"] (42)');
  });

  test('logEditedMessage format renders via formatActivityEvent (requires Task 2)', () => {
    expect(formatActivityEvent({ kind: 'edited', text: 'fixed text' })).toBe('[Edited: fixed text]');
  });
});
```

- [ ] **Step 2: Run tests, confirm they fail**

```bash
bun test test/services/conversation-logger.test.ts
```
Expected: module not found. The `edited` test also fails until Task 2 adds it to ActivityEvent.

- [ ] **Step 3: Implement ConversationLogger**

```ts
// src/services/conversation-logger.ts
import type Anthropic from '@anthropic-ai/sdk';
import type { ChatHistoryRepository } from '../database/repositories/chat-history.repository.ts';

export class ConversationLogger {
  constructor(private repo: ChatHistoryRepository) {}

  logUserMessage(userId: number, text: string, chatId?: number): void {
    this.repo.save(userId, 'user', text, chatId);
  }

  logBotResponse(userId: number, text: string, chatId?: number): void {
    this.repo.save(userId, 'assistant', JSON.stringify({ kind: 'bot', text }), chatId);
  }

  logCommand(userId: number, name: string, chatId?: number): void {
    this.repo.save(userId, 'user', JSON.stringify({ kind: 'command', name }), chatId);
  }

  logButtonPress(userId: number, label: string, detail?: string, chatId?: number): void {
    this.repo.save(userId, 'user', JSON.stringify({ kind: 'button', label, detail }), chatId);
  }

  logEditedMessage(userId: number, text: string, chatId?: number): void {
    this.repo.save(userId, 'user', JSON.stringify({ kind: 'edited', text }), chatId);
  }

  logAiTurn(userId: number, blocks: Anthropic.ContentBlockParam[], chatId?: number): void {
    this.repo.save(userId, 'assistant', JSON.stringify(blocks), chatId);
  }

  logToolResults(userId: number, results: Anthropic.ToolResultBlockParam[], chatId?: number): void {
    this.repo.save(userId, 'tool', JSON.stringify(results), chatId);
  }
}
```

- [ ] **Step 4: Run tests (excluding edited compat test — needs Task 2)**

```bash
bun test test/services/conversation-logger.test.ts
```
Expected: 12 of 13 pass. The `logEditedMessage` compat test fails until Task 2.

- [ ] **Step 5: Commit**

```bash
git add src/services/conversation-logger.ts test/services/conversation-logger.test.ts
git commit -m "feat(logger): add ConversationLogger service"
```

---

## Task 2: Add `edited` to ActivityEvent

**Files:**
- Modify: `src/services/ai/activity-event.ts`
- Modify: `test/services/ai/activity-event.test.ts` (create if missing)

- [ ] **Step 1: Check for existing activity-event tests**

```bash
ls test/services/ai/activity-event.test.ts 2>/dev/null || echo "missing"
```

If missing, create the file with tests for all existing kinds before adding `edited`.

- [ ] **Step 2: Add failing test for `edited` kind**

```ts
test('formatActivityEvent edited', () => {
  expect(formatActivityEvent({ kind: 'edited', text: 'new text' })).toBe('[Edited: new text]');
});
```

Run — confirm TypeScript error: `edited` not in union.

- [ ] **Step 3: Update activity-event.ts**

```ts
export type ActivityEvent =
  | { kind: 'button'; label: string; detail?: string }
  | { kind: 'command'; name: string }
  | { kind: 'bot'; text: string }
  | { kind: 'edited'; text: string };

export function formatActivityEvent(event: ActivityEvent): string {
  switch (event.kind) {
    case 'button':
      return `[Button: "${event.label}"]${event.detail ? ` (${event.detail})` : ''}`;
    case 'command':
      return `[Command: ${event.name}]`;
    case 'bot':
      return `[Bot: ${event.text}]`;
    case 'edited':
      return `[Edited: ${event.text}]`;
  }
}
```

- [ ] **Step 4: Run all logger and activity-event tests**

```bash
bun test test/services/conversation-logger.test.ts test/services/ai/activity-event.test.ts
```
Expected: all 13 + activity-event tests pass.

- [ ] **Step 5: Lint**

```bash
bun run lint
```

- [ ] **Step 6: Commit**

```bash
git add src/services/ai/activity-event.ts test/services/ai/activity-event.test.ts test/services/conversation-logger.test.ts
git commit -m "feat(logger): add 'edited' ActivityEvent kind; all ConversationLogger tests pass"
```

---

## Task 3: Add ConversationLogger to AgentContext and MessageHandlerDeps

**Files:**
- Modify: `src/services/ai/types.ts`
- Modify: `src/bot/handlers/message.handler.ts`
- Modify: `src/bot/index.ts` (instantiate ConversationLogger singleton)

- [ ] **Step 1: Add to AgentContext in types.ts**

```ts
import type { ConversationLogger } from '../../services/conversation-logger.ts';
// In AgentContext interface:
conversationLogger: ConversationLogger;
```

- [ ] **Step 2: Add to MessageHandlerDeps**

```ts
import type { ConversationLogger } from '../../services/conversation-logger.ts';
// In MessageHandlerDeps interface:
conversationLogger: ConversationLogger;
```

- [ ] **Step 3: Thread through buildAgentContextFactory**

In `buildAgentContextFactory`, add to the returned `AgentContext`:
```ts
conversationLogger: deps.conversationLogger,
```

- [ ] **Step 4: Instantiate in bot/index.ts and pass through**

```ts
import { ConversationLogger } from '../services/conversation-logger.ts';
const conversationLogger = new ConversationLogger(db.chatHistory);
// Pass as deps.conversationLogger to createMessageHandler(deps)
```

- [ ] **Step 5: Lint — fix all type errors**

```bash
bun run lint
```

- [ ] **Step 6: Commit**

```bash
git add src/services/ai/types.ts src/bot/handlers/message.handler.ts src/bot/index.ts
git commit -m "feat(logger): thread ConversationLogger into AgentContext"
```

---

## Task 4: Update agent.ts — remove saveUserMessage, fix buildMessages, limit 30

**Files:**
- Modify: `src/services/ai/agent.ts`
- Modify: `test/services/ai/agent.test.ts`

### Existing tests that break after this task

After removing the `messages.push(current message)` line from `buildMessages`, these **four** tests in `agent.test.ts` will fail:

| Test | Current assertion | Updated assertion |
|---|---|---|
| line 65: `includes system prompt and user message` | `messages.length === 1` (appended msg) | Pre-save msg to history; still `length === 1` from history |
| line 74: `includes chat history` | `messages.length === 3` (2 history + 1 appended) | Pre-save current msg to history; `length === 3` (all from history) |
| line 97: `prefixes current message with UTC timestamp` | empty history, appended msg has `[time]` prefix | Pre-save to history; timestamp comes from `created_at` via `withTimestamp` |
| line 156: `saveUserMessage saves user text to chat history` | calls `agent.saveUserMessage(ctx)` — method exists | Delete this test — `saveUserMessage` method is removed entirely |

Write the updated tests BEFORE making the code change, confirm they fail, then make the change.

- [ ] **Step 1: Write failing tests (limit + no-duplicate + updated broken tests)**

Add to `test/services/ai/agent.test.ts`:

```ts
// Test limit=30 — must use group context because buildMessages calls getRecentByChat directly for groups
// (private path uses the history argument passed from run(), not a direct getRecentByChat call)
test('buildMessages fetches 30 entries for group chats', () => {
  const calls: { chatId: number; limit: number }[] = [];
  const mockChatHistory = {
    ...ctx.chatHistory,
    getRecentByChat: (chatId: number, limit: number) => { calls.push({ chatId, limit }); return []; },
  } as never;
  const groupCtx: AgentContext = { ...ctx, isGroup: true, groupChatId: 456, chatHistory: mockChatHistory };

  const agent = new CalendarBotAgent(config, sender);
  agent.buildMessages(groupCtx, []);
  expect(calls[0]).toMatchObject({ chatId: 456, limit: 30 });
});

// Confirm no duplicate: current message in history once, not twice
test('buildMessages does not re-append current message already in history', () => {
  // Simulate middleware having saved the current message before pipeline ran
  ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);
  const history = ctx.chatHistory.getRecent(USER_ID);
  const agent = new CalendarBotAgent(config, sender);
  const { messages } = agent.buildMessages(ctx, history);
  const userMessages = messages.filter(m => m.role === 'user');
  expect(userMessages).toHaveLength(1);
  expect(userMessages[0]!.content as string).toContain(ctx.messageText);
});
```

Update the three breaking tests:

```ts
// Was: buildMessages includes system prompt and user message
test('buildMessages includes system prompt and user message', () => {
  ctx.chatHistory.save(USER_ID, 'user', ctx.messageText); // middleware saves before pipeline
  const history = ctx.chatHistory.getRecent(USER_ID);
  const agent = new CalendarBotAgent(config, sender);
  const { systemPrompt, messages } = agent.buildMessages(ctx, history);
  expect(systemPrompt).toContain('calendar assistant');
  expect(messages.length).toBe(1);
  expect(messages[0]!.role).toBe('user');
  expect(messages[0]!.content as string).toContain('What do I have today?');
});

// Was: buildMessages includes chat history
test('buildMessages includes chat history', () => {
  ctx.chatHistory.save(USER_ID, 'user', 'Previous question');
  ctx.chatHistory.save(USER_ID, 'assistant', JSON.stringify([{ type: 'text', text: 'Previous answer' }]));
  ctx.chatHistory.save(USER_ID, 'user', ctx.messageText); // current msg saved by middleware
  const history = ctx.chatHistory.getRecent(USER_ID);
  const agent = new CalendarBotAgent(config, sender);
  const { messages } = agent.buildMessages(ctx, history);
  expect(messages.length).toBe(3);
  expect(messages[0]!.content as string).toContain('Previous question');
  expect(messages[2]!.content as string).toContain(ctx.messageText);
});

// Was: buildMessages prefixes current message with UTC timestamp
test('buildMessages prefixes user messages with UTC timestamp', () => {
  ctx.chatHistory.save(USER_ID, 'user', ctx.messageText); // middleware saves it
  const history = ctx.chatHistory.getRecent(USER_ID);
  const agent = new CalendarBotAgent(config, sender);
  const { messages } = agent.buildMessages(ctx, history);
  expect(messages[0]!.content as string).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]/);
  expect(messages[0]!.content as string).toContain(ctx.messageText);
});
```

- [ ] **Step 2: Run — confirm new tests fail and updated tests fail**

```bash
bun test test/services/ai/agent.test.ts
```
Expected: limit test fails (still 10), no-duplicate fails (still 2 user messages), updated tests fail.

- [ ] **Step 3: Remove saveUserMessage, update saveAssistantTurn/saveToolResults**

In `src/services/ai/agent.ts`, delete the `saveUserMessage()` method entirely.

```ts
saveAssistantTurn(ctx: AgentContext, contentBlocks: Anthropic.ContentBlockParam[]): void {
  const chatId = ctx.isGroup ? ctx.groupChatId : undefined;
  ctx.conversationLogger.logAiTurn(ctx.user.telegram_id, contentBlocks, chatId);
}

saveToolResults(ctx: AgentContext, toolResults: Anthropic.ToolResultBlockParam[]): void {
  const chatId = ctx.isGroup ? ctx.groupChatId : undefined;
  ctx.conversationLogger.logToolResults(ctx.user.telegram_id, toolResults, chatId);
}
```

- [ ] **Step 4: Remove the current-message append from buildMessages**

Delete this line:
```ts
messages.push({ role: 'user', content: `[${nowUtc}] ${ctx.messageText}` });
```
Remove `nowUtc` if it is only used there.

- [ ] **Step 5: Update history limits to 30**

```ts
// In run():
const history = ctx.chatHistory.getRecent(ctx.user.telegram_id, 30);
// In buildMessages():
ctx.chatHistory.getRecentByChat(ctx.groupChatId, 30)
```

- [ ] **Step 6: Remove saveUserMessage call in run()**

Delete `this.saveUserMessage(ctx)` from `agent.run()`.

- [ ] **Step 7: Run tests — confirm all pass**

```bash
bun test test/services/ai/agent.test.ts
```

- [ ] **Step 8: Commit**

```bash
git add src/services/ai/agent.ts test/services/ai/agent.test.ts
git commit -m "feat(logger): agent uses ConversationLogger, limit 30, buildMessages reads from history"
```

---

## Task 5: GramIO universal middleware — all update types

**Files:**
- Modify: `src/bot/index.ts`

This single middleware replaces the partial command logger AND all per-handler button logging. It intercepts `message`, `edited_message`, and `callback_query` updates universally.

- [ ] **Step 1: Read the existing command middleware block (~lines 340–380)**

Identify the block to remove: the one that checks `text?.startsWith('/')` and wraps `ctx.send` for first response only.

- [ ] **Step 2: Remove old command middleware**

Delete that entire block.

- [ ] **Step 3: Add universal middleware BEFORE `.extend(scenesSetup.plugin)`**

```ts
.use(async (context, next) => {
  const ctx = context as unknown as {
    message?: { text?: string };
    edited_message?: { text?: string };
    callbackQuery?: { data?: string };
    dbUser?: User;
    chatId?: number | bigint;
    send?: (text: string, opts?: Record<string, unknown>) => Promise<unknown>;
  };

  const user = ctx.dbUser;
  if (!user) return next();

  const chatId = ctx.chatId ? Number(ctx.chatId) : undefined;
  const isPrivate = !chatId || chatId === user.telegram_id;
  const logChatId = isPrivate ? undefined : chatId;

  // Incoming text message (regular or command)
  const incomingText = ctx.message?.text;
  if (incomingText) {
    if (incomingText.startsWith('/')) {
      conversationLogger.logCommand(user.telegram_id, incomingText.split(' ')[0]!, logChatId);
    } else {
      conversationLogger.logUserMessage(user.telegram_id, incomingText, logChatId);
    }
  }

  // Edited message
  const editedText = ctx.edited_message?.text;
  if (editedText) {
    conversationLogger.logEditedMessage(user.telegram_id, editedText, logChatId);
  }

  // Callback query (button press or ai_btn answer) — universal, no per-handler logging needed
  const callbackData = ctx.callbackQuery?.data;
  if (callbackData) {
    const firstColon = callbackData.indexOf(':');
    const action = firstColon >= 0 ? callbackData.slice(0, firstColon) : callbackData;
    const payload = firstColon >= 0 ? callbackData.slice(firstColon + 1) : '';

    if (action === 'ai_btn') {
      // ai_btn payload: "{answerText}" (private) or "{userId}:{answerText}" (group)
      const secondColon = payload.indexOf(':');
      const firstSegment = secondColon >= 0 ? payload.slice(0, secondColon) : payload;
      const answerText =
        secondColon >= 0 && /^\d+$/.test(firstSegment)
          ? payload.slice(secondColon + 1)
          : payload;
      conversationLogger.logUserMessage(user.telegram_id, answerText, logChatId);
    } else {
      conversationLogger.logButtonPress(user.telegram_id, action, payload || undefined, logChatId);
    }
  }

  // Wrap ctx.send — logs every bot response (intent matcher, scenes, commands)
  // Note: AI agent uses TelegramSender.sendMessage() directly; those are logged via logAiTurn
  const originalSend = ctx.send?.bind(ctx);
  if (originalSend) {
    (ctx as { send: typeof originalSend }).send = async (text, opts) => {
      const result = await originalSend(text, opts);
      conversationLogger.logBotResponse(user.telegram_id, text, logChatId);
      return result;
    };
  }

  return next();
})
```

- [ ] **Step 4: Add ordering test**

This test confirms the invariant the AI-supplement feature (next spec) depends on: user message row is written to history BEFORE the intent auto-reply row.

```ts
// In test/services/ai/agent.test.ts or a new integration test file:
test('user message is saved before bot response in history', () => {
  const db = createTestDb();
  const chatHistoryRepo = new ChatHistoryRepository(db);
  const logger = new ConversationLogger(chatHistoryRepo);

  logger.logUserMessage(USER_ID, 'add meeting');
  logger.logBotResponse(USER_ID, 'Meeting added!');

  const history = chatHistoryRepo.getRecent(USER_ID);
  expect(history).toHaveLength(2);
  expect(history[0]!.role).toBe('user');
  expect(history[1]!.role).toBe('assistant');
  // User row id is lower than assistant row id — strict ordering
  expect(history[0]!.id).toBeLessThan(history[1]!.id);
});
```

Run — should pass immediately (ordering is guaranteed by insert order + autoincrement id).

- [ ] **Step 5: Run full test suite**

```bash
bun test
```
Fix any failures.

- [ ] **Step 6: Commit**

```bash
git add src/bot/index.ts
git commit -m "feat(logger): universal GramIO middleware — messages, edits, callbacks, all update types"
```

---

## Task 6: Remove manual saves from intent-matcher and callback handler

**Files:**
- Modify: `src/bot/pipeline/intent-matcher-layer.ts`
- Modify: `src/bot/handlers/callback.handler.ts`
- Modify: `src/bot/handlers/message.handler.ts` (call site cleanup)

### intent-matcher-layer.ts

- [ ] **Step 1: Remove the manual save**

Delete lines 166–168:
```ts
if (chatHistoryRepo) {
  chatHistoryRepo.save(userId, 'assistant', JSON.stringify({ kind: 'bot', text: formatted }));
}
```

- [ ] **Step 2: Remove `chatHistoryRepo` parameter if no longer used**

Check if `chatHistoryRepo` is used anywhere else in `createIntentMatcherLayer`. If the deleted block was the only use, remove the parameter from the signature. Update the call site in `src/bot/handlers/message.handler.ts` to remove that argument.

### callback.handler.ts

`createCallbackHandler` takes 20+ positional parameters. Add `conversationLogger` immediately after `chatHistoryRepo` (position 11, replacing its write role while `chatHistoryRepo` stays for voice_prompt read):

```ts
export function createCallbackHandler(
  eventService: EventService,
  editValueScene: AnyScene,
  holidayService: HolidayService,
  prefsService: NotificationPreferencesService,
  calendarRepo?: GoogleCalendarRepository,
  disconnectDeps?: DisconnectDeps,
  onCalendarsDone?: (userId: number) => Promise<void>,
  renderService?: RenderService,
  invitationService?: InvitationService,
  eventRepo?: EventRepository,
  chatHistoryRepo?: ChatHistoryRepository,   // kept for voice_prompt READ at line ~1071
  conversationLogger?: ConversationLogger,   // ← ADD HERE (position 12)
  onAiButtonClick?: (userId: number, chatId: number, text: string) => Promise<void>,
  // ... rest unchanged
```

Import `ConversationLogger` at the top.

- [ ] **Step 3: Remove the button-press write block**

Delete lines 133–142:
```ts
if (chatHistoryRepo && user && action !== 'ai_btn') {
  chatHistoryRepo.save(
    user.telegram_id, 'user',
    JSON.stringify({ kind: 'button', label: action, detail: payload }),
  );
}
```

This is now handled universally by the GramIO middleware (Task 5).

- [ ] **Step 4: Remove the ai_btn stale comment**

On the line that said `// answerText is saved by agent.run() → saveUserMessage()`, delete the comment. The ai_btn logging now happens in the middleware (Task 5 step 3).

- [ ] **Step 5: Update call site in bot/index.ts**

Find where `createCallbackHandler(...)` is called and add `conversationLogger` in position 12.

- [ ] **Step 6: Run tests**

```bash
bun test
```

- [ ] **Step 7: Commit**

```bash
git add src/bot/pipeline/intent-matcher-layer.ts src/bot/handlers/callback.handler.ts src/bot/handlers/message.handler.ts src/bot/index.ts
git commit -m "feat(logger): remove all manual history writes from callback and intent handlers"
```

---

## Task 7: Final verification

- [ ] **Step 1: Zero remaining direct chatHistory write calls**

```bash
grep -rn "chatHistory\.save\|chatHistoryRepo\.save" src/
```
Expected: zero results.

- [ ] **Step 2: Remaining chatHistoryRepo usages are reads only**

```bash
grep -rn "chatHistoryRepo\." src/
```
Expected: only `chatHistoryRepo.getRecent` in `callback.handler.ts` (voice_prompt). Everything else is gone.

- [ ] **Step 3: Full suite + coverage**

```bash
bun test --coverage
```
Expected: all pass, ≥ 80% coverage.

- [ ] **Step 4: Lint**

```bash
bun run lint
```
Zero warnings, zero errors.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat(logger): ConversationLogger complete — all history writes centralized"
```

---

## Notes

- **No TTL**: history rows are never purged. No cleanup job needed.
- **`get_history` tool** (`src/services/ai/tool-handlers/history.ts`): handles all formats written by ConversationLogger via `formatContent`:
  - Plain text (`logUserMessage`) → rendered as-is
  - `{ kind: 'bot'|'command'|'button'|'edited', ... }` → `formatActivityEvent` → e.g. `[Bot: text]`
  - ContentBlockParam arrays (`logAiTurn`) → text blocks extracted
  - ToolResultBlockParam arrays (`logToolResults`) → renders as empty string (existing behavior, not a regression)
  - **Dependency**: `logEditedMessage` format requires Task 2 before `get_history` renders it correctly.
- **voice_prompt limit**: `chatHistoryRepo.getRecent(userId, 10)` in `callback.handler.ts` line ~1071 is intentional — it reads last 10 for TTS playback, not the full 30-message conversation context. Do not change this `10`.
- **Multi-send commands**: the middleware logs EVERY `ctx.send()` call (not just the first). This is intentional — previously only the first response was saved, which was lossy.
- **Log-after-send**: `logBotResponse` is called after `await originalSend(...)`. If the send throws, nothing is logged for that response. This is acceptable: failed sends shouldn't be in history.
- **Group chats**: private saves use `chatId = undefined` (matching `chat_id IS NULL` in `getRecent`). Group saves pass the group's chatId (matching `getRecentByChat`).
- **HTML in bot responses**: `logBotResponse` stores raw text including any HTML tags. The `get_history` tool will surface them to the AI. This matches the existing behavior of the old command middleware.
- **Ordering guarantee for AI-supplement spec**: user message is logged by middleware BEFORE `next()` is called; auto-reply is logged inside the wrapped `ctx.send()` which runs during `next()`. Insert order equals `id` order in SQLite. The ordering test in Task 5 step 4 validates this invariant.
