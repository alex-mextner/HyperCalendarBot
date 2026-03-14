// src/bot/commands/start.ts

import type { AnyScene } from '@gramio/scenes';
import { t } from '../../config/constants.ts';
import type { User } from '../../database/types.ts';
import type { EventService } from '../../services/event/event-service.ts';
import { formatEventDetail } from '../../services/event/formatters.ts';
import type { DeepLinkService } from '../../services/sharing/deep-link-service.ts';
import type { BotCommandContext } from '../types.ts';

export async function handleStart(
  ctx: BotCommandContext,
  onboardingScene: AnyScene,
  deepLinkService?: DeepLinkService,
  eventService?: EventService,
): Promise<void> {
  const user = ctx.dbUser as User;
  const lang = user.language as 'en' | 'ru';

  // Handle deep links (s_ = shared event, i_ = invitation, g_ = group context)
  if (ctx.args && deepLinkService) {
    const arg = ctx.args.trim();

    if (arg.startsWith('s_') || arg.startsWith('i_') || arg.startsWith('g_')) {
      const resolved = deepLinkService.resolve(arg);
      if (resolved) {
        if (resolved.type === 'shared_event' && eventService) {
          const eventId = (resolved.payload as { event_id: number }).event_id;
          const event = eventService.getEvent(eventId, resolved.createdBy);
          if (event) {
            const card = formatEventDetail(event, event.timezone, lang);
            await ctx.send(card, { parse_mode: 'HTML' });
            return;
          }
        }

        if (resolved.type === 'invitation') {
          await ctx.send(
            lang === 'ru'
              ? '\u{1f4e8} Проверьте ваши приглашения: /invitations'
              : '\u{1f4e8} Check your invitations: /invitations',
          );
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

  await ctx.scene.enter(onboardingScene);
}
