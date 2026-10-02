// src/services/ai/tool-handlers/history.ts

import { z } from 'zod';
import { t } from '../../../config/constants.ts';
import { jsonCodec } from '../../../utils/json-codec.ts';
import { type ActivityEvent, formatActivityEvent } from '../activity-event.ts';
import type { AgentContext, ToolHandlerMeta, ToolResult } from '../types.ts';
import { hasInvalidReflectionScope, normalizeReflectionLimit, reflectionBoundary } from './reflection.ts';

interface GetHistoryInput {
  limit?: number;
  search?: string;
  before?: string;
  after?: string;
}

const ContentBlocksCodec = jsonCodec(z.array(z.object({ type: z.string(), text: z.string().optional() })));
const ActivityEventCodec = jsonCodec(z.object({ kind: z.string() }).passthrough());

function formatContent(content: string): string {
  const blocksResult = ContentBlocksCodec.safeParse(content);
  if (blocksResult.success) {
    return blocksResult.data
      .filter((b) => b.type === 'text' && b.text)
      .map((b) => b.text!)
      .join(' ');
  }
  const activityResult = ActivityEventCodec.safeParse(content);
  if (activityResult.success) {
    return formatActivityEvent(activityResult.data as ActivityEvent);
  }
  return content;
}

export function handleGetHistory(
  ctx: Pick<AgentContext, 'user' | 'chatId' | 'isGroup' | 'groupChatId' | 'chatHistory'>,
  input: GetHistoryInput,
): ToolResult {
  if (hasInvalidReflectionScope(ctx)) {
    return { success: false, error: t(ctx.user.language).aiTools.history.scopeUnavailable };
  }
  const limit = normalizeReflectionLimit(input.limit, 50);
  let before: string | undefined;
  let after: string | undefined;
  try {
    before = reflectionBoundary(input.before);
    after = reflectionBoundary(input.after);
  } catch {
    return { success: false, error: 'Invalid before/after timestamp. Use YYYY-MM-DD or a UTC/offset datetime.' };
  }

  // In group context, scope to the group chat history to avoid leaking private DM messages.
  if (ctx.isGroup && ctx.groupChatId) {
    const messages = ctx.chatHistory.searchByChat(ctx.groupChatId, {
      limit,
      search: input.search,
      before,
      after,
    });
    if (messages.length === 0)
      return {
        success: true,
        output: t(ctx.user.language).aiTools.history.notFound,
      };
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
    return {
      success: true,
      output: t(ctx.user.language).aiTools.history.notFound,
    };
  }

  const lines = messages.map((msg) => {
    const ts = msg.created_at.slice(0, 16);
    const role = msg.role === 'tool' ? 'tool_result' : msg.role;
    return `[${ts}] [${role}] ${formatContent(msg.content)}`;
  });

  return { success: true, output: lines.join('\n') };
}
handleGetHistory.meta = { readonly: true, skipActionLog: true, skipPersist: true } satisfies ToolHandlerMeta;
