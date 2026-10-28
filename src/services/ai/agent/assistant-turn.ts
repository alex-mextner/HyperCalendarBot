// What of an assistant turn is worth persisting to chat_history: its tool calls minus the
// skip-persist ones, and nothing at all when no content or call is left.
import type OpenAI from 'openai';
import type { MessageParam } from './message-sanitizer.ts';

function toolCallsOf(message: MessageParam): OpenAI.ChatCompletionMessageToolCall[] {
  return message.role === 'assistant' && Array.isArray(message.tool_calls) ? message.tool_calls : [];
}

/**
 * The turn without the tool calls whose ids are in `skipIds`, so the persisted tool_calls and
 * tool_results stay in sync. When every call is skipped the turn keeps only its text content.
 */
export function withoutSkippedToolCalls(message: MessageParam, skipIds?: Set<string>): MessageParam {
  const calls = toolCallsOf(message);
  if (!skipIds?.size || calls.length === 0 || message.role !== 'assistant') return message;
  const kept = calls.filter((tc) => !skipIds.has(tc.id));
  if (kept.length === calls.length) return message;
  if (kept.length > 0) return { ...message, tool_calls: kept };
  return { role: 'assistant', content: typeof message.content === 'string' ? message.content : null };
}

/**
 * False for an empty assistant turn (no content, no tool_calls) — what is left when every call
 * of a round was skip-persist (e.g. only get_history was called).
 */
export function hasPersistablePayload(message: MessageParam): boolean {
  const hasContent =
    Boolean(message.content) && (typeof message.content !== 'string' || message.content.trim().length > 0);
  return hasContent || toolCallsOf(message).length > 0;
}
