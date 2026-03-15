// src/bot/commands/invitations.ts

import type { CalendarEvent, Invitation, InvitationStatus } from '../../database/types.ts';
import type { BotCommandContext } from '../types.ts';

interface InvitationRepo {
  getByInvitee(inviteeId: number): Invitation[];
  getByInviter(inviterId: number): Invitation[];
}

interface EventRepo {
  findById(id: number, userId: number): CalendarEvent | null;
}

const STATUS_EMOJI: Record<InvitationStatus, string> = {
  pending: '⏳',
  accepted: '✅',
  declined: '❌',
  maybe: '🤔',
  cancelled: '🚫',
  expired: '⌛',
};

function formatInvitationLine(inv: Invitation, event: CalendarEvent): string {
  const emoji = STATUS_EMOJI[inv.status];
  return `${emoji} <b>${event.title}</b>`;
}

export async function handleInvitations(
  ctx: BotCommandContext,
  invRepo: InvitationRepo,
  eventRepo: EventRepo,
): Promise<void> {
  const userId = ctx.dbUser.telegram_id;
  const lang = ctx.dbUser.language as 'en' | 'ru';

  const received = invRepo.getByInvitee(userId);
  const sent = invRepo.getByInviter(userId);

  const receivedLines: string[] = [];
  for (const inv of received) {
    const event = eventRepo.findById(inv.event_id, inv.inviter_id);
    if (!event) continue;
    receivedLines.push(formatInvitationLine(inv, event));
  }

  const sentLines: string[] = [];
  for (const inv of sent) {
    const event = eventRepo.findById(inv.event_id, userId);
    if (!event) continue;
    sentLines.push(formatInvitationLine(inv, event));
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
