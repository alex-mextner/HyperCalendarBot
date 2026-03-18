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

// Normalize ISO 8601 timestamp to SQLite datetime format "YYYY-MM-DD HH:MM:SS"
function toSqliteDateTime(ts: string): string {
  // "2026-03-18T10:30:00Z" or "2026-03-18T10:30:00.000Z" → "2026-03-18 10:30:00"
  return ts
    .replace('T', ' ')
    .replace(/\.\d+Z?$/, '')
    .replace('Z', '')
    .slice(0, 19);
}

export function handleGetHistory(ctx: AgentContext, input: GetHistoryInput): ToolResult {
  const limit = input.limit ?? 50;
  const before = input.before ? toSqliteDateTime(input.before) : undefined;
  const after = input.after ? toSqliteDateTime(input.after) : undefined;

  // In group context, scope to the group chat history to avoid leaking private DM messages
  if (ctx.isGroup && ctx.groupChatId) {
    const messages = ctx.chatHistory.getRecentByChat(ctx.groupChatId, limit);
    if (messages.length === 0) return { success: true, output: 'No history found.' };
    const lines = messages.map((msg) => {
      const ts = msg.created_at.slice(0, 16);
      const role = msg.role === 'tool' ? 'tool_result' : msg.role;
      return `[${ts}] [${role}] ${formatContent(msg.content)}`;
    });
    return { success: true, output: lines.join('\n') };
  }

  const messages = ctx.chatHistory.search(ctx.user.telegram_id, {
    limit,
    search: input.search,
    before,
    after,
  });

  if (messages.length === 0) {
    return { success: true, output: 'No history found.' };
  }

  const lines = messages.map((msg) => {
    const ts = msg.created_at.slice(0, 16);
    const role = msg.role === 'tool' ? 'tool_result' : msg.role;
    return `[${ts}] [${role}] ${formatContent(msg.content)}`;
  });

  return { success: true, output: lines.join('\n') };
}
