// src/bot/commands/start.ts

import type { AnyScene } from '@gramio/scenes';
import { t } from '../../config/constants.ts';
import type { InvitationRepository } from '../../database/repositories/invitation.repository.ts';
import type { UserRepository } from '../../database/repositories/user.repository.ts';
import type { Invitation, User } from '../../database/types.ts';
import type { EventService } from '../../services/event/event-service.ts';
import { formatEventDetail, formatInvitation } from '../../services/event/formatters.ts';
import type { DeepLinkService } from '../../services/sharing/deep-link-service.ts';
import { readInvitationRoster } from '../../services/sharing/invitation-roster.ts';
import { invitationRsvpKeyboard } from '../../services/sharing/invitation-rsvp-keyboard.ts';
import { cmdLogger } from '../../utils/logger.ts';
import type { BotCommandContext } from '../types.ts';

export interface StartDeps {
  onboardingScene: AnyScene;
  deepLinkService?: DeepLinkService;
  eventService?: EventService;
  invitationRepo?: InvitationRepository;
  userRepo?: UserRepository;
}

/** Who is running /start: the DB user and their language. */
interface StartScope {
  ctx: BotCommandContext;
  user: User;
  lang: 'en' | 'ru';
  onboardingScene: AnyScene;
}

const DEEP_LINK_PREFIXES = ['s_', 'i_', 'g_'];

/** Shows the shared event card; false when the event is gone so /start continues normally. */
async function showSharedEvent(
  scope: StartScope,
  eventService: EventService,
  eventId: number,
  createdBy: number,
): Promise<boolean> {
  const { ctx, user, lang, onboardingScene } = scope;
  const event = eventService.getEvent(eventId, createdBy);
  if (!event) return false;
  const card = formatEventDetail(event, event.timezone, lang);
  await ctx.send(card, { parse_mode: 'HTML' });
  if (!user.onboarding_completed) await ctx.scene.enter(onboardingScene);
  return true;
}

/** An invitation link only works for the invitee it was issued to, for that event, from that inviter. */
function invitationBindingMismatch(
  invitation: Invitation,
  userId: number,
  eventId: number,
  inviterId: number,
): boolean {
  return invitation.invitee_id !== userId || invitation.event_id !== eventId || invitation.inviter_id !== inviterId;
}

async function sendPendingInvitation(
  scope: StartScope,
  deps: InvitationDeepLinkDeps,
  invitation: Invitation,
  eventId: number,
  createdBy: number,
): Promise<void> {
  const { ctx, user, lang } = scope;
  const event = deps.eventService.getEvent(eventId, createdBy);
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
        readInvitationRoster(deps.invitationRepo, event.id, user.telegram_id),
      )
    : `📨 ${inviterName} ${lang === 'ru' ? 'приглашает вас на событие' : 'invites you to an event'}`;
  await ctx.send(text, {
    parse_mode: 'HTML',
    reply_markup: invitationRsvpKeyboard(invitation.id, lang, event),
  });
}

interface InvitationDeepLinkDeps {
  invitationRepo: InvitationRepository;
  eventService: EventService;
  userRepo: UserRepository | undefined;
}

/** Handles an `i_` deep link; always consumes /start (the link resolved to an invitation). */
async function handleInvitationDeepLink(
  scope: StartScope,
  deps: InvitationDeepLinkDeps,
  payload: { invitation_id: number; event_id: number },
  createdBy: number,
): Promise<void> {
  const { ctx, user, lang, onboardingScene } = scope;
  const invitation = deps.invitationRepo.findById(payload.invitation_id);
  if (invitation && invitationBindingMismatch(invitation, user.telegram_id, payload.event_id, createdBy)) {
    cmdLogger.warn(
      { invitationId: invitation.id, userId: user.telegram_id },
      'Invitation link recipient or binding mismatch',
    );
    await ctx.send(t(lang).aiTools.meta.invitationLinkUnavailable);
    return;
  }

  const pending = invitation && invitation.status === 'pending' ? invitation : null;
  if (pending) {
    await sendPendingInvitation(scope, deps, pending, payload.event_id, createdBy);
  } else {
    await ctx.send(lang === 'ru' ? '📨 Приглашение уже недействительно.' : '📨 This invitation is no longer valid.');
  }

  if (!user.onboarding_completed) {
    cmdLogger.info({ userId: user.telegram_id }, 'Starting onboarding after invitation deep link');
    await ctx.scene.enter(
      onboardingScene,
      pending
        ? {
            pendingInvitationId: pending.id,
            pendingEventId: payload.event_id,
            pendingInviterTelegramId: pending.inviter_id,
          }
        : {},
    );
  }
}

/** Handles /start deep links (s_ = shared event, i_ = invitation, g_ = group context); true when /start is consumed. */
async function tryHandleDeepLink(
  scope: StartScope,
  deps: StartDeps,
  deepLinkService: DeepLinkService,
  arg: string,
): Promise<boolean> {
  if (!DEEP_LINK_PREFIXES.some((prefix) => arg.startsWith(prefix))) return false;
  const resolved = deepLinkService.resolve(arg);
  // Invalid deep link — fall through to normal /start behavior
  if (!resolved) return false;

  if (resolved.type === 'shared_event' && deps.eventService) {
    return showSharedEvent(scope, deps.eventService, resolved.payload.event_id, resolved.createdBy);
  }

  if (resolved.type === 'invitation' && deps.invitationRepo && deps.eventService) {
    const invitationDeps = {
      invitationRepo: deps.invitationRepo,
      eventService: deps.eventService,
      userRepo: deps.userRepo,
    };
    await handleInvitationDeepLink(scope, invitationDeps, resolved.payload, resolved.createdBy);
    return true;
  }

  if (resolved.type === 'group_context') {
    await scope.ctx.send(scope.lang === 'ru' ? '\u{1f465} Группа подключена' : '\u{1f465} Group connected');
    return true;
  }
  return false;
}

export async function handleStart(ctx: BotCommandContext, deps: StartDeps): Promise<void> {
  const user = ctx.dbUser;
  if (!user) return;
  const lang = user.language as 'en' | 'ru';
  const scope: StartScope = { ctx, user, lang, onboardingScene: deps.onboardingScene };

  if (ctx.args && deps.deepLinkService) {
    if (await tryHandleDeepLink(scope, deps, deps.deepLinkService, ctx.args.trim())) return;
  }

  if (user.onboarding_completed) {
    await ctx.send(t(lang).welcome_back);
    return;
  }

  await ctx.scene.enter(deps.onboardingScene);
}
