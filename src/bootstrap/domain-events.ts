// src/bootstrap/domain-events.ts
//
// Startup phase: the domain event bus and the subscribers that do not need the bot itself.
//
// Ordering invariants:
//  - The bus is created before createBot(): the bot and its services publish on it.
//  - The Google participant-push subscribers exist only when the Google sync phase produced a
//    scheduler; they register before the invitation-card refresher, as before.
//  - The card refresher edits messages through `ctx.botRef`, resolved at call time (patched after
//    createBot()).
//  - TriggerService subscribes later, in scheduled-ai.ts, once the AI queue exists.

import { AgendaRepository } from '../database/repositories/agenda.repository.ts';
import { DomainEventBus } from '../services/scheduled/domain-event-bus.ts';
import { InvitationCardRefresher } from '../services/sharing/invitation-cards.ts';
import type { WeatherService } from '../services/weather/weather-service.ts';
import { botLogger } from '../utils/logger.ts';
import type { ParticipantPushScheduler } from './google-sync.ts';
import type { StartupContext } from './runtime.ts';

/** Participant Google Sync — push accepted invitation events to invitee's Google Calendar. */
export function subscribeParticipantGooglePush(
  bus: DomainEventBus,
  schedule: ParticipantPushScheduler,
  groupMembers: StartupContext['db']['groupMembers'],
): void {
  bus.on('myInvitations.accepted', ({ inviteeId, event }) => {
    schedule(inviteeId, event.id, 'create').catch((err) =>
      botLogger.error({ err, inviteeId, eventId: event.id }, 'Failed to schedule participant Google push'),
    );
  });
  bus.on('myInvitations.rejected', ({ inviteeId, event }) => {
    schedule(inviteeId, event.id, 'delete').catch((err) =>
      botLogger.error({ err, inviteeId, eventId: event.id }, 'Failed to schedule participant Google delete'),
    );
  });
  bus.on('myGroup.newEvent', ({ groupChatId, newEvent }) => {
    for (const member of groupMembers.getActiveMembers(groupChatId)) {
      schedule(member.user_id, newEvent.id, 'create').catch((err) =>
        botLogger.error(
          { err, userId: member.user_id, eventId: newEvent.id },
          'Failed to schedule group event Google push',
        ),
      );
    }
  });
  bus.on('myGroup.rsvp', ({ userId, eventId, status }) => {
    schedule(userId, eventId, status === 'accepted' ? 'create' : 'delete').catch((err) =>
      botLogger.error({ err, userId, eventId, status }, 'Failed to schedule group RSVP Google sync'),
    );
  });
}

/**
 * Delivered invitation cards list who is invited and each answer; re-render them when that changes.
 * The edit resolves botRef at call time (patched after createBot).
 */
function subscribeInvitationCardRefresh(
  bus: DomainEventBus,
  ctx: StartupContext,
  weatherService: WeatherService | undefined,
): void {
  const { db, botRef } = ctx;
  const invitationCards = new InvitationCardRefresher({
    eventRepo: db.events,
    invitationRepo: db.invitations,
    userRepo: db.users,
    agendaRepository: new AgendaRepository(db.db),
    weatherService,
    editMessage: (chatId, messageId, text, options) =>
      botRef.editMessage(chatId, messageId, text, options.parse_mode, options.reply_markup),
  });
  bus.on('invitationRoster.changed', (change) => {
    invitationCards.refresh(change).catch((err: unknown) => {
      botLogger.error({ err, eventId: change.eventId }, 'Failed to refresh delivered invitation cards');
    });
  });
}

export interface DomainEventInputs {
  participantPushScheduler: ParticipantPushScheduler | undefined;
  weatherService: WeatherService | undefined;
}

export function createDomainEventBus(ctx: StartupContext, inputs: DomainEventInputs): DomainEventBus {
  const bus = new DomainEventBus();
  if (inputs.participantPushScheduler) {
    subscribeParticipantGooglePush(bus, inputs.participantPushScheduler, ctx.db.groupMembers);
  }
  subscribeInvitationCardRefresh(bus, ctx, inputs.weatherService);
  return bus;
}
