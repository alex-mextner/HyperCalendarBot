// src/bot/commands/start.ts

import type { AnyScene } from '@gramio/scenes';
import { InlineKeyboard } from 'gramio';
import { CB, t } from '../../config/constants.ts';
import type { InvitationRepository } from '../../database/repositories/invitation.repository.ts';
import type { UserRepository } from '../../database/repositories/user.repository.ts';
import type { User } from '../../database/types.ts';
import type { EventService } from '../../services/event/event-service.ts';
import { formatEventDetail, formatInvitation } from '../../services/event/formatters.ts';
import type { DeepLinkService } from '../../services/sharing/deep-link-service.ts';
import { cmdLogger } from '../../utils/logger.ts';
import type { BotCommandContext } from '../types.ts';

export interface StartDeps {
  onboardingScene: AnyScene;
  deepLinkService?: DeepLinkService;
  eventService?: EventService;
  invitationRepo?: InvitationRepository;
  userRepo?: UserRepository;
}

export async function handleStart(ctx: BotCommandContext, deps: StartDeps): Promise<void> {
  const user = ctx.dbUser as User;
  const lang = user.language as 'en' | 'ru';

  // Handle deep links (s_ = shared event, i_ = invitation, g_ = group context)
  if (ctx.args && deps.deepLinkService) {
    const arg = ctx.args.trim();

    if (arg.startsWith('s_') || arg.startsWith('i_') || arg.startsWith('g_')) {
      const resolved = deps.deepLinkService.resolve(arg);
      if (resolved) {
        if (resolved.type === 'shared_event' && deps.eventService) {
          const eventId = (resolved.payload as { event_id: number }).event_id;
          const event = deps.eventService.getEvent(eventId, resolved.createdBy);
          if (event) {
            const card = formatEventDetail(event, event.timezone, lang);
            await ctx.send(card, { parse_mode: 'HTML' });
            if (!user.onboarding_completed) await ctx.scene.enter(deps.onboardingScene);
            return;
          }
        }

        if (resolved.type === 'invitation' && deps.invitationRepo && deps.eventService) {
          const payload = resolved.payload as { invitation_id: number; event_id: number };
          const invitation = deps.invitationRepo.findById(payload.invitation_id);

          if (invitation && invitation.status === 'pending') {
            const event = deps.eventService.getEvent(payload.event_id, resolved.createdBy);
            const inviter = deps.userRepo?.findByTelegramId(invitation.inviter_id);
            const inviterName = inviter?.first_name ?? inviter?.username ?? `User ${invitation.inviter_id}`;

            const text = event
              ? formatInvitation(
                  event,
                  event.timezone,
                  lang,
                  inviterName,
                  invitation.inviter_id,
                  inviter?.username,
                  user.timezone,
                  !!user.onboarding_completed,
                )
              : `📨 ${inviterName} ${lang === 'ru' ? 'приглашает вас на событие' : 'invites you to an event'}`;
            const kb = new InlineKeyboard()
              .text('Accept ✅', `${CB.INVITATION_ACTION}:accept:${invitation.id}`)
              .text('Decline ❌', `${CB.INVITATION_ACTION}:decline:${invitation.id}`)
              .row()
              .text('Maybe 🤔', `${CB.INVITATION_ACTION}:maybe:${invitation.id}`);

            await ctx.send(text, { parse_mode: 'HTML', reply_markup: kb });
          } else {
            await ctx.send(
              lang === 'ru' ? '📨 Приглашение уже недействительно.' : '📨 This invitation is no longer valid.',
            );
          }

          if (!user.onboarding_completed) {
            cmdLogger.info({ userId: user.telegram_id }, 'Starting onboarding after invitation deep link');
            await ctx.scene.enter(deps.onboardingScene);
          }
          return;
        }

        if (resolved.type === 'group_context') {
          await ctx.send(lang === 'ru' ? '\u{1f465} Группа подключена' : '\u{1f465} Group connected');
          return;
        }
      }
      // Invalid deep link — fall through to normal /start behavior
    }
  }

  if (user.onboarding_completed) {
    await ctx.send(t(lang).welcome_back);
    return;
  }

  await ctx.scene.enter(deps.onboardingScene);
}
