// src/bot/handlers/callback/invitation-notify.ts
// Messages sent to an inviter when an invitee responds, proposes another time, or the proposal closes.

import { InlineKeyboard } from 'gramio';
import type { Lang } from '../../../config/constants.ts';
import { CB, t } from '../../../config/constants.ts';
import type { EventRepository } from '../../../database/repositories/event.repository.ts';
import type { UserRepository } from '../../../database/repositories/user.repository.ts';
import type { Invitation, User } from '../../../database/types.ts';
import type { ImageDelivery } from '../../../services/image/image-delivery.ts';
import { queuePicture } from '../../../services/image/queue-picture.ts';
import { conflictImageJob } from '../../../services/image/render-conflict.ts';
import { ConflictService } from '../../../services/invite/conflict-service.ts';
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
  imageDelivery: ImageDelivery;
  invitation: Invitation;
  /** The callback query of this answer: a repeated answer is a new request, a redelivered one is the same. */
  answerId: string;
  respondent: User;
  inviter: User;
  window: { startAt: string; endAt: string };
  deps: {
    userRepo: UserRepository;
    sendMessage: (chatId: number, text: string, options: { parse_mode: ParseMode }) => Promise<void>;
    sendPhoto: (chatId: number, photo: File) => Promise<{ message_id: number }>;
    sendDocument?: (chatId: number, document: File, caption: string) => Promise<{ message_id: number }>;
  };
  eventRepo?: EventRepository;
}

/** Queues the organizer/invitee conflict picture for an accepted invite; it is DMed to the inviter when ready. */
async function queueConflictImage({
  imageDelivery,
  invitation,
  answerId,
  respondent,
  inviter,
  window,
  deps,
  eventRepo,
}: ConflictImageRequest): Promise<void> {
  const twoHoursMs = 2 * 60 * 60 * 1000;
  const windowStart = new Date(new Date(window.startAt).getTime() - twoHoursMs).toISOString();
  const windowEnd = new Date(new Date(window.endAt).getTime() + twoHoursMs).toISOString();
  const organizerLabel = inviter.first_name ?? inviter.username ?? `#${invitation.inviter_id}`;
  const locale = inviter.language === 'ru' ? 'ru' : 'en';
  const chatId = invitation.inviter_id;

  // Read the schedules when the render starts, and again if the inviter's calendar changes while it renders.
  const buildJob = () => {
    const organizerRawEvents = eventRepo ? eventRepo.findVisibleOverlapping(chatId, windowStart, windowEnd) : [];
    const inviteeConflicts = eventRepo
      ? new ConflictService(eventRepo, deps.userRepo).checkConflicts(
          chatId,
          [respondent.telegram_id],
          window.startAt,
          window.endAt,
          inviter.timezone ?? 'UTC',
        )
      : [];
    return conflictImageJob(
      chatId,
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
    );
  };

  await queuePicture(imageDelivery, {
    chatId,
    language: locale,
    kind: 'conflict',
    label: t(locale).invitation_conflict_picture_label,
    busyNote: t(locale).invitation_conflict_picture_skipped,
    failureNote: t(locale).invitation_conflict_picture_failed,
    slot: `conflict:${invitation.id}`,
    requestId: `invitation:${invitation.id}:${answerId}`,
    dataOwner: chatId,
    filename: 'conflict.png',
    buildJob,
    sendPhoto: async (file) => (await deps.sendPhoto(chatId, file)).message_id,
    sendDocument: deps.sendDocument
      ? async (file, options) => (await deps.sendDocument!(chatId, file, options.caption)).message_id
      : undefined,
    notify: (text) => deps.sendMessage(chatId, text, { parse_mode: 'HTML' }),
  });
}

export async function notifyInviter(
  invitation: Invitation,
  action: 'accept' | 'decline' | 'maybe',
  respondent: User,
  deps: {
    userRepo: UserRepository;
    sendMessage: (chatId: number, text: string, options: { parse_mode: ParseMode }) => Promise<void>;
    sendPhoto?: (chatId: number, photo: File) => Promise<{ message_id: number }>;
    sendDocument?: (chatId: number, document: File, caption: string) => Promise<{ message_id: number }>;
  },
  eventRepo: EventRepository | undefined,
  imageDelivery: ImageDelivery | undefined,
  answerId: string,
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
  if (action === 'accept' && imageDelivery && deps.sendPhoto && event?.start_at && event.end_at) {
    await queueConflictImage({
      imageDelivery,
      answerId,
      invitation,
      respondent,
      inviter,
      window: { startAt: event.start_at, endAt: event.end_at },
      deps: { ...deps, sendPhoto: deps.sendPhoto },
      eventRepo,
    });
  }
}
