// src/bot/commands/invitations.ts

import { type Messages, t } from '../../config/constants.ts';
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

/** Which side of the invitation the viewer is on; decides whose event it is and which person is shown. */
interface InvitationDirection {
  /** Owner of the invited event (used to look it up). */
  eventOwnerId: (inv: Invitation, viewerId: number) => number;
  /** The other party shown on the line. */
  counterpartId: (inv: Invitation) => number;
  personLabel: (messages: Messages, name: string) => string;
}

const RECEIVED: InvitationDirection = {
  eventOwnerId: (inv) => inv.inviter_id,
  counterpartId: (inv) => inv.inviter_id,
  personLabel: (messages, name) => messages.invitations_from(name),
};

const SENT: InvitationDirection = {
  eventOwnerId: (_inv, viewerId) => viewerId,
  counterpartId: (inv) => inv.invitee_id,
  personLabel: (messages, name) => messages.invitations_to(name),
};

interface InvitationLinesScope {
  eventRepo: EventRepo;
  userRepo: UserRepo | undefined;
  viewerId: number;
  timezone: string;
  lang: 'en' | 'ru';
}

function buildInvitationLines(
  invitations: Invitation[],
  direction: InvitationDirection,
  scope: InvitationLinesScope,
): string[] {
  const { eventRepo, userRepo, viewerId, timezone, lang } = scope;
  const messages = t(lang);
  const lines: string[] = [];
  for (const inv of invitations) {
    const event = eventRepo.findById(inv.event_id, direction.eventOwnerId(inv, viewerId));
    if (!event) continue;
    const counterpartId = direction.counterpartId(inv);
    const counterpart = userRepo?.findByTelegramId(counterpartId) ?? null;
    const personLabel = direction.personLabel(messages, getUserName(counterpart, counterpartId));
    lines.push(formatInvitationLine(inv, event, personLabel, timezone, lang));
  }
  return lines;
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
  const scope: InvitationLinesScope = { eventRepo, userRepo, viewerId: userId, timezone: user.timezone, lang };

  const received = invRepo.getByInvitee(userId);
  const sent = invRepo.getByInviter(userId);

  const receivedLines = buildInvitationLines(received, RECEIVED, scope);
  const sentLines = buildInvitationLines(sent, SENT, scope);

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
