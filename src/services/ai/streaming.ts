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
import { DEFAULT_FAST_CHAIN, DEFAULT_SMART_CHAIN, loadConfig } from '../../config/env.ts';
import {
  type ProviderChainKind,
  reportAllProvidersFailed,
  reportProviderAnswered,
  reportProviderFailure,
} from '../../utils/ai-provider-alert.ts';
import { logger, logOnce } from '../../utils/logger.ts';
import { geminiClient, groqClient, hfClient, zaiClient } from './clients.ts';
import { getModelOverride, isModelNotFoundError, resolveModelOverride } from './model-registry.ts';
import type { ProviderId } from './provider-ids.ts';

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
  /** User ID for log context only. */
  userId?: number;
}

export interface StreamCallbacks {
  onTextDelta?: (text: string) => void;
  onToolCallStart?: (name: string) => void;
  /** Called when provider failed mid-stream and fallback to next provider is attempted.
   *  Caller should discard partial buffered content so the next provider starts clean. */
  onProviderSwitch?: () => void;
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

/** One provider slot's failure, kept for the aggregate error and the admin alert. */
export interface ProviderFailure {
  /** Provider slot label including the model actually requested. */
  provider: string;
  /** HTTP status, when the provider returned one. */
  status?: number;
  message: string;
  /** True when the provider looked temporarily down rather than rejecting the request. */
  transient: boolean;
}

/**
 * Thrown when every slot in the chain failed. Carries each provider's reason so
 * a single log line (or admin alert) explains the whole outage — the previous
 * behavior of rethrowing only the last error hid which providers died and why.
 */
export class AllProvidersFailedError extends Error {
  readonly failures: ProviderFailure[];

  constructor(failures: ProviderFailure[]) {
    const detail = failures.map((f) => `${f.provider}: ${f.status ?? 'no status'} ${f.message}`).join(' | ');
    super(`All ${failures.length} AI providers failed — ${detail}`);
    this.name = 'AllProvidersFailedError';
    this.failures = failures;
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

/**
 * True when the provider looked temporarily unavailable (5xx, rate limit,
 * timeout, aborted connection) rather than rejecting our request outright.
 *
 * This no longer decides whether the chain continues — every provider error
 * falls through to the next slot. It only picks the log level and marks the
 * failure in `AllProvidersFailedError`, so a transient blip reads differently
 * from a provider that will keep rejecting us until a human intervenes.
 */
export function isTransientProviderError(error: unknown): boolean {
  if (isProviderDown(error)) return true;
  if (error instanceof Error && error.name === 'AbortError') return true;
  // OpenAI SDK v6 throws APIUserAbortError (extends APIError, status=undefined)
  // when an AbortSignal fires. This comes from the agent's per-round timeout,
  // not from the user.
  if (error instanceof OpenAI.APIError && error.status === undefined) return true;
  if (error instanceof OpenAI.APIError && typeof error.status === 'number') {
    // 400 with no body is a transient provider issue (Gemini returns this intermittently).
    // A real 400 always includes a body describing the error.
    if (error.status === 400 && error.message.includes('no body')) return true;
    // 413 Request Too Large: Groq returns this for per-minute TPM rate limits
    // ("on tokens per minute (TPM): Limit X, Requested Y").
    if (error.status === 413) return true;
    return error.status === 429 || error.status >= 500;
  }
  // "Request timed out." from the OpenAI SDK's built-in connection timeout
  if (error instanceof Error && error.message.includes('timed out')) return true;
  return false;
}

/**
 * True only when the caller genuinely cancelled the request. `AbortSignal.timeout()`
 * aborts with a `TimeoutError`, which is our own per-round deadline — that must
 * still fall through to a (possibly faster) next provider.
 */
function isCallerAbort(signal: AbortSignal | undefined): boolean {
  if (!signal?.aborted) return false;
  const reason: unknown = signal.reason;
  if (reason instanceof Error && reason.name === 'TimeoutError') return false;
  return true;
}

// ── Provider adapters ──────────────────────────────────────────────────────

interface ProviderSlot {
  /** Provider label without the model, e.g. `Groq`. */
  label: string;
  provider: ProviderId;
  /** Model id from the config. May be overridden at request time when it is gone. */
  configuredModel: string;
  getClient: () => OpenAI;
  stream: (model: string, opts: StreamRoundOptions, cbs: StreamCallbacks) => Promise<StreamRoundResult>;
}

interface ToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface PendingToolCall {
  id: string;
  name: string;
  args: string;
}

/**
 * OpenAI spec requires `index` on every tool_call delta, but some providers
 * (HF Router, early Gemini) ship chunks without it:
 *   1. numeric `index` → use it directly;
 *   2. no index but an id or function name → a NEW tool call, fresh slot;
 *   3. no index and no id/name → continuation of the most recently opened slot;
 *   4. nothing open yet → orphan fragment, skip it.
 */
function resolveToolCallKey(tc: ToolCallDelta, toolCalls: Map<number, PendingToolCall>): number | null {
  if (typeof tc.index === 'number') return tc.index;
  if (tc.id || tc.function?.name) return toolCalls.size;
  if (toolCalls.size > 0) return [...toolCalls.keys()][toolCalls.size - 1] ?? null;
  return null;
}

function applyToolCallDelta(tc: ToolCallDelta, toolCalls: Map<number, PendingToolCall>, cbs: StreamCallbacks): void {
  const key = resolveToolCallKey(tc, toolCalls);
  if (key === null) return;

  const existing = toolCalls.get(key);
  if (existing) {
    existing.args += tc.function?.arguments ?? '';
    if (tc.id && !existing.id) existing.id = tc.id;
    if (tc.function?.name && !existing.name) existing.name = tc.function.name;
    return;
  }

  const name = tc.function?.name ?? '';
  if (name) cbs.onToolCallStart?.(name);
  toolCalls.set(key, { id: tc.id ?? '', name, args: tc.function?.arguments ?? '' });
}

interface ConsumedStream {
  text: string;
  toolCalls: StreamToolCall[];
  finishReason: string;
}

async function consumeStream(
  stream: AsyncIterable<OpenAI.ChatCompletionChunk>,
  cbs: StreamCallbacks,
): Promise<ConsumedStream> {
  let text = '';
  let finishReason = 'stop';
  const toolCalls = new Map<number, PendingToolCall>();

  for await (const chunk of stream) {
    const choice = chunk.choices[0];
    const delta = choice?.delta;
    if (!delta) continue;

    if (delta.content) {
      text += delta.content;
      cbs.onTextDelta?.(delta.content);
    }

    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) applyToolCallDelta(tc, toolCalls, cbs);
    }

    if (choice?.finish_reason) finishReason = choice.finish_reason;
  }

  return {
    text,
    finishReason,
    toolCalls: [...toolCalls.values()].map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.args })),
  };
}

function buildAssistantMessage(text: string, toolCalls: StreamToolCall[]): OpenAI.ChatCompletionMessageParam {
  if (toolCalls.length === 0) return { role: 'assistant', content: text };
  return {
    role: 'assistant',
    content: text || null,
    tool_calls: toolCalls.map((tc) => ({
      id: tc.id,
      type: 'function' as const,
      function: { name: tc.name, arguments: tc.arguments },
    })),
  };
}

/** Standard OpenAI streaming adapter (works for all four providers). */
function streamingSlot(
  label: string,
  provider: ProviderId,
  getClient: () => OpenAI,
  configuredModel: string,
): ProviderSlot {
  return {
    label,
    provider,
    configuredModel,
    getClient,
    stream: async (model, opts, cbs) => {
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
      const { text, toolCalls, finishReason } = await consumeStream(stream, cbs);

      // z.ai coding endpoint returns content='' and only reasoning_content for
      // pure text responses (no tools). If we got 200 OK but nothing usable,
      // treat as provider failure so the chain falls through.
      if (!text && toolCalls.length === 0) {
        throw new EmptyProviderResponseError(slotName(label, model));
      }

      return {
        text,
        toolCalls,
        finishReason,
        assistantMessage: buildAssistantMessage(text, toolCalls),
        providerUsed: slotName(label, model),
      };
    },
  };
}

function slotName(label: string, model: string): string {
  return `${label} (${model})`;
}

// ── Chains ─────────────────────────────────────────────────────────────────

/**
 * The client factory each slot uses, behind one indirection.
 *
 * This exists so tests can substitute fake providers by assigning to this
 * object rather than replacing the whole clients module. `mock.module` is
 * process-global and outlives the file that calls it, so a test that mocked
 * `clients.ts` handed its fakes to whatever test file bun happened to load
 * next — which broke `clients.test.ts` on Linux and not on macOS, purely
 * because directory order differs between the two filesystems.
 */
export const providerClients = {
  zai: zaiClient,
  groq: groqClient,
  gemini: geminiClient,
  hf: hfClient,
};

const PROVIDER_LABELS: Record<ProviderId, string> = {
  zai: 'z.ai',
  groq: 'Groq',
  gemini: 'Gemini',
  hf: 'HF',
};

/** What a provider needs before it can be put in a chain. */
interface ProviderAvailability {
  model?: string;
  apiKey?: string;
}

/**
 * Builds one chain in the configured order, skipping any provider whose key or
 * model is missing. Order is configuration rather than code because the reason
 * to change it arrives as an incident: a provider that answers 429 all week, or
 * one whose tier rejects a request this size on every single call. Both happened
 * on 2026-09-02, and both were a one-line change away from being routed around.
 *
 * An order that names only providers which turn out to be unconfigured would
 * leave the bot with nothing to answer with — worse than ignoring the order — so
 * that case falls back to every provider that IS configured, and says so loudly.
 */
function buildChain(
  kind: ProviderChainKind,
  order: ProviderId[],
  fallbackOrder: ProviderId[],
  available: Record<ProviderId, ProviderAvailability>,
): ProviderSlot[] {
  // An optional provider missing from the DEFAULT order is the documented
  // minimal deployment, not a mistake — Groq is in both defaults and plenty of
  // installations have no Groq key. Only a provider the operator named
  // themselves is worth a warning.
  const wasChosen = order !== fallbackOrder;
  const slotsFor = (ids: readonly ProviderId[]): ProviderSlot[] => {
    const chain: ProviderSlot[] = [];
    for (const provider of ids) {
      const { model, apiKey } = available[provider];
      if (!model || !apiKey) {
        logOnce(`skip:${kind}:${provider}:${!!model}:${!!apiKey}`, () => {
          const detail = { chain: kind, provider, hasModel: !!model, hasKey: !!apiKey };
          if (wasChosen) aiLogger.warn(detail, 'Provider named in the chain order is not configured — skipping it');
          else aiLogger.debug(detail, 'Optional provider in the default chain order is not configured — skipping it');
        });
        continue;
      }
      chain.push(streamingSlot(PROVIDER_LABELS[provider], provider, providerClients[provider], model));
    }
    return chain;
  };

  const configured = slotsFor(order);
  if (configured.length > 0) return configured;

  // The fallback walks the default order rather than the declaration order of
  // the provider ids, so the preference this code is built around survives the
  // one path where the configured order could not be honoured.
  const fallback = slotsFor(fallbackOrder);
  if (fallback.length === 0) {
    // Not reachable today — loadConfig requires the z.ai, HF and Gemini
    // credentials and refuses to start without them, so at least three
    // providers always have both. Kept because that is a startup rule, not an
    // invariant of this function, and an empty chain fails every request.
    logOnce(`none:${kind}:${order.join(',')}`, () =>
      aiLogger.error(
        { chain: kind, order },
        'No provider is configured with both a key and a model — every AI request will fail',
      ),
    );
    return fallback;
  }
  logOnce(`fallback:${kind}:${order.join(',')}`, () =>
    aiLogger.error(
      { chain: kind, order, usable: fallback.map((slot) => slot.provider) },
      'Configured provider order named nothing that is configured — falling back to the default order',
    ),
  );
  return fallback;
}

function buildSmartChain(): ProviderSlot[] {
  const cfg = loadConfig();
  return buildChain('smart', cfg.AI_SMART_CHAIN, DEFAULT_SMART_CHAIN, {
    zai: { model: cfg.ZAI_MODEL, apiKey: cfg.ZAI_API_KEY },
    groq: { model: cfg.GROQ_MODEL, apiKey: cfg.GROQ_API_KEY },
    gemini: { model: cfg.GEMINI_MODEL, apiKey: cfg.GEMINI_API_KEY },
    hf: { model: cfg.HF_MODEL, apiKey: cfg.HF_TOKEN },
  });
}

function buildFastChain(): ProviderSlot[] {
  const cfg = loadConfig();
  return buildChain('fast', cfg.AI_FAST_CHAIN, DEFAULT_FAST_CHAIN, {
    zai: { model: cfg.ZAI_FAST_MODEL, apiKey: cfg.ZAI_API_KEY },
    groq: { model: cfg.GROQ_FAST_MODEL, apiKey: cfg.GROQ_API_KEY },
    gemini: { model: cfg.GEMINI_FAST_MODEL, apiKey: cfg.GEMINI_API_KEY },
    hf: { model: cfg.HF_FAST_MODEL, apiKey: cfg.HF_TOKEN },
  });
}

// ── Slot execution with live-model discovery ───────────────────────────────

/**
 * Run one slot. If the provider says the configured model is gone, probe its
 * `/v1/models` endpoint once, pick a live replacement and retry the request on
 * the same provider before giving up on it.
 *
 * A model-not-found error always comes from the request itself, before any
 * chunk is streamed, so the retry can never duplicate text already sent to the
 * user.
 */
async function runSlot(slot: ProviderSlot, opts: StreamRoundOptions, cbs: StreamCallbacks): Promise<StreamRoundResult> {
  const cachedOverride = getModelOverride(slot.provider, slot.configuredModel);
  const model = cachedOverride ?? slot.configuredModel;

  try {
    return await slot.stream(model, opts, cbs);
  } catch (error) {
    if (!isModelNotFoundError(error)) throw error;

    const replacement = await resolveModelOverride({
      provider: slot.provider,
      client: slot.getClient(),
      configuredModel: slot.configuredModel,
      fast: opts.fast === true,
      // The cached replacement is dead too — probe again instead of reusing it.
      forceRefresh: cachedOverride !== null,
      deadModel: model,
    });
    if (!replacement || replacement === model) throw error;

    aiLogger.warn(
      { provider: slot.label, configuredModel: slot.configuredModel, resolvedModel: replacement, userId: opts.userId },
      'Configured model is gone — retrying the same provider with an auto-detected live model',
    );
    return await slot.stream(replacement, opts, cbs);
  }
}

function describeFailure(slot: ProviderSlot, error: unknown): ProviderFailure {
  const status = error instanceof OpenAI.APIError && typeof error.status === 'number' ? error.status : undefined;
  const message = error instanceof Error ? error.message : String(error);
  const model = getModelOverride(slot.provider, slot.configuredModel) ?? slot.configuredModel;
  return { provider: slotName(slot.label, model), status, message, transient: isTransientProviderError(error) };
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
 * Fallback policy: ANY provider error moves on to the next slot. A 400/401/403/404
 * says that provider cannot serve this request — it never says the request is
 * unanswerable, and treating it as fatal once took the whole bot down while a
 * healthy provider sat unused further down the chain. Specifically:
 * - 5xx / timeout / connection error / 429 / 413   → next slot
 * - 400/401/403/404 and any other 4xx              → next slot
 * - balance exhausted                              → alert admin, next slot
 * - model deleted by the provider                  → auto-detect a live model,
 *                                                    retry the same slot once,
 *                                                    then next slot
 * - 200 OK but empty text AND no tool calls        → next slot (z.ai quirk)
 * - provider died mid-stream after text or a tool label reached the user
 *                                                    → discard that output, next slot
 * - caller cancelled via AbortSignal                → propagate immediately
 * When every slot fails, throws `AllProvidersFailedError` listing each reason.
 */
export async function aiStreamRound(
  options: StreamRoundOptions,
  callbacks: StreamCallbacks = {},
): Promise<StreamRoundResult> {
  const chainKind: ProviderChainKind = options.fast ? 'fast' : 'smart';
  const chain = options.fast ? buildFastChain() : buildSmartChain();
  const failures: ProviderFailure[] = [];
  // Anything the caller has already shown the user for this round: streamed text
  // or a "running <tool>" label. Both must be cleared before another provider
  // starts, otherwise the user sees output from a round that never finished.
  let partialOutputShown = false;

  const wrappedCallbacks: StreamCallbacks = {
    onTextDelta: (text) => {
      partialOutputShown = true;
      callbacks.onTextDelta?.(text);
    },
    onToolCallStart: (name) => {
      partialOutputShown = true;
      callbacks.onToolCallStart?.(name);
    },
  };

  for (const slot of chain) {
    try {
      aiLogger.info({ provider: slot.label, model: slot.configuredModel, userId: options.userId }, 'Trying provider');
      const result = await runSlot(slot, options, wrappedCallbacks);
      // A slot that answers settles any outstanding outage for it and for its own
      // chain. The alert layer decides whether that is worth telling the admin
      // about.
      reportProviderAnswered(slot.label, chainKind);
      return result;
    } catch (error) {
      const failure = describeFailure(slot, error);
      failures.push(failure);
      reportSlotFailure(failure, error, options.userId, chainKind);

      if (partialOutputShown) {
        aiLogger.error(
          { provider: failure.provider, userId: options.userId },
          'Provider died mid-stream after output was shown — discarding it and trying next provider',
        );
        callbacks.onProviderSwitch?.();
        partialOutputShown = false;
      }

      if (isCallerAbort(options.signal)) throw error;
    }
  }

  const aggregate = new AllProvidersFailedError(failures);
  aiLogger.error({ failures, userId: options.userId }, 'Every AI provider in the chain failed');
  // The loudest alert there is: nobody answered, so the user got nothing.
  reportAllProvidersFailed(failures, chainKind);
  throw aggregate;
}

function reportSlotFailure(
  failure: ProviderFailure,
  error: unknown,
  userId: number | undefined,
  chain: ProviderChainKind,
): void {
  const context = { err: error, provider: failure.provider, status: failure.status, userId };
  if (failure.transient) {
    aiLogger.warn(context, 'Provider temporarily unavailable — trying next provider');
  } else {
    aiLogger.error(context, 'Provider rejected the request — trying next provider');
  }

  // The alert layer classifies and throttles; a transient blip never reaches the
  // admin on its own, so this is safe to call for every failure.
  reportProviderFailure(failure, chain);
}
