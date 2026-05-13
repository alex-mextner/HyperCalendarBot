import type OpenAI from 'openai';

const CHARS_PER_TOKEN = 3.5;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

type MessageParam = OpenAI.ChatCompletionMessageParam;

function extractContent(msg: MessageParam): string {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (typeof block === 'object' && block !== null && 'text' in block && typeof block.text === 'string')
          return block.text;
        return '';
      })
      .join('');
  }
  return '';
}

export function estimateMessageListTokens(messages: MessageParam[]): number {
  return messages.reduce((sum, msg) => sum + estimateTokens(extractContent(msg)), 0);
}
