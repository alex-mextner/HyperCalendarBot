// Inline RSVP keyboards attached to invitation cards the invitee can still answer.
import { InlineKeyboard } from 'gramio';
import { CB, type Lang, t } from '../../config/constants.ts';
import { type EventPlace, withMapButton } from '../location/event-venue.ts';

/**
 * Accept/Decline row and Maybe/Propose-time row for one personal invitation, plus the Map button
 * when the event (`place`, null when it could not be loaded) has a confirmed place.
 */
export function invitationRsvpKeyboard(invitationId: number, lang: Lang, place: EventPlace | null): InlineKeyboard {
  const msgs = t(lang);
  const keyboard = new InlineKeyboard()
    .text(msgs.invite_accept_btn, `${CB.INVITATION_ACTION}:accept:${invitationId}`)
    .text(msgs.invite_decline_btn, `${CB.INVITATION_ACTION}:decline:${invitationId}`)
    .row()
    .text(msgs.invite_maybe_btn, `${CB.INVITATION_ACTION}:maybe:${invitationId}`)
    .text(msgs.invite_propose_btn, `${CB.INVITATION_ACTION}:propose:${invitationId}`);
  return withMapButton(keyboard, place, lang);
}

/**
 * Going/Not going row on a group invitation: every member answers for themselves, keyed by event.
 * The Map button follows when the event (`place`) has a confirmed place.
 */
export function groupRsvpKeyboard(eventId: number, lang: Lang, place: EventPlace | null): InlineKeyboard {
  const msgs = t(lang);
  const keyboard = new InlineKeyboard()
    .text(msgs.group_rsvp_going_btn, `${CB.GROUP_RSVP}:${eventId}:going`)
    .text(msgs.group_rsvp_notgoing_btn, `${CB.GROUP_RSVP}:${eventId}:notgoing`);
  return withMapButton(keyboard, place, lang);
}
