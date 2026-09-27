// Inline RSVP keyboards attached to invitation cards the invitee can still answer.
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

/** Going/Not going row on a group invitation: every member answers for themselves, keyed by event. */
export function groupRsvpKeyboard(eventId: number, lang: Lang): InlineKeyboard {
  const msgs = t(lang);
  return new InlineKeyboard()
    .text(msgs.group_rsvp_going_btn, `${CB.GROUP_RSVP}:${eventId}:going`)
    .text(msgs.group_rsvp_notgoing_btn, `${CB.GROUP_RSVP}:${eventId}:notgoing`);
}
