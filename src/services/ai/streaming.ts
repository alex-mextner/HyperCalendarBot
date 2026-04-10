// src/services/ai/streaming.ts
// Unified AI streaming round with automatic provider fallback.
//
// Two chains, selected via options.fast:
//   SMART_CHAIN (main): z.ai ${ZAI_MODEL}      → Gemini ${GEMINI_MODEL}      → HF ${HF_MODEL}
//   FAST_CHAIN:          z.ai ${ZAI_FAST_MODEL} → Gemini ${GEMINI_FAST_MODEL} → HF ${HF_FAST_MODEL}
//
// Callers that need live updates (agent.ts) pass `onTextDelta`/`onToolCallStart` callbacks.
// Callers that just want the final text (validator, intent-learner, city-resolver,
// tts-translation) omit callbacks — the full result is still returned either way.

import OpenAI from 'openai';
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
  /** Use the fast chain (cheap/fast models) instead of the smart chain. Default: false. */
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
  /** Human-readable provider slot that actually produced the result. */
  providerUsed: string;
}

// ── Error helpers (exported for tests) ─────────────────────────────────────

/**
 * Provider-level down/unavailable detection: 5xx, timeout, connection errors.
 * Distinct from 429 (rate limit) which is handled separately.
 */
function isProviderDown(error: unknown): boolean {
  if (error instanceof OpenAI.APIError && typeof error.status === 'number' && error.status >= 500) {
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
  if (error instanceof OpenAI.APIError && typeof error.status === 'number') {
    return error.status === 429 || error.status >= 500;
  }
  return false;
}

export function getBackoffDelay(attempt: number, error: unknown): number {
  if (error instanceof OpenAI.APIError && error.status === 429) {
    // OpenAI SDK v6 stores headers as a Headers instance (Web API), not a plain object.
    const retryAfterRaw = error.headers?.get?.('retry-after');
    if (retryAfterRaw) {
      const seconds = Number.parseInt(retryAfterRaw, 10);
      if (!Number.isNaN(seconds) && seconds > 0) {
        return Math.min(seconds * 1000, 30_000);
      }
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

/** Standard OpenAI streaming adapter (works for z.ai, Gemini, HF Router). */
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
        throw new Error('Provider returned empty response (likely coding-endpoint reasoning-only path)');
      }

      const assistantMessage: OpenAI.ChatCompletionMessageParam =
        toolCallsArray.length > 0
          ? {
              role: 'assistant',
              content: text || null,
              tool_calls: toolCallsArray.map((tc) => ({
                id: tc.id,
                type: 'function' as const,
                function: { name: tc.name, arguments: tc.arguments },
              })),
            }
          : {
              role: 'assistant',
              content: text,
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
 *   fast=false → z.ai ZAI_MODEL      → Gemini GEMINI_MODEL      → HF HF_MODEL
 *   fast=true  → z.ai ZAI_FAST_MODEL → Gemini GEMINI_FAST_MODEL → HF HF_FAST_MODEL
 *
 * Fallback rules:
 * - Provider returns 5xx / timeout / 429  → try next
 * - Balance exhausted                     → alert admin, try next
 * - Provider already streamed text to user → propagate the error (can't splice)
 * - 200 OK but empty text AND no tool calls → try next (z.ai coding-endpoint quirk)
 * - 4xx non-429                           → propagate (client error — our bug)
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
      aiLogger.info({ provider: slot.name }, 'Trying provider');
      return await slot.stream(options, wrappedCallbacks);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      aiLogger.error({ err: lastError, provider: slot.name }, 'Provider failed');

      if (isBalanceExhausted(error)) {
        alertProviderBalanceExhausted(slot.name, lastError.message);
      }

      if (textEmitted) {
        aiLogger.error({ provider: slot.name }, 'Provider died mid-stream after text was emitted — cannot fallback');
        throw error;
      }

      const emptyResponse = lastError.message.includes('empty response');
      if (isRetryableError(error) || isBalanceExhausted(error) || emptyResponse) {
        aiLogger.warn({ provider: slot.name }, 'Falling through to next provider');
        continue;
      }

      throw error;
    }
  }

  throw lastError ?? new Error('All providers failed');
}
