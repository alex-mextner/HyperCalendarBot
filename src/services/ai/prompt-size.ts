// src/services/ai/prompt-size.ts
// Estimated size of an outgoing request, split into the parts a compaction can change: system prompt, tool
// catalog, history and the user's last message. Computed once per round at the point where the request is
// assembled. These are estimates from token-estimate.ts; the provider's prompt_tokens stays the truth. Only
// numbers come out: no prompt text is kept.

import type OpenAI from 'openai';
import type { AiUsageEvent } from '../../database/repositories/ai-usage.repository.ts';
import { estimateTokens } from './token-estimate.ts';

/** Estimated prompt components in tokens; null is unknown (a skipped attempt or a row from before the sizes). */
export type PromptSize = Pick<
  AiUsageEvent,
  'systemPromptTokens' | 'toolCatalogTokens' | 'historyTokens' | 'userTokens' | 'toolCount' | 'messageCount'
>;

export const UNKNOWN_PROMPT_SIZE: PromptSize = {
  systemPromptTokens: null,
  toolCatalogTokens: null,
  historyTokens: null,
  userTokens: null,
  toolCount: null,
  messageCount: null,
};

type Message = OpenAI.ChatCompletionMessageParam;

/** The text a message contributes: its text parts, then the name and arguments of its tool calls. Images are ignored. */
function textOf(message: Message): string {
  const { content } = message;
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    for (const part of content) if (part.type === 'text') text += part.text;
  }
  if (message.role === 'assistant') {
    for (const call of message.tool_calls ?? []) {
      if (call.type === 'function') text += call.function.name + call.function.arguments;
    }
  }
  return text;
}

export function estimatePromptSize(
  messages: readonly Message[],
  tools: readonly OpenAI.ChatCompletionTool[] | undefined,
): PromptSize {
  const lastIndex = messages.length - 1;
  let systemTokens = 0;
  let historyTokens = 0;
  let userTokens = 0;
  messages.forEach((message, index) => {
    const tokens = estimateTokens(textOf(message));
    if (message.role === 'system' || message.role === 'developer') systemTokens += tokens;
    else if (index === lastIndex && message.role === 'user') userTokens = tokens;
    else historyTokens += tokens;
  });
  const toolCount = tools?.length ?? 0;
  return {
    systemPromptTokens: systemTokens,
    toolCatalogTokens: toolCount === 0 ? 0 : estimateTokens(JSON.stringify(tools)),
    historyTokens,
    userTokens,
    toolCount,
    messageCount: messages.length,
  };
}
