// src/services/ai/streaming.ts
// Unified AI streaming round with automatic provider fallback.
//
// Two chains, selected via options.fast:
//   SMART_CHAIN (main): z.ai ${ZAI_MODEL}      → Groq ${GROQ_MODEL}      → Gemini ${GEMINI_MODEL}      → HF ${HF_MODEL}
//   FAST_CHAIN:          z.ai ${ZAI_FAST_MODEL} → Groq ${GROQ_FAST_MODEL} → Gemini ${GEMINI_FAST_MODEL} → HF ${HF_FAST_MODEL}
//
// Callers that need live updates (agent.ts) pass `onTextDelta`/`onToolCallStart` callbacks.
// Callers that just want the final text (validator, intent-learner, city-resolver,
// tts-translation) omit callbacks — the full result is still returned either way.

import OpenAI from 'openai';
import { loadConfig } from '../../config/env.ts';
import { alertProviderBalanceExhausted, isBalanceExhausted } from '../../utils/ai-provider-alert.ts';
import { logger } from '../../utils/logger.ts';
import { geminiClient, groqClient, hfClient, zaiClient } from './clients.ts';

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

/**
 * Sentinel error type: provider returned 200 OK but no usable output
 * (z.ai coding endpoint's reasoning-only quirk). We detect this via instanceof
 * rather than substring-matching the message — a future copy-edit to the
 * message text would otherwise silently break the fallback decision.
 */
export class EmptyProviderResponseError extends Error {
  constructor(provider: string) {
    super(`Provider ${provider} returned 200 OK with no text and no tool calls`);
    this.name = 'EmptyProviderResponseError';
  }
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
  // OpenAI SDK v6 throws APIUserAbortError (extends APIError, status=undefined)
  // when an AbortSignal fires. This comes from the agent's per-round timeout,
  // not from the user — treat as retryable so the chain can try a faster provider.
  if (error instanceof OpenAI.APIError && error.status === undefined) return true;
  if (error instanceof OpenAI.APIError && typeof error.status === 'number') {
    // 400 with no body is a transient provider issue (Gemini returns this intermittently).
    // A real 400 always includes a body describing the error — treat no-body 400 as retryable
    // so the chain falls through to the next provider instead of propagating.
    if (error.status === 400 && error.message.includes('no body')) return true;
    // 413 Request Too Large: Groq returns this for per-minute TPM rate limits
    // ("on tokens per minute (TPM): Limit X, Requested Y"). The next provider in
    // the chain may have more headroom, so fall through.
    if (error.status === 413) return true;
    return error.status === 429 || error.status >= 500;
  }
  // "Request timed out." from the OpenAI SDK's built-in connection timeout
  if (error instanceof Error && error.message.includes('timed out')) return true;
  return false;
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
            // OpenAI spec requires `index` on every tool_call delta, but some
            // providers (HF Router, early Gemini) ship chunks without it.
            //
            // Resolution:
            //   1. If `tc.index` is a number, use it directly.
            //   2. Otherwise, if this chunk has an id OR a function name, treat
            //      it as a NEW tool call and allocate a fresh slot.
            //   3. Otherwise (pure args-fragment chunk without index), append
            //      to the most recently opened slot.
            let key: number;
            if (typeof tc.index === 'number') {
              key = tc.index;
            } else if (tc.id || tc.function?.name) {
              key = toolCalls.size;
            } else if (toolCalls.size > 0) {
              // continuation of the last open slot
              key = [...toolCalls.keys()].pop() as number;
            } else {
              // orphan fragment with no prior slot — skip it safely
              continue;
            }

            const existing = toolCalls.get(key);
            if (existing) {
              existing.args += tc.function?.arguments ?? '';
              if (tc.id && !existing.id) existing.id = tc.id;
              if (tc.function?.name && !existing.name) existing.name = tc.function.name;
            } else {
              const tcName = tc.function?.name ?? '';
              if (tcName) cbs.onToolCallStart?.(tcName);
              toolCalls.set(key, {
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
        throw new EmptyProviderResponseError(name);
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
  const chain: ProviderSlot[] = [streamingSlot(`z.ai (${cfg.ZAI_MODEL})`, zaiClient, cfg.ZAI_MODEL)];
  if (cfg.GROQ_API_KEY && cfg.GROQ_MODEL) {
    chain.push(streamingSlot(`Groq (${cfg.GROQ_MODEL})`, groqClient, cfg.GROQ_MODEL));
  }
  chain.push(
    streamingSlot(`Gemini (${cfg.GEMINI_MODEL})`, geminiClient, cfg.GEMINI_MODEL),
    streamingSlot(`HF (${cfg.HF_MODEL})`, hfClient, cfg.HF_MODEL),
  );
  return chain;
}

function buildFastChain(): ProviderSlot[] {
  const cfg = loadConfig();
  const chain: ProviderSlot[] = [streamingSlot(`z.ai (${cfg.ZAI_FAST_MODEL})`, zaiClient, cfg.ZAI_FAST_MODEL)];
  if (cfg.GROQ_API_KEY && cfg.GROQ_FAST_MODEL) {
    chain.push(streamingSlot(`Groq (${cfg.GROQ_FAST_MODEL})`, groqClient, cfg.GROQ_FAST_MODEL));
  }
  chain.push(
    streamingSlot(`Gemini (${cfg.GEMINI_FAST_MODEL})`, geminiClient, cfg.GEMINI_FAST_MODEL),
    streamingSlot(`HF (${cfg.HF_FAST_MODEL})`, hfClient, cfg.HF_FAST_MODEL),
  );
  return chain;
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
 *   fast=false → z.ai ZAI_MODEL      → Groq GROQ_MODEL      → Gemini GEMINI_MODEL      → HF HF_MODEL
 *   fast=true  → z.ai ZAI_FAST_MODEL → Groq GROQ_FAST_MODEL → Gemini GEMINI_FAST_MODEL → HF HF_FAST_MODEL
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

      const balanceExhausted = isBalanceExhausted(error);
      if (balanceExhausted) {
        alertProviderBalanceExhausted(slot.name, lastError.message);
      }

      if (textEmitted) {
        aiLogger.error({ provider: slot.name }, 'Provider died mid-stream after text was emitted — cannot fallback');
        throw error;
      }

      if (isRetryableError(error) || balanceExhausted || error instanceof EmptyProviderResponseError) {
        aiLogger.warn({ provider: slot.name }, 'Falling through to next provider');
        continue;
      }

      throw error;
    }
  }

  throw lastError ?? new Error('All providers failed');
}
