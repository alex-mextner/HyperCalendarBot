// src/services/ai/tool-handlers/action-log.ts

import { t } from '../../../config/constants.ts';
import { telegramMessageLink } from '../../../database/repositories/action-log.repository.ts';
import type { AgentContext, ToolHandlerMeta, ToolResult } from '../types.ts';
import { hasInvalidReflectionScope, normalizeReflectionLimit, reflectionBoundary } from './reflection.ts';

interface GetActionLogInput {
  target_user_id?: number;
  event_id?: number;
  action_type?: string;
  action_name?: string;
  after?: string;
  before?: string;
  limit?: number;
}

export function handleGetActionLog(
  ctx: Pick<AgentContext, 'user' | 'chatId' | 'isGroup' | 'groupChatId' | 'actionLogRepo'>,
  input: GetActionLogInput,
): ToolResult {
  if (!ctx.actionLogRepo) {
    return { success: false, error: 'Action log not available' };
  }

  if (hasInvalidReflectionScope(ctx)) {
    return { success: false, error: t(ctx.user.language).aiTools.history.scopeUnavailable };
  }
  const limit = normalizeReflectionLimit(input.limit, 30);
  let before: string | undefined;
  let after: string | undefined;
  try {
    before = reflectionBoundary(input.before);
    after = reflectionBoundary(input.after);
  } catch {
    return { success: false, error: 'Invalid before/after timestamp. Use YYYY-MM-DD or a UTC/offset datetime.' };
  }

  const entries = ctx.actionLogRepo.query({
    user_id: ctx.user.telegram_id,
    chat_id: ctx.isGroup ? ctx.groupChatId : undefined,
    target_event_id: input.event_id,
    target_user_id: input.target_user_id,
    action_type: input.action_type,
    action_name: input.action_name,
    after,
    before,
    limit,
  });

  if (entries.length === 0) {
    return {
      success: true,
      output: t(ctx.user.language).aiTools.actionLog.notFound,
    };
  }

  const lines = entries.map((entry) => {
    const ts = entry.created_at.slice(0, 16);
    const status = entry.success ? '✓' : '✗';
    const link = entry.message_id ? telegramMessageLink(entry.chat_id, entry.message_id) : null;
    const linkStr = link ? ` [msg](${link})` : '';

    const parts = [`[${ts}] ${status} ${entry.action_type}:${entry.action_name}`];
    if (entry.input_summary) parts.push(`  input: ${entry.input_summary}`);
    if (entry.result_summary) parts.push(`  result: ${entry.result_summary.slice(0, 150)}`);
    if (entry.target_event_id) parts.push(`  event_id: ${entry.target_event_id}`);
    if (entry.target_user_id) parts.push(`  target_user: ${entry.target_user_id}`);
    if (linkStr) parts.push(`  link: ${linkStr}`);

    return parts.join('\n');
  });

  return { success: true, output: lines.join('\n\n') };
}
handleGetActionLog.meta = { readonly: true, skipActionLog: true, skipPersist: true } satisfies ToolHandlerMeta;
