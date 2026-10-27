// src/bot/handlers/callback/invite-routes.ts
// Outgoing invitation flow callbacks: event pick, contact pick, force invite, retime and cancel.

import type { Lang } from '../../../config/constants.ts';
import { CB, t } from '../../../config/constants.ts';
import type { CalendarEvent, User } from '../../../database/types.ts';
import { formatInvitation } from '../../../services/event/formatters.ts';
import { readInvitationRoster } from '../../../services/sharing/invitation-roster.ts';
import { invitationRsvpKeyboard } from '../../../services/sharing/invitation-rsvp-keyboard.ts';
import { cmdLogger } from '../../../utils/logger.ts';
import { escapeHtml } from '../../../utils/telegram.ts';
import { inviteContactPickerKeyboard } from '../../keyboards.ts';
import type { BotCallbackContext } from '../../types.ts';
import type { CallbackDispatch, CallbackRouteDeps, ForceInviteDeps } from './types.ts';

export function registerInviteRoutes(dispatch: CallbackDispatch, deps: CallbackRouteDeps): void {
  const { eventService } = deps;
  const { userRepo, forceInviteDeps, invitationRepo, contactRepo } = deps.opts;

  // Invite: user picked an event → show contact picker
  dispatch.set(CB.INVITE_PICK, async (ctx, payload, _parts, user) => {
    const lang = (user.language ?? 'en') as Lang;
    if (payload === 'cancel') {
      await ctx.answer();
      await ctx.editText(t(lang).callbackErrors.cancelled);
      return;
    }
    const eventId = Number(payload);
    const event = eventService.getEvent(eventId, user.telegram_id);
    if (!event) return ctx.answer({ text: t(lang).callbackErrors.notFound });
    await ctx.answer();
    const contacts = contactRepo ? contactRepo.list(user.telegram_id) : [];
    await ctx.editText(
      lang === 'ru'
        ? `📨 Приглашение на: <b>${event.title}</b>\nВыберите кого пригласить:`
        : `📨 Inviting to: <b>${event.title}</b>\nChoose who to invite:`,
      { parse_mode: 'HTML', reply_markup: inviteContactPickerKeyboard(contacts, eventId, lang) },
    );
  });

  async function ensureEventOwner(ctx: BotCallbackContext, user: User, lang: Lang, eventId: number): Promise<boolean> {
    // Security: verify user is event owner
    const ownerId = eventService.getEventOwnerId(eventId);
    if (!ownerId) {
      await ctx.answer({ text: t(lang).callbackErrors.notFound });
      return false;
    }
    if (ownerId !== user.telegram_id) {
      await ctx.answer({ text: t(lang).callbackErrors.notAuthorized });
      return false;
    }
    return true;
  }

  async function requestInviteTarget(
    ctx: BotCallbackContext,
    user: User,
    lang: Lang,
    eventId: number,
    target: 'picker' | 'chat',
  ): Promise<void> {
    const event = eventService.getEvent(eventId, user.telegram_id);
    if (!event) {
      await ctx.answer({ text: t(lang).callbackErrors.notFound });
      return;
    }
    await ctx.answer();
    await ctx.editText(t(lang).callbackErrors.invitePickContact(event.title), { parse_mode: 'HTML' });
    const { Keyboard } = await import('gramio');
    const kb =
      target === 'picker'
        ? new Keyboard()
            .requestUsers(t(lang).callbackErrors.inviteSelectUser, eventId, {
              user_is_bot: false,
              max_quantity: 10,
              request_name: true,
              request_username: true,
            })
            .resized()
            .oneTime()
        : new Keyboard()
            .requestChat(t(lang).callbackErrors.inviteSelectGroup, eventId, { chat_is_channel: false })
            .resized()
            .oneTime();
    await ctx.send(t(lang).callbackErrors.inviteTapButton, { reply_markup: kb });
  }

  /** Builds the invitation card now and returns the function that sends it to the invitee in the background. */
  function prepareInvitation(
    sender: ForceInviteDeps,
    user: User,
    event: CalendarEvent | null | undefined,
    eventId: number,
    invitationId: number,
    inviteeId: number,
    failureLog: string,
  ): () => void {
    const inviterName = user.first_name ?? user.username ?? `User ${user.telegram_id}`;
    const eventTitle = event?.title ?? `Event #${eventId}`;
    const inviteeUser = userRepo?.findByTelegramId(inviteeId);
    const inviteeLang = (inviteeUser?.language ?? 'en') as Lang;
    const inviteeText = event
      ? formatInvitation(
          event,
          event.timezone,
          inviteeLang,
          inviterName,
          user.telegram_id,
          user.username ?? undefined,
          inviteeUser?.timezone ?? null,
          !!inviteeUser?.onboarding_completed,
          invitationRepo ? readInvitationRoster(invitationRepo, event.id, inviteeId) : null,
        )
      : t(inviteeLang).invitation_received(escapeHtml(eventTitle), escapeHtml(inviterName));
    return () => {
      sender
        .sendMessage(inviteeId, inviteeText, {
          parse_mode: 'HTML',
          reply_markup: invitationRsvpKeyboard(invitationId, inviteeLang, event ?? null),
        })
        .then((sent) => {
          sender.invRepo.setMessageInfo(invitationId, sent.message_id, inviteeId);
        })
        .catch((err: unknown) => {
          cmdLogger.error({ err: err, inviteeId }, failureLog);
        });
    };
  }

  async function inviteKnownContact(
    ctx: BotCallbackContext,
    user: User,
    lang: Lang,
    eventId: number,
    inviteeId: number,
    sender: ForceInviteDeps,
  ): Promise<void> {
    if (!(await ensureEventOwner(ctx, user, lang, eventId))) return;
    const event = eventService.getEvent(eventId, user.telegram_id);
    const eventTitle = event?.title ?? `Event #${eventId}`;
    const result = sender.invitationService.sendInvitation(eventId, user.telegram_id, inviteeId);
    if (!result.success || !result.invitation) {
      await ctx.answer({ text: result.error ?? t(lang).callbackErrors.error });
      return;
    }
    const deliver = prepareInvitation(
      sender,
      user,
      event,
      eventId,
      result.invitation.id,
      inviteeId,
      'Invite contact send failed',
    );
    await ctx.answer();
    await ctx.editText(t(lang).invite_delivered(eventTitle), { parse_mode: 'HTML' });
    deliver();
  }

  // Invite contact — invc:{eventId}:{telegramId|picker|chat|cancel}
  dispatch.set(CB.INVITE_CONTACT, async (ctx, payload, _parts, user) => {
    const invLang = (user.language ?? 'en') as Lang;
    if (payload === 'cancel') {
      await ctx.answer();
      await ctx.editText(t(invLang).callbackErrors.cancelled);
      return;
    }
    const colonIdx = payload.indexOf(':');
    const eventId = Number(payload.slice(0, colonIdx));
    const sub = payload.slice(colonIdx + 1);

    if (sub === 'picker' || sub === 'chat') {
      await requestInviteTarget(ctx, user, invLang, eventId, sub);
      return;
    }

    // sub = telegramId — send invitation to known contact
    if (!forceInviteDeps) {
      await ctx.answer({ text: t(invLang).callbackErrors.notConfigured });
      return;
    }
    await inviteKnownContact(ctx, user, invLang, eventId, Number(sub), forceInviteDeps);
  });

  // Invite force — callback: "inv_force:{eventId}:{inviteeIds}"
  dispatch.set(CB.INV_FORCE, async (ctx, payload, _parts, user) => {
    if (!forceInviteDeps) {
      await ctx.answer();
      return;
    }
    const invLang = (user.language ?? 'en') as Lang;
    const colonIdx = payload.indexOf(':');
    const eventId = Number(payload.slice(0, colonIdx));
    const inviteeIdsStr = payload.slice(colonIdx + 1);

    if (!(await ensureEventOwner(ctx, user, invLang, eventId))) return;

    const inviteeIds = inviteeIdsStr.split(',').map(Number).filter(Boolean);
    const eventForInv = eventService.getEvent(eventId, user.telegram_id);
    const eventTitle = eventForInv?.title ?? `Event #${eventId}`;

    await ctx.answer();
    await ctx.editText(t(invLang).callbackErrors.inviteSending);

    for (const inviteeId of inviteeIds) {
      const result = forceInviteDeps.invitationService.sendInvitation(eventId, user.telegram_id, inviteeId);
      if (!result.success || !result.invitation) continue;
      prepareInvitation(
        forceInviteDeps,
        user,
        eventForInv,
        eventId,
        result.invitation.id,
        inviteeId,
        'Force invite send failed',
      )();
    }

    await ctx.editText(t(invLang).invite_delivered(eventTitle), { parse_mode: 'HTML' });
  });

  // Invite retime — prompt to change event time
  dispatch.set(CB.INV_RETIME, async (ctx, payload, _parts, user) => {
    const invLang = (user.language ?? 'en') as Lang;
    const eventId = Number(payload);
    const ownerId = eventService.getEventOwnerId(eventId);
    if (!ownerId) {
      await ctx.answer({ text: t(invLang).callbackErrors.notFound });
      return;
    }
    if (ownerId !== user.telegram_id) {
      await ctx.answer({ text: t(invLang).callbackErrors.notAuthorized });
      return;
    }
    await ctx.answer();
    await ctx.editText(
      invLang === 'ru'
        ? '🕐 Используйте /edit чтобы изменить время события, затем повторите приглашение.'
        : '🕐 Use /edit to change the event time, then resend the invitation.',
    );
  });

  // Invite cancel
  dispatch.set(CB.INV_CANCEL, async (ctx, _payload, _parts, user) => {
    const invLang = (user.language ?? 'en') as Lang;
    await ctx.answer();
    await ctx.editText(t(invLang).callbackErrors.invitationCancelled);
  });
}
