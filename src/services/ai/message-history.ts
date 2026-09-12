import type OpenAI from 'openai';

type MessageParam = OpenAI.ChatCompletionMessageParam;

/**
 * Sanitize message history before handing it to the model.
 *
 * Two invariants, both enforced to keep OpenAI-compatible providers happy:
 *   1. The first non-system message must be a user message. If the history
 *      begins with an assistant or tool turn (e.g. a leading bot reply after
 *      migration), insert a '...' user placeholder.
 *   2. Every assistant message with `tool_calls` must be followed by one
 *      tool-role message per tool_call_id. If any id is unmatched — usually
 *      because a previous run crashed mid-loop and left an orphaned assistant
 *      turn in `chat_history` — strip the `tool_calls` field entirely and
 *      fall back to the text content (or drop the message if it's empty).
 *      Without this, OpenAI returns `400 - An assistant message with
 *      'tool_calls' must be followed by tool messages`.
 */
export function sanitizeMessages(messages: MessageParam[]): MessageParam[] {
  const paired: MessageParam[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    // Tool results are consumed only with their immediately preceding complete
    // assistant call block below. A standalone result has no trustworthy name/ID
    // binding and makes Groq's Harmony renderer reject the whole request.
    if (msg.role === 'tool') continue;
    if (
      msg.role !== 'assistant' ||
      !('tool_calls' in msg) ||
      !Array.isArray(msg.tool_calls) ||
      msg.tool_calls.length === 0
    ) {
      paired.push(msg);
      continue;
    }
    // Collect tool_call_ids from the following consecutive tool messages.
    const expectedIds = new Set(msg.tool_calls.map((tc) => tc.id));
    const foundIds = new Set<string>();
    let j = i + 1;
    while (j < messages.length && messages[j]!.role === 'tool') {
      const toolMsg = messages[j] as OpenAI.ChatCompletionToolMessageParam;
      if (toolMsg.tool_call_id) foundIds.add(toolMsg.tool_call_id);
      j++;
    }
    const allPaired = expectedIds.size > 0 && [...expectedIds].every((id) => foundIds.has(id));
    if (allPaired) {
      paired.push(msg);
      const emittedIds = new Set<string>();
      for (let k = i + 1; k < j; k++) {
        const toolMsg = messages[k] as OpenAI.ChatCompletionToolMessageParam;
        if (expectedIds.has(toolMsg.tool_call_id) && !emittedIds.has(toolMsg.tool_call_id)) {
          paired.push(toolMsg);
          emittedIds.add(toolMsg.tool_call_id);
        }
      }
      i = j - 1;
      continue;
    }
    // Orphaned tool_calls — strip them. Preserve any text content as a fallback;
    // otherwise drop the assistant turn altogether so we don't leave an empty
    // `assistant` message in the list.
    const textContent = typeof msg.content === 'string' ? msg.content.trim() : '';
    if (textContent) {
      paired.push({ role: 'assistant', content: textContent });
    }
    // None of the trailing results has a surviving call block here. Preserve
    // the existing incomplete-block fallback, but never carry unrelated orphan
    // results into a subsequent provider request.
    i = j - 1; // advance past the orphaned tool block
  }

  // Second pass: ensure the first non-system message is a user.
  const result: MessageParam[] = [];
  let seenNonSystem = false;
  for (const msg of paired) {
    if (msg.role === 'system') {
      result.push(msg);
      continue;
    }
    if (!seenNonSystem) {
      if (msg.role !== 'user') {
        result.push({ role: 'user', content: '...' });
      }
      seenNonSystem = true;
    }
    result.push(msg);
  }
  return result;
}
