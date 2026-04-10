# OpenAI SDK Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Anthropic SDK with OpenAI SDK and add multi-provider fallback chains for reliability.

**Architecture:** Two unified API functions — `aiStreamRound()` (streaming with callbacks) and `aiComplete()` (non-streaming) — each backed by a provider chain. Streaming chain: z.ai GLM 5.1 → Gemini 2.5 Pro → HF Qwen3-235B. Main completion chain: Gemini 2.5 Pro → HF Qwen3-235B. Light completion chain: Gemini 2.5 Flash → HF Llama-3.3-70B. z.ai only used in streaming (coding endpoint doesn't produce text content for non-tool responses). All providers use OpenAI SDK with different `baseURL`.

**Tech Stack:** `openai` npm package (replacing `@anthropic-ai/sdk`), Bun runtime

---

## File Structure

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/services/ai/clients.ts` | OpenAI client instances for z.ai, HF, Gemini |
| Create | `src/services/ai/streaming.ts` | `aiStreamRound()` — one streaming round with provider fallback |
| Create | `src/services/ai/completion.ts` | `aiComplete()` — non-streaming with provider fallback + light chain |
| Modify | `src/services/ai/agent.ts` | Rewrite streaming loop to use `aiStreamRound()` |
| Modify | `src/services/ai/tools.ts` | Convert `input_schema` → `parameters`, wrap in `{type:'function', function:{...}}` |
| Modify | `src/services/ai/types.ts` | Add `OpenAiMessage` type alias, remove Anthropic deps |
| Modify | `src/services/ai/response-validator.ts` | Switch to `aiComplete()` |
| Modify | `src/services/ai/debug-logger.ts` | Replace `Anthropic.ContentBlockParam` with OpenAI types |
| Modify | `src/services/ai/tool-executor.ts` | No changes (already SDK-agnostic) |
| Modify | `src/services/intent/intent-learner.ts` | Replace raw `fetch()` with `aiComplete()` |
| Modify | `src/services/timezone/city-resolver.ts` | Replace SDK call with `aiComplete()` |
| Modify | `src/services/voice/tts-translation.ts` | Replace SDK call with `aiComplete()` |
| Modify | `src/config/env.ts` | Add `GEMINI_API_KEY`, rename/restructure AI env vars |
| Modify | `src/index.ts` | Remove Anthropic client creation, update AgentConfig |
| Modify | `src/utils/ai-provider-alert.ts` | Already created — wire into streaming/completion |
| Delete | `src/services/ai/anthropic-client.ts` | Replaced by `clients.ts` |
| Remove dep | `@anthropic-ai/sdk` | No longer needed |

---

### Task 1: Environment config — add new provider keys

**Files:**
- Modify: `src/config/env.ts`
- Modify: `.env.example`

- [ ] **Step 1: Update EnvConfig interface**

```typescript
// In src/config/env.ts, replace these fields:
//   ANTHROPIC_API_KEY: string;
//   AI_BASE_URL: string;
//   AI_MODEL_FALLBACK?: string;
//   AI_BASE_URL_FALLBACK?: string;
//   AI_API_KEY_FALLBACK?: string;
// With:
  ZAI_API_KEY: string;
  AI_MODEL: string;
  AI_FAST_MODEL: string;
  HF_TOKEN: string;       // was optional, now required
  GEMINI_API_KEY: string;  // new
```

Remove `AI_BASE_URL`, `AI_MODEL_FALLBACK`, `AI_BASE_URL_FALLBACK`, `AI_API_KEY_FALLBACK`.

- [ ] **Step 2: Update loadConfig()**

Replace the `ANTHROPIC_API_KEY` validation block with:

```typescript
const ZAI_API_KEY = process.env.ANTHROPIC_API_KEY ?? process.env.ZAI_API_KEY;
if (!ZAI_API_KEY) {
  throw new Error('ZAI_API_KEY (or ANTHROPIC_API_KEY) environment variable is required');
}
const HF_TOKEN = process.env.HF_TOKEN;
if (!HF_TOKEN) {
  throw new Error('HF_TOKEN environment variable is required');
}
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  throw new Error('GEMINI_API_KEY environment variable is required');
}
```

In the return object:
```typescript
ZAI_API_KEY,
HF_TOKEN,
GEMINI_API_KEY,
AI_MODEL: process.env.AI_MODEL || 'glm-5.1',
AI_FAST_MODEL: process.env.AI_FAST_MODEL || 'glm-4.7-flash',
```

Remove: `ANTHROPIC_API_KEY`, `AI_BASE_URL`, `AI_MODEL_FALLBACK`, `AI_BASE_URL_FALLBACK`, `AI_API_KEY_FALLBACK`, `GROQ_API_KEY`.

- [ ] **Step 3: Update .env.example**

```env
ZAI_API_KEY=your_zai_api_key
AI_MODEL=glm-5.1
AI_FAST_MODEL=glm-4.7-flash
HF_TOKEN=your_hf_token
GEMINI_API_KEY=your_gemini_api_key
```

- [ ] **Step 4: Run tsc to check compile errors**

Run: `tsc --noEmit 2>&1 | head -50`
Expected: Errors in files that reference old env var names — that's fine, we'll fix them in subsequent tasks.

- [ ] **Step 5: Commit**

```bash
git add src/config/env.ts .env.example
git commit -m "refactor(env): replace Anthropic env vars with multi-provider keys (z.ai, HF, Gemini)"
```

---

### Task 2: Create OpenAI clients module

**Files:**
- Create: `src/services/ai/clients.ts`

- [ ] **Step 1: Create clients.ts**

```typescript
// src/services/ai/clients.ts
// OpenAI SDK clients for all AI providers.
// All use the same OpenAI SDK — only baseURL and apiKey differ.

import OpenAI from 'openai';
import { loadConfig } from '../../config/env.ts';

const ZAI_BASE_URL = 'https://api.z.ai/api/coding/paas/v4';
const HF_BASE_URL = 'https://router.huggingface.co/v1';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/';

const DEFAULT_TIMEOUT_MS = 60_000;

// Placeholder prevents OpenAI SDK from throwing at construction when key is missing
// (e.g. in tests). Actual API calls will fail with 401.
const PLACEHOLDER = 'missing';

let _zai: OpenAI | null = null;
let _hf: OpenAI | null = null;
let _gemini: OpenAI | null = null;

function env() {
  return loadConfig();
}

export function zaiClient(): OpenAI {
  if (!_zai) {
    const cfg = env();
    _zai = new OpenAI({
      apiKey: cfg.ZAI_API_KEY || PLACEHOLDER,
      baseURL: ZAI_BASE_URL,
      timeout: DEFAULT_TIMEOUT_MS,
      maxRetries: 0,
    });
  }
  return _zai;
}

export function hfClient(): OpenAI {
  if (!_hf) {
    const cfg = env();
    _hf = new OpenAI({
      apiKey: cfg.HF_TOKEN || PLACEHOLDER,
      baseURL: HF_BASE_URL,
      timeout: DEFAULT_TIMEOUT_MS,
      maxRetries: 0,
    });
  }
  return _hf;
}

export function geminiClient(): OpenAI {
  if (!_gemini) {
    const cfg = env();
    _gemini = new OpenAI({
      apiKey: cfg.GEMINI_API_KEY || PLACEHOLDER,
      baseURL: GEMINI_BASE_URL,
      timeout: DEFAULT_TIMEOUT_MS,
      maxRetries: 0,
    });
  }
  return _gemini;
}

/** Reset all clients (for testing). */
export function resetClients(): void {
  _zai = null;
  _hf = null;
  _gemini = null;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/services/ai/clients.ts
git commit -m "feat(ai): add OpenAI SDK client instances for z.ai, HF, Gemini"
```

---

### Task 3: Create streaming module

**Files:**
- Create: `src/services/ai/streaming.ts`
- Test: `test/services/ai/streaming.test.ts`

- [ ] **Step 1: Write test for isRetryableError and getBackoffDelay**

```typescript
// test/services/ai/streaming.test.ts
import { describe, expect, test } from 'bun:test';
import { isRetryableError, getBackoffDelay } from '../../src/services/ai/streaming.ts';
import OpenAI from 'openai';

describe('isRetryableError', () => {
  test('returns true for 429', () => {
    const err = new OpenAI.APIError(429, { message: 'rate limited' }, 'rate limited', {});
    expect(isRetryableError(err)).toBe(true);
  });

  test('returns true for 500+', () => {
    const err = new OpenAI.APIError(503, { message: 'overloaded' }, 'overloaded', {});
    expect(isRetryableError(err)).toBe(true);
  });

  test('returns false for 400', () => {
    const err = new OpenAI.APIError(400, { message: 'bad request' }, 'bad request', {});
    expect(isRetryableError(err)).toBe(false);
  });

  test('returns true for timeout', () => {
    const err = new Error('Request timed out');
    expect(isRetryableError(err)).toBe(true);
  });
});

describe('getBackoffDelay', () => {
  test('returns exponential delay', () => {
    const err = new Error('network');
    expect(getBackoffDelay(0, err)).toBe(2000);
    expect(getBackoffDelay(1, err)).toBe(6000);
    expect(getBackoffDelay(2, err)).toBe(18000);
  });

  test('caps at 30s', () => {
    const err = new Error('network');
    expect(getBackoffDelay(5, err)).toBe(30000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/services/ai/streaming.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create streaming.ts**

```typescript
// src/services/ai/streaming.ts
// Streaming AI round with automatic provider fallback.
// STREAMING_CHAIN: z.ai GLM → Gemini Pro → HF Qwen3-235B

import type OpenAI from 'openai';
import { loadConfig } from '../../config/env.ts';
import { logger } from '../../utils/logger.ts';
import {
  alertProviderBalanceExhausted,
  isBalanceExhausted,
} from '../../utils/ai-provider-alert.ts';
import { zaiClient, hfClient, geminiClient } from './clients.ts';

const aiLogger = logger.child({ module: 'ai-stream' });

// ── Types ──────────────────────────────────────────────────────────────────

export interface StreamRoundOptions {
  messages: OpenAI.ChatCompletionMessageParam[];
  tools?: OpenAI.ChatCompletionTool[];
  maxTokens: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface StreamCallbacks {
  onTextDelta?: (text: string) => void;
  onToolCallStart?: (name: string) => void;
}

export interface StreamToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface StreamRoundResult {
  text: string;
  toolCalls: StreamToolCall[];
  finishReason: string;
  assistantMessage: OpenAI.ChatCompletionMessageParam;
}

// ── Error helpers (exported for tests) ─────────────────────────────────────

function isProviderDown(error: unknown): boolean {
  if (error instanceof OpenAI.APIError && error.status !== undefined && error.status >= 500) {
    return true;
  }
  if (error instanceof Error) {
    if (error.message.includes('timed out')) return true;
    const code = (error as NodeJS.ErrnoException).code;
    if (code && ['ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'ENOTFOUND'].includes(code)) {
      return true;
    }
  }
  return false;
}

export function isRetryableError(error: unknown): boolean {
  if (isProviderDown(error)) return true;
  if (error instanceof Error && error.name === 'AbortError') return true;
  if (error instanceof OpenAI.APIError) {
    return error.status === 429 || error.status >= 500;
  }
  return false;
}

export function getBackoffDelay(attempt: number, error: unknown): number {
  if (error instanceof OpenAI.APIError && error.status === 429) {
    const retryAfter = error.headers?.['retry-after'];
    if (retryAfter) {
      const seconds = Number.parseInt(retryAfter, 10);
      if (!Number.isNaN(seconds) && seconds > 0) return Math.min(seconds * 1000, 30_000);
    }
    return 5000;
  }
  return Math.min(2000 * 3 ** attempt, 30_000);
}

// ── Provider adapters ──────────────────────────────────────────────────────

interface ProviderSlot {
  name: string;
  stream: (opts: StreamRoundOptions, cbs: StreamCallbacks) => Promise<StreamRoundResult>;
}

function openaiStreamSlot(name: string, getClient: () => OpenAI, model: string): ProviderSlot {
  return {
    name,
    stream: async (opts, cbs) => {
      const params: OpenAI.ChatCompletionCreateParamsStreaming = {
        model,
        messages: opts.messages,
        max_tokens: opts.maxTokens,
        temperature: opts.temperature ?? 0.3,
        stream: true,
      };
      if (opts.tools && opts.tools.length > 0) {
        params.tools = opts.tools;
      }

      const stream = await getClient().chat.completions.create(params, { signal: opts.signal });

      let text = '';
      const toolCalls = new Map<number, { id: string; name: string; args: string }>();
      let finishReason = 'stop';

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          text += delta.content;
          cbs.onTextDelta?.(delta.content);
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const existing = toolCalls.get(tc.index);
            if (existing) {
              existing.args += tc.function?.arguments ?? '';
              if (tc.id && !existing.id) existing.id = tc.id;
              if (tc.function?.name && !existing.name) existing.name = tc.function.name;
            } else {
              const tcName = tc.function?.name ?? '';
              if (tcName) cbs.onToolCallStart?.(tcName);
              toolCalls.set(tc.index, {
                id: tc.id ?? '',
                name: tcName,
                args: tc.function?.arguments ?? '',
              });
            }
          }
        }

        if (chunk.choices[0]?.finish_reason) {
          finishReason = chunk.choices[0].finish_reason;
        }
      }

      const toolCallsArray: StreamToolCall[] = [...toolCalls.values()].map((tc) => ({
        id: tc.id,
        name: tc.name,
        arguments: tc.args,
      }));

      const assistantMessage: OpenAI.ChatCompletionMessageParam = {
        role: 'assistant',
        content: text || null,
        ...(toolCallsArray.length > 0
          ? {
              tool_calls: toolCallsArray.map((tc) => ({
                id: tc.id,
                type: 'function' as const,
                function: { name: tc.name, arguments: tc.arguments },
              })),
            }
          : {}),
      };

      // z.ai coding endpoint returns reasoning_content instead of content for text-only
      // responses. If we got 200 OK but no text and no tool calls, treat as empty response
      // so the chain falls through to the next provider.
      if (!text && toolCallsArray.length === 0) {
        throw new Error('Provider returned empty response (coding endpoint reasoning-only)');
      }

      return { text, toolCalls: toolCallsArray, finishReason, assistantMessage };
    },
  };
}

/** Non-streaming fallback for providers with unreliable streaming. */
function nonStreamSlot(name: string, getClient: () => OpenAI, model: string): ProviderSlot {
  return {
    name,
    stream: async (opts, cbs) => {
      const params: OpenAI.ChatCompletionCreateParamsNonStreaming = {
        model,
        messages: opts.messages,
        max_tokens: opts.maxTokens,
        temperature: opts.temperature ?? 0.3,
      };
      if (opts.tools && opts.tools.length > 0) {
        params.tools = opts.tools;
      }

      const response = await getClient().chat.completions.create(params, { signal: opts.signal });
      const choice = response.choices[0];
      const text = choice?.message?.content?.trim() ?? '';

      if (text) cbs.onTextDelta?.(text);

      const toolCalls: StreamToolCall[] = (choice?.message?.tool_calls ?? []).map((tc) => {
        if (tc.function.name) cbs.onToolCallStart?.(tc.function.name);
        return { id: tc.id, name: tc.function.name, arguments: tc.function.arguments };
      });

      const assistantMessage: OpenAI.ChatCompletionMessageParam = {
        role: 'assistant',
        content: text || null,
        ...(toolCalls.length > 0
          ? {
              tool_calls: toolCalls.map((tc) => ({
                id: tc.id,
                type: 'function' as const,
                function: { name: tc.name, arguments: tc.arguments },
              })),
            }
          : {}),
      };

      return {
        text,
        toolCalls,
        finishReason: choice?.finish_reason ?? 'stop',
        assistantMessage,
      };
    },
  };
}

// ── Chain ───────────────────────────────────────────────────────────────────

function buildStreamingChain(): ProviderSlot[] {
  const cfg = loadConfig();
  return [
    openaiStreamSlot(`z.ai (${cfg.AI_MODEL})`, zaiClient, cfg.AI_MODEL),
    openaiStreamSlot('Gemini 2.5 Pro', geminiClient, 'gemini-2.5-pro'),
    nonStreamSlot('HF Qwen3-235B', hfClient, 'Qwen/Qwen3-235B-A22B'),
  ];
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Execute one streaming round with automatic provider fallback.
 *
 * Chain: z.ai GLM → Gemini 2.5 Pro → HF Qwen3-235B.
 *
 * Fallback happens ONLY on provider-down errors BEFORE text is emitted.
 * Once streaming starts, errors propagate to the caller.
 */
export async function aiStreamRound(
  options: StreamRoundOptions,
  callbacks: StreamCallbacks = {},
): Promise<StreamRoundResult> {
  const chain = buildStreamingChain();
  let lastError: Error | null = null;
  let textEmitted = false;

  const wrappedCallbacks: StreamCallbacks = {
    onTextDelta: (text) => {
      textEmitted = true;
      callbacks.onTextDelta?.(text);
    },
    onToolCallStart: callbacks.onToolCallStart,
  };

  for (const slot of chain) {
    try {
      aiLogger.info(`Trying ${slot.name}`);
      return await slot.stream(options, wrappedCallbacks);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      aiLogger.error({ err: lastError }, `${slot.name} failed`);

      if (isBalanceExhausted(error)) {
        alertProviderBalanceExhausted(slot.name, lastError.message);
      }

      if (textEmitted) {
        aiLogger.error(`${slot.name} died mid-stream after text was emitted — cannot fallback`);
        throw error;
      }

      if (isProviderDown(error) || isBalanceExhausted(error)) {
        aiLogger.warn(`${slot.name} is down, trying next provider`);
        continue;
      }

      // Non-provider error (4xx client error, etc.) — don't retry
      throw error;
    }
  }

  throw lastError ?? new Error('All providers failed');
}
```

- [ ] **Step 4: Run tests**

Run: `bun test test/services/ai/streaming.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/ai/streaming.ts test/services/ai/streaming.test.ts
git commit -m "feat(ai): add streaming module with multi-provider fallback chain"
```

---

### Task 4: Create completion module

**Files:**
- Create: `src/services/ai/completion.ts`
- Test: `test/services/ai/completion.test.ts`

- [ ] **Step 1: Create completion.ts**

```typescript
// src/services/ai/completion.ts
// Non-streaming AI completion with provider fallback.
// Supports two chains: main (heavy) and light (fast/cheap).

import type OpenAI from 'openai';
import { loadConfig } from '../../config/env.ts';
import { logger } from '../../utils/logger.ts';
import {
  alertProviderBalanceExhausted,
  isBalanceExhausted,
} from '../../utils/ai-provider-alert.ts';
import { isRetryableError, getBackoffDelay } from './streaming.ts';
import { zaiClient, hfClient, geminiClient } from './clients.ts';

const aiLogger = logger.child({ module: 'ai-completion' });

// ── Types ──────────────────────────────────────────────────────────────────

export type ChatMessage = OpenAI.ChatCompletionMessageParam;

export interface CompletionOptions {
  messages: ChatMessage[];
  maxTokens: number;
  temperature?: number;
  light?: boolean;
  tools?: OpenAI.ChatCompletionTool[];
  signal?: AbortSignal;
}

export interface ToolCallResult {
  id: string;
  name: string;
  arguments: string;
}

export interface CompletionResult {
  text: string;
  finishReason: string | null;
  model: string;
  toolCalls?: ToolCallResult[];
}

// ── Provider slots ─────────────────────────────────────────────────────────

interface ModelSlot {
  name: string;
  call: (opts: CompletionOptions) => Promise<CompletionResult>;
}

function callProvider(getClient: () => OpenAI, model: string): ModelSlot['call'] {
  return async (opts) => {
    const params: OpenAI.ChatCompletionCreateParamsNonStreaming = {
      model,
      messages: opts.messages,
      max_tokens: opts.maxTokens,
      temperature: opts.temperature ?? 0.3,
    };
    if (opts.tools && opts.tools.length > 0) {
      params.tools = opts.tools;
    }

    const response = await getClient().chat.completions.create(params, { signal: opts.signal });
    const choice = response.choices[0];
    const text = choice?.message?.content?.trim() ?? '';
    const toolCalls = choice?.message?.tool_calls?.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
    }));

    return {
      text,
      finishReason: choice?.finish_reason ?? null,
      model: `${model}`,
      toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
    };
  };
}

// ── Chains ──────────────────────────────────────────────────────────────────

// No z.ai in completion chains — coding endpoint doesn't produce text content
// for non-tool responses (only reasoning_content).
function buildCompletionChain(): ModelSlot[] {
  return [
    { name: 'Gemini 2.5 Pro', call: callProvider(geminiClient, 'gemini-2.5-pro') },
    { name: 'HF Qwen3-235B', call: callProvider(hfClient, 'Qwen/Qwen3-235B-A22B') },
  ];
}

function buildLightChain(): ModelSlot[] {
  return [
    { name: 'Gemini 2.5 Flash', call: callProvider(geminiClient, 'gemini-2.5-flash') },
    { name: 'HF Llama-3.3-70B', call: callProvider(hfClient, 'meta-llama/Llama-3.3-70B-Instruct') },
  ];
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Run a chat completion with automatic provider fallback.
 *
 * Completion chain: Gemini 2.5 Pro → HF Qwen3-235B
 * Light chain:      Gemini 2.5 Flash → HF Llama-3.3-70B
 *
 * On 5xx / timeout / balance exhausted the current model is abandoned immediately.
 */
export async function aiComplete(options: CompletionOptions): Promise<CompletionResult> {
  const chain = options.light ? buildLightChain() : buildCompletionChain();
  let lastError: Error | null = null;

  for (const slot of chain) {
    try {
      aiLogger.info(`Trying ${slot.name}`);
      return await slot.call(options);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      aiLogger.error({ err: lastError }, `${slot.name} failed`);

      if (isBalanceExhausted(error)) {
        alertProviderBalanceExhausted(slot.name, lastError.message);
        continue;
      }

      if (isRetryableError(error)) {
        aiLogger.warn(`${slot.name} is down, trying next provider`);
        continue;
      }

      throw error;
    }
  }

  throw lastError ?? new Error('All providers failed');
}
```

- [ ] **Step 2: Write test**

```typescript
// test/services/ai/completion.test.ts
import { describe, expect, test } from 'bun:test';
// Basic smoke test — integration tests will cover the real chains
// Unit test focuses on chain logic with mocked providers

describe('aiComplete', () => {
  test('module exports aiComplete function', async () => {
    const mod = await import('../../src/services/ai/completion.ts');
    expect(typeof mod.aiComplete).toBe('function');
  });
});
```

- [ ] **Step 3: Run test**

Run: `bun test test/services/ai/completion.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/services/ai/completion.ts test/services/ai/completion.test.ts
git commit -m "feat(ai): add completion module with main/light provider chains"
```

---

### Task 5: Convert tool definitions to OpenAI format

**Files:**
- Modify: `src/services/ai/tools.ts`

- [ ] **Step 1: Replace Anthropic tool type with OpenAI format**

At top of file, replace:
```typescript
import type Anthropic from '@anthropic-ai/sdk';
type ToolDefinition = Anthropic.Tool;
```
With:
```typescript
import type OpenAI from 'openai';
type ToolDefinition = OpenAI.ChatCompletionTool;
```

- [ ] **Step 2: Wrap each tool in OpenAI format**

Each tool changes from:
```typescript
{
  name: 'get_events',
  description: '...',
  input_schema: { type: 'object', properties: {...}, required: [...] },
}
```
To:
```typescript
{
  type: 'function',
  function: {
    name: 'get_events',
    description: '...',
    parameters: { type: 'object', properties: {...}, required: [...] },
  },
}
```

This is a mechanical transformation: every `input_schema` → `parameters`, every tool wrapped in `{ type: 'function', function: { ... } }`.

Use a search-and-replace approach. There are 60+ tools — all follow the same pattern.

- [ ] **Step 3: Update getToolDefinitions return type**

The function signature should return `OpenAI.ChatCompletionTool[]`.

- [ ] **Step 4: Run tsc to verify types**

Run: `tsc --noEmit 2>&1 | grep tools.ts`
Expected: No errors from tools.ts

- [ ] **Step 5: Commit**

```bash
git add src/services/ai/tools.ts
git commit -m "refactor(tools): convert tool definitions from Anthropic to OpenAI format"
```

---

### Task 6: Rewrite agent.ts streaming loop

**Files:**
- Modify: `src/services/ai/agent.ts`

This is the biggest change. The agent loop switches from:
- `client.messages.stream()` → `aiStreamRound()`
- `Anthropic.ContentBlockParam[]` / `Anthropic.ToolResultBlockParam[]` → `OpenAI.ChatCompletionMessageParam`
- `stream.finalMessage()` → `StreamRoundResult.toolCalls` + `StreamRoundResult.assistantMessage`

- [ ] **Step 1: Replace imports**

Remove:
```typescript
import type Anthropic from '@anthropic-ai/sdk';
import { createAnthropicClient } from './anthropic-client.ts';
```

Add:
```typescript
import type OpenAI from 'openai';
import { aiStreamRound, type StreamCallbacks, type StreamRoundResult } from './streaming.ts';
import { aiComplete } from './completion.ts';
```

- [ ] **Step 2: Replace MessageParam type**

Replace:
```typescript
interface MessageParam {
  role: 'user' | 'assistant';
  content: string | Anthropic.ContentBlockParam[];
}
```
With:
```typescript
type MessageParam = OpenAI.ChatCompletionMessageParam;
```

- [ ] **Step 3: Remove client fields from CalendarBotAgent**

Remove these class fields:
```typescript
private client: Anthropic;
private fallbackClient: Anthropic | null;
private model: string;
private fallbackModel: string | null;
private validationModel: string | null;
```

Replace with:
```typescript
private validationEnabled: boolean;
```

Update constructor:
```typescript
constructor(config: AgentConfig, sender: TelegramSender) {
  this.validationEnabled = config.validationModel !== undefined;
  this.sender = sender;
  this.debugLogger = config.debugLogger;
}
```

- [ ] **Step 4: Update buildMessages to use OpenAI format**

Messages become `OpenAI.ChatCompletionMessageParam[]`. System prompt goes as first message with `role: 'system'` instead of separate `system` parameter.

History messages map to `{ role: 'user' | 'assistant', content: string }`.

- [ ] **Step 5: Rewrite the main streaming loop**

Replace the current loop body (lines 253-479) with:

```typescript
for (let round = 0; round < MAX_ROUNDS; round++) {
  dbg?.logRound(round);

  if (Date.now() - startTime > TIMEOUT_MS) {
    aiLogger.warn({ userId: ctx.user.telegram_id }, 'Agent timeout');
    writer.appendText('\n\n⚠️ Timeout reached.');
    break;
  }

  const callbacks: StreamCallbacks = {
    onTextDelta: (text) => {
      writer.appendText(text);
      writer.flush(false).catch(() => {});
    },
    onToolCallStart: (name) => {
      writer.setToolLabel(name);
      writer.flush(true).catch(() => {});
    },
  };

  const result = await aiStreamRound(
    {
      messages: currentMessages,
      tools: getToolDefinitions(ctx.inputMode, caps, ctx.supplementMode),
      maxTokens: 4096,
      temperature: 0.3,
      signal: AbortSignal.timeout(TIMEOUT_MS - (Date.now() - startTime)),
    },
    callbacks,
  );

  dbg?.logAiText(result.text);

  if (result.toolCalls.length === 0) {
    aiLogger.info(
      { userId: ctx.user.telegram_id, chatId: ctx.chatId, round, textPreview: result.text.slice(0, 300) },
      'AI text-only response (no tool calls)',
    );
    break;
  }

  // Execute tools
  const toolResultMessages: OpenAI.ChatCompletionMessageParam[] = [];

  for (const tc of result.toolCalls) {
    const input = JSON.parse(tc.arguments);

    aiLogger.info({ tool: tc.name, input, userId: ctx.user.telegram_id, chatId: ctx.chatId }, 'Tool call');
    dbg?.logToolCall(tc.name, input);

    writer.setToolLabel(tc.name, input);
    await writer.flush(true);

    const toolResult = await executeTool(ctx, tc.name, input);

    writer.markToolResult(toolResult.success);
    aiLogger.info(
      { tool: tc.name, success: toolResult.success, ...(!toolResult.success && { error: toolResult.error ?? toolResult.output ?? 'Unknown error' }), userId: ctx.user.telegram_id, chatId: ctx.chatId },
      'Tool result',
    );
    dbg?.logToolResult(tc.name, toolResult.success, toolResult.output, toolResult.error);

    allToolCalls.push({ name: tc.name, input });
    allToolResults.push({ success: toolResult.success, output: toolResult.output });

    const content = toolResult.success
      ? `${toolResult.output ?? 'OK'}${toolResult.agentHint ? `\n[AGENT: ${toolResult.agentHint}]` : ''}`
      : `Error: ${toolResult.error ?? toolResult.output ?? 'Unknown error'}`;

    toolResultMessages.push({
      role: 'tool',
      tool_call_id: tc.id,
      content,
    });

    if (toolResult.stopLoop) {
      writer.clearToolLabel();
      writer.commitIntermediate();
      await writer.finalize();
      dbg?.logFinal(writer.getText().trim(), allToolCalls.length);
      dbg?.flush();
      return {
        responseText: ctx.inputMode !== 'text' ? writer.getPlainText() : writer.getText(),
        toolCalls: allToolCalls,
        toolResults: allToolResults,
        endCall: ctx.callEndRequested === true,
      };
    }
  }

  // [SKIP] in a round with tool calls
  if (isSkipText(writer.getText())) {
    await writer.discard();
    dbg?.logFinal('[SKIP] (mid-loop discard)', allToolCalls.length);
    dbg?.flush();
    return { responseText: '', toolCalls: allToolCalls, toolResults: allToolResults };
  }

  writer.clearToolLabel();
  writer.commitIntermediate();

  // Append assistant message + tool results for next round
  currentMessages = [
    ...currentMessages,
    result.assistantMessage,
    ...toolResultMessages,
  ];
}
```

Key differences from old code:
- No `finalMessage()` — tool calls come from `StreamRoundResult`
- Tool results use `role: 'tool'` with `tool_call_id` (OpenAI format), not `role: 'user'` with content blocks
- No `Anthropic.ContentBlockParam[]` or `Anthropic.ToolResultBlockParam[]`
- No manual primary/fallback retry — `aiStreamRound()` handles the chain
- System prompt passed as first message, not separate `system` parameter

- [ ] **Step 6: Update response validation**

Replace:
```typescript
const validation = await validateResponse(this.client, this.validationModel, {...});
```
With:
```typescript
const validation = await validateResponse({...});
```

(The validator will use `aiComplete({ light: true })` — see Task 7)

- [ ] **Step 7: Update runRetryLoop to use aiStreamRound**

Rewrite `runRetryLoop()` similarly — replace `this.client.messages.stream()` with `aiStreamRound()`, and use OpenAI message format for tool results.

- [ ] **Step 8: Update buildMessages for system prompt as first message**

In OpenAI format, system prompt is a message:
```typescript
const systemMessage: OpenAI.ChatCompletionMessageParam = {
  role: 'system',
  content: systemPrompt,
};
const messages: OpenAI.ChatCompletionMessageParam[] = [systemMessage, ...historyMessages, userMessage];
```

- [ ] **Step 9: Run existing agent tests**

Run: `bun test test/services/ai/`
Fix any test failures related to the new API.

- [ ] **Step 10: Commit**

```bash
git add src/services/ai/agent.ts
git commit -m "refactor(agent): rewrite streaming loop to use aiStreamRound with OpenAI SDK"
```

---

### Task 7: Update response-validator.ts

**Files:**
- Modify: `src/services/ai/response-validator.ts`

- [ ] **Step 1: Replace Anthropic SDK with aiComplete**

Replace entire file — remove `Anthropic` import, use `aiComplete`:

```typescript
// src/services/ai/response-validator.ts
import { logger } from '../../utils/logger.ts';
import { aiComplete } from './completion.ts';

const aiLogger = logger.child({ module: 'response-validator' });

const VALIDATION_TIMEOUT_MS = 15_000;
const VALIDATION_MAX_TOKENS = 256;

const VALIDATION_PROMPT = `...`; // Keep existing prompt unchanged

interface ValidationInput {
  userMessage: string;
  toolCalls: string[];
  response: string;
}

export type ValidationResult = { approved: true } | { approved: false; reason: string };

export async function validateResponse(input: ValidationInput): Promise<ValidationResult> {
  const toolCallsSummary = input.toolCalls.length > 0
    ? input.toolCalls.join(', ')
    : '(none — no tools were called)';

  const userContent = `USER MESSAGE: ${input.userMessage}\n\nTOOL CALLS MADE: ${toolCallsSummary}\n\nASSISTANT RESPONSE (first 2000 chars):\n${input.response.substring(0, 2000)}`;

  try {
    const result = await aiComplete({
      messages: [
        { role: 'system', content: VALIDATION_PROMPT },
        { role: 'user', content: userContent },
      ],
      maxTokens: VALIDATION_MAX_TOKENS,
      light: true,
      signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS),
    });

    const text = result.text.trim();
    aiLogger.info({ result: text }, 'Response validation result');

    if (text.startsWith('APPROVE')) return { approved: true };

    const reason = text.replace(/^REJECT:\s*/i, '').trim() || 'Validation failed';
    return { approved: false, reason };
  } catch (err) {
    aiLogger.error({ err }, 'Response validation failed');
    if (input.toolCalls.length === 0) {
      return { approved: false, reason: 'Validator unavailable and no tools were called — likely hallucination' };
    }
    return { approved: true };
  }
}
```

- [ ] **Step 2: Update call site in agent.ts**

Change from:
```typescript
const validation = await validateResponse(this.client, this.validationModel, { ... });
```
To:
```typescript
const validation = await validateResponse({ ... });
```

- [ ] **Step 3: Run tests**

Run: `bun test test/services/ai/`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/services/ai/response-validator.ts src/services/ai/agent.ts
git commit -m "refactor(validator): switch response validator to aiComplete with light chain"
```

---

### Task 8: Migrate intent-learner.ts

**Files:**
- Modify: `src/services/intent/intent-learner.ts`

- [ ] **Step 1: Replace raw fetch with aiComplete**

In `callLearnerAI()`, replace the `fetch()` block (lines 158-172) with:

```typescript
import { aiComplete } from '../ai/completion.ts';

// Inside callLearnerAI:
const result = await aiComplete({
  messages: [
    { role: 'system', content: LEARNER_SYSTEM_PROMPT },
    ...conversationMessages,
  ],
  maxTokens: 2048,
  light: true,
});

const text = result.text;
if (!text) return null;
if (result.finishReason === 'length') {
  cmdLogger.warn('IntentLearner response truncated (max_tokens), skipping');
  return null;
}
```

- [ ] **Step 2: Remove Anthropic-specific config fields**

Remove `baseUrl`, `apiKey`, `model` from the IntentLearner config — it now uses `aiComplete()` which handles provider selection internally.

The config becomes just `{ dailyLimit, intentRepo, adminId }`.

- [ ] **Step 3: Remove the Anthropic response schema parse**

The `anthropicResponseSchema` Zod schema (line 178) is no longer needed — `aiComplete()` already returns `{ text, finishReason }`.

- [ ] **Step 4: Update call sites**

Find everywhere IntentLearner is constructed and remove `baseUrl`, `apiKey`, `model` from the config.

- [ ] **Step 5: Run tests**

Run: `bun test test/services/intent/`
Expected: PASS (update mocks if needed)

- [ ] **Step 6: Commit**

```bash
git add src/services/intent/intent-learner.ts
git commit -m "refactor(intent-learner): replace raw Anthropic fetch with aiComplete"
```

---

### Task 9: Migrate city-resolver.ts and tts-translation.ts

**Files:**
- Modify: `src/services/timezone/city-resolver.ts`
- Modify: `src/services/voice/tts-translation.ts`

- [ ] **Step 1: Update city-resolver.ts**

Replace:
```typescript
import { createAnthropicClient } from '../ai/anthropic-client.ts';
// ...
const client = createAnthropicClient();
const response = await client.messages.create({
  model: model ?? 'claude-haiku-4-5-20251001',
  max_tokens: 10,
  system: SYSTEM_PROMPT,
  messages: [{ role: 'user', content: ... }],
});
const text = response.content[0]?.type === 'text' ? response.content[0].text.trim() : '';
```

With:
```typescript
import { aiComplete } from '../ai/completion.ts';
// ...
const result = await aiComplete({
  messages: [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: ... },
  ],
  maxTokens: 10,
  light: true,
});
const text = result.text;
```

Remove the `model` parameter from `resolveCity()` — model selection is now internal.

- [ ] **Step 2: Update tts-translation.ts**

Replace the `TtsTranslationService` class — it stored an Anthropic client instance. Simplify to use `aiComplete()`:

```typescript
import { aiComplete } from '../ai/completion.ts';

export class TtsTranslationService {
  private cache = new Map<string, string>();

  async translate(text: string, targetLang: string): Promise<string> {
    const cached = this.cache.get(text);
    if (cached) return cached;

    const result = await aiComplete({
      messages: [
        { role: 'system', content: `Translate to ${targetLang}. Return ONLY the translation.` },
        { role: 'user', content: text },
      ],
      maxTokens: 1024,
      light: true,
    });

    const translated = result.text.trim();
    this.cache.set(text, translated);
    return translated;
  }

  clearCache(): void {
    this.cache.clear();
  }
}
```

Remove constructor params `apiKey`, `baseUrl`, `model`.

- [ ] **Step 3: Update call sites**

Find where `TtsTranslationService` is constructed and `resolveCity()` is called — remove Anthropic-specific args.

- [ ] **Step 4: Run tests**

Run: `bun test test/services/timezone/ test/services/voice/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/timezone/city-resolver.ts src/services/voice/tts-translation.ts
git commit -m "refactor(ai): migrate city-resolver and tts-translation to aiComplete"
```

---

### Task 10: Update debug-logger.ts types

**Files:**
- Modify: `src/services/ai/debug-logger.ts`

- [ ] **Step 1: Replace Anthropic types**

Replace:
```typescript
import type Anthropic from '@anthropic-ai/sdk';
type ContentBlock = Anthropic.ContentBlockParam;
```

With:
```typescript
import type OpenAI from 'openai';
type ContentBlock = OpenAI.ChatCompletionMessageParam;
```

Update `serializeContent()` to handle OpenAI message format:

```typescript
function serializeContent(content: string | OpenAI.ChatCompletionMessageParam): string {
  if (typeof content === 'string') return content;
  if (typeof content.content === 'string') return content.content;
  if (Array.isArray(content.content)) {
    return content.content.map((p) => ('text' in p ? p.text : `[${p.type}]`)).join(' ');
  }
  return JSON.stringify(content).slice(0, 500);
}
```

Update `DebugMessage` interface similarly.

- [ ] **Step 2: Update agent.ts calls to debug logger**

Ensure `saveAssistantTurn()` and `saveToolResults()` pass OpenAI-format messages.

- [ ] **Step 3: Run tests**

Run: `bun test test/services/ai/`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/services/ai/debug-logger.ts
git commit -m "refactor(debug-logger): update types from Anthropic to OpenAI format"
```

---

### Task 11: Update AgentConfig and index.ts wiring

**Files:**
- Modify: `src/services/ai/types.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Simplify AgentConfig**

In `types.ts`, the current `AgentConfig` has Anthropic-specific fields. Simplify:

```typescript
export interface AgentConfig {
  validationModel?: string;  // keep for enable/disable validation
  debugLogger?: AiDebugLogger;
}
```

Remove: `apiKey`, `baseUrl`, `model`, `fallback`.

- [ ] **Step 2: Update index.ts**

Remove all Anthropic client creation, fallback client setup. The agent no longer needs API keys — `aiStreamRound()` and `aiComplete()` handle providers internally.

Remove imports of `createAnthropicClient`. Remove env var references to `AI_BASE_URL`, `AI_MODEL_FALLBACK`, etc.

- [ ] **Step 3: Run full test suite**

Run: `bun test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/services/ai/types.ts src/index.ts
git commit -m "refactor(config): simplify AgentConfig, remove Anthropic client wiring from index"
```

---

### Task 12: Delete anthropic-client.ts and remove @anthropic-ai/sdk

**Files:**
- Delete: `src/services/ai/anthropic-client.ts`
- Modify: `package.json`

- [ ] **Step 1: Verify no remaining imports**

Run: `grep -r "anthropic-client" src/` — should return no results.
Run: `grep -r "@anthropic-ai/sdk" src/` — should return no results.
Run: `grep -r "Anthropic" src/ --include="*.ts"` — should return no results.

- [ ] **Step 2: Delete the file**

```bash
rm src/services/ai/anthropic-client.ts
```

- [ ] **Step 3: Remove the dependency**

```bash
bun remove @anthropic-ai/sdk
```

- [ ] **Step 4: Run full test suite + tsc**

Run: `tsc --noEmit && bun test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: remove @anthropic-ai/sdk, delete anthropic-client.ts"
```

---

### Task 13: Integration test — run test-ai-chains.ts

**Files:**
- Modify: `scripts/test-ai-chains.ts`

- [ ] **Step 1: Update test script to use the new modules**

Import `aiStreamRound` and `aiComplete` from the actual modules and run them:

```typescript
import { aiStreamRound } from '../src/services/ai/streaming.ts';
import { aiComplete } from '../src/services/ai/completion.ts';

// Test streaming
const streamResult = await aiStreamRound({
  messages: [
    { role: 'system', content: 'Reply briefly in Russian.' },
    { role: 'user', content: 'Привет!' },
  ],
  maxTokens: 100,
});
console.log('Stream:', streamResult.text);

// Test completion (main)
const mainResult = await aiComplete({
  messages: [
    { role: 'system', content: 'Reply briefly in Russian.' },
    { role: 'user', content: 'Привет!' },
  ],
  maxTokens: 100,
});
console.log('Main:', mainResult.text);

// Test completion (light)
const lightResult = await aiComplete({
  messages: [
    { role: 'system', content: 'Reply briefly in Russian.' },
    { role: 'user', content: 'Привет!' },
  ],
  maxTokens: 100,
  light: true,
});
console.log('Light:', lightResult.text);
```

- [ ] **Step 2: Run it**

Run: `bun scripts/test-ai-chains.ts`
Expected: All three calls succeed with Russian text responses.

- [ ] **Step 3: Commit**

```bash
git add scripts/test-ai-chains.ts
git commit -m "test: update integration test script for new AI chain modules"
```

---

### Task 14: Final verification

- [ ] **Step 1: Run full test suite with coverage**

Run: `bun test --coverage`
Expected: All tests pass, coverage ≥ 80%

- [ ] **Step 2: Run linter**

Run: `bun run lint`
Expected: No warnings, no errors

- [ ] **Step 3: Run tsc**

Run: `tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Run knip**

Run: `bunx knip`
Expected: No unused exports related to the migration

- [ ] **Step 5: Final commit if any fixups needed**
