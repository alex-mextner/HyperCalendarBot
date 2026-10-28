import { describe, expect, spyOn, test } from 'bun:test';
import { subscribeParticipantGooglePush } from '../../src/bootstrap/domain-events.ts';
import type { GroupMemberRepository } from '../../src/database/repositories/group-member.repository.ts';
import type { CalendarEvent } from '../../src/database/types.ts';
import { DomainEventBus } from '../../src/services/scheduled/domain-event-bus.ts';
import { botLogger } from '../../src/utils/logger.ts';

function eventWithId(id: number): CalendarEvent {
  return {
    id,
    user_id: 1,
    title: 'e',
    description: null,
    category: null,
    start_at: '2026-10-26 10:00:00',
    end_at: null,
    all_day: 0,
    timezone: 'UTC',
    location: null,
    recurrence_rule: null,
    recurrence_end_at: null,
    parent_event_id: null,
    original_start_at: null,
    is_cancelled: 0,
    is_deleted: 0,
    reminder_overrides: null,
    google_event_id: null,
    google_calendar_id: null,
    google_etag: null,
    sync_status: 'local_only',
    sync_version: 0,
    owner_type: 'user',
    group_id: null,
    created_by: null,
    resolved_address: null,
    latitude: null,
    longitude: null,
    google_maps_url: null,
    location_verified: 0,
    venue_name: null,
    last_synced_at: null,
    created_at: '2026-10-26 09:00:00',
    updated_at: '2026-10-26 09:00:00',
  };
}

type Push = [number, number, 'create' | 'update' | 'delete'];

function wired(activeMemberIds: number[] = []) {
  const bus = new DomainEventBus();
  const pushes: Push[] = [];
  const groupMembers = {
    getActiveMembers: (_chatId: number) => activeMemberIds.map((user_id) => ({ user_id })),
  } as unknown as GroupMemberRepository;
  subscribeParticipantGooglePush(
    bus,
    async (userId, eventId, action) => {
      pushes.push([userId, eventId, action]);
    },
    groupMembers,
  );
  return { bus, pushes };
}

describe('subscribeParticipantGooglePush', () => {
  test('an accepted invitation creates the invitee copy', () => {
    const { bus, pushes } = wired();
    bus.emit('myInvitations.accepted', { userId: 1, inviteeId: 20, event: eventWithId(5) });
    expect(pushes).toEqual([[20, 5, 'create']]);
  });

  test('a rejected invitation deletes the invitee copy', () => {
    const { bus, pushes } = wired();
    bus.emit('myInvitations.rejected', { userId: 1, inviteeId: 20, event: eventWithId(5) });
    expect(pushes).toEqual([[20, 5, 'delete']]);
  });

  test('a new group event is pushed to every active member', () => {
    const { bus, pushes } = wired([11, 12]);
    bus.emit('myGroup.newEvent', { userId: 1, groupChatId: -9, newEvent: eventWithId(7), createdBy: 1 });
    expect(pushes).toEqual([
      [11, 7, 'create'],
      [12, 7, 'create'],
    ]);
  });

  test('an RSVP creates the copy when accepted and deletes it otherwise', () => {
    const { bus, pushes } = wired();
    bus.emit('myGroup.rsvp', { userId: 30, eventId: 8, status: 'accepted' });
    bus.emit('myGroup.rsvp', { userId: 30, eventId: 8, status: 'declined' });
    expect(pushes).toEqual([
      [30, 8, 'create'],
      [30, 8, 'delete'],
    ]);
  });

  test('a failing push is swallowed and logged, not thrown into the emitter', async () => {
    const logged = spyOn(botLogger, 'error').mockImplementation(() => undefined);
    try {
      const failures: Promise<void>[] = [];
      const bus = new DomainEventBus();
      subscribeParticipantGooglePush(
        bus,
        () => {
          const failure = Promise.reject<void>(new Error('queue down'));
          failures.push(failure);
          return failure;
        },
        { getActiveMembers: () => [] } as unknown as GroupMemberRepository,
      );

      expect(() =>
        bus.emit('myInvitations.accepted', { userId: 1, inviteeId: 2, event: eventWithId(1) }),
      ).not.toThrow();
      // The subscriber attached its catch first, so it has run by the time this one settles.
      await Promise.all(failures.map((failure) => failure.catch(() => undefined)));
      expect(logged).toHaveBeenCalledTimes(1);
    } finally {
      logged.mockRestore();
    }
  });
});
