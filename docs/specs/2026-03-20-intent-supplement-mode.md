# Intent Supplement Mode — Design Spec

**Date:** 2026-03-20
**Status:** Draft

## Overview

After an intent matcher fires and sends an automatic response, the main AI agent also runs
in "supplement mode". It reviews the auto-response in conversation context and either stays
silent (nothing to add), enriches the response with commentary, or offers to correct/undo
if the auto-response was inappropriate.

This combines the best of both systems: the speed and determinism of intent automation with
the contextual awareness of the AI agent.

---

## Motivation

Intent workflows are fast and predictable but context-blind. They fire on pattern match
regardless of what the user actually meant in the broader conversation. The AI can catch
cases where:

- The auto-response was technically correct but missed the point given prior messages
- A destructive action (delete, update) was triggered but the user likely didn't intend it
- A read response (event list, agenda) can be enriched with observations or suggestions

---

## Pipeline Changes

### Current pipeline order

```
[IntentMatcherLayer, FeedbackRouterLayer, AiAgentLayer]
```

`runPipeline` stops at the first `{ handled: true }`. IntentMatcherLayer currently returns
`{ handled: true }` on success, which stops the pipeline.

### New behavior

IntentMatcherLayer returns `{ handled: true; needsSupplement: true }` on a **successful,
fully-completed** intent execution. `runPipeline` sees this flag, does not stop, and
continues through the remaining layers with `supplementMode: true` injected into `extra`.

Cases that do NOT set `needsSupplement`:
- Suspended workflow (ask_user mid-step) — returns `{ handled: true }` as before
- Session resume (user answering an ask_user question) — `{ handled: true }` as before
- Intent execution failure (fall-through to AI) — `{ handled: false }` as before
- No intent match — `{ handled: false }` as before

### FeedbackRouterLayer in the path

When `needsSupplement: true` causes the pipeline to continue, `FeedbackRouterLayer` runs
before `AiAgentLayer`. For any normal user message, `FeedbackRouterLayer` returns
`{ handled: false }` — it only intercepts admin-to-user reply messages, which cannot be
the same turn as an intent match. No change needed in `FeedbackRouterLayer`.

### Updated types

```typescript
// pipeline/types.ts
export type PipelineResult =
  | { handled: true }
  | { handled: true; needsSupplement: true }   // ← new: continue to supplement
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

### Updated runPipeline

```typescript
// pipeline/pipeline.ts
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
        continue; // don't stop — run remaining layers in supplement mode
      }
      return;
    }
    if ('feedbackContext' in result) {
      feedbackContext = result.feedbackContext;
    }
  }
}
```

---

## AgentContext Changes

```typescript
// services/ai/types.ts
export interface AgentContext {
  // ...existing fields...
  supplementMode?: boolean;
}
```

`AiAgentLayer` reads `extra.supplementMode` and sets `agentContext.supplementMode = true`.

---

## agent.ts Changes

Four changes required in `CalendarBotAgent`.

### 1. No-op sender in supplement mode (no streaming to Telegram)

`responseText` in `AgentRunResult` is sourced from `writer.getText()` (line 294).
A null writer is not viable — `writer.*` calls would need null guards everywhere,
and `writer.getText()` at line 294 plus `writer.finalize()` in the `stopLoop` path
(line 238) would crash.

Instead, pass a **no-op `TelegramSender`** when creating the writer in supplement mode.
The writer still accumulates text and all calls work unchanged; nothing is sent to Telegram.

```typescript
// agent.ts — in run(), before writer construction
const effectiveSender: TelegramSender = ctx.supplementMode
  ? {
      // required methods
      sendMessage: async () => ({ message_id: 0 }),
      editMessageText: async () => {},
      // optional methods — included explicitly so TypeScript is satisfied
      // if TelegramSender ever gains required methods, update this object too
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
const writer = new TelegramStreamWriter(effectiveSender, ctx.chatId, ctx.user.language, { ... });
await writer.init();
```

No other changes to writer usage needed — the `stopLoop` early-return path
(`writer.clearToolLabel()` / `writer.commitIntermediate()` / `writer.finalize()` at lines
232–244) works correctly with a no-op sender.

### 2. Pass supplementMode to getToolDefinitions

```typescript
// agent.ts — streamRequest() body, line 150
tools: getToolDefinitions(ctx.inputMode, ctx.supplementMode),
```

`getToolDefinitions` gains a second parameter `supplementMode?: boolean`.

### 3. Skip saveUserMessage in supplement mode

The intent matcher layer saves the user message before its auto-response (see below).
Calling `saveUserMessage` again would duplicate the user turn in chat history.

```typescript
// agent.ts — in run()
if (!ctx.supplementMode) {
  this.saveUserMessage(ctx);
}
```

### 4. Skip final user message append in buildMessages in supplement mode

`buildMessages` always appends the current user message at the end (line 88). In supplement
mode the user message is already the second-to-last entry in `chatHistory` (saved by the
intent matcher), so appending it again would show the AI a duplicate user turn.

```typescript
// agent.ts — buildMessages(), line 88
if (!ctx.supplementMode) {
  messages.push({ role: 'user', content: `[${nowUtc}] ${ctx.messageText}` });
}
```

---

## IntentMatcherLayer History Change

For supplement mode to work, the AI must see history ordered as:
`[..., user: message, assistant: auto-response]`.

Currently the intent matcher saves only the **assistant** auto-response (line 167), not the
user message. When the supplement agent calls `getRecent()` it sees the assistant turn first
with no user message entry before it.

Fix: save the user message **before** the assistant response in the intent matcher:

```typescript
// intent-matcher-layer.ts — step 8, before line 167
if (chatHistoryRepo) {
  chatHistoryRepo.save(userId, 'user', messageText);           // ← new
  chatHistoryRepo.save(userId, 'assistant', JSON.stringify({ kind: 'bot', text: formatted }));
}
```

This ensures `buildMessages` loads `[..., user: message, assistant: auto-response]` and the
AI sees the correct conversation order without any additional appending.

`saveAssistantTurn` and `saveToolResults` are called as normal in supplement mode —
the supplement response must be persisted in history for future turns.

---

## AiAgentLayer Changes

```typescript
// ai-agent-layer.ts
const agentContext = deps.agentContextBuilder(...);
if (extra?.supplementMode) {
  agentContext.supplementMode = true;
}

try {
  const result = await deps.agent.run(agentContext);

  if (extra?.supplementMode) {
    const skipped = result.toolCalls.some(tc => tc.name === 'supplement_skip');
    // responseText comes from writer.getText() which produces HTML-formatted text.
    // Must send with parse_mode: 'HTML' — same as TelegramStreamWriter.finalize() does.
    if (!skipped && result.responseText) {
      await ctx.send(result.responseText, { parse_mode: 'HTML' });
    }
    // IntentLearner is not called in supplement mode
    return { handled: true };
  }

  // normal path — existing code unchanged
  if (deps.intentLearner && result.toolCalls.length > 0) { ... }
} catch (error) {
  if (extra?.supplementMode) {
    // auto-response already sent — log warn, stay silent, don't alarm user
    cmdLogger.warn({ err: error, userId: user.telegram_id }, 'AI supplement error (suppressed)');
    return { handled: true };
  }
  cmdLogger.error({ err: error, userId: user.telegram_id }, 'AI agent error');
  await ctx.send(t(lang).something_wrong);
}
```

---

## System Prompt Section

`buildSystemPrompt` appends this section when `ctx.supplementMode === true`:

```
## Supplement Mode

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
- Do not call ask_user or pick_users in supplement mode.
```

---

## `supplement_skip` Tool

A no-op tool exposed **only** when `supplementMode` is true (second parameter of
`getToolDefinitions`). The AI calls it to signal that the auto-response was sufficient.

```typescript
// tools.ts
export function getToolDefinitions(
  inputMode?: string,
  supplementMode?: boolean,
): ToolDefinition[] {
  const tools = [...existingTools(inputMode)];
  if (supplementMode) {
    tools.push({
      name: 'supplement_skip',
      description: 'Call when the automatic response was correct and complete. Suppresses your response.',
      input_schema: { type: 'object', properties: {}, required: [] },
    });
  }
  return tools;
}
```

Handler in `tool-executor.ts`:

```typescript
case 'supplement_skip':
  return { success: true, stopLoop: true };
```

`AiAgentLayer` checks `toolCalls.some(tc => tc.name === 'supplement_skip')` after `run()`
to decide whether to send `responseText`. The tool never reaches the user.

### Why not exclude ask_user / pick_users in supplement mode

The system prompt instructs the AI not to call `ask_user`/`pick_users`. Removing them from
the tool list is an additional safety layer but adds complexity. v1 relies on the prompt
instruction. If violations are observed in production, tool exclusion can be added then.

---

## Files Changed

| File | Change |
|------|--------|
| `src/bot/pipeline/types.ts` | Add `{ handled: true; needsSupplement: true }` to `PipelineResult`; add `supplementMode?: boolean` to `PipelineLayer` extra object |
| `src/bot/pipeline/pipeline.ts` | Continue on `needsSupplement` with `supplementMode = true`; pass it in `extra` |
| `src/bot/pipeline/intent-matcher-layer.ts` | Return `{ handled: true, needsSupplement: true }` on completed intent; save user message to chatHistory before auto-response |
| `src/bot/pipeline/ai-agent-layer.ts` | Read `extra.supplementMode`, set on context, suppress/send `responseText` based on `supplement_skip`, swallow errors silently |
| `src/services/ai/types.ts` | Add `supplementMode?: boolean` to `AgentContext` |
| `src/services/ai/system-prompt.ts` | Add supplement section when `ctx.supplementMode` |
| `src/services/ai/tools.ts` | Add `supplementMode?: boolean` param; append `supplement_skip` tool when true |
| `src/services/ai/tool-executor.ts` | Handle `supplement_skip` — return `{ success: true, stopLoop: true }` |
| `src/services/ai/agent.ts` | Use no-op sender in supplement mode (no streaming); skip `saveUserMessage`; pass `supplementMode` to `getToolDefinitions`; skip final user message append in `buildMessages` |

No new files. No schema migrations.

---

## Tests

| File | What it covers |
|------|---------------|
| `test/bot/pipeline/pipeline.test.ts` | `needsSupplement: true` → continues with `supplementMode`; plain `handled: true` → stops |
| `test/bot/handlers/message.handler.test.ts` | Full flow: intent match → supplement AI runs |
| `test/bot/pipeline/intent-matcher-layer.test.ts` | Successful intent → `needsSupplement: true`; suspended → plain `handled: true` |
| `test/bot/pipeline/ai-agent-layer.test.ts` | `supplementMode` → `supplement_skip` suppresses text; no `supplement_skip` → text sent; error → warn not error, no user message |
| `test/services/ai/system-prompt.test.ts` | Supplement section present iff `supplementMode: true` |
| `test/services/ai/agent.test.ts` | `supplementMode` → `saveUserMessage` not called; null writer used |

---

## Out of Scope (v1)

- Per-user toggle to disable supplement mode
- Supplement for voice messages (only text intents for now)
- Metrics on how often supplement fires vs stays silent
- Excluding `ask_user`/`pick_users` from supplement tool list (prompt instruction is sufficient for v1)
