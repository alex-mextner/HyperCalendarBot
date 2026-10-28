// Repairs stored history into a message list OpenAI-compatible providers accept.
import type OpenAI from 'openai';

export type MessageParam = OpenAI.ChatCompletionMessageParam;

export function isToolMessage(msg: MessageParam): msg is OpenAI.ChatCompletionToolMessageParam {
  return msg.role === 'tool';
}

/**
 * Pull each tool-call block back together before sanitizeMessages checks it.
 * Other chat_history rows can be saved between an assistant tool-call turn and
 * its results — a button press, an edit, another group member's message — and
 * sanitizeMessages would then drop the whole pair. Those rows move to just after
 * the call's last result, keeping their relative order. A call whose results are
 * not all present later is left in place for sanitizeMessages to strip.
 */
export function regroupToolCallBlocks(messages: MessageParam[]): MessageParam[] {
  const ordered = [...messages];
  for (let i = 0; i < ordered.length; i++) {
    const msg = ordered[i]!;
    if (msg.role !== 'assistant' || !msg.tool_calls?.length) continue;
    const pendingIds = new Set(msg.tool_calls.map((tc) => tc.id));
    const results: MessageParam[] = [];
    const interleaved: MessageParam[] = [];
    let j = i + 1;
    for (; j < ordered.length && pendingIds.size > 0; j++) {
      const next = ordered[j]!;
      if (isToolMessage(next) && pendingIds.delete(next.tool_call_id)) results.push(next);
      else interleaved.push(next);
    }
    if (pendingIds.size > 0 || interleaved.length === 0) continue;
    ordered.splice(i + 1, j - i - 1, ...results, ...interleaved);
    // Resume at the first interleaved row, which may itself be another call
    // block; the moved results before it are tool messages, never call blocks.
    i += results.length;
  }
  return ordered;
}

/**
 * Sanitize message history before handing it to the model.
 *
 * Three invariants, all enforced to keep OpenAI-compatible providers happy:
 *   1. The first non-system message must be a user message. If the history
 *      begins with an assistant turn (e.g. a leading bot reply after
 *      migration), insert a '...' user placeholder.
 *   2. Every assistant message with `tool_calls` must be followed by one
 *      tool-role message per tool_call_id. If any id is unmatched — usually
 *      because a previous run crashed mid-loop and left an orphaned assistant
 *      turn in `chat_history` — strip the `tool_calls` field entirely and
 *      fall back to the text content (or drop the message if it's empty).
 *      Without this, OpenAI returns `400 - An assistant message with
 *      'tool_calls' must be followed by tool messages`.
 *   3. A tool-role message is sent only inside the complete call block directly
 *      above it, once per tool_call_id. Any other result is dropped: most often
 *      the history window starts on a result whose call row was cut off. Chat
 *      templates resolve a tool message's name from the call it answers and can
 *      reject an orphaned result.
 */
export function sanitizeMessages(messages: MessageParam[]): MessageParam[] {
  const paired: MessageParam[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    // Complete call blocks consume their results below; a result reaching here answers nothing.
    if (isToolMessage(msg)) continue;
    if (!isAssistantWithToolCalls(msg)) {
      paired.push(msg);
      continue;
    }
    const block = resolveCallBlock(messages, i, msg);
    paired.push(...block.kept);
    i = block.lastIndex;
  }
  return withLeadingUser(paired);
}

type AssistantMessageParam = OpenAI.ChatCompletionAssistantMessageParam;

function isAssistantWithToolCalls(msg: MessageParam): msg is AssistantMessageParam {
  return msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
}

/**
 * What survives of one assistant tool-call turn and the tool messages directly after it, and the
 * index of the last message it consumed. A complete block is kept whole (each result once); an
 * orphaned one is stripped to its text, or dropped when it has none, together with its results,
 * which answer no surviving call.
 */
function resolveCallBlock(
  messages: MessageParam[],
  start: number,
  msg: AssistantMessageParam,
): { kept: MessageParam[]; lastIndex: number } {
  const expectedIds = new Set((msg.tool_calls ?? []).map((tc) => tc.id));
  // The consecutive tool messages following the call turn: the only candidates for its results.
  const results: OpenAI.ChatCompletionToolMessageParam[] = [];
  let end = start + 1;
  while (end < messages.length) {
    const next = messages[end]!;
    if (!isToolMessage(next)) break;
    results.push(next);
    end++;
  }
  const foundIds = new Set(results.flatMap((toolMsg) => (toolMsg.tool_call_id ? [toolMsg.tool_call_id] : [])));
  const lastIndex = end - 1;

  if ([...expectedIds].every((id) => foundIds.has(id))) {
    const emittedIds = new Set<string>();
    const kept: MessageParam[] = [msg];
    for (const toolMsg of results) {
      if (!expectedIds.has(toolMsg.tool_call_id) || emittedIds.has(toolMsg.tool_call_id)) continue;
      kept.push(toolMsg);
      emittedIds.add(toolMsg.tool_call_id);
    }
    return { kept, lastIndex };
  }

  // Orphaned tool_calls — strip them. Preserve any text content as a fallback;
  // otherwise drop the assistant turn altogether so we don't leave an empty
  // `assistant` message in the list.
  const textContent = typeof msg.content === 'string' ? msg.content.trim() : '';
  return { kept: textContent ? [{ role: 'assistant', content: textContent }] : [], lastIndex };
}

/** The first non-system message must be a user message: a leading assistant turn gets a '...' user before it. */
function withLeadingUser(paired: MessageParam[]): MessageParam[] {
  const result: MessageParam[] = [];
  let seenNonSystem = false;
  for (const msg of paired) {
    if (!seenNonSystem && msg.role !== 'system') {
      if (msg.role !== 'user') result.push({ role: 'user', content: '...' });
      seenNonSystem = true;
    }
    result.push(msg);
  }
  return result;
}
