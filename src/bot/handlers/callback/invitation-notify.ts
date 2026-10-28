// src/bot/handlers/callback/invitation-notify.ts
// Messages sent to an inviter when an invitee responds, proposes another time, or the proposal closes.

import { InlineKeyboard } from 'gramio';
import type { Lang } from '../../../config/constants.ts';
import { CB, t } from '../../../config/constants.ts';
import type { EventRepository } from '../../../database/repositories/event.repository.ts';
import type { UserRepository } from '../../../database/repositories/user.repository.ts';
import type { Invitation, User } from '../../../database/types.ts';
import { renderConflictImage } from '../../../services/image/render-conflict.ts';
import type { ImageRenderer } from '../../../services/image/render-service.ts';
import { ConflictService } from '../../../services/invite/conflict-service.ts';
import { sendAgendaImage } from '../../../utils/agenda-image.ts';
import { cmdLogger } from '../../../utils/logger.ts';
import type { ParseMode } from '../../../utils/telegram.ts';
import type { BotCallbackContext } from '../../types.ts';

export async function notifyInviterProposal(
  invitation: Invitation,
  respondent: User,
  formattedTime: string,
  eventTitle: string,
  deps: {
    userRepo: UserRepository;
    sendMessage: (
      chatId: number,
      text: string,
      options: { parse_mode: ParseMode; reply_markup?: InlineKeyboard },
    ) => Promise<void>;
  },
): Promise<void> {
  const inviter = deps.userRepo.findByTelegramId(invitation.inviter_id);
  if (!inviter) return;
  const inviterLang = (inviter.language ?? 'en') as Lang;
  const name = respondent.first_name ?? respondent.username ?? `#${respondent.telegram_id}`;
  const text = t(inviterLang).invite_propose_notify(name, eventTitle, formattedTime);
  const keyboard = new InlineKeyboard()
    .text(t(inviterLang).invite_reschedule_btn, `${CB.INVITATION_ACTION}:reschedule:${invitation.id}`)
    .text(t(inviterLang).invite_keep_btn, `${CB.INVITATION_ACTION}:dismiss:${invitation.id}`);
  await deps.sendMessage(invitation.inviter_id, text, { parse_mode: 'HTML', reply_markup: keyboard });
}

/** Replaces the inviter's proposal notice, whose Reschedule/Keep buttons can no longer act on anything. */
export async function answerProposalClosed(ctx: BotCallbackContext, lang: Lang): Promise<void> {
  const text = t(lang).invite_proposal_closed;
  await ctx.answer({ text });
  await ctx.editText(text, { parse_mode: 'HTML' }).catch((err: unknown) => {
    cmdLogger.warn({ err }, 'Failed to close the inviter proposal notice');
  });
}

interface ConflictImageRequest {
  invitation: Invitation;
  respondent: User;
  inviter: User;
  window: { startAt: string; endAt: string };
  deps: {
    userRepo: UserRepository;
    sendPhoto: (chatId: number, photo: File) => Promise<void>;
    sendDocument?: (chatId: number, document: File, caption: string) => Promise<void>;
  };
  eventRepo?: EventRepository;
  renderService: ImageRenderer;
}

/** Fire-and-forget: renders the organizer/invitee conflict picture for an accepted invite and DMs it to the inviter. */
function sendConflictImage({
  invitation,
  respondent,
  inviter,
  window,
  deps,
  eventRepo,
  renderService,
}: ConflictImageRequest): void {
  const twoHoursMs = 2 * 60 * 60 * 1000;
  const windowStart = new Date(new Date(window.startAt).getTime() - twoHoursMs).toISOString();
  const windowEnd = new Date(new Date(window.endAt).getTime() + twoHoursMs).toISOString();
  const organizerRawEvents = eventRepo
    ? eventRepo.findVisibleOverlapping(invitation.inviter_id, windowStart, windowEnd)
    : [];
  const inviteeConflicts = eventRepo
    ? new ConflictService(eventRepo, deps.userRepo).checkConflicts(
        invitation.inviter_id,
        [respondent.telegram_id],
        window.startAt,
        window.endAt,
        inviter.timezone ?? 'UTC',
      )
    : [];
  const organizerLabel = inviter.first_name ?? inviter.username ?? `#${invitation.inviter_id}`;
  const locale = inviter.language === 'ru' ? 'ru' : 'en';
  renderConflictImage(
    renderService,
    invitation.inviter_id,
    organizerLabel,
    organizerRawEvents.map((e) => ({
      startAt: e.start_at,
      endAt: e.end_at ?? new Date(new Date(e.start_at).getTime() + 30 * 60 * 1000).toISOString(),
      title: e.title ?? '',
    })),
    inviteeConflicts,
    window.startAt,
    window.endAt,
    locale,
  )
    .then((buffer) => {
      const photo = new File([buffer], 'conflict.png', { type: 'image/png' });
      return sendAgendaImage(photo, {
        sendPhoto: (file) => deps.sendPhoto(invitation.inviter_id, file),
        sendDocument: deps.sendDocument
          ? (file, options) => deps.sendDocument!(invitation.inviter_id, file, options.caption)
          : undefined,
      });
    })
    .catch((err) => {
      cmdLogger.error({ err }, 'Failed to render/send conflict image');
    });
}

export async function notifyInviter(
  invitation: Invitation,
  action: 'accept' | 'decline' | 'maybe',
  respondent: User,
  deps: {
    userRepo: UserRepository;
    sendMessage: (chatId: number, text: string, options: { parse_mode: ParseMode }) => Promise<void>;
    sendPhoto?: (chatId: number, photo: File) => Promise<void>;
    sendDocument?: (chatId: number, document: File, caption: string) => Promise<void>;
  },
  eventRepo?: EventRepository,
  renderService?: ImageRenderer,
): Promise<void> {
  const inviter = deps.userRepo.findByTelegramId(invitation.inviter_id);
  if (!inviter) return;

  const inviterLang = (inviter.language ?? 'en') as Lang;
  const msgs = t(inviterLang);
  const respondentName = respondent.first_name ?? respondent.username ?? `#${respondent.telegram_id}`;

  const event = eventRepo?.findById(invitation.event_id, invitation.inviter_id);
  const eventTitle = event?.title ?? `Event #${invitation.event_id}`;

  const text =
    action === 'accept'
      ? msgs.invitation_response_accepted(respondentName, eventTitle)
      : action === 'decline'
        ? msgs.invitation_response_declined(respondentName, eventTitle)
        : msgs.invitation_response_maybe(respondentName, eventTitle);

  await deps.sendMessage(invitation.inviter_id, text, { parse_mode: 'HTML' });
  if (action === 'accept' && renderService && deps.sendPhoto && event?.start_at && event.end_at) {
    sendConflictImage({
      invitation,
      respondent,
      inviter,
      window: { startAt: event.start_at, endAt: event.end_at },
      deps: { ...deps, sendPhoto: deps.sendPhoto },
      eventRepo,
      renderService,
    });
  }
}
