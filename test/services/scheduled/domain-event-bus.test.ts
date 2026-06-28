import { describe, expect, mock, test } from 'bun:test';
import { ALL_TOPICS, DomainEventBus } from '../../../src/services/scheduled/domain-event-bus.ts';

describe('DomainEventBus', () => {
  test('emits typed event to subscriber', () => {
    const bus = new DomainEventBus();
    const handler = mock(() => {});
    bus.on('myCalendar.newEvent', handler);
    const payload = { userId: 1, newEvent: { id: 1, title: 'Test' } as never };
    bus.emit('myCalendar.newEvent', payload);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(payload);
  });

  test('multiple subscribers all receive event', () => {
    const bus = new DomainEventBus();
    const h1 = mock(() => {});
    const h2 = mock(() => {});
    bus.on('myCalendar.deletedEvent', h1);
    bus.on('myCalendar.deletedEvent', h2);
    bus.emit('myCalendar.deletedEvent', { userId: 1, eventId: 1, title: 'Test' });
    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
  });

  test('subscriber for different topic does not receive event', () => {
    const bus = new DomainEventBus();
    const handler = mock(() => {});
    bus.on('myInvitations.accepted', handler);
    bus.emit('myCalendar.newEvent', { userId: 1, newEvent: { id: 1, title: 'Test' } as never });
    expect(handler).not.toHaveBeenCalled();
  });

  test('myGroup.rsvp is excluded from ALL_TOPICS (internal plumbing, never user-triggerable)', () => {
    // Security invariant: myGroup.rsvp.userId is the tapping member, not an event owner. It must
    // never reach TriggerService (fires user-defined automations) or the AI scheduled-call topic
    // list, both of which iterate/validate against ALL_TOPICS. A future "make ALL_TOPICS
    // exhaustive" change must not silently re-include it.
    expect(ALL_TOPICS).not.toContain('myGroup.rsvp');
  });
});
