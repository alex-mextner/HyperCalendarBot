// Inline RSVP keyboard attached to every personal invitation card the invitee can still answer.
import { InlineKeyboard } from 'gramio';
import { CB, type Lang, t } from '../../config/constants.ts';

/** Accept/Decline row and Maybe/Propose-time row for one personal invitation. */
export function invitationRsvpKeyboard(invitationId: number, lang: Lang): InlineKeyboard {
  return new InlineKeyboard()
    .text('✅ Accept', `${CB.INVITATION_ACTION}:accept:${invitationId}`)
    .text('❌ Decline', `${CB.INVITATION_ACTION}:decline:${invitationId}`)
    .row()
    .text('Maybe 🤔', `${CB.INVITATION_ACTION}:maybe:${invitationId}`)
    .text(t(lang).invite_propose_btn, `${CB.INVITATION_ACTION}:propose:${invitationId}`);
}
