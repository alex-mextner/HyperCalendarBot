// src/bot/handlers/callback/invitation-actions.ts
// Steps of the invitation response callbacks: propose a time, reschedule/keep after a proposal, accept/decline/maybe.

import { InlineKeyboard } from 'gramio';
import type { Lang } from '../../../config/constants.ts';
import { CB, t } from '../../../config/constants.ts';
import type { CalendarEvent, Invitation, User } from '../../../database/types.ts';
import type { EventService } from '../../../services/event/event-service.ts';
import { formatInvitation } from '../../../services/event/formatters.ts';
import {
  formatAnsweredInvitationCard,
  invitationAnswerLabel,
} from '../../../services/sharing/answered-invitation-card.ts';
import { readInvitationRoster } from '../../../services/sharing/invitation-roster.ts';
import { invitationRsvpKeyboard } from '../../../services/sharing/invitation-rsvp-keyboard.ts';
import type { InvitationResult, InvitationService } from '../../../services/sharing/invitation-service.ts';
import { formatProposedTime } from '../../../utils/invite-time-format.ts';
import { cmdLogger } from '../../../utils/logger.ts';
import { escapeHtml } from '../../../utils/telegram.ts';
import { editAgendaText } from '../../commands/agenda-text.ts';
import { getGroupId, isGroup } from '../../group-context.ts';
import type { BotCallbackContext } from '../../types.ts';
import { answerProposalClosed, notifyInviter, notifyInviterProposal } from './invitation-notify.ts';
import type { CallbackHandlerOpts } from './types.ts';

export type InvitationAnswer = 'accept' | 'decline' | 'maybe';

/** Everything an invitation callback step needs: the tapped invitation, who tapped, and the services. */
export interface InvitationActionCall {
  ctx: BotCallbackContext;
  user: User;
  lang: Lang;
  invId: number;
  invitationService: InvitationService;
  eventService: EventService;
  opts: CallbackHandlerOpts;
}

type MaybeEvent = CalendarEvent | null | undefined;

function failureText(call: InvitationActionCall, result: InvitationResult): string {
  const { lang } = call;
  return result.reason ? t(lang)[result.reason] : (result.error ?? t(lang).callbackErrors.error);
}

function eventTitleOf(event: MaybeEvent, invitation: Invitation): string {
  return event?.title ?? `Event #${invitation.event_id}`;
}

/** The +30/+60 buttons sit on a separate prompt, so the invitation card still has its RSVP buttons. */
async function replaceCardAfterQuickProposal(
  call: InvitationActionCall,
  proposedTime: string,
  proposalSent: string,
): Promise<void> {
  const { invId, opts } = call;
  // Replace it with the notice a typed proposal leaves: the location refresh skips pending cards
  // with a proposed time, relying on no such card still showing live buttons.
  // Re-read first: an answer given before this stale tap, or during the awaits above, must stay visible.
  const latest = opts.invitationRepo?.findById(invId);
  const editMessage = opts.invitationNotifyDeps?.editMessage;
  const stillPending = latest?.status === 'pending' && latest.proposed_time === proposedTime;
  if (!latest || !stillPending || !latest.message_id || !latest.chat_id || !editMessage) return;
  await editMessage(latest.chat_id, latest.message_id, proposalSent).catch((err: unknown) => {
    cmdLogger.warn({ err, invitationId: invId }, 'Failed to replace the invitation card after a quick proposal');
  });
}

async function proposeQuickly(
  call: InvitationActionCall,
  inv: Invitation,
  event: MaybeEvent,
  offsetMs: number,
): Promise<void> {
  const { ctx, user, lang, invId, invitationService, opts } = call;
  const baseTime = event?.start_at ? new Date(event.start_at).getTime() : Date.now();
  const proposedTime = new Date(baseTime + offsetMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const propResult = invitationService.proposeTime(invId, user.telegram_id, proposedTime);
  if (!propResult.success) {
    await ctx.answer({ text: failureText(call, propResult) });
    return;
  }
  const formatted = formatProposedTime(proposedTime, user.timezone, lang);
  const proposalSent = t(lang).invite_propose_sent(formatted);
  await ctx.answer();
  await ctx.editText(proposalSent, { parse_mode: 'HTML' }).catch(() => {});
  await replaceCardAfterQuickProposal(call, proposedTime, proposalSent);
  if (opts.invitationNotifyDeps && event) {
    notifyInviterProposal(inv, user, formatted, eventTitleOf(event, inv), opts.invitationNotifyDeps).catch(() => {});
  }
}

async function askForProposedTime(call: InvitationActionCall): Promise<void> {
  const { ctx, user, lang, invId, opts } = call;
  opts.proposeTimeSessions?.set(user.telegram_id, { invitationId: invId });
  await ctx.answer();
  const msgs = t(lang);
  const quickKeyboard = new InlineKeyboard()
    .text(msgs.invite_propose_plus30, `${CB.INVITATION_ACTION}:propose:${invId}:+30`)
    .text(msgs.invite_propose_plus60, `${CB.INVITATION_ACTION}:propose:${invId}:+60`);
  await ctx.message?.send(msgs.invite_propose_ask, { reply_markup: quickKeyboard });
}

const QUICK_PROPOSAL_OFFSET_MS = new Map([
  ['+30', 30 * 60_000],
  ['+60', 60 * 60_000],
]);

/** Invitee proposes a different time: a quick +30/+60 button, or the prompt that offers them. */
export async function proposeInvitationTime(call: InvitationActionCall, offsetStr: string | undefined): Promise<void> {
  const { ctx, lang, invId, opts } = call;
  const inv = opts.invitationRepo?.findById(invId);
  if (!inv) {
    await ctx.answer({ text: t(lang).invitation_not_found });
    return;
  }
  const offsetMs = offsetStr ? QUICK_PROPOSAL_OFFSET_MS.get(offsetStr) : undefined;
  if (offsetMs === undefined) {
    await askForProposedTime(call);
    return;
  }
  await proposeQuickly(call, inv, opts.eventRepo?.findById(inv.event_id, inv.inviter_id), offsetMs);
}

function notifyInviteeRescheduled(
  call: InvitationActionCall,
  invitation: Invitation,
  event: MaybeEvent,
  proposedTime: string,
): void {
  const notifyDeps = call.opts.invitationNotifyDeps;
  if (!notifyDeps) return;
  const inviteeUser = notifyDeps.userRepo.findByTelegramId(invitation.invitee_id);
  const inviteeLang = (inviteeUser?.language ?? 'en') as Lang;
  const inviteeTz = inviteeUser?.timezone ?? 'UTC';
  const formattedTimeInvitee = formatProposedTime(proposedTime, inviteeTz, inviteeLang);
  notifyDeps
    .sendMessage(
      invitation.invitee_id,
      t(inviteeLang).invite_rescheduled_invitee(eventTitleOf(event, invitation), formattedTimeInvitee),
      { parse_mode: 'HTML' },
    )
    .catch(() => {});
}

/** Inviter accepts the invitee's proposal: move the event and tell both sides. */
export async function rescheduleFromProposal(call: InvitationActionCall): Promise<void> {
  const { ctx, user, lang, invId, invitationService, eventService, opts } = call;
  const moveEventToProposedTime = (eventId: number, proposedTime: string) => {
    const event = opts.eventRepo?.findById(eventId, user.telegram_id);
    if (!event) return null;
    const durationMs = event.end_at ? new Date(event.end_at).getTime() - new Date(event.start_at).getTime() : 0;
    const newEnd = durationMs > 0 ? new Date(new Date(proposedTime).getTime() + durationMs).toISOString() : undefined;
    return eventService.updateEvent(event.id, user.telegram_id, {
      start_at: proposedTime,
      ...(newEnd ? { end_at: newEnd } : {}),
    });
  };
  const reschedResult = invitationService.rescheduleFromProposal(invId, user.telegram_id, moveEventToProposedTime);
  if (reschedResult.reason === 'invite_proposal_closed') {
    await answerProposalClosed(ctx, lang);
    return;
  }
  if (!reschedResult.success) {
    await ctx.answer({ text: reschedResult.error ?? t(lang).callbackErrors.error });
    return;
  }
  const invitation = reschedResult.invitation!;
  const proposedTime = reschedResult.proposedTime!;
  const event = opts.eventRepo?.findById(invitation.event_id, user.telegram_id);
  const formattedTimeInviter = formatProposedTime(proposedTime, user.timezone, lang);
  await ctx.answer();
  await ctx.editText(t(lang).invite_rescheduled_inviter(formattedTimeInviter), { parse_mode: 'HTML' }).catch(() => {});
  notifyInviteeRescheduled(call, invitation, event, proposedTime);
}

function restoreInvitationCard(call: InvitationActionCall, invitation: Invitation, event: MaybeEvent): void {
  const { opts } = call;
  const notifyDeps = opts.invitationNotifyDeps;
  if (!notifyDeps?.editMessage || !invitation.message_id || !invitation.chat_id) return;
  const inviteeUser = notifyDeps.userRepo.findByTelegramId(invitation.invitee_id);
  const inviteeLang = (inviteeUser?.language ?? 'en') as Lang;
  const inviterUser = notifyDeps.userRepo.findByTelegramId(invitation.inviter_id);
  const inviterName = inviterUser?.first_name ?? inviterUser?.username ?? `#${invitation.inviter_id}`;
  const originalText = event
    ? formatInvitation(
        event,
        event.timezone,
        inviteeLang,
        inviterName,
        invitation.inviter_id,
        inviterUser?.username ?? undefined,
        inviteeUser?.timezone ?? null,
        !!inviteeUser?.onboarding_completed,
        opts.invitationRepo ? readInvitationRoster(opts.invitationRepo, event.id, invitation.chat_id) : null,
      )
    : t(inviteeLang).invitation_received(escapeHtml(eventTitleOf(event, invitation)), escapeHtml(inviterName));
  notifyDeps
    .editMessage(
      invitation.chat_id,
      invitation.message_id,
      originalText,
      invitationRsvpKeyboard(invitation.id, inviteeLang, event ?? null),
    )
    .catch(() => {});
}

function notifyInviteeKept(call: InvitationActionCall, invitation: Invitation, event: MaybeEvent): void {
  const notifyDeps = call.opts.invitationNotifyDeps;
  if (!notifyDeps) return;
  const inviteeUser = notifyDeps.userRepo.findByTelegramId(invitation.invitee_id);
  const inviteeLang = (inviteeUser?.language ?? 'en') as Lang;
  const inviteeTz = inviteeUser?.timezone ?? 'UTC';
  const formattedOriginal = event?.start_at ? formatProposedTime(event.start_at, inviteeTz, inviteeLang) : '';
  notifyDeps
    .sendMessage(
      invitation.invitee_id,
      t(inviteeLang).invite_kept_invitee(eventTitleOf(event, invitation), formattedOriginal),
      { parse_mode: 'HTML' },
    )
    .catch(() => {});
  restoreInvitationCard(call, invitation, event);
}

/** Inviter dismisses the invitee's proposal and keeps the original time. */
export async function keepOriginalTime(call: InvitationActionCall): Promise<void> {
  const { ctx, user, lang, invId, invitationService, opts } = call;
  const keepResult = invitationService.keepOriginalTime(invId, user.telegram_id);
  if (keepResult.reason === 'invite_proposal_closed') {
    await answerProposalClosed(ctx, lang);
    return;
  }
  if (!keepResult.success) {
    await ctx.answer({ text: keepResult.error ?? t(lang).callbackErrors.error });
    return;
  }
  const invitation = keepResult.invitation!;
  const event = opts.eventRepo?.findById(invitation.event_id, user.telegram_id);
  await ctx.answer();
  await ctx.editText(t(lang).invite_kept_inviter, { parse_mode: 'HTML' }).catch(() => {});
  notifyInviteeKept(call, invitation, event);
}

function runInvitationAnswer(call: InvitationActionCall, answer: InvitationAnswer): InvitationResult {
  const { user, invId, invitationService } = call;
  if (answer === 'accept') return invitationService.acceptInvitation(invId, user.telegram_id);
  if (answer === 'decline') return invitationService.declineInvitation(invId, user.telegram_id);
  return invitationService.maybeInvitation(invId, user.telegram_id);
}

const ANSWER_STATE = { accept: 'accepted', decline: 'declined', maybe: 'maybe' } as const;

async function showAnsweredCard(
  call: InvitationActionCall,
  answer: (typeof ANSWER_STATE)[InvitationAnswer],
  invitation: Invitation | undefined,
): Promise<void> {
  const { ctx, user, lang, eventService, opts } = call;
  const event = opts.eventRepo?.findById(invitation?.event_id ?? 0, invitation?.inviter_id ?? 0);
  // A group chat must be identified to be checked against the roster's privacy rule; fail closed.
  const inGroup = isGroup(ctx);
  const rosterChatId = inGroup ? getGroupId(ctx) : user.telegram_id;
  const editText = await formatAnsweredInvitationCard(
    answer,
    event ?? null,
    {
      userId: user.telegram_id,
      language: lang,
      timezone: user.timezone,
      groupId: inGroup ? (getGroupId(ctx) ?? undefined) : undefined,
    },
    { agendaRepository: eventService.agendaRepository, weatherService: opts.weatherService },
    event && opts.invitationRepo && rosterChatId !== null
      ? readInvitationRoster(opts.invitationRepo, event.id, rosterChatId)
      : null,
  );
  await editAgendaText(ctx, editText, { parse_mode: 'HTML' }).catch(() => {});
}

/** Invitee accepts, declines or answers maybe; the inviter is told and onboarding starts if needed. */
export async function answerInvitation(call: InvitationActionCall, subAction: InvitationAnswer): Promise<void> {
  const { ctx, user, lang, opts } = call;
  const result = runInvitationAnswer(call, subAction);
  if (!result.success) {
    await ctx.answer(failureText(call, result));
    return;
  }
  const answer = ANSWER_STATE[subAction];
  await ctx.answer(invitationAnswerLabel(answer, lang));
  await showAnsweredCard(call, answer, result.invitation);
  if (opts.invitationNotifyDeps && result.invitation) {
    notifyInviter(
      result.invitation,
      subAction,
      user,
      opts.invitationNotifyDeps,
      opts.eventRepo,
      opts.renderService,
    ).catch(() => {});
  }
  if (!user.onboarding_completed && opts.onboardingScene) {
    await ctx.scene.enter(opts.onboardingScene);
  }
}
