import mitt from 'mitt';
import type { CalendarEvent } from '../../database/types.ts';

export type DomainEventMap = {
  'myCalendar.newEvent': { userId: number; newEvent: CalendarEvent };
  'myCalendar.updatedEvent': { userId: number; updatedEvent: CalendarEvent; oldEvent: CalendarEvent };
  'myCalendar.deletedEvent': { userId: number; eventId: number; title: string };
  'myCalendar.conflictDetected': { userId: number; event: CalendarEvent; conflictsWith: CalendarEvent };
  'myCalendar.eventStarting': { userId: number; event: CalendarEvent };
  'myInvitations.accepted': { userId: number; inviteeId: number; event: CalendarEvent };
  'myInvitations.rejected': { userId: number; inviteeId: number; event: CalendarEvent };
  'myGroup.newEvent': { userId: number; groupChatId: number; newEvent: CalendarEvent; createdBy: number };
};

export type DomainEventTopic = keyof DomainEventMap;

export const ALL_TOPICS = Object.freeze([
  'myCalendar.newEvent',
  'myCalendar.updatedEvent',
  'myCalendar.deletedEvent',
  'myCalendar.conflictDetected',
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
