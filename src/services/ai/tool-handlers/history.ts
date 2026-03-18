// src/services/ai/tool-handlers/history.ts

import { isValid, parseISO } from 'date-fns';
import { type ActivityEvent, formatActivityEvent } from '../activity-event.ts';
import type { AgentContext, ToolResult } from '../types.ts';

interface GetHistoryInput {
  limit?: number;
  search?: string;
  before?: string;
  after?: string;
}

function formatContent(content: string): string {
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((b: { type: string; text?: string }) => b.type === 'text' && b.text)
        .map((b: { text: string }) => b.text)
        .join(' ');
    }
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.kind === 'string') {
      return formatActivityEvent(parsed as ActivityEvent);
    }
  } catch {
    // plain text
  }
  return content;
}

// Normalize a datetime string to SQLite format "YYYY-MM-DD HH:MM:SS" (UTC).
// Accepts ISO 8601 ("2026-03-18T10:30:00Z", "2026-03-18T10:30:00+05:00", "2026-03-18"),
// SQLite format ("2026-03-18 10:30:00"), or partial datetime ("2026-03-18 10:30").
function toSqliteDateTime(ts: string): string {
  // Already SQLite format (space separator) — return as-is, trimmed to 19 chars
  if (/^\d{4}-\d{2}-\d{2} /.test(ts)) {
    return ts.slice(0, 19);
  }
  // ISO 8601 — parseISO handles Z, offsets, date-only, milliseconds
  const date = parseISO(ts);
  if (isValid(date)) {
    return date.toISOString().slice(0, 19).replace('T', ' ');
  }
  return ts.slice(0, 19);
}

export function handleGetHistory(ctx: AgentContext, input: GetHistoryInput): ToolResult {
  const limit = input.limit ?? 50;
  const before = input.before ? toSqliteDateTime(input.before) : undefined;
  const after = input.after ? toSqliteDateTime(input.after) : undefined;

  // In group context, scope to the group chat history to avoid leaking private DM messages.
  // before/after filters are not supported for group history (group timestamps are shared context).
  if (ctx.isGroup && ctx.groupChatId) {
    const messages = ctx.chatHistory.searchByChat(ctx.groupChatId, {
      limit,
      search: input.search,
    });
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
