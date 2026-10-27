// src/services/ai/streaming/response-shape.ts
// Pure turning of a consumed provider stream into a round result: usage normalization (unknown stays
// null, never zero), tool-call validity, the assistant message, and the diagnostics attached to
// empty / malformed / safety-stopped responses.

import type OpenAI from 'openai';
import type { CompletionUsage } from 'openai/resources/completions';
import { z } from 'zod';
import { jsonCodec } from '../../../utils/json-codec.ts';
import type { EmptyResponseDiagnostics, StreamTokenUsage, StreamToolCall } from './types.ts';

const toolArgumentsCodec = jsonCodec(z.record(z.string(), z.json()));

const KNOWN_FINISH_REASONS = ['stop', 'length', 'tool_calls', 'function_call', 'content_filter'];

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A field the provider did not report (or reported as non-finite) is `null`, never `0`. */
export function normalizeUsage(usage: CompletionUsage | null): StreamTokenUsage | null {
  if (!usage) return null;
  const reportedCost = 'cost' in usage ? finite(usage.cost) : null;
  return {
    promptTokens: finite(usage.prompt_tokens),
    completionTokens: finite(usage.completion_tokens),
    totalTokens: finite(usage.total_tokens),
    cachedTokens: finite(usage.prompt_tokens_details?.cached_tokens),
    reasoningTokens: finite(usage.completion_tokens_details?.reasoning_tokens),
    ...(reportedCost === null ? {} : { costUsd: reportedCost }),
  };
}

export function buildAssistantMessage(text: string, toolCalls: StreamToolCall[]): OpenAI.ChatCompletionMessageParam {
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

/**
 * Tool fragments arrived but none resolved to a call, or a call has no id, an unusable name, arguments
 * that are not a JSON object, or shares its id with another call: nothing may be executed.
 */
export function hasInvalidToolCalls(toolFragmentCount: number, toolCalls: StreamToolCall[]): boolean {
  return (
    (toolFragmentCount > 0 && toolCalls.length === 0) ||
    toolCalls.some(
      (tc) =>
        !tc.id.trim() || !/^[a-zA-Z0-9_-]{1,64}$/.test(tc.name) || !toolArgumentsCodec.safeParse(tc.arguments).success,
    ) ||
    new Set(toolCalls.map((tc) => tc.id)).size !== toolCalls.length
  );
}

export interface DiagnosticsInput {
  refusalSeen: boolean;
  finishReason: string;
  finishReasonSeen: boolean;
  invalidTools: boolean;
  usage: StreamTokenUsage | null;
  chunkCount: number;
  choiceCount: number;
  toolFragmentCount: number;
  maxOutputTokens: number;
  messageCount: number;
  toolCount: number;
}

function classifyEmptyResponse(input: DiagnosticsInput): EmptyResponseDiagnostics['classification'] {
  if (input.refusalSeen || input.finishReason === 'content_filter') return 'safety';
  if (input.invalidTools) return 'malformed_tools';
  if (input.finishReasonSeen && input.finishReason === 'length') return 'length';
  if ((input.usage?.reasoningTokens ?? 0) > 0) return 'reasoning_only';
  if (input.chunkCount === 0) return 'no_chunks';
  if (input.choiceCount === 0) return 'no_choices';
  return 'empty';
}

/** The finish reason exactly as a terminal chunk reported it (unlisted values become 'unknown'), `null` when none came. */
function reportedFinishReason(input: DiagnosticsInput): string | null {
  if (!input.finishReasonSeen) return null;
  return KNOWN_FINISH_REASONS.includes(input.finishReason) ? input.finishReason : 'unknown';
}

export function buildResponseDiagnostics(input: DiagnosticsInput): EmptyResponseDiagnostics {
  return {
    classification: classifyEmptyResponse(input),
    finishReason: reportedFinishReason(input),
    chunkCount: input.chunkCount,
    choiceCount: input.choiceCount,
    toolFragmentCount: input.toolFragmentCount,
    maxOutputTokens: input.maxOutputTokens,
    messageCount: input.messageCount,
    toolCount: input.toolCount,
    usage: input.usage,
  };
}
