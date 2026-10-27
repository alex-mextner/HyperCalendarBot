// src/bot/handlers/callback/invitation-routes.ts
// Invitation response callbacks: inv (accept/decline/maybe/propose) and group RSVP.

import type { Lang } from '../../../config/constants.ts';
import { CB, t } from '../../../config/constants.ts';
import { cmdLogger } from '../../../utils/logger.ts';
import { getGroupId } from '../../group-context.ts';
import {
  answerInvitation,
  type InvitationActionCall,
  keepOriginalTime,
  proposeInvitationTime,
  rescheduleFromProposal,
} from './invitation-actions.ts';
import type { CallbackDispatch, CallbackRouteDeps } from './types.ts';

export function registerInvitationRoutes(dispatch: CallbackDispatch, deps: CallbackRouteDeps): void {
  const { eventService } = deps;
  const { invitationService } = deps.opts;

  // Invitation actions
  dispatch.set(CB.INVITATION_ACTION, async (ctx, _payload, parts, user) => {
    if (!invitationService) return;
    const subAction = parts[1];
    const lang = (user.language ?? 'en') as Lang;
    const call: InvitationActionCall = {
      ctx,
      user,
      lang,
      invId: Number(parts[2]),
      invitationService,
      eventService,
      opts: deps.opts,
    };

    switch (subAction) {
      case 'keep':
        await ctx.answer(t(lang).invitation_accepted);
        return;
      case 'propose':
        return proposeInvitationTime(call, parts[3]);
      case 'reschedule':
        return rescheduleFromProposal(call);
      case 'dismiss':
        return keepOriginalTime(call);
      case 'accept':
      case 'decline':
      case 'maybe':
        return answerInvitation(call, subAction);
      default:
        await ctx.answer();
    }
  });

  // Group RSVP — any member of a group event responds for themselves.
  // Callback data: "grsvp:<eventId>:going|notgoing". callback_data is forgeable, so it is NOT an
  // authorization boundary: the RSVP is bound to the group whose message carried the button. The
  // chat Telegram reports for that message is the real group id, and `recordGroupAttendance`
  // requires an active invitation linking the event to that group before writing anything.
  dispatch.set(CB.GROUP_RSVP, async (ctx, _payload, parts, user) => {
    if (!invitationService) return;
    const lang = (user.language ?? 'en') as Lang;
    const eventId = Number(parts[1]);
    const action = parts[2];
    if (!Number.isInteger(eventId) || (action !== 'going' && action !== 'notgoing')) {
      cmdLogger.warn({ userId: user.telegram_id, data: parts.join(':') }, 'Malformed group RSVP callback');
      await ctx.answer();
      return;
    }
    // Fail closed: a group RSVP can only originate from a group/supergroup message. Without a
    // group chat id (private chat, channel, or no chat at all) the tap cannot be bound to a
    // group, so we reject it and write nothing.
    const groupChatId = getGroupId(ctx);
    if (groupChatId === null) {
      cmdLogger.warn({ userId: user.telegram_id, eventId }, 'Group RSVP tap outside a group chat');
      await ctx.answer({ text: t(lang).group_rsvp_not_authorized });
      return;
    }
    const status = action === 'going' ? 'accepted' : 'declined';
    const result = invitationService.recordGroupAttendance(eventId, user.telegram_id, status, groupChatId);
    if (!result.success) {
      await ctx.answer({ text: t(lang).group_rsvp_not_authorized });
      return;
    }
    // Toast only — never edit the shared group message, or one member's tap would replace the
    // RSVP keyboard for everyone else in the chat.
    await ctx.answer(action === 'going' ? t(lang).group_rsvp_recorded : t(lang).group_rsvp_removed);
  });
}
