// src/services/ai/streaming/types.ts
// Public data shapes of an AI streaming round: options, callbacks, results, metrics and failure records.
// Type-only, so every other streaming module can depend on it without creating an import cycle.

import type OpenAI from 'openai';
import type { ProviderChainKind } from '../../../utils/ai-provider-alert.ts';
import type { ProviderId } from '../provider-ids.ts';
import type { AiCallPurpose, AiTokenUsage } from '../usage-recorder.ts';

export interface StreamRoundOptions {
  messages: OpenAI.ChatCompletionMessageParam[];
  tools?: OpenAI.ChatCompletionTool[];
  maxTokens: number;
  /** Optional narrower wall-time cap for one provider, including all stream chunks. */
  providerTimeoutMs?: number;
  temperature?: number;
  /** Use the fast chain (cheap/fast models) instead of the smart chain. Default: false. */
  fast?: boolean;
  signal?: AbortSignal;
  /** User ID for log context only. */
  userId?: number;
  /** Opaque per-agent-run correlation id; contains no user content. */
  requestId?: string;
  /** What the round is for; recorded with each provider attempt. */
  purpose?: AiCallPurpose;
  /**
   * The caller reveals a tool the providers rejected as unexposed and retries the round,
   * and reports the outage itself if that recovery gives up. Only such a caller sets this.
   */
  deferOutageAlert?: boolean;
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

export interface StreamTokenUsage extends AiTokenUsage {
  totalTokens: number | null;
}

export interface StreamRoundMetrics {
  provider: ProviderId;
  model: string;
  chain: ProviderChainKind;
  /** First usable delta measured from the winning provider attempt start. */
  firstUsableSinceAttemptMs: number | null;
  /** Duration of the winning provider attempt only. */
  providerDurationMs: number;
  totalDurationMs: number;
  attemptCount: number;
  fallbackCount: number;
  usage: StreamTokenUsage | null;
  failedProviders?: { provider: ProviderId; model: string }[];
  skippedProviders?: { provider: ProviderId; model: string }[];
}

export interface FailedRoundMetrics {
  totalDurationMs: number;
  attemptCount: number;
  fallbackCount: number;
}

export interface StreamRoundResult {
  text: string;
  toolCalls: StreamToolCall[];
  finishReason: string;
  assistantMessage: OpenAI.ChatCompletionMessageParam;
  /** Human-readable provider slot that actually produced the result. */
  providerUsed: string;
  metrics?: StreamRoundMetrics;
}

export interface EmptyResponseDiagnostics {
  classification: 'no_chunks' | 'no_choices' | 'length' | 'reasoning_only' | 'empty' | 'malformed_tools' | 'safety';
  choiceCount: number;
  toolFragmentCount: number;
  finishReason: string | null;
  chunkCount: number;
  maxOutputTokens: number;
  messageCount: number;
  toolCount: number;
  usage: StreamTokenUsage | null;
}

/** One provider slot's failure, kept for the aggregate error and the admin alert. */
export interface ProviderFailure {
  emptyResponse?: EmptyResponseDiagnostics;
  skippedBeforeRequest?: boolean;
  /** Human-readable provider slot including the model actually requested. */
  provider: string;
  providerId: ProviderId;
  model: string;
  /** HTTP status, when the provider returned one. */
  status?: number;
  message: string;
  /** True when the provider looked temporarily down rather than rejecting the request. */
  transient: boolean;
}
