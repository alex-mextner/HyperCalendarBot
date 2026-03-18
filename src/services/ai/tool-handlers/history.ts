// src/services/ai/tool-handlers/history.ts

import type { AgentContext, ToolResult } from '../types.ts';

interface GetHistoryInput {
  limit?: number;
  search?: string;
  before?: string;
  after?: string;
}

type ActivityEvent =
  | { kind: 'button'; label: string; detail?: string }
  | { kind: 'command'; name: string }
  | { kind: 'bot'; text: string };

function formatContent(content: string): string {
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      // ContentBlock array — extract text
      return parsed
        .filter((b: { type: string; text?: string }) => b.type === 'text' && b.text)
        .map((b: { text: string }) => b.text)
        .join(' ');
    }
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.kind === 'string') {
      const event = parsed as ActivityEvent;
      switch (event.kind) {
        case 'button':
          return `[Button: "${event.label}"]${event.detail ? ` (${event.detail})` : ''}`;
        case 'command':
          return `[Command: ${event.name}]`;
        case 'bot':
          return `[Bot: ${event.text}]`;
      }
    }
  } catch {
    // plain text
  }
  return content;
}

export function handleGetHistory(ctx: AgentContext, input: GetHistoryInput): ToolResult {
  const messages = ctx.chatHistory.search(ctx.user.telegram_id, {
    limit: input.limit ?? 50,
    search: input.search,
    before: input.before,
    after: input.after,
  });

  if (messages.length === 0) {
    return { success: true, output: 'No history found.' };
  }

  const lines = messages.map((msg) => {
    const ts = msg.created_at.slice(0, 16);
    const role = msg.role === 'tool' ? 'tool_result' : msg.role;
    const text = formatContent(msg.content);
    return `[${ts}] [${role}] ${text}`;
  });

  return { success: true, output: lines.join('\n') };
}
