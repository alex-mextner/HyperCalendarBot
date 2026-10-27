// src/bot/handlers/message/propose-time.ts
// "Propose another time" reply flow: parse the invitee's typed time, record it and notify the inviter.

import { t } from '../../../config/constants.ts';
import type { User } from '../../../database/types.ts';
import { parseSimpleDate } from '../../../utils/date.ts';
import { formatProposedTime } from '../../../utils/invite-time-format.ts';
import { cmdLogger } from '../../../utils/logger.ts';
import type { BotCommandContext } from '../../types.ts';
import type { MessageHandlerDeps } from './types.ts';

/** Replace the invitation card with the "proposal sent" text; a failed edit is logged, never thrown. */
function updateInvitationCard(
  invitation: { message_id?: number | null; chat_id?: number | null } | null | undefined,
  text: string,
  deps: MessageHandlerDeps,
): void {
  if (!invitation?.message_id || !invitation.chat_id || !deps.editMessage) return;
  deps.editMessage(invitation.chat_id, invitation.message_id, text).catch((e: unknown) => {
    cmdLogger.error({ err: e }, 'Failed to edit invitation message after propose');
  });
}

export async function handleProposeTimeInput(
  ctx: BotCommandContext,
  text: string,
  user: User,
  session: { invitationId: number },
  deps: MessageHandlerDeps,
): Promise<void> {
  const lang = user.language as 'en' | 'ru';
  const chatId = ctx.chatId;
  if (!chatId) return;

  const parsed = parseSimpleDate(text, user.timezone);

  if (!parsed) {
    deps.proposeTimeSessions?.set(user.telegram_id, session);
    await ctx.send(lang === 'ru' ? 'Не могу распознать время. Попробуй ещё раз:' : 'Could not parse time. Try again:');
    return;
  }

  const proposedTime = parsed.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const result = deps.invitationService?.proposeTime(session.invitationId, user.telegram_id, proposedTime);

  if (!result?.success) {
    await ctx.send(result?.reason ? t(lang)[result.reason] : (result?.error ?? (lang === 'ru' ? 'Ошибка' : 'Error')));
    return;
  }

  const formattedTime = formatProposedTime(proposedTime, user.timezone, lang);
  await ctx.send(t(lang).invite_propose_sent(formattedTime), { parse_mode: 'HTML' });

  const invitation = deps.invitationRepo?.findById(session.invitationId);
  updateInvitationCard(invitation, t(lang).invite_propose_sent(formattedTime), deps);

  if (deps.notifyInviterProposal) {
    const event = deps.eventService.getEvent?.(invitation?.event_id ?? 0, user.telegram_id);
    const eventTitle = (event as { title?: string } | undefined)?.title ?? '';
    deps.notifyInviterProposal(session.invitationId, user, formattedTime, eventTitle).catch((e: unknown) => {
      cmdLogger.error({ err: e }, 'Failed to notify inviter of time proposal');
    });
  }
}
