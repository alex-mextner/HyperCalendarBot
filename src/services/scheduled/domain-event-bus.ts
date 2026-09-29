import mitt from 'mitt';
import type { CalendarEvent } from '../../database/types.ts';

export type DomainEventMap = {
  'myCalendar.newEvent': { userId: number; newEvent: CalendarEvent };
  'myCalendar.updatedEvent': { userId: number; updatedEvent: CalendarEvent; oldEvent: CalendarEvent };
  'myCalendar.deletedEvent': { userId: number; eventId: number; title: string };
  'myCalendar.eventStarting': { userId: number; event: CalendarEvent };
  'myInvitations.accepted': { userId: number; inviteeId: number; event: CalendarEvent };
  'myInvitations.rejected': { userId: number; inviteeId: number; event: CalendarEvent };
  'myGroup.newEvent': { userId: number; groupChatId: number; newEvent: CalendarEvent; createdBy: number };
  // Internal plumbing topic: one group member's RSVP, used only to mirror their answer into their
  // own Google Calendar. userId is the tapping member — deliberately kept OUT of ALL_TOPICS so it
  // never reaches TriggerService (would fire user-defined automations) or the AI scheduled-call
  // topic list.
  'myGroup.rsvp': { userId: number; eventId: number; status: 'accepted' | 'declined' };
  // Internal plumbing topic: someone was invited to, answered, or was withdrawn from an event, so its
  // delivered invitation cards re-render their roster; kept OUT of ALL_TOPICS like myGroup.rsvp.
  // userId is the organizer (the event owner); answeredInvitationId names the card the answering
  // invitee's own callback rewrites itself, so only their RSVP sets it.
  'invitationRoster.changed': { userId: number; eventId: number; answeredInvitationId?: number };
};

export type DomainEventTopic = keyof DomainEventMap;

export const ALL_TOPICS = Object.freeze([
  'myCalendar.newEvent',
  'myCalendar.updatedEvent',
  'myCalendar.deletedEvent',
  'myCalendar.eventStarting',
  'myInvitations.accepted',
  'myInvitations.rejected',
  'myGroup.newEvent',
] as const satisfies readonly DomainEventTopic[]);

export class DomainEventBus {
  private emitter = mitt<DomainEventMap>();

  emit<T extends DomainEventTopic>(topic: T, payload: DomainEventMap[T]): void {
    this.emitter.emit(topic, payload);
  }

  on<T extends DomainEventTopic>(topic: T, handler: (payload: DomainEventMap[T]) => void): void {
    this.emitter.on(topic, handler);
  }
}
