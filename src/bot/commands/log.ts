// src/bot/commands/log.ts

import type { ActionLogRepository } from '../../database/repositories/action-log.repository.ts';
import { telegramMessageLink } from '../../database/repositories/action-log.repository.ts';
import type { UserActionLog } from '../../database/types.ts';
import { splitMessage } from '../../utils/telegram.ts';
import type { BotCommandContext } from '../types.ts';

/**
 * /log [user_id] [limit] — admin-only command to browse action log.
 * Usage:
 *   /log              — last 20 entries for all users
 *   /log 123          — last 20 entries for user 123
 *   /log 123 50       — last 50 entries for user 123
 *   /log event:42     — all actions on event #42
 */
export async function handleLog(
  ctx: BotCommandContext,
  actionLogRepo: ActionLogRepository,
  adminId?: number,
): Promise<void> {
  const user = ctx.dbUser;
  if (!user) return;

  if (!adminId || user.telegram_id !== adminId) {
    await ctx.send('Admin only.');
    return;
  }

  const args = (ctx.args ?? '').trim();
  const parts = args.split(/\s+/).filter(Boolean);

  // Parse "event:N" filter
  const eventArg = parts.find((p) => p.startsWith('event:'));
  if (eventArg) {
    const eventId = Number.parseInt(eventArg.slice(6), 10);
    if (Number.isNaN(eventId)) {
      await ctx.send('Invalid event ID.');
      return;
    }
    const entries = actionLogRepo.getByEvent(eventId, 50);
    await sendEntries(ctx, entries, `Action log for event #${eventId}`);
    return;
  }

  const userId = parts[0] ? Number.parseInt(parts[0], 10) : undefined;
  const limit = parts[1] ? Number.parseInt(parts[1], 10) : 20;

  if (userId && Number.isNaN(userId)) {
    await ctx.send('Usage: /log [user_id] [limit] or /log event:ID');
    return;
  }

  const entries = userId ? actionLogRepo.getRecent(userId, limit) : actionLogRepo.query({ limit });
  const title = userId ? `Action log for user ${userId}` : 'Recent action log';
  await sendEntries(ctx, entries, title);
}

async function sendEntries(ctx: BotCommandContext, entries: UserActionLog[], title: string): Promise<void> {
  if (entries.length === 0) {
    await ctx.send(`${title}: no entries.`);
    return;
  }

  const lines = entries.map((e) => {
    const ts = e.created_at.slice(0, 16);
    const status = e.success ? '✓' : '✗';
    const link = e.message_id ? telegramMessageLink(e.chat_id, e.message_id) : null;
    const parts = [`[${ts}] ${status} ${e.action_type}:${e.action_name} (user:${e.user_id})`];
    if (e.input_summary) parts.push(`  in: ${e.input_summary.slice(0, 100)}`);
    if (e.target_event_id) parts.push(`  event: #${e.target_event_id}`);
    if (link) parts.push(`  ${link}`);
    return parts.join('\n');
  });

  const text = `<b>${title}</b> (${entries.length})\n\n<pre>${lines.join('\n\n')}</pre>`;

  for (const chunk of splitMessage(text)) {
    await ctx.send(chunk, { parse_mode: 'HTML' });
  }
}
