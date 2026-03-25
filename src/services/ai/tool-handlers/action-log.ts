// src/services/ai/tool-handlers/action-log.ts

import { isValid, parseISO } from 'date-fns';
import { t } from '../../../config/constants.ts';
import { telegramMessageLink } from '../../../database/repositories/action-log.repository.ts';
import type { AgentContext, ToolResult } from '../types.ts';

interface GetActionLogInput {
  event_id?: number;
  action_type?: string;
  action_name?: string;
  after?: string;
  before?: string;
  limit?: number;
}

function toSqliteDateTime(ts: string): string {
  if (/^\d{4}-\d{2}-\d{2} /.test(ts)) return ts.slice(0, 19);
  const date = parseISO(ts);
  if (isValid(date)) return date.toISOString().slice(0, 19).replace('T', ' ');
  return ts.slice(0, 19);
}

export function handleGetActionLog(ctx: AgentContext, input: GetActionLogInput): ToolResult {
  if (!ctx.actionLogRepo) {
    return { success: false, error: 'Action log not available' };
  }

  const limit = input.limit ?? 30;
  const after = input.after ? toSqliteDateTime(input.after) : undefined;
  const before = input.before ? toSqliteDateTime(input.before) : undefined;

  const entries = ctx.actionLogRepo.query({
    user_id: ctx.user.telegram_id,
    target_event_id: input.event_id,
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
