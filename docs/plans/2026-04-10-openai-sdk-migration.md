# OpenAI SDK Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Anthropic SDK with OpenAI SDK and add multi-provider fallback chains for reliability.

**Architecture:** Single unified streaming API `aiStreamRound()` backed by provider chains. Callbacks are optional — services without UI (validator, intent-learner, city-resolver, tts-translation) call it without callbacks and collect the full result. Two chains: main (heavy tool calling) and light (cheap/fast internal calls) selected via `{ fast: true }` option. All providers use OpenAI SDK with different `baseURL` (z.ai coding endpoint, HF router, Gemini OpenAI-compat). All base URLs and models are loaded from env — no hardcoded values.

**Chains:**
- `SMART_CHAIN = z.ai ${AI_MODEL} → Gemini ${GEMINI_MODEL} → HF ${HF_MODEL}`
- `FAST_CHAIN = z.ai ${AI_FAST_MODEL} → Gemini ${GEMINI_FAST_MODEL} → HF ${HF_FAST_MODEL}`

**Defaults (via env):**
- `AI_BASE_URL=https://api.z.ai/api/coding/paas/v4`, `AI_MODEL=glm-5.1`, `AI_FAST_MODEL=glm-4.5-flash`
- `HF_BASE_URL=https://router.huggingface.co/v1`, `HF_MODEL=Qwen/Qwen3-235B-A22B`, `HF_FAST_MODEL=meta-llama/Llama-3.3-70B-Instruct`
- `GEMINI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/`, `GEMINI_MODEL=gemini-2.5-pro`, `GEMINI_FAST_MODEL=gemini-2.5-flash`

**z.ai coding endpoint quirk:** Returns `content: ''` and populates `reasoning_content` for text-only responses (no tool calls). Tool calling works fine. Post-tool-result rounds also return proper `content`. Strategy: if z.ai returns 200 with empty text AND no tool calls, treat as provider failure → fall through to Gemini. This only affects pure text responses (greetings, [SKIP]), which are fine handled by Gemini.

**Tech Stack:** `openai` npm package (replacing `@anthropic-ai/sdk`), Bun runtime.

---

## File Structure

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/services/ai/clients.ts` | OpenAI client instances for z.ai, HF, Gemini — all reading base URLs from env |
| Create | `src/services/ai/streaming.ts` | `aiStreamRound()` — single unified API with provider fallback, supports both streaming (with callbacks) and collection (without callbacks); `fast?: boolean` selects chain |
| Modify | `src/services/ai/agent.ts` | Rewrite streaming loop to use `aiStreamRound()` |
| Modify | `src/services/ai/tools.ts` | Convert `input_schema` → `parameters`, wrap in `{type:'function', function:{...}}` |
| Modify | `src/services/ai/types.ts` | Simplify `AgentConfig`, remove Anthropic deps |
| Modify | `src/services/ai/response-validator.ts` | Switch to `aiStreamRound({fast: true})` |
| Modify | `src/services/ai/debug-logger.ts` | Replace `Anthropic.ContentBlockParam` with OpenAI types |
| Modify | `src/services/ai/tool-executor.ts` | No functional changes (already SDK-agnostic) |
| Modify | `src/services/intent/intent-learner.ts` | Replace raw `fetch()` with `aiStreamRound()` — **smart chain**, intent extraction needs quality |
| Modify | `src/services/timezone/city-resolver.ts` | Replace SDK call with `aiStreamRound({fast: true})` |
| Modify | `src/services/voice/tts-translation.ts` | Replace SDK call with `aiStreamRound({fast: true})` |
| Modify | `src/config/env.ts` | Add `HF_BASE_URL`, `HF_MODEL`, `HF_FAST_MODEL`, `GEMINI_API_KEY`, `GEMINI_BASE_URL`, `GEMINI_MODEL`, `GEMINI_FAST_MODEL`. Remove old fallback vars. All AI-related vars become **required**. |
| Modify | `.env.example` | Add all new env vars with documentation |
| Modify | `.env` | Add new vars with real values (keys from ExpenseSyncBot where applicable) |
| Modify | `src/index.ts` | Simplify — no more Anthropic client wiring, AgentConfig loses apiKey/baseUrl/model |
| Modify | `src/utils/ai-provider-alert.ts` | Already created — wired into streaming |
| Delete | `src/services/ai/anthropic-client.ts` | Replaced by `clients.ts` |
| Remove dep | `@anthropic-ai/sdk` | No longer needed |

---

### Task 1: Environment config — add new provider keys (all required)

**Files:**
- Modify: `src/config/env.ts`
- Modify: `.env.example`
- Modify: `.env`

- [ ] **Step 1: Update EnvConfig interface**

In `src/config/env.ts`, update the `EnvConfig` interface:

```typescript
export interface EnvConfig {
  BOT_TOKEN: string;
  DATABASE_PATH: string;
  NODE_ENV: 'development' | 'production';

  // AI primary provider (z.ai coding endpoint)
  ANTHROPIC_API_KEY: string;  // keep name — it's the z.ai key
  AI_BASE_URL: string;
  AI_MODEL: string;
  AI_FAST_MODEL: string;

  // HuggingFace Router (fallback)
  HF_TOKEN: string;           // was optional, now required
  HF_BASE_URL: string;
  HF_MODEL: string;
  HF_FAST_MODEL: string;

  // Google Gemini (fallback)
  GEMINI_API_KEY: string;
  GEMINI_BASE_URL: string;
  GEMINI_MODEL: string;
  GEMINI_FAST_MODEL: string;

  REDIS_URL?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string;
  OAUTH_SERVER_PORT?: number;
  ENCRYPTION_KEY?: string;
  PUBLIC_DOMAIN?: string;
  BOT_USERNAME?: string;
  MTPROTO_API_ID?: number;
  MTPROTO_API_HASH?: string;
  GROQ_API_KEY?: string;
  BOT_ADMIN_ID?: number;
  INTENT_LEARNER_DAILY_LIMIT: number;
  INLINE_BOT_TOKEN?: string;
  INLINE_BOT_USERNAME?: string;
  AGENT_JWT_SECRET?: string;
  AGENT_DOWNLOAD_URL?: string;
  SILERO_PYTHON_PATH?: string;
  DEEPGRAM_API_KEY?: string;
  DISABLE_VOICE?: boolean;
  AI_DEBUG_LOGS?: boolean;
  ADMIN_ALERT_TOKEN?: string;
  OPENWEATHER_API_KEY?: string;
}
```

Remove: `AI_MODEL_FALLBACK`, `AI_BASE_URL_FALLBACK`, `AI_API_KEY_FALLBACK` (dead code from old fallback logic).

- [ ] **Step 2: Helper for required env vars**

Add a helper near the top of `loadConfig()`:

```typescript
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} environment variable is required`);
  return value;
}
```

- [ ] **Step 3: Update loadConfig()**

Replace the return object to use `requireEnv()` for all AI vars:

```typescript
return {
  BOT_TOKEN,
  DATABASE_PATH: process.env.DATABASE_PATH || './data/calendar.db',
  NODE_ENV: (process.env.NODE_ENV as EnvConfig['NODE_ENV']) || 'development',

  // AI primary (z.ai)
  ANTHROPIC_API_KEY: requireEnv('ANTHROPIC_API_KEY'),
  AI_BASE_URL: requireEnv('AI_BASE_URL'),
  AI_MODEL: requireEnv('AI_MODEL'),
  AI_FAST_MODEL: requireEnv('AI_FAST_MODEL'),

  // HuggingFace
  HF_TOKEN: requireEnv('HF_TOKEN'),
  HF_BASE_URL: requireEnv('HF_BASE_URL'),
  HF_MODEL: requireEnv('HF_MODEL'),
  HF_FAST_MODEL: requireEnv('HF_FAST_MODEL'),

  // Gemini
  GEMINI_API_KEY: requireEnv('GEMINI_API_KEY'),
  GEMINI_BASE_URL: requireEnv('GEMINI_BASE_URL'),
  GEMINI_MODEL: requireEnv('GEMINI_MODEL'),
  GEMINI_FAST_MODEL: requireEnv('GEMINI_FAST_MODEL'),

  // ... rest unchanged
};
```

Remove the old `ANTHROPIC_API_KEY` check (it's now handled by `requireEnv`).

- [ ] **Step 4: Update .env.example**

```env
BOT_TOKEN=your_bot_token

# AI primary — z.ai coding endpoint (GLM 5.1 via OpenAI-compat API)
ANTHROPIC_API_KEY=your_zai_api_key
AI_BASE_URL=https://api.z.ai/api/coding/paas/v4
AI_MODEL=glm-5.1
AI_FAST_MODEL=glm-4.5-flash

# HuggingFace Router (fallback, tool calling capable)
HF_TOKEN=your_hf_token
HF_BASE_URL=https://router.huggingface.co/v1
HF_MODEL=Qwen/Qwen3-235B-A22B
HF_FAST_MODEL=meta-llama/Llama-3.3-70B-Instruct

# Google Gemini (fallback, tool calling capable)
GEMINI_API_KEY=your_gemini_api_key
GEMINI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/
GEMINI_MODEL=gemini-2.5-pro
GEMINI_FAST_MODEL=gemini-2.5-flash

# All AI provider fields above are REQUIRED — no hardcoded defaults.
```

- [ ] **Step 5: Update .env**

Add the real values:

```env
AI_BASE_URL=https://api.z.ai/api/coding/paas/v4
AI_MODEL=glm-5.1
AI_FAST_MODEL=glm-4.5-flash

HF_BASE_URL=https://router.huggingface.co/v1
HF_MODEL=Qwen/Qwen3-235B-A22B
HF_FAST_MODEL=meta-llama/Llama-3.3-70B-Instruct

GEMINI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/
GEMINI_MODEL=gemini-2.5-pro
GEMINI_FAST_MODEL=gemini-2.5-flash
```

(`HF_TOKEN` and `GEMINI_API_KEY` already present.)

- [ ] **Step 6: Update tests that mock env**

Run `bun test` and fix any test that mocks config to add the new required fields (or use a shared test helper to build a complete config).

- [ ] **Step 7: Commit**

```bash
git add src/config/env.ts .env.example .env
git commit -m "refactor(env): require all provider fields, add HF/Gemini base URLs and models"
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
// Base URLs are loaded from env — no hardcoded values.

import OpenAI from 'openai';
import { loadConfig } from '../../config/env.ts';

const DEFAULT_TIMEOUT_MS = 60_000;

let _zai: OpenAI | null = null;
let _hf: OpenAI | null = null;
let _gemini: OpenAI | null = null;

export function zaiClient(): OpenAI {
  if (!_zai) {
    const cfg = loadConfig();
    _zai = new OpenAI({
      apiKey: cfg.ANTHROPIC_API_KEY,
      baseURL: cfg.AI_BASE_URL,
      timeout: DEFAULT_TIMEOUT_MS,
      maxRetries: 0,
    });
  }
  return _zai;
}

export function hfClient(): OpenAI {
  if (!_hf) {
    const cfg = loadConfig();
    _hf = new OpenAI({
      apiKey: cfg.HF_TOKEN,
      baseURL: cfg.HF_BASE_URL,
      timeout: DEFAULT_TIMEOUT_MS,
      maxRetries: 0,
    });
  }
  return _hf;
}

export function geminiClient(): OpenAI {
  if (!_gemini) {
    const cfg = loadConfig();
    _gemini = new OpenAI({
      apiKey: cfg.GEMINI_API_KEY,
      baseURL: cfg.GEMINI_BASE_URL,
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
git commit -m "feat(ai): add OpenAI SDK client factories for z.ai, HF, Gemini"
```

---

### Task 3: Create unified streaming module

**Files:**
- Create: `src/services/ai/streaming.ts`
- Test: `test/services/ai/streaming.test.ts`

- [ ] **Step 1: Write test for error helpers**

```typescript
// test/services/ai/streaming.test.ts
import { describe, expect, test } from 'bun:test';
import OpenAI from 'openai';
import { getBackoffDelay, isRetryableError } from '../../src/services/ai/streaming.ts';

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

  test('returns true for network timeout', () => {
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
// Unified AI streaming round with automatic provider fallback.
//
// Two chains, selected via options.fast:
//   SMART_CHAIN (main): z.ai ${AI_MODEL}      → Gemini ${GEMINI_MODEL}      → HF ${HF_MODEL}
//   FAST_CHAIN:            z.ai ${AI_FAST_MODEL} → Gemini ${GEMINI_FAST_MODEL} → HF ${HF_FAST_MODEL}
//
// Callers that need live updates (agent.ts) pass `onTextDelta`/`onToolCallStart` callbacks.
// Callers that just want the final text (validator, intent-learner, etc.) omit callbacks.

import type OpenAI from 'openai';
import { loadConfig } from '../../config/env.ts';
import { alertProviderBalanceExhausted, isBalanceExhausted } from '../../utils/ai-provider-alert.ts';
import { logger } from '../../utils/logger.ts';
import { geminiClient, hfClient, zaiClient } from './clients.ts';

const aiLogger = logger.child({ module: 'ai-stream' });

// ── Types ──────────────────────────────────────────────────────────────────

export interface StreamRoundOptions {
  messages: OpenAI.ChatCompletionMessageParam[];
  tools?: OpenAI.ChatCompletionTool[];
  maxTokens: number;
  temperature?: number;
  /** Use light chain (cheap/fast) instead of main streaming chain. Default: false. */
  fast?: boolean;
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
  /** Which provider slot actually produced the result. */
  providerUsed: string;
}

// ── Error helpers (exported for tests) ─────────────────────────────────────

function isProviderDown(error: unknown): boolean {
  const OpenAI = require('openai').default;
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
  // biome-ignore lint/suspicious/noExplicitAny: duck-typing for error detection
  const status = (error as any)?.status;
  if (typeof status === 'number' && (status === 429 || status >= 500)) return true;
  return false;
}

export function getBackoffDelay(attempt: number, error: unknown): number {
  // biome-ignore lint/suspicious/noExplicitAny: duck-typing
  const anyErr = error as any;
  if (anyErr?.status === 429) {
    const retryAfter = anyErr?.headers?.['retry-after'];
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

/** Standard OpenAI streaming adapter (works for z.ai, Gemini, HF when supported). */
function streamingSlot(name: string, getClient: () => OpenAI, model: string): ProviderSlot {
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

      // z.ai coding endpoint returns content='' and only reasoning_content for
      // pure text responses (no tools). If we got 200 OK but nothing usable,
      // treat as provider failure so the chain falls through.
      if (!text && toolCallsArray.length === 0) {
        throw new Error('Provider returned empty response (likely coding endpoint reasoning-only path)');
      }

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

      return { text, toolCalls: toolCallsArray, finishReason, assistantMessage, providerUsed: name };
    },
  };
}

// ── Chains ─────────────────────────────────────────────────────────────────

function buildSmartChain(): ProviderSlot[] {
  const cfg = loadConfig();
  return [
    streamingSlot(`z.ai (${cfg.AI_MODEL})`, zaiClient, cfg.AI_MODEL),
    streamingSlot(`Gemini (${cfg.GEMINI_MODEL})`, geminiClient, cfg.GEMINI_MODEL),
    streamingSlot(`HF (${cfg.HF_MODEL})`, hfClient, cfg.HF_MODEL),
  ];
}

function buildFastChain(): ProviderSlot[] {
  const cfg = loadConfig();
  return [
    streamingSlot(`z.ai (${cfg.AI_FAST_MODEL})`, zaiClient, cfg.AI_FAST_MODEL),
    streamingSlot(`Gemini (${cfg.GEMINI_FAST_MODEL})`, geminiClient, cfg.GEMINI_FAST_MODEL),
    streamingSlot(`HF (${cfg.HF_FAST_MODEL})`, hfClient, cfg.HF_FAST_MODEL),
  ];
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Execute one AI round with automatic provider fallback.
 *
 * With callbacks: streams text deltas and tool-call starts to the caller
 * (used by the main agent loop for live Telegram updates).
 *
 * Without callbacks: collects the full result and returns it at the end
 * (used by validator, intent-learner, city-resolver, tts-translation).
 *
 * Chains:
 *   light: false → z.ai ${AI_MODEL}      → Gemini ${GEMINI_MODEL}      → HF ${HF_MODEL}
 *   fast: true  → z.ai ${AI_FAST_MODEL} → Gemini ${GEMINI_FAST_MODEL} → HF ${HF_FAST_MODEL}
 *
 * Fallback rules:
 * - If a provider returns 5xx/timeout/429: try next
 * - If balance exhausted: alert admin, try next
 * - If provider streamed text to the user already: propagate the error (can't splice)
 * - If provider returns 200 OK but empty text AND no tool calls: try next (z.ai quirk)
 * - If 4xx non-429: propagate (client error)
 */
export async function aiStreamRound(
  options: StreamRoundOptions,
  callbacks: StreamCallbacks = {},
): Promise<StreamRoundResult> {
  const chain = options.fast ? buildFastChain() : buildSmartChain();
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

      if (isRetryableError(error) || isBalanceExhausted(error) || lastError.message.includes('empty response')) {
        aiLogger.warn(`${slot.name} failed, trying next provider`);
        continue;
      }

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
git commit -m "feat(ai): add unified aiStreamRound with main + light provider chains"
```

---

### Task 4: Convert tool definitions to OpenAI format

**Files:**
- Modify: `src/services/ai/tools.ts`

- [ ] **Step 1: Replace Anthropic tool type**

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

Mechanical transformation: every `input_schema` → `parameters`, every tool wrapped in `{ type: 'function', function: { ... } }`. There are 60+ tools — all follow the same pattern.

- [ ] **Step 3: Update getToolDefinitions return type**

The function should return `OpenAI.ChatCompletionTool[]`.

- [ ] **Step 4: Verify with tsc**

Run: `tsc --noEmit 2>&1 | grep tools.ts`
Expected: No errors from tools.ts

- [ ] **Step 5: Commit**

```bash
git add src/services/ai/tools.ts
git commit -m "refactor(tools): convert tool definitions from Anthropic to OpenAI format"
```

---

### Task 5: Rewrite agent.ts streaming loop

**Files:**
- Modify: `src/services/ai/agent.ts`

Biggest change. Agent loop switches from:
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
import { aiStreamRound, type StreamCallbacks } from './streaming.ts';
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

- [ ] **Step 3: Simplify CalendarBotAgent class**

Remove client/model/fallback/validationModel fields. The agent no longer holds API state — `aiStreamRound()` handles providers. Validation is always enabled.

```typescript
export class CalendarBotAgent {
  private sender: TelegramSender;
  private debugLogger?: AiDebugLogger;

  constructor(config: AgentConfig, sender: TelegramSender) {
    this.sender = sender;
    this.debugLogger = config.debugLogger;
  }

  getSender(): TelegramSender {
    return this.sender;
  }
  // ...
}
```

- [ ] **Step 4: Rewrite sanitizeMessages for OpenAI format**

OpenAI supports a `tool` role for tool results, but strict alternation is still wanted between user/assistant content rounds. Update:

```typescript
function sanitizeMessages(messages: MessageParam[]): MessageParam[] {
  // OpenAI is more lenient than Anthropic but we still want consistent ordering.
  // Tool messages (role: 'tool') can appear between assistant and next user/assistant.
  // Primary rule: the first non-system message must be 'user'.
  const result: MessageParam[] = [];
  let hasSeenNonSystem = false;
  for (const msg of messages) {
    if (msg.role === 'system') {
      result.push(msg);
      continue;
    }
    if (!hasSeenNonSystem && msg.role !== 'user') {
      result.push({ role: 'user', content: '...' });
    }
    hasSeenNonSystem = true;
    result.push(msg);
  }
  return result;
}
```

- [ ] **Step 5: Update buildMessages to use system message instead of system parameter**

OpenAI uses `role: 'system'` as the first message:

```typescript
const systemMessage: MessageParam = { role: 'system', content: systemPrompt };
const historyMessages: MessageParam[] = chatHistory.map(/* ... */);
const userMessage: MessageParam = { role: 'user', content: ctx.messageText };
const messages: MessageParam[] = sanitizeMessages([systemMessage, ...historyMessages, userMessage]);
```

- [ ] **Step 6: Rewrite the main streaming loop**

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
      signal: AbortSignal.timeout(Math.max(1000, TIMEOUT_MS - (Date.now() - startTime))),
    },
    callbacks,
  );

  aiLogger.info(
    { userId: ctx.user.telegram_id, providerUsed: result.providerUsed, round, toolCount: result.toolCalls.length },
    'Agent round complete',
  );
  dbg?.logAiText(result.text);

  if (result.toolCalls.length === 0) {
    break;
  }

  // Execute tools
  const toolResultMessages: MessageParam[] = [];

  for (const tc of result.toolCalls) {
    let input: { [key: string]: unknown };
    try {
      input = JSON.parse(tc.arguments);
    } catch (err) {
      aiLogger.error({ err, tool: tc.name, arguments: tc.arguments }, 'Failed to parse tool arguments');
      input = {};
    }

    aiLogger.info({ tool: tc.name, input, userId: ctx.user.telegram_id, chatId: ctx.chatId }, 'Tool call');
    dbg?.logToolCall(tc.name, input);

    writer.setToolLabel(tc.name, input);
    await writer.flush(true);

    const toolResult = await executeTool(ctx, tc.name, input);

    writer.markToolResult(toolResult.success);
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

  // [SKIP] mid-loop: discard immediately
  if (isSkipText(writer.getText())) {
    await writer.discard();
    dbg?.logFinal('[SKIP] (mid-loop discard)', allToolCalls.length);
    dbg?.flush();
    return { responseText: '', toolCalls: allToolCalls, toolResults: allToolResults };
  }

  writer.clearToolLabel();
  writer.commitIntermediate();

  currentMessages = [...currentMessages, result.assistantMessage, ...toolResultMessages];
}
```

Key differences from old code:
- No `finalMessage()` — everything comes from `StreamRoundResult`
- Tool results use `role: 'tool'` with `tool_call_id` (OpenAI format)
- No manual primary/fallback retry — `aiStreamRound()` handles the chain
- No `Anthropic.ContentBlockParam[]` anywhere

- [ ] **Step 7: Preserve response validation logic**

After the main loop completes, the agent must validate the response when NO tools were called. This prevents hallucinations (model claiming to have checked the calendar without actually calling `get_events`, etc.).

Validation is **always enabled** — no flag. It uses the light chain via `aiStreamRound({fast: true})` inside `validateResponse()`, so it's cheap.

Add this block right after the `for (let round ...)` loop in `run()`:

```typescript
// Response validation: when no tools were called, verify the response isn't hallucinated.
// Always enabled — cheap via light chain, critical for calendar correctness.
// Skip when tools were NOT available (nothing to validate against) or in supplement mode.
const availableTools = getToolDefinitions(ctx.inputMode, caps, ctx.supplementMode);
if (availableTools.length > 0 && allToolCalls.length === 0 && !ctx.supplementMode) {
  const responseText = writer.getText().trim();
  if (responseText && !isSkipText(responseText)) {
    const validation = await validateResponse({
      userMessage: ctx.messageText,
      toolCalls: allToolCalls.map((tc) => tc.name),
      response: responseText,
    });

    if (!validation.approved) {
      aiLogger.info(
        { userId: ctx.user.telegram_id, reason: validation.reason },
        'Response validation REJECTED — retrying with tools',
      );

      writer.reset();
      allToolCalls.length = 0;
      allToolResults.length = 0;

      const retryMessages: MessageParam[] = [
        ...messages,
        { role: 'assistant', content: responseText },
        {
          role: 'user',
          content: `[SYSTEM] Your previous response was rejected by the quality validator. Reason: ${validation.reason}. You MUST call the appropriate tools and re-answer the question properly. Do NOT repeat the same mistake.`,
        },
      ];

      const retryResult = await this.runRetryLoop(
        ctx,
        retryMessages,
        systemPrompt,
        writer,
        dbg,
        caps,
        allToolCalls,
        allToolResults,
      );
      if (retryResult) return retryResult;
    }
  }
}
```

Note the new `validateResponse()` signature takes only the input object — no client/model params (handled internally).

- [ ] **Step 8: Rewrite runRetryLoop similarly**

Use `aiStreamRound()` instead of `this.client.messages.stream()`, OpenAI message format for tool results.

- [ ] **Step 9: Remove saveToolResults/saveAssistantTurn Anthropic-specific logic**

These currently serialize `Anthropic.ContentBlockParam[]`. Update to serialize OpenAI messages (plain JSON.stringify works for both formats).

- [ ] **Step 10: Run agent tests**

Run: `bun test test/services/ai/`
Fix any test failures related to the new API.

- [ ] **Step 11: Commit**

```bash
git add src/services/ai/agent.ts
git commit -m "refactor(agent): rewrite streaming loop to use aiStreamRound with OpenAI SDK"
```

---

### Task 6: Update response-validator.ts

**Files:**
- Modify: `src/services/ai/response-validator.ts`

- [ ] **Step 1: Replace Anthropic SDK with aiStreamRound**

```typescript
// src/services/ai/response-validator.ts
import { logger } from '../../utils/logger.ts';
import { aiStreamRound } from './streaming.ts';

const aiLogger = logger.child({ module: 'response-validator' });

const VALIDATION_TIMEOUT_MS = 15_000;
const VALIDATION_MAX_TOKENS = 256;

const VALIDATION_PROMPT = `You are a strict QA validator for a calendar assistant bot.
// ... (keep existing prompt unchanged)`;

interface ValidationInput {
  userMessage: string;
  toolCalls: string[];
  response: string;
}

export type ValidationResult = { approved: true } | { approved: false; reason: string };

export async function validateResponse(input: ValidationInput): Promise<ValidationResult> {
  const toolCallsSummary = input.toolCalls.length > 0 ? input.toolCalls.join(', ') : '(none — no tools were called)';

  const userContent = `USER MESSAGE: ${input.userMessage}\n\nTOOL CALLS MADE: ${toolCallsSummary}\n\nASSISTANT RESPONSE (first 2000 chars):\n${input.response.substring(0, 2000)}`;

  try {
    const result = await aiStreamRound({
      messages: [
        { role: 'system', content: VALIDATION_PROMPT },
        { role: 'user', content: userContent },
      ],
      maxTokens: VALIDATION_MAX_TOKENS,
      fast: true,
      signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS),
    });

    const text = result.text.trim();
    aiLogger.info({ result: text, providerUsed: result.providerUsed }, 'Response validation result');

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

Change from `await validateResponse(this.client, this.validationModel, { ... })` to `await validateResponse({ ... })`.

- [ ] **Step 3: Run tests**

Run: `bun test test/services/ai/`

- [ ] **Step 4: Commit**

```bash
git add src/services/ai/response-validator.ts src/services/ai/agent.ts
git commit -m "refactor(validator): switch to aiStreamRound with light chain"
```

---

### Task 7: Migrate intent-learner.ts

**Files:**
- Modify: `src/services/intent/intent-learner.ts`

- [ ] **Step 1: Replace raw fetch with aiStreamRound**

Remove the `fetch()` block (lines 158-172) and the Anthropic response schema. Replace with:

```typescript
import { aiStreamRound } from '../ai/streaming.ts';

// Inside callLearnerAI():
// Uses SMART chain (no fast flag) — intent extraction is a reasoning task
// that benefits from the primary model, not a cheap fast one.
const result = await aiStreamRound({
  messages: [
    { role: 'system', content: LEARNER_SYSTEM_PROMPT },
    ...conversationMessages,
  ],
  maxTokens: 2048,
});

if (result.finishReason === 'length') {
  cmdLogger.warn('IntentLearner response truncated (max_tokens), skipping');
  return null;
}

const text = result.text;
if (!text) return null;
```

- [ ] **Step 2: Remove Anthropic-specific config fields**

Remove `baseUrl`, `apiKey`, `model` from the IntentLearner config — it now uses `aiStreamRound()` which handles provider selection internally.

The config becomes just `{ dailyLimit, intentRepo, adminId }`.

- [ ] **Step 3: Update call sites in index.ts**

Find everywhere IntentLearner is constructed and remove `baseUrl`, `apiKey`, `model` from the config.

- [ ] **Step 4: Remove the anthropicResponseSchema Zod schema**

Lines 178-181 become dead code — delete.

- [ ] **Step 5: Run tests**

Run: `bun test test/services/intent/`

- [ ] **Step 6: Commit**

```bash
git add src/services/intent/intent-learner.ts src/index.ts
git commit -m "refactor(intent-learner): replace raw Anthropic fetch with aiStreamRound"
```

---

### Task 8: Migrate city-resolver.ts and tts-translation.ts

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
import { aiStreamRound } from '../ai/streaming.ts';
// ...
const result = await aiStreamRound({
  messages: [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: ... },
  ],
  maxTokens: 10,
  fast: true,
});
const text = result.text;
```

Remove the `model` parameter from `resolveCity()`.

- [ ] **Step 2: Update tts-translation.ts (with streaming callback)**

Translations for voice calls benefit from streaming — tokens can be fed to the TTS engine
as they arrive, reducing perceived latency. Add an optional `onDelta` callback that the
caller can pipe into the TTS engine. The full translated string is still returned (for
caching and for callers that want the complete text).

```typescript
import { createHash } from 'node:crypto';
import { aiStreamRound } from '../ai/streaming.ts';
import { voiceLogger } from './types';

const MAX_CACHE_ENTRIES = 200;

const SYSTEM_PROMPT = `You are a translator for a voice assistant. Translate the text to {language}.
Output ONLY the translated text with no explanation, no quotes, no markdown.
Preserve proper nouns, times (like "14:00"), and dates exactly as-is.
Use natural spoken language suitable for text-to-speech synthesis.`;

export class TtsTranslationService {
  private cache = new Map<string, string>();

  /**
   * Translate text for TTS synthesis.
   *
   * @param text - source text
   * @param targetLang - target language name (e.g. "Russian", "English")
   * @param onDelta - optional callback fired with each streamed text chunk.
   *                  Use this to feed the TTS engine incrementally for faster
   *                  perceived response in voice calls. On cache hit, the
   *                  callback is called once with the full cached text.
   */
  async translate(
    text: string,
    targetLang: string,
    onDelta?: (chunk: string) => void,
  ): Promise<string> {
    const cacheKey = this.getCacheKey(text, targetLang);
    const cached = this.cache.get(cacheKey);
    if (cached) {
      onDelta?.(cached);
      return cached;
    }

    try {
      const systemPrompt = SYSTEM_PROMPT.replace('{language}', targetLang);
      const result = await aiStreamRound(
        {
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: text },
          ],
          maxTokens: 1024,
          fast: true,
        },
        onDelta ? { onTextDelta: onDelta } : {},
      );

      const translated = result.text.trim();

      if (this.cache.size >= MAX_CACHE_ENTRIES) {
        const oldest = this.cache.keys().next().value;
        if (oldest) this.cache.delete(oldest);
      }
      this.cache.set(cacheKey, translated);
      return translated;
    } catch (err) {
      voiceLogger.error({ err, targetLang }, 'TTS translation failed, using original text');
      onDelta?.(text);
      return text;
    }
  }

  get cacheSize(): number {
    return this.cache.size;
  }

  clearCache(): void {
    this.cache.clear();
  }

  private getCacheKey(text: string, targetLang: string): string {
    return `${targetLang}:${createHash('sha256').update(text).digest('hex')}`;
  }
}
```

Remove constructor params `apiKey`, `baseUrl`, `model` (the default constructor is empty now).

**Note:** Wiring the `onDelta` callback into the actual TTS engine's streaming input is
out of scope for this migration. This change just adds the hook; the TTS caller can adopt
it later as a separate improvement. Current callers that don't pass `onDelta` behave
identically to the non-streaming version.

- [ ] **Step 3: Update call sites**

Find where `TtsTranslationService` is constructed and `resolveCity()` is called — remove Anthropic-specific args.

- [ ] **Step 4: Run tests**

Run: `bun test test/services/timezone/ test/services/voice/`

- [ ] **Step 5: Commit**

```bash
git add src/services/timezone/city-resolver.ts src/services/voice/tts-translation.ts src/index.ts
git commit -m "refactor(ai): migrate city-resolver and tts-translation to aiStreamRound"
```

---

### Task 9: Update debug-logger.ts types

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
type ChatMessage = OpenAI.ChatCompletionMessageParam;
```

Update `serializeContent()` to handle OpenAI message format:

```typescript
function serializeMessage(msg: ChatMessage): string {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.map((p) => ('text' in p ? p.text : `[${p.type}]`)).join(' ');
  }
  if (msg.role === 'assistant' && 'tool_calls' in msg && msg.tool_calls) {
    return msg.tool_calls.map((tc) => `[tool_use: ${tc.function.name} | input: ${tc.function.arguments.slice(0, 200)}]`).join(' ');
  }
  if (msg.role === 'tool') return `[tool_result: ${String(msg.content).slice(0, 300)}]`;
  return JSON.stringify(msg).slice(0, 500);
}
```

Update `DebugMessage` interface similarly.

- [ ] **Step 2: Update agent.ts calls to debug logger**

Ensure `saveAssistantTurn()` and `saveToolResults()` pass OpenAI-format messages.

- [ ] **Step 3: Run tests**

Run: `bun test test/services/ai/`

- [ ] **Step 4: Commit**

```bash
git add src/services/ai/debug-logger.ts
git commit -m "refactor(debug-logger): update types from Anthropic to OpenAI format"
```

---

### Task 10: Simplify AgentConfig and index.ts wiring

**Files:**
- Modify: `src/services/ai/types.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Simplify AgentConfig**

In `types.ts`, the current `AgentConfig` has Anthropic-specific fields. Simplify:

```typescript
export interface AgentConfig {
  debugLogger?: AiDebugLogger;
}
```

Remove entirely: `apiKey`, `baseUrl`, `model`, `fallback`, `validationModel`.

Validation is now **always enabled** (no flag) — `aiStreamRound({fast: true})` makes it cheap.

- [ ] **Step 2: Update index.ts**

Remove all Anthropic client creation, fallback client setup. The agent no longer needs API keys. Remove imports of `createAnthropicClient`, any references to `AI_BASE_URL_FALLBACK`, etc.

- [ ] **Step 3: Run full test suite**

Run: `bun test`

- [ ] **Step 4: Commit**

```bash
git add src/services/ai/types.ts src/index.ts
git commit -m "refactor(config): simplify AgentConfig, remove Anthropic client wiring"
```

---

### Task 11: Delete anthropic-client.ts and remove @anthropic-ai/sdk

**Files:**
- Delete: `src/services/ai/anthropic-client.ts`
- Modify: `package.json`

- [ ] **Step 1: Verify no remaining imports**

Run the following Greps and confirm all return zero results in `src/`:
- `anthropic-client`
- `@anthropic-ai/sdk`
- `import type Anthropic`

- [ ] **Step 2: Delete the file**

```bash
rm src/services/ai/anthropic-client.ts
```

- [ ] **Step 3: Remove the dependency**

```bash
bun remove @anthropic-ai/sdk
```

- [ ] **Step 4: Run full suite**

```bash
tsc --noEmit && bun test && bun run lint && bunx knip
```

Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: remove @anthropic-ai/sdk, delete anthropic-client.ts"
```

---

### Task 12: Integration test

**Files:**
- Modify: `scripts/test-ai-chains.ts`

- [ ] **Step 1: Update test script to use the new modules**

Import `aiStreamRound` from the actual module and run it in both streaming and collect modes, for both chains:

```typescript
import { aiStreamRound } from '../src/services/ai/streaming.ts';

// Test streaming chain (main), with callbacks
console.log('--- STREAMING (main) ---');
await aiStreamRound(
  {
    messages: [
      { role: 'system', content: 'Reply briefly in Russian.' },
      { role: 'user', content: 'Привет!' },
    ],
    maxTokens: 100,
  },
  {
    onTextDelta: (t) => process.stdout.write(t),
  },
);
console.log();

// Test streaming chain collect mode
console.log('--- COLLECT (main) ---');
const main = await aiStreamRound({
  messages: [{ role: 'user', content: 'Привет!' }],
  maxTokens: 100,
});
console.log('provider:', main.providerUsed, 'text:', main.text);

// Test light chain
console.log('--- LIGHT ---');
const light = await aiStreamRound({
  messages: [{ role: 'user', content: 'Привет!' }],
  maxTokens: 100,
  fast: true,
});
console.log('provider:', light.providerUsed, 'text:', light.text);

// Test tool calling
console.log('--- TOOLS ---');
const tools = await aiStreamRound({
  messages: [{ role: 'user', content: 'What time is it in Belgrade?' }],
  maxTokens: 200,
  tools: [
    {
      type: 'function',
      function: {
        name: 'get_current_time',
        description: 'Get current time',
        parameters: {
          type: 'object',
          properties: { timezone: { type: 'string' } },
          required: ['timezone'],
        },
      },
    },
  ],
});
console.log('provider:', tools.providerUsed, 'toolCalls:', tools.toolCalls);
```

- [ ] **Step 2: Run it**

Run: `bun scripts/test-ai-chains.ts`
Expected: All four calls succeed.

- [ ] **Step 3: Commit**

```bash
git add scripts/test-ai-chains.ts
git commit -m "test: update integration script for unified aiStreamRound API"
```

---

### Task 13: Final verification

- [ ] **Step 1: Run full test suite with coverage**

Run: `bun test --coverage`
Expected: All pass, coverage ≥ 80%

- [ ] **Step 2: Run linter + tsc + knip**

```bash
bun run lint && tsc --noEmit && bunx knip
```

- [ ] **Step 3: Restart the bot locally and smoke test**

Kill the running bot, restart, send a test message in a group chat. Verify:
- Text-only greeting works
- Tool calling (e.g. "what's on my calendar today") works
- Fallback triggers if z.ai is manually broken (e.g. by temporarily changing the API key)

- [ ] **Step 4: Update production .env on the server**

The production bot runs from `/opt/hypercal/.env` on `104.248.84.190`. Without the new required env vars, the bot will throw at startup after deploy.

**Current state of prod `.env` (as of writing this plan):**

| Var | Present? | Action |
|-----|:--------:|--------|
| `ANTHROPIC_API_KEY` | ✓ | **verify balance** (was `28eec...` danny key — 429 insufficient balance). Use the Alex key that's in the `#` comment on the line, or top up. |
| `AI_BASE_URL` | ✓ | **CHANGE** from `https://api.z.ai/api/anthropic` → `https://api.z.ai/api/coding/paas/v4` |
| `AI_MODEL` | ✓ | keep as `glm-5.1` |
| `AI_FAST_MODEL` | ✓ | **CHANGE** from `glm-4.7-flash` (500 errors on coding endpoint) → `glm-4.5-flash` |
| `HF_TOKEN` | ✓ | keep |
| `HF_BASE_URL` | ✗ | **ADD** `https://router.huggingface.co/v1` |
| `HF_MODEL` | ✗ | **ADD** `Qwen/Qwen3-235B-A22B` |
| `HF_FAST_MODEL` | ✗ | **ADD** `meta-llama/Llama-3.3-70B-Instruct` |
| `GEMINI_API_KEY` | ✗ | **ADD** — copy from local `.env` (Alex has it) |
| `GEMINI_BASE_URL` | ✗ | **ADD** `https://generativelanguage.googleapis.com/v1beta/openai/` |
| `GEMINI_MODEL` | ✗ | **ADD** `gemini-2.5-pro` |
| `GEMINI_FAST_MODEL` | ✗ | **ADD** `gemini-2.5-flash` |

**Before deploying the new code**, SSH in, back up the current file, and apply the changes:

```bash
ssh root@104.248.84.190 "cp /opt/hypercal/.env /opt/hypercal/.env.backup-$(date +%Y%m%d)"

# Edit /opt/hypercal/.env manually to change AI_BASE_URL and AI_FAST_MODEL.
# Then append the new vars:
ssh root@104.248.84.190 "cat >> /opt/hypercal/.env <<'ENV'

# OpenAI SDK migration (2026-04-10)
HF_BASE_URL=https://router.huggingface.co/v1
HF_MODEL=Qwen/Qwen3-235B-A22B
HF_FAST_MODEL=meta-llama/Llama-3.3-70B-Instruct

GEMINI_API_KEY=<paste real value here>
GEMINI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/
GEMINI_MODEL=gemini-2.5-pro
GEMINI_FAST_MODEL=gemini-2.5-flash
ENV"
```

**Important:** if there are duplicate `AI_BASE_URL` or `AI_FAST_MODEL` lines after the edit, the last occurrence wins. Verify with:

```bash
ssh root@104.248.84.190 "grep -cE '^AI_BASE_URL=|^AI_FAST_MODEL=' /opt/hypercal/.env"
# Expected: 2 (one of each, no duplicates)

ssh root@104.248.84.190 "grep -E '^AI_BASE_URL|^AI_MODEL|^AI_FAST_MODEL|^HF_|^GEMINI_|^ANTHROPIC_API_KEY' /opt/hypercal/.env"
# Expected: 11 lines, all values correct
```

Delete any duplicates before continuing.

- [ ] **Step 5: Deploy to production and monitor**

Push the feature branch, create PR, merge to main. CI deploys automatically. Watch container logs:

```bash
ssh root@104.248.84.190 "docker logs hypercal-bot --since 2m 2>&1 | grep -E 'provider|Trying|failed'"
```

Verify z.ai is the primary and fallbacks only trigger on real failures. If the bot fails to start with "environment variable is required", a new var is missing on prod — add it and restart the container.
