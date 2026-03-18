// src/bot/commands/invite.ts

import { InlineKeyboard } from 'gramio';
import { CB, t } from '../../config/constants.ts';
import type { InvitationRepository } from '../../database/repositories/invitation.repository.ts';
import type { User } from '../../database/types.ts';
import type { EventService } from '../../services/event/event-service.ts';
import { renderConflictImage } from '../../services/image/render-conflict.ts';
import type { RenderService } from '../../services/image/render-service.ts';
import type { ConflictResult, ConflictService } from '../../services/invite/conflict-service.ts';
import type { DeepLinkService } from '../../services/sharing/deep-link-service.ts';
import type { InvitationService } from '../../services/sharing/invitation-service.ts';
import type { BotCommandContext } from '../types.ts';

interface TelegramSendResult {
  message_id: number;
}

type SendMessageFn = (
  chatId: number,
  text: string,
  options: { parse_mode: string; reply_markup?: unknown },
) => Promise<TelegramSendResult>;

export interface InviteDeps {
  invitationService: InvitationService;
  eventService: EventService;
  invRepo: InvitationRepository;
  deepLinkService: DeepLinkService;
  sendMessage: SendMessageFn;
  conflictService?: ConflictService;
  renderService?: RenderService;
}

function buildConflictCaption(conflicts: ConflictResult[], lang: 'en' | 'ru'): string {
  const conflicting = conflicts.filter((c) => c.hasConflict);
  const names = conflicting.map((c) => (c.username ? `@${c.username}` : `#${c.userId}`)).join(', ');
  return lang === 'ru' ? `⚠️ Конфликт: ${names} занят(а) в это время` : `⚠️ Conflict: ${names} is busy at this time`;
}

export async function handleInvite(ctx: BotCommandContext, deps: InviteDeps): Promise<void> {
  const { eventService, conflictService, renderService } = deps;
  const user = ctx.dbUser as User;
  const lang = user.language as 'en' | 'ru';
  const messages = t(lang);

  const parts = (ctx.args ?? '').trim().split(/\s+/);
  const inviteeId = Number.parseInt(parts[0] ?? '', 10);
  const eventId = Number.parseInt(parts[1] ?? '', 10);

  if (!inviteeId || !eventId || Number.isNaN(inviteeId) || Number.isNaN(eventId)) {
    await ctx.send(messages.invite_usage);
    return;
  }

  const event = eventService.getEvent(eventId, user.telegram_id);
  const eventTitle = event?.title ?? `Event #${eventId}`;

  // Conflict check before creating invite records
  if (conflictService && renderService && event?.start_at && event?.end_at) {
    const conflicts = conflictService.checkConflicts(
      user.telegram_id,
      [inviteeId],
      event.start_at,
      event.end_at,
      user.timezone,
    );
    const hasAnyConflict = conflicts.some((c) => c.hasConflict);

    if (hasAnyConflict) {
      const inviteeIdsStr = String(inviteeId);
      const keyboard = new InlineKeyboard()
        .text(lang === 'ru' ? 'Пригласить всё равно' : 'Invite anyway', `${CB.INV_FORCE}:${eventId}:${inviteeIdsStr}`)
        .text(lang === 'ru' ? 'Сменить время' : 'Change time', `${CB.INV_RETIME}:${eventId}`)
        .row()
        .text(lang === 'ru' ? 'Отменить' : 'Cancel', CB.INV_CANCEL);

      const caption = buildConflictCaption(conflicts, lang);

      try {
        const organizerLabel = user.first_name ?? user.username ?? `#${user.telegram_id}`;
        const organizerEvents =
          eventService
            .getEventsInRange?.(
              user.telegram_id,
              new Date(new Date(event.start_at).getTime() - 2 * 3600_000).toISOString(),
              new Date(new Date(event.end_at).getTime() + 2 * 3600_000).toISOString(),
            )
            ?.map((occ) => ({
              startAt: occ.occurrence_start ?? occ.start_at,
              endAt: occ.occurrence_end ?? occ.end_at ?? occ.start_at,
              title: occ.title,
            })) ?? [];

        const buf = await renderConflictImage(
          renderService,
          user.telegram_id,
          organizerLabel,
          organizerEvents,
          conflicts,
          event.start_at,
          event.end_at,
          lang,
        );
        const photo = new File([buf], 'conflict.png', { type: 'image/png' });
        await ctx.sendPhoto(photo, { caption, reply_markup: keyboard });
      } catch {
        // Fall back to text-only if render fails
        await ctx.send(caption, { reply_markup: keyboard });
      }
      return;
    }
  }

  await doSendInvitation(ctx, deps, user, messages, inviteeId, eventId, eventTitle);
}

async function doSendInvitation(
  ctx: BotCommandContext,
  deps: InviteDeps,
  user: User,
  messages: ReturnType<typeof t>,
  inviteeId: number,
  eventId: number,
  eventTitle: string,
): Promise<void> {
  const { invitationService, invRepo, deepLinkService, sendMessage } = deps;

  const result = invitationService.sendInvitation(eventId, user.telegram_id, inviteeId);

  if (!result.success || !result.invitation) {
    await ctx.send(result.error ?? messages.invite_usage);
    return;
  }

  const invitation = result.invitation;
  const inviterName = user.first_name ?? user.username ?? `User ${user.telegram_id}`;
  const inviteeText = messages.invitation_received(eventTitle, inviterName);

  const keyboard = new InlineKeyboard()
    .text('Accept ✅', `${CB.INVITATION_ACTION}:accept:${invitation.id}`)
    .text('Decline ❌', `${CB.INVITATION_ACTION}:decline:${invitation.id}`)
    .row()
    .text('Maybe 🤔', `${CB.INVITATION_ACTION}:maybe:${invitation.id}`);

  try {
    const sent = await sendMessage(inviteeId, inviteeText, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
    invRepo.setMessageInfo(invitation.id, sent.message_id, inviteeId);
    await ctx.send(messages.invite_delivered(eventTitle), { parse_mode: 'HTML' });
  } catch (err) {
    const statusCode = (err as Record<string, unknown>).statusCode;
    if (statusCode === 403) {
      const deepLink = deepLinkService.createInvitationLink(invitation.id, eventId, user.telegram_id);
      const url = deepLinkService.generateUrl(deepLink.code, process.env.BOT_USERNAME ?? 'bot');
      await ctx.send(messages.invite_deep_link(eventTitle, url), { parse_mode: 'HTML' });
    } else {
      throw err;
    }
  }
}
