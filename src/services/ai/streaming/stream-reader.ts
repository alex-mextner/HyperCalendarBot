// src/services/ai/streaming/stream-reader.ts
// Reads one provider's chunk stream to the end: accumulates text and tool-call fragments, keeps the
// finish reason and usage from terminal chunks (including choices=[] chunks that carry no delta), and
// stays cancellable even when the producer ignores its abort signal.

import type OpenAI from 'openai';
import type { CompletionUsage } from 'openai/resources/completions';
import { waitForAbort } from '../provider-deadline.ts';
import { estimateTokens } from '../token-estimate.ts';
import { aiLogger } from './logger.ts';
import type { StreamCallbacks, StreamToolCall } from './types.ts';

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
 * (HF Router) ship chunks without it:
 *   1. numeric `index` → use it directly;
 *   2. no index but an id or function name → a NEW tool call, fresh slot;
 *   3. no index and no id/name → continuation of the most recently opened slot;
 *   4. nothing open yet → orphan fragment, skip it.
 */
export function resolveToolCallKey(tc: ToolCallDelta, toolCalls: Map<number, PendingToolCall>): number | null {
  if (typeof tc.index === 'number') return tc.index;
  if (tc.id || tc.function?.name) return toolCalls.size;
  if (toolCalls.size > 0) return [...toolCalls.keys()][toolCalls.size - 1] ?? null;
  return null;
}

export function applyToolCallDelta(
  tc: ToolCallDelta,
  toolCalls: Map<number, PendingToolCall>,
  cbs: StreamCallbacks,
): void {
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

export interface ConsumedStream {
  refusalSeen: boolean;
  choiceCount: number;
  toolFragmentCount: number;
  chunkCount: number;
  finishReasonSeen: boolean;
  text: string;
  toolCalls: StreamToolCall[];
  finishReason: string;
  firstUsableMs: number | null;
  usage: CompletionUsage | null;
}

/** No character estimates above 1/1.2 tokens (see token-estimate.ts). */
const MIN_CHARS_PER_TOKEN = 1.2;

/** What `consumeStream` has read so far; mutated chunk by chunk. */
interface ReadState {
  text: string;
  finishReason: string;
  chunkCount: number;
  choiceCount: number;
  toolFragmentCount: number;
  finishReasonSeen: boolean;
  refusalSeen: boolean;
  firstUsableMs: number | null;
  usage: CompletionUsage | null;
  readonly toolCalls: Map<number, PendingToolCall>;
  /** Visible output (text, tool-call names and argument fragments), kept only when a visible limit applies. */
  visible: string | null;
  // Each character adds at most 1/MIN_CHARS_PER_TOKEN tokens, so until the visible output grows
  // past this length the estimate cannot pass the limit and need not be recomputed.
  estimateAtChars: number;
}

function createReadState(visibleTokenLimit: number | undefined): ReadState {
  return {
    text: '',
    finishReason: 'stop',
    chunkCount: 0,
    choiceCount: 0,
    toolFragmentCount: 0,
    finishReasonSeen: false,
    refusalSeen: false,
    firstUsableMs: null,
    usage: null,
    toolCalls: new Map(),
    visible: visibleTokenLimit === undefined ? null : '',
    estimateAtChars:
      visibleTokenLimit === undefined ? Number.POSITIVE_INFINITY : visibleTokenLimit * MIN_CHARS_PER_TOKEN,
  };
}

function markUsable(state: ReadState, startedAt: number): void {
  if (state.firstUsableMs === null) state.firstUsableMs = Math.max(0, performance.now() - startedAt);
}

function readToolCalls(
  state: ReadState,
  toolCalls: readonly ToolCallDelta[],
  cbs: StreamCallbacks,
  startedAt: number,
): void {
  state.toolFragmentCount += toolCalls.length;
  if (toolCalls.some((tc) => tc.id || tc.function?.name || tc.function?.arguments)) markUsable(state, startedAt);
  for (const tc of toolCalls) {
    applyToolCallDelta(tc, state.toolCalls, cbs);
    if (state.visible !== null) state.visible += (tc.function?.name ?? '') + (tc.function?.arguments ?? '');
  }
}

function readDelta(
  state: ReadState,
  delta: OpenAI.ChatCompletionChunk.Choice.Delta,
  cbs: StreamCallbacks,
  startedAt: number,
): void {
  if (delta.refusal) state.refusalSeen = true;
  if (delta.content) {
    markUsable(state, startedAt);
    state.text += delta.content;
    if (state.visible !== null) state.visible += delta.content;
    cbs.onTextDelta?.(delta.content);
  }
  if (delta.tool_calls) readToolCalls(state, delta.tool_calls, cbs, startedAt);
}

function readChunk(state: ReadState, chunk: OpenAI.ChatCompletionChunk, cbs: StreamCallbacks, startedAt: number): void {
  state.chunkCount++;
  state.choiceCount += chunk.choices.length;
  // OpenAI-compatible providers emit the final usage in a choices=[] chunk.
  // Capture it BEFORE looking for delta or it silently disappears.
  if (chunk.usage) state.usage = chunk.usage;
  const choice = chunk.choices[0];
  if (choice?.finish_reason) {
    state.finishReason = choice.finish_reason;
    state.finishReasonSeen = true;
  }
  if (choice?.delta) readDelta(state, choice.delta, cbs, startedAt);
}

/** True (and the finish reason forced to `length`) once the visible output passes the limit. */
function stopAtVisibleLimit(state: ReadState, visibleTokenLimit: number | undefined): boolean {
  if (visibleTokenLimit === undefined || state.visible === null || state.visible.length <= state.estimateAtChars) {
    return false;
  }
  const estimate = estimateTokens(state.visible);
  if (estimate > visibleTokenLimit) {
    state.finishReason = 'length';
    state.finishReasonSeen = true;
    return true;
  }
  state.estimateAtChars = state.visible.length + (visibleTokenLimit - estimate) * MIN_CHARS_PER_TOKEN;
  return false;
}

/** Cancellation must request producer cleanup but cannot wait forever on return(). */
function requestIteratorCleanup(iterator: AsyncIterator<OpenAI.ChatCompletionChunk>): void {
  if (!iterator.return) return;
  Promise.resolve()
    .then(() => iterator.return?.())
    .catch(() => {
      aiLogger.warn('Provider stream cleanup failed after cancellation');
    });
}

function consumedFrom(state: ReadState): ConsumedStream {
  return {
    text: state.text,
    finishReason: state.finishReason,
    refusalSeen: state.refusalSeen,
    choiceCount: state.choiceCount,
    toolFragmentCount: state.toolFragmentCount,
    chunkCount: state.chunkCount,
    finishReasonSeen: state.finishReasonSeen,
    firstUsableMs: state.firstUsableMs,
    usage: state.usage,
    toolCalls: [...state.toolCalls.values()].map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.args })),
  };
}

/**
 * `visibleTokenLimit`, when set, stops reading once the visible output (text, tool-call names and
 * argument fragments) passes that many estimated tokens, as if the provider had stopped at
 * `length`. Claude bills hidden thinking against `max_tokens`, so its server cap cannot carry
 * the caller's limit; the reader enforces it instead.
 */
export async function consumeStream(
  stream: AsyncIterable<OpenAI.ChatCompletionChunk>,
  cbs: StreamCallbacks,
  startedAt: number,
  signal?: AbortSignal,
  visibleTokenLimit?: number,
): Promise<ConsumedStream> {
  const state = createReadState(visibleTokenLimit);
  const iterator = stream[Symbol.asyncIterator]();
  let completed = false;
  try {
    while (true) {
      const next = await waitForAbort(() => iterator.next(), signal);
      if (next.done) {
        completed = true;
        break;
      }
      readChunk(state, next.value, cbs, startedAt);
      if (stopAtVisibleLimit(state, visibleTokenLimit)) break;
    }
  } finally {
    if (!completed) requestIteratorCleanup(iterator);
  }
  return consumedFrom(state);
}
