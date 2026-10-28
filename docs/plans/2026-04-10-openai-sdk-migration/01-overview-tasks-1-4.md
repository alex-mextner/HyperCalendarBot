> Part 1 of 2 of [OpenAI SDK Migration — Implementation Plan](../2026-04-10-openai-sdk-migration.md) — next: [02-tasks-5-13.md](02-tasks-5-13.md)

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
  ZAI_API_KEY: string;
  ZAI_BASE_URL: string;
  ZAI_MODEL: string;
  ZAI_FAST_MODEL: string;

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

Remove: `AI_MODEL_FALLBACK`, `AI_BASE_URL_FALLBACK`, `AI_API_KEY_FALLBACK` (dead code from old fallback logic — these are the OLD var names in the existing EnvConfig to delete).

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
  ZAI_API_KEY: requireEnv('ZAI_API_KEY'),
  ZAI_BASE_URL: requireEnv('ZAI_BASE_URL'),
  ZAI_MODEL: requireEnv('ZAI_MODEL'),
  ZAI_FAST_MODEL: requireEnv('ZAI_FAST_MODEL'),

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

Remove the old `ANTHROPIC_API_KEY` check (it's now handled by `requireEnv('ZAI_API_KEY')`).

- [ ] **Step 4: Update .env.example**

```env
BOT_TOKEN=your_bot_token

# AI primary — z.ai coding endpoint (GLM 5.1 via OpenAI-compat API)
ZAI_API_KEY=your_zai_api_key
ZAI_BASE_URL=https://api.z.ai/api/coding/paas/v4
ZAI_MODEL=glm-5.1
ZAI_FAST_MODEL=glm-4.7-flash

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
ZAI_BASE_URL=https://api.z.ai/api/coding/paas/v4
ZAI_MODEL=glm-5.1
ZAI_FAST_MODEL=glm-4.7-flash

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
      apiKey: cfg.ZAI_API_KEY,
      baseURL: cfg.ZAI_BASE_URL,
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
//   SMART_CHAIN (main): z.ai ${ZAI_MODEL}      → Gemini ${GEMINI_MODEL}      → HF ${HF_MODEL}
//   FAST_CHAIN:            z.ai ${ZAI_FAST_MODEL} → Gemini ${GEMINI_FAST_MODEL} → HF ${HF_FAST_MODEL}
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
    streamingSlot(`z.ai (${cfg.ZAI_MODEL})`, zaiClient, cfg.ZAI_MODEL),
    streamingSlot(`Gemini (${cfg.GEMINI_MODEL})`, geminiClient, cfg.GEMINI_MODEL),
    streamingSlot(`HF (${cfg.HF_MODEL})`, hfClient, cfg.HF_MODEL),
  ];
}

function buildFastChain(): ProviderSlot[] {
  const cfg = loadConfig();
  return [
    streamingSlot(`z.ai (${cfg.ZAI_FAST_MODEL})`, zaiClient, cfg.ZAI_FAST_MODEL),
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
 *   light: false → z.ai ${ZAI_MODEL}      → Gemini ${GEMINI_MODEL}      → HF ${HF_MODEL}
 *   fast: true  → z.ai ${ZAI_FAST_MODEL} → Gemini ${GEMINI_FAST_MODEL} → HF ${HF_FAST_MODEL}
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

