// src/services/ai/streaming/slot.ts
// A provider slot (one provider + model + account in a chain) and the standard OpenAI-compatible
// streaming adapter every slot runs: request construction, the streaming-usage compatibility retry,
// and mapping the consumed stream to a round result or a typed empty/safety error.

import type OpenAI from 'openai';
import { logOnce } from '../../../utils/logger.ts';
import { type ModelPreset, type ModelRole, presetRequestFields } from '../model-presets.ts';
import { getModelOverride } from '../model-registry.ts';
import type { ProviderId } from '../provider-ids.ts';
import { rejectsUsageStreamOption } from './error-classification.ts';
import { EmptyProviderResponseError, ProviderSafetyStopError } from './errors.ts';
import { aiLogger } from './logger.ts';
import {
  buildAssistantMessage,
  buildResponseDiagnostics,
  hasInvalidToolCalls,
  normalizeUsage,
} from './response-shape.ts';
import { consumeStream } from './stream-reader.ts';
import type { StreamCallbacks, StreamRoundOptions, StreamRoundResult } from './types.ts';

export interface ProviderSlot {
  /** Provider label without the model, e.g. `Claude`. */
  label: string;
  provider: ProviderId;
  /** Model id from the config. May be overridden at request time when it is gone. */
  configuredModel: string;
  /** Identifies the provider account (endpoint + credential) for the durable circuit. */
  circuitKey: string;
  /** The circuit of the whole credential, for a provider whose `circuitKey` is per model (OpenRouter). */
  accountCircuitKey?: string;
  /** Role whose chain this slot belongs to; unset on a legacy-chain slot. */
  role?: ModelRole;
  /** Registry preset the slot runs, set with the preset's own settings; such a slot runs only its measured model. */
  presetId?: string;
  getClient: () => OpenAI;
  stream: (
    model: string,
    opts: StreamRoundOptions,
    cbs: StreamCallbacks,
    onHttpAttempt: () => void,
  ) => Promise<StreamRoundResult>;
}

export function slotName(label: string, model: string): string {
  return `${label} (${model})`;
}

/**
 * The model a request to this slot names now: the live replacement when the configured one was found gone.
 * A preset slot has no replacement: its model is the one that was measured.
 */
export function modelRequestedFrom(slot: ProviderSlot): string {
  if (slot.presetId !== undefined) return slot.configuredModel;
  return getModelOverride(slot.provider, slot.configuredModel) ?? slot.configuredModel;
}

const providersWithoutStreamingUsage = new Set<ProviderId>();
export function _resetStreamingUsageCompatibilityForTest(): void {
  providersWithoutStreamingUsage.clear();
}

/**
 * Claude 5.x answers 400 "`temperature` is deprecated for this model" to any request that
 * names it, so its requests run on the provider's own sampling default.
 */
export function acceptsSamplingTemperature(provider: ProviderId): boolean {
  return provider !== 'claude';
}

/**
 * The `max_tokens` every Claude request carries: the live-verified output ceiling of both
 * claude-sonnet-5-5 and claude-haiku-5-5 (2026-10-10; one more is a 400). Claude 5.5 thinks before
 * answering, streams none of it on the compatible endpoint, yet bills it against `max_tokens`,
 * and no request field caps that thinking. So the server cap stays out of the way and the
 * caller's limit is enforced on the visible stream; the per-attempt deadline bounds runaway thinking.
 */
export const CLAUDE_MAX_OUTPUT_TOKENS = 128_000;

function buildStreamParams(
  provider: ProviderId,
  model: string,
  opts: StreamRoundOptions,
  active: ModelPreset | undefined,
): OpenAI.ChatCompletionCreateParamsStreaming {
  const params: OpenAI.ChatCompletionCreateParamsStreaming = {
    model,
    messages: opts.messages,
    max_tokens:
      provider === 'claude' ? CLAUDE_MAX_OUTPUT_TOKENS : Math.max(opts.maxTokens, active?.maxOutputTokens ?? 0),
    ...(acceptsSamplingTemperature(provider) ? { temperature: active?.temperature ?? opts.temperature ?? 0.3 } : {}),
    ...(active ? presetRequestFields(provider, active) : {}),
    stream: true,
    ...(providersWithoutStreamingUsage.has(provider) ? {} : { stream_options: { include_usage: true } }),
  };
  if (opts.tools && opts.tools.length > 0) {
    params.tools = opts.tools;
  }
  return params;
}

/**
 * Opens the completion stream. A provider that rejects `stream_options.include_usage` is remembered and
 * the request repeated once without it. `startedAt` is stamped just before the request that actually
 * produced the stream, so the provider duration excludes the rejected attempt.
 */
async function openCompletionStream(
  client: OpenAI,
  params: OpenAI.ChatCompletionCreateParamsStreaming,
  provider: ProviderId,
  signal: AbortSignal | undefined,
  onHttpAttempt: () => void,
): Promise<{ stream: AsyncIterable<OpenAI.ChatCompletionChunk>; startedAt: number }> {
  let startedAt = performance.now();
  let stream: AsyncIterable<OpenAI.ChatCompletionChunk>;
  try {
    startedAt = performance.now();
    onHttpAttempt();
    stream = await client.chat.completions.create(params, { signal });
  } catch (error) {
    if (!rejectsUsageStreamOption(error)) throw error;
    const { stream_options: _unsupported, ...withoutUsage } = params;
    providersWithoutStreamingUsage.add(provider);
    logOnce(`usage-stream-unsupported:${provider}`, () =>
      aiLogger.warn(
        { provider, model: params.model },
        'Provider rejected streaming usage — retrying this request without usage telemetry',
      ),
    );
    startedAt = performance.now();
    onHttpAttempt();
    stream = await client.chat.completions.create(withoutUsage as OpenAI.ChatCompletionCreateParamsStreaming, {
      signal,
    });
  }
  return { stream, startedAt };
}

/**
 * Standard OpenAI streaming adapter (works for every provider). A `preset` carries the settings its
 * model was measured with, and applies only while the slot sends exactly that model: its temperature
 * replaces the caller's, its output ceiling is a floor under the caller's limit (a reasoning model spends
 * output tokens before it answers; the visible stream is still cut at the caller's limit) and its effort
 * goes out in the field the provider understands.
 */
export function streamingSlot(
  label: string,
  provider: ProviderId,
  getClient: () => OpenAI,
  configuredModel: string,
  circuitKey: string,
  preset?: ModelPreset,
): ProviderSlot {
  return {
    label,
    provider,
    configuredModel,
    circuitKey,
    ...(preset ? { presetId: preset.id } : {}),
    getClient,
    stream: async (model, opts, cbs, onHttpAttempt) => {
      // Settings were measured on one model: a live replacement for it, or another model's slot, runs plain.
      const active = preset && preset.models[provider] === model ? preset : undefined;
      // A raised server cap must not raise what the caller gets: the visible stream is cut at its own limit.
      const raisedOutputCap = (active?.maxOutputTokens ?? 0) > opts.maxTokens;
      const params = buildStreamParams(provider, model, opts, active);

      const client = getClient();
      const { stream, startedAt: attemptStartedAt } = await openCompletionStream(
        client,
        params,
        provider,
        opts.signal,
        onHttpAttempt,
      );
      const consumed = await consumeStream(
        stream,
        cbs,
        attemptStartedAt,
        opts.signal,
        provider === 'claude' || raisedOutputCap ? opts.maxTokens : undefined,
      );
      const { text, toolCalls, finishReason, firstUsableMs, refusalSeen } = consumed;

      const invalidTools = hasInvalidToolCalls(consumed.toolFragmentCount, toolCalls);
      const normalizedUsage = normalizeUsage(consumed.usage);
      const diagnostics = buildResponseDiagnostics({
        refusalSeen,
        finishReason,
        finishReasonSeen: consumed.finishReasonSeen,
        invalidTools,
        usage: normalizedUsage,
        chunkCount: consumed.chunkCount,
        choiceCount: consumed.choiceCount,
        toolFragmentCount: consumed.toolFragmentCount,
        maxOutputTokens: params.max_tokens ?? opts.maxTokens,
        messageCount: opts.messages.length,
        toolCount: opts.tools?.length ?? 0,
      });
      if (refusalSeen || finishReason === 'content_filter') throw new ProviderSafetyStopError(diagnostics);
      if (invalidTools || (!text.trim() && toolCalls.length === 0)) {
        throw new EmptyProviderResponseError(slotName(label, model), diagnostics);
      }

      return {
        text,
        toolCalls,
        finishReason,
        assistantMessage: buildAssistantMessage(text, toolCalls),
        providerUsed: slotName(label, model),
        metrics: {
          provider,
          model,
          chain: opts.fast ? 'fast' : 'smart',
          firstUsableSinceAttemptMs: firstUsableMs,
          providerDurationMs: Math.max(0, performance.now() - attemptStartedAt),
          totalDurationMs: 0,
          attemptCount: 1,
          fallbackCount: 0,
          usage: normalizeUsage(consumed.usage),
        },
      };
    },
  };
}
