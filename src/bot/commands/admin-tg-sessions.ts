// src/bot/commands/admin-tg-sessions.ts

import type { NotificationLogRepository } from '../../database/repositories/notification-log.repository.ts';
import type { TelegramSessionRepository } from '../../database/repositories/telegram-session.repository.ts';
import type { BotCommandContext } from '../types.ts';

/**
 * /admin_tg_sessions — admin-only: shows telegram session stats and recent deliveries.
 */
export async function handleAdminTgSessions(
  ctx: BotCommandContext,
  sessionRepo: TelegramSessionRepository,
  notifLogRepo: NotificationLogRepository,
  adminId?: number,
): Promise<void> {
  const user = ctx.dbUser;
  if (!user) return;

  if (!adminId || user.telegram_id !== adminId) {
    await ctx.send('Admin only.');
    return;
  }

  const counts = sessionRepo.countByStatus();
  const total = counts.active + counts.expired + counts.revoked;
  const recentDeliveries = notifLogRepo.recentByChannel('mtproto_user', 5);

  const lines: string[] = [
    '<b>Telegram Sessions</b>',
    '',
    `Total: ${total}`,
    `  Active: ${counts.active}`,
    `  Expired: ${counts.expired}`,
    `  Revoked: ${counts.revoked}`,
  ];

  if (recentDeliveries.length > 0) {
    lines.push('', '<b>Recent mtproto_user deliveries</b>', '');
    for (const d of recentDeliveries) {
      const ts = d.created_at.slice(0, 16);
      const status = d.status === 'sent' ? '✓' : d.status === 'failed' ? '✗' : d.status;
      const errPart = d.error ? ` err: ${d.error.slice(0, 80)}` : '';
      lines.push(`[${ts}] ${status} user:${d.user_id} ${d.type}${errPart}`);
    }
  } else {
    lines.push('', 'No mtproto_user deliveries yet.');
  }

  await ctx.send(lines.join('\n'), { parse_mode: 'HTML' });
}
