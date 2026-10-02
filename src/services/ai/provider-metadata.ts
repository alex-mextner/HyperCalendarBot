import type OpenAI from 'openai';
import { z } from 'zod';

/** Opaque protocol state, not reasoning text. Preserve it only on the original tool call. */
export const googleToolMetadataSchema = z.object({
  google: z.object({ thought_signature: z.string().min(1).max(131_072) }),
});
export type GoogleToolMetadata = z.infer<typeof googleToolMetadataSchema>;

/** Do not expose provider-scoped opaque state to a fallback vendor. Never mutate stored history. */
export function withoutGoogleMetadata(
  messages: readonly OpenAI.ChatCompletionMessageParam[],
): OpenAI.ChatCompletionMessageParam[] {
  return messages.map((message) => {
    if (message.role !== 'assistant' || !message.tool_calls?.length) return message;
    return {
      ...message,
      tool_calls: message.tool_calls.map((call) => {
        if (!('extra_content' in call)) return call;
        const { extra_content: _metadata, ...plain } = call;
        return plain;
      }),
    };
  });
}
