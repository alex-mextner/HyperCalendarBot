# OpenAI SDK Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Anthropic SDK with OpenAI SDK so both primary (z.ai/GLM) and fallback (HF Novita/R1) use the same OpenAI-compatible format.

**Architecture:** Single `openai` npm package talks to z.ai (primary) and HF router (fallback). Tool definitions converted from Anthropic `input_schema` to OpenAI `function.parameters`. Streaming uses `client.chat.completions.create({ stream: true })` with manual chunk accumulation (no `finalMessage()`). Internal types replace all `Anthropic.*` type references.

**Tech Stack:** `openai` npm package, OpenAI Chat Completions API format, z.ai `/api/paas/v4`, HF Router `/v1`

**Spec:** `docs/specs/2026-04-02-openai-sdk-migration.md`

---

### Task 1: Install OpenAI SDK, remove Anthropic SDK

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install openai, remove @anthropic-ai/sdk**

```bash
bun add openai
bun remove @anthropic-ai/sdk
```

- [ ] **Step 2: Verify installation**

```bash
bun run -e "import OpenAI from 'openai'; console.log('OK')"
```

Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add package.json bun.lock
git commit -m "chore: replace @anthropic-ai/sdk with openai"
```

---

### Task 2: Create AI client factory + internal types

**Files:**
- Create: `src/services/ai/ai-client.ts`
- Modify: `src/services/ai/types.ts`
- Modify: `src/config/env.ts`
- Delete: `src/services/ai/anthropic-client.ts`
- Modify: `test/services/ai/anthropic-client.test.ts` → rename to `test/services/ai/ai-client.test.ts`

- [ ] **Step 1: Write failing test for new client factory**

Create `test/services/ai/ai-client.test.ts`:

```ts
import { describe, expect, mock, test } from 'bun:test';

mock.module('openai', () => ({
  default: class MockOpenAI {
    apiKey: string;
    baseURL: string;
    constructor(opts: { apiKey: string; baseURL: string }) {
      this.apiKey = opts.apiKey;
      this.baseURL = opts.baseURL;
    }
  },
}));

describe('createAiClient', () => {
  test('uses env defaults', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    process.env.AI_BASE_URL = 'https://test.api';
    const { createAiClient } = await import('../../../src/services/ai/ai-client.ts');
    const client = createAiClient();
    expect((client as any).apiKey).toBe('test-key');
    expect((client as any).baseURL).toBe('https://test.api');
  });

  test('overrides with opts', async () => {
    const { createAiClient } = await import('../../../src/services/ai/ai-client.ts');
    const client = createAiClient({ apiKey: 'override', baseURL: 'https://override' });
    expect((client as any).apiKey).toBe('override');
    expect((client as any).baseURL).toBe('https://override');
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

```bash
bun test test/services/ai/ai-client.test.ts
```

Expected: FAIL (module not found)

- [ ] **Step 3: Create `src/services/ai/ai-client.ts`**

```ts
// src/services/ai/ai-client.ts
import OpenAI from 'openai';

/**
 * Creates an OpenAI-compatible client.
 * Works with z.ai, HF Router, or any OpenAI-compatible endpoint.
 */
export function createAiClient(opts?: { apiKey?: string; baseURL?: string }): OpenAI {
  return new OpenAI({
    apiKey: opts?.apiKey ?? process.env.ANTHROPIC_API_KEY,
    baseURL: opts?.baseURL ?? process.env.AI_BASE_URL,
  });
}
```

- [ ] **Step 4: Add internal types to `src/services/ai/types.ts`**

Add these types (keep existing AgentConfig, TelegramSender etc.):

```ts
/** Internal content block — replaces Anthropic.ContentBlockParam */
export interface AiTextBlock {
  type: 'text';
  text: string;
}

/** Internal tool call — parsed from OpenAI delta.tool_calls */
export interface AiToolCallBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: { [key: string]: unknown };
}

export type AiContentBlock = AiTextBlock | AiToolCallBlock;

/** Tool result sent back to the model */
export interface AiToolResultMessage {
  role: 'tool';
  tool_call_id: string;
  content: string;
}
```

Update `AgentConfig.fallback` — no changes needed (already has model/baseUrl/apiKey).

Add `AI_FAST_MODEL_FALLBACK` to `EnvConfig` in `src/config/env.ts`:

```ts
AI_FAST_MODEL_FALLBACK?: string;
```

And in `loadConfig()` return:

```ts
AI_FAST_MODEL_FALLBACK: process.env.AI_FAST_MODEL_FALLBACK || undefined,
```

- [ ] **Step 5: Delete old anthropic-client.ts and its test**

```bash
rm src/services/ai/anthropic-client.ts
rm test/services/ai/anthropic-client.test.ts
```

- [ ] **Step 6: Run test — verify it passes**

```bash
bun test test/services/ai/ai-client.test.ts
```

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: replace Anthropic client with OpenAI-compatible ai-client"
```

---

### Task 3: Convert tool definitions to OpenAI format

**Files:**
- Modify: `src/services/ai/tools.ts`
- Modify: `test/services/ai/tools.test.ts` (if exists, otherwise create)

- [ ] **Step 1: Write failing test**

```ts
import { describe, expect, test } from 'bun:test';
import { getToolDefinitions } from '../../../src/services/ai/tools.ts';

describe('getToolDefinitions (OpenAI format)', () => {
  test('returns tools in OpenAI function calling format', () => {
    const tools = getToolDefinitions('text');
    expect(tools.length).toBeGreaterThan(0);
    const first = tools[0]!;
    expect(first.type).toBe('function');
    expect(first.function).toBeDefined();
    expect(first.function.name).toBeDefined();
    expect(first.function.parameters).toBeDefined();
    expect(first.function.parameters.type).toBe('object');
  });

  test('no tool has input_schema (Anthropic format)', () => {
    const tools = getToolDefinitions('text');
    for (const tool of tools) {
      expect((tool as any).input_schema).toBeUndefined();
    }
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Expected: FAIL (tools still in Anthropic format)

- [ ] **Step 3: Convert tools.ts**

Replace the type alias and export format. Change:

```ts
import type Anthropic from '@anthropic-ai/sdk';
type ToolDefinition = Anthropic.Tool;
```

To:

```ts
import type OpenAI from 'openai';
type ToolDefinition = OpenAI.ChatCompletionTool;
```

Then convert every tool definition from:

```ts
{
  name: 'get_events',
  description: '...',
  input_schema: { type: 'object', properties: {...}, required: [...] }
}
```

To:

```ts
{
  type: 'function',
  function: {
    name: 'get_events',
    description: '...',
    parameters: { type: 'object', properties: {...}, required: [...] }
  }
}
```

This is a mechanical transformation: wrap each tool in `{ type: 'function', function: { name, description, parameters: <old input_schema> } }`.

Also update `getToolDefinitions()` return type from `ToolDefinition[]` to `OpenAI.ChatCompletionTool[]`.

- [ ] **Step 4: Run test — verify it passes**

```bash
bun test test/services/ai/tools.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/services/ai/tools.ts test/services/ai/tools.test.ts
git commit -m "feat: convert tool definitions to OpenAI function calling format"
```

---

### Task 4: Refactor agent.ts — streaming + messages + tool parsing

This is the core task. Replace Anthropic streaming with OpenAI streaming.

**Files:**
- Modify: `src/services/ai/agent.ts`

- [ ] **Step 1: Replace imports**

Change:
```ts
import type Anthropic from '@anthropic-ai/sdk';
import { createAnthropicClient } from './anthropic-client.ts';
```

To:
```ts
import type OpenAI from 'openai';
import { createAiClient } from './ai-client.ts';
```

- [ ] **Step 2: Update class fields and constructor**

Replace `Anthropic` types with `OpenAI`:

```ts
export class CalendarBotAgent {
  private client: OpenAI;
  private fallbackClient: OpenAI | null;
  // ... rest stays same

  constructor(config: AgentConfig, sender: TelegramSender) {
    this.client = createAiClient({ apiKey: config.apiKey, baseURL: config.baseUrl });
    // ... fallback same pattern with createAiClient
  }
```

- [ ] **Step 3: Update MessageParam interface**

Change from Anthropic content blocks to OpenAI format:

```ts
interface MessageParam {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: OpenAI.ChatCompletionMessageToolCall[];
  tool_call_id?: string;
}
```

- [ ] **Step 4: Update buildMessages()**

Key changes:
- System prompt becomes `{ role: 'system', content: systemPrompt }` in messages array
- Content blocks from history → reconstruct as string or tool_calls
- Tool results → `{ role: 'tool', tool_call_id, content }` messages

- [ ] **Step 5: Update saveAssistantTurn() and saveToolResults()**

Use `AiContentBlock[]` from types.ts instead of `Anthropic.ContentBlockParam[]`.

- [ ] **Step 6: Rewrite the streaming loop in run()**

Replace `makeStreamRequest` → `client.chat.completions.create({ stream: true })`.

OpenAI streaming accumulates tool_calls across multiple chunks:

```ts
const makeStreamRequest = (client: OpenAI, model: string) =>
  client.chat.completions.create({
    model,
    max_tokens: 4096,
    messages: [
      { role: 'system', content: systemPrompt },
      ...currentMessages,
    ],
    tools: getToolDefinitions(ctx.inputMode, caps, ctx.supplementMode),
    stream: true,
  });

// Accumulate tool calls from stream chunks
const pendingToolCalls: Map<number, { id: string; name: string; args: string }> = new Map();

for await (const chunk of stream) {
  const delta = chunk.choices[0]?.delta;
  if (!delta) continue;

  // Text content
  if (delta.content) {
    writer.appendText(delta.content);
    await writer.flush(false);
  }

  // Tool calls (streamed incrementally)
  if (delta.tool_calls) {
    for (const tc of delta.tool_calls) {
      const existing = pendingToolCalls.get(tc.index);
      if (!existing) {
        pendingToolCalls.set(tc.index, {
          id: tc.id ?? '',
          name: tc.function?.name ?? '',
          args: tc.function?.arguments ?? '',
        });
        if (tc.function?.name) {
          hasToolUse = true;
          writer.setToolLabel(tc.function.name);
          await writer.flush(true);
        }
      } else {
        if (tc.function?.arguments) existing.args += tc.function.arguments;
      }
    }
  }
}

// After stream ends — check finish_reason from last chunk
const finishReason = lastChunk?.choices[0]?.finish_reason;
if (finishReason === 'tool_calls') hasToolUse = true;
```

No `stream.finalMessage()` — build the final message manually from accumulated text + pendingToolCalls.

- [ ] **Step 7: Update tool result handling**

After executing tools, push results as:

```ts
// Assistant message with tool_calls
currentMessages.push({
  role: 'assistant',
  content: accumulatedText || null,
  tool_calls: [...pendingToolCalls.values()].map(tc => ({
    id: tc.id,
    type: 'function' as const,
    function: { name: tc.name, arguments: tc.args },
  })),
});

// Tool results — one message per tool call
for (const result of toolResults) {
  currentMessages.push({
    role: 'tool',
    tool_call_id: result.tool_use_id,
    content: result.content,
  });
}
```

- [ ] **Step 8: Verify tsc compiles**

```bash
tsc --noEmit
```

- [ ] **Step 9: Commit**

```bash
git add src/services/ai/agent.ts
git commit -m "feat: rewrite agent streaming to OpenAI chat completions format"
```

---

### Task 5: Update conversation-logger.ts and debug-logger.ts

**Files:**
- Modify: `src/services/conversation-logger.ts`
- Modify: `src/services/ai/debug-logger.ts`

- [ ] **Step 1: Replace Anthropic types in conversation-logger.ts**

Change:
```ts
import type Anthropic from '@anthropic-ai/sdk';
// ...
logAiTurn(userId: number, blocks: Anthropic.ContentBlockParam[], chatId?: number): void
logToolResults(userId: number, results: Anthropic.ToolResultBlockParam[], chatId?: number): void
```

To:
```ts
import type { AiContentBlock, AiToolResultMessage } from './ai/types.ts';
// ...
logAiTurn(userId: number, blocks: AiContentBlock[], chatId?: number): void
logToolResults(userId: number, results: AiToolResultMessage[], chatId?: number): void
```

- [ ] **Step 2: Replace Anthropic types in debug-logger.ts**

Change:
```ts
import type Anthropic from '@anthropic-ai/sdk';
type ContentBlock = Anthropic.ContentBlockParam;
```

To:
```ts
import type { AiContentBlock } from './types.ts';
type ContentBlock = AiContentBlock;
```

- [ ] **Step 3: Verify tsc compiles**

```bash
tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add src/services/conversation-logger.ts src/services/ai/debug-logger.ts
git commit -m "refactor: replace Anthropic types with internal AiContentBlock types"
```

---

### Task 6: Convert simple AI calls (city-resolver, tts-translation)

**Files:**
- Modify: `src/services/timezone/city-resolver.ts`
- Modify: `src/services/voice/tts-translation.ts`

- [ ] **Step 1: Convert city-resolver.ts**

Replace:
```ts
import { createAnthropicClient } from '../ai/anthropic-client.ts';
```
With:
```ts
import { createAiClient } from '../ai/ai-client.ts';
```

Replace `client.messages.create()` with `client.chat.completions.create()`:

```ts
const client = createAiClient();
const response = await client.chat.completions.create({
  model: model ?? 'glm-4.7-flash',
  max_tokens: 64,
  messages: [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: trimmed },
  ],
});

const raw = response.choices[0]?.message?.content;
if (raw) {
  const tz = raw.trim();
  // ... rest of validation logic unchanged
}
```

- [ ] **Step 2: Convert tts-translation.ts**

Replace:
```ts
import type Anthropic from '@anthropic-ai/sdk';
import { createAnthropicClient } from '../ai/anthropic-client.ts';
```
With:
```ts
import type OpenAI from 'openai';
import { createAiClient } from '../ai/ai-client.ts';
```

Replace `this.client.messages.create()`:

```ts
private client: OpenAI;

constructor(opts?) {
  this.client = createAiClient({ apiKey: opts?.apiKey, baseURL: opts?.baseUrl });
  this.model = opts?.model ?? 'glm-4.7-flash';
}

async translate(text, targetLang) {
  const message = await this.client.chat.completions.create({
    model: this.model,
    max_tokens: 1024,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: text },
    ],
  });
  const translated = message.choices[0]?.message?.content?.trim() ?? text;
  // ... cache logic unchanged
}
```

- [ ] **Step 3: Verify tsc compiles**

```bash
tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add src/services/timezone/city-resolver.ts src/services/voice/tts-translation.ts
git commit -m "refactor: convert city-resolver and tts-translation to OpenAI format"
```

---

### Task 7: Convert intent-learner raw fetch to OpenAI format

**Files:**
- Modify: `src/services/intent/intent-learner.ts`

- [ ] **Step 1: Convert raw fetch from Anthropic to OpenAI format**

Change the `callLearnerAI` method. Replace:

```ts
const response = await fetch(`${this.config.baseUrl}/v1/messages`, {
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': this.config.apiKey,
    'anthropic-version': '2023-06-01',
  },
  body: JSON.stringify({
    model: this.config.model,
    max_tokens: 2048,
    system: LEARNER_SYSTEM_PROMPT,
    messages: conversationMessages,
  }),
});
```

With:

```ts
const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${this.config.apiKey}`,
  },
  body: JSON.stringify({
    model: this.config.model ?? 'glm-4.7-flash',
    max_tokens: 2048,
    messages: [
      { role: 'system', content: LEARNER_SYSTEM_PROMPT },
      ...conversationMessages,
    ],
  }),
});
```

Update response parsing from Anthropic format:
```ts
// Old: data.content[0].text, data.stop_reason
// New: data.choices[0].message.content, data.choices[0].finish_reason
const data = await response.json() as {
  choices: { message: { content: string }; finish_reason: string }[];
};
const text = data.choices[0]?.message?.content ?? '';
const finished = data.choices[0]?.finish_reason !== 'length';
```

Also update the retry/conversation loop — assistant messages use `{ role: 'assistant', content: text }` (same format as now).

- [ ] **Step 2: Verify tsc compiles**

```bash
tsc --noEmit
```

- [ ] **Step 3: Run intent-learner tests**

```bash
bun test test/services/intent/intent-learner.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add src/services/intent/intent-learner.ts
git commit -m "refactor: convert intent-learner from Anthropic to OpenAI API format"
```

---

### Task 8: Update tests — agent mocks

**Files:**
- Modify: `test/services/ai/agent-run.test.ts`
- Modify: `test/services/ai/agent.test.ts`

- [ ] **Step 1: Update mock client format in agent-run.test.ts**

Replace mock Anthropic client structure with OpenAI structure. The mock `stream` needs to emit OpenAI-format chunks instead of Anthropic events:

```ts
// Old Anthropic mock events:
{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } }

// New OpenAI mock chunks:
{ choices: [{ delta: { content: 'Hello' }, index: 0, finish_reason: null }] }

// Old tool use events:
{ type: 'content_block_start', content_block: { type: 'tool_use', name: 'get_events' } }

// New tool call chunks:
{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'get_events', arguments: '' } }] }, index: 0, finish_reason: null }] }
```

No more `finalMessage()` — remove from mocks. The stream is a plain async iterable.

Mock client structure changes from:
```ts
{ messages: { stream: mock(() => streamObj) } }
```
To:
```ts
{ chat: { completions: { create: mock(() => streamIterable) } } }
```

- [ ] **Step 2: Update agent.test.ts mocks similarly**

- [ ] **Step 3: Run all tests**

```bash
bun test
```

Expected: all pass

- [ ] **Step 4: Commit**

```bash
git add test/
git commit -m "test: update agent mocks to OpenAI streaming format"
```

---

### Task 9: Update env config and index.ts wiring

**Files:**
- Modify: `src/config/env.ts`
- Modify: `src/index.ts`
- Modify: `src/bot/index.ts`

- [ ] **Step 1: Add AI_FAST_MODEL_FALLBACK to env.ts (if not done in Task 2)**

- [ ] **Step 2: Update index.ts — pass fallback config with fast model**

The `createBot()` already receives `aiConfig`. Ensure `fallback` includes both model and fast model. Update the scheduled AI calls and intent learner config to use fallback when configured.

- [ ] **Step 3: Update default model names**

In `env.ts`, change defaults from Claude model names:
```ts
AI_MODEL: process.env.AI_MODEL || 'glm-5.1',
AI_FAST_MODEL: process.env.AI_FAST_MODEL || 'glm-4.7-flash',
```

- [ ] **Step 4: Verify everything compiles and tests pass**

```bash
tsc --noEmit && bun run lint && bun test
```

- [ ] **Step 5: Commit**

```bash
git add src/config/env.ts src/index.ts src/bot/index.ts
git commit -m "feat: wire OpenAI SDK with z.ai primary + HF Novita fallback"
```

---

### Task 10: Final verification, lint, cleanup

- [ ] **Step 1: Verify no Anthropic references remain**

```bash
grep -r "anthropic-ai/sdk\|Anthropic\.\|anthropic-version\|createAnthropicClient" src/
```

Expected: no matches

- [ ] **Step 2: Run full test suite**

```bash
bun test
```

Expected: all pass

- [ ] **Step 3: Run lint and format**

```bash
bun run lint:fix && bun run format
```

- [ ] **Step 4: Run knip for unused exports**

```bash
bunx knip
```

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "chore: cleanup — remove all Anthropic SDK references"
```
