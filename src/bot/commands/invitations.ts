// src/bot/commands/invitations.ts

import { t } from '../../config/constants.ts';
import type { CalendarEvent, Invitation, InvitationStatus, User } from '../../database/types.ts';
import { formatDateShort, formatTime } from '../../utils/date.ts';
import { escapeHtml } from '../../utils/telegram.ts';
import type { BotCommandContext } from '../types.ts';

interface InvitationRepo {
  getByInvitee(inviteeId: number): Invitation[];
  getByInviter(inviterId: number): Invitation[];
}

interface EventRepo {
  findById(id: number, userId: number): CalendarEvent | null;
}

interface UserRepo {
  findByTelegramId(telegramId: number): User | null;
}

const STATUS_EMOJI: Record<InvitationStatus, string> = {
  pending: '⏳',
  accepted: '✅',
  declined: '❌',
  maybe: '🤔',
  cancelled: '🚫',
  expired: '⌛',
};

function formatInvitationLine(
  inv: Invitation,
  event: CalendarEvent,
  personLabel: string,
  timezone: string,
  lang: string,
): string {
  const emoji = STATUS_EMOJI[inv.status];
  const title = escapeHtml(event.title);
  const date = formatDateShort(event.start_at, timezone, lang);
  const time = event.all_day ? '' : ` ${formatTime(event.start_at, timezone)}`;
  return `${emoji} <b>${title}</b>\n   ${date}${time} · ${personLabel}`;
}

function getUserName(user: User | null, telegramId: number): string {
  if (user?.first_name) return user.first_name;
  if (user?.username) return `@${user.username}`;
  return `#${telegramId}`;
}

export async function handleInvitations(
  ctx: BotCommandContext,
  invRepo: InvitationRepo,
  eventRepo: EventRepo,
  userRepo?: UserRepo,
): Promise<void> {
  const user = ctx.dbUser;
  if (!user) return;
  const userId = user.telegram_id;
  const lang = user.language as 'en' | 'ru';
  const timezone = user.timezone;
  const messages = t(lang);

  const received = invRepo.getByInvitee(userId);
  const sent = invRepo.getByInviter(userId);

  const receivedLines: string[] = [];
  for (const inv of received) {
    const event = eventRepo.findById(inv.event_id, inv.inviter_id);
    if (!event) continue;
    const inviter = userRepo?.findByTelegramId(inv.inviter_id) ?? null;
    const personLabel = messages.invitations_from(getUserName(inviter, inv.inviter_id));
    receivedLines.push(formatInvitationLine(inv, event, personLabel, timezone, lang));
  }

  const sentLines: string[] = [];
  for (const inv of sent) {
    const event = eventRepo.findById(inv.event_id, userId);
    if (!event) continue;
    const invitee = userRepo?.findByTelegramId(inv.invitee_id) ?? null;
    const personLabel = messages.invitations_to(getUserName(invitee, inv.invitee_id));
    sentLines.push(formatInvitationLine(inv, event, personLabel, timezone, lang));
  }

  if (receivedLines.length === 0 && sentLines.length === 0) {
    const emptyMsg = lang === 'ru' ? '📨 Нет приглашений.' : '📨 No invitations.';
    await ctx.send(emptyMsg);
    return;
  }

  const sections: string[] = [];

  if (receivedLines.length > 0) {
    const header = lang === 'ru' ? '📥 <b>Полученные</b>' : '📥 <b>Received</b>';
    sections.push(`${header}\n${receivedLines.join('\n')}`);
  }

  if (sentLines.length > 0) {
    const header = lang === 'ru' ? '📤 <b>Отправленные</b>' : '📤 <b>Sent</b>';
    sections.push(`${header}\n${sentLines.join('\n')}`);
  }

  await ctx.send(sections.join('\n\n'), { parse_mode: 'HTML' });
}
