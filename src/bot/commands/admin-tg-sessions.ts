// src/bot/commands/admin-tg-sessions.ts

import type { NotificationLogRepository } from '../../database/repositories/notification-log.repository.ts';
import type { TelegramSessionRepository } from '../../database/repositories/telegram-session.repository.ts';
import type { BotCommandContext } from '../types.ts';

/**
 * /admin_tg_sessions — admin-only: shows telegram session stats and recent deliveries.
 * /admin_tg_sessions <userId> — detail view for a specific user.
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

  const args = (ctx.args ?? '').trim();
  const targetUserId = args ? Number.parseInt(args, 10) : null;

  if (targetUserId !== null && !Number.isNaN(targetUserId)) {
    await showUserDetail(ctx, sessionRepo, notifLogRepo, targetUserId);
    return;
  }

  await showOverview(ctx, sessionRepo, notifLogRepo);
}

async function showOverview(
  ctx: BotCommandContext,
  sessionRepo: TelegramSessionRepository,
  notifLogRepo: NotificationLogRepository,
): Promise<void> {
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

async function showUserDetail(
  ctx: BotCommandContext,
  sessionRepo: TelegramSessionRepository,
  notifLogRepo: NotificationLogRepository,
  targetUserId: number,
): Promise<void> {
  const session = sessionRepo.findByUserId(targetUserId);
  const stats = notifLogRepo.getDeliveryStats(targetUserId);

  const lines: string[] = [`<b>Session detail: user ${targetUserId}</b>`, ''];

  if (session) {
    lines.push(
      `Status: ${session.status}`,
      `Created: ${session.created_at}`,
      `Updated: ${session.updated_at}`,
      `TZ consent: ${session.tz_detection_consent_at ?? 'not asked'}`,
    );
  } else {
    lines.push('No session found.');
  }

  lines.push('', `Deliveries (mtproto_user): ${stats.total}`);
  if (stats.lastError) {
    lines.push(`Last error: ${stats.lastError.slice(0, 200)}`);
  }

  await ctx.send(lines.join('\n'), { parse_mode: 'HTML' });
}
