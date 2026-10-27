// event tool handlers: the order in which update/delete/snooze refuse a call, and the Google
// Calendar fan-out they run after a write. Locks in the behavior of the helpers extracted from
// handleUpdateEvent and handleDeleteEvent (events/google-push.ts, events/update.ts, events/delete.ts).
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { EventRepository } from '../../../../src/database/repositories/event.repository.ts';
import { GoogleCalendarRepository } from '../../../../src/database/repositories/google-calendar.repository.ts';
import { GroupMemberRepository } from '../../../../src/database/repositories/group-member.repository.ts';
import { ParticipantRepository } from '../../../../src/database/repositories/participant.repository.ts';
import { UserRepository } from '../../../../src/database/repositories/user.repository.ts';
import { approveDeletes } from '../../../../src/services/ai/delete-confirmation.ts';
import {
  type ParticipantPush,
  pushEventToUsers,
} from '../../../../src/services/ai/tool-handlers/events/google-push.ts';
import {
  handleDeleteEvent,
  handleSnoozeEvent,
  handleUpdateEvent,
} from '../../../../src/services/ai/tool-handlers/events.ts';
import type { AgentContext, GoogleCapability } from '../../../../src/services/ai/types.ts';
import { createEventToolFixture, type EventToolFixture, USER_ID } from './events-fixtures.ts';

const GROUP_CHAT_ID = -100777;
const ACCEPTED_USER = 601;
const PENDING_USER = 602;
const OTHER_GROUP_MEMBER = 603;

type PushAction = 'create' | 'update' | 'delete';
interface RecordedPush {
  userId: number;
  eventId: number;
  action: PushAction;
}

function recordingPush(failFor: readonly number[] = []) {
  const pushed: RecordedPush[] = [];
  const push = mock(async (userId: number, eventId: number, action: PushAction) => {
    pushed.push({ userId, eventId, action });
    if (failFor.includes(userId)) throw new Error(`push failed for ${userId}`);
  });
  return { pushed, push };
}

describe('event write handlers', () => {
  let db: EventToolFixture['db'];
  let ctx: AgentContext;

  beforeEach(() => {
    ({ db, ctx } = createEventToolFixture());
    const userRepo = new UserRepository(db);
    for (const id of [ACCEPTED_USER, PENDING_USER, OTHER_GROUP_MEMBER])
      userRepo.create({ telegram_id: id, timezone: 'UTC' });
  });

  function createOwnEvent(googleEventId?: string) {
    const event = ctx.eventService.createEvent({
      user_id: USER_ID,
      title: 'Planning',
      start_at: '2026-03-15T10:00:00Z',
      end_at: '2026-03-15T11:00:00Z',
      timezone: 'UTC',
    });
    if (googleEventId !== undefined)
      new EventRepository(db).updateSyncFields(event.id, { google_event_id: googleEventId });
    return event;
  }

  function withGoogle(push: ParticipantPush, schedulePush?: GoogleCapability['schedulePush']): AgentContext {
    return {
      ...ctx,
      participantRepo: new ParticipantRepository(db),
      google: { googleCalendarRepo: new GoogleCalendarRepository(db), scheduleParticipantPush: push, schedulePush },
    };
  }

  describe('pushEventToUsers', () => {
    test('pushes the action to every user and keeps going past a rejected push', async () => {
      const { pushed, push } = recordingPush([2]);
      await pushEventToUsers(push, [1, 2, 3], 42, 'delete', 'push failed', 'userId');
      expect(pushed).toEqual([
        { userId: 1, eventId: 42, action: 'delete' },
        { userId: 2, eventId: 42, action: 'delete' },
        { userId: 3, eventId: 42, action: 'delete' },
      ]);
    });

    test('does nothing for an empty audience', async () => {
      const { pushed, push } = recordingPush();
      await pushEventToUsers(push, [], 42, 'update', 'push failed', 'participantUserId');
      expect(pushed).toEqual([]);
    });
  });

  describe('handleUpdateEvent — refusal order', () => {
    test('group scope without a group chat is refused before the event is looked up', async () => {
      const result = await handleUpdateEvent(ctx, { event_id: 9999, title: 'x', scope: 'group' });
      expect(result).toEqual({
        success: false,
        mutationState: 'not_applied',
        error: 'Group context required for group scope',
      });
    });

    test('an unknown event is "not found" even when the timestamp is also invalid', async () => {
      const result = await handleUpdateEvent(ctx, { event_id: 9999, start_at: 'tomorrow-ish' });
      expect(result.mutationState).toBe('not_applied');
      expect(result.error).toBe('Event 9999 not found or not owned by you.');
    });

    test('an existing event with an invalid timestamp is refused and left unchanged', async () => {
      const event = createOwnEvent();
      const result = await handleUpdateEvent(ctx, { event_id: event.id, title: 'Renamed', start_at: 'tomorrow-ish' });
      expect(result.success).toBe(false);
      expect(result.mutationState).toBe('not_applied');
      expect(result.error).toContain('INVALID_EVENT_DATETIME: start_at');
      expect(ctx.eventService.getEvent(event.id, USER_ID)?.title).toBe('Planning');
    });
  });

  describe('handleUpdateEvent — Google fan-out', () => {
    test('pushes the update to accepted participants only, never to the owner or pending guests', async () => {
      const event = createOwnEvent();
      const participantRepo = new ParticipantRepository(db);
      participantRepo.add(event.id, ACCEPTED_USER, 'accepted');
      participantRepo.add(event.id, PENDING_USER, 'pending');
      participantRepo.add(event.id, USER_ID, 'accepted');
      const { pushed, push } = recordingPush();

      const result = await handleUpdateEvent(withGoogle(push), { event_id: event.id, title: 'Planning v2' });

      expect(result.success).toBe(true);
      expect(pushed).toEqual([{ userId: ACCEPTED_USER, eventId: event.id, action: 'update' }]);
      expect(result.output).toContain('1 participant');
    });

    test('a rejected participant push is logged, not surfaced: the edit still succeeds', async () => {
      const event = createOwnEvent();
      new ParticipantRepository(db).add(event.id, ACCEPTED_USER, 'accepted');
      const { push } = recordingPush([ACCEPTED_USER]);

      const result = await handleUpdateEvent(withGoogle(push), { event_id: event.id, title: 'Planning v2' });

      expect(result.success).toBe(true);
      expect(ctx.eventService.getEvent(event.id, USER_ID)?.title).toBe('Planning v2');
    });

    test('a rejected owner schedulePush does not fail the edit either', async () => {
      const event = createOwnEvent();
      const schedulePush = mock(async () => {
        throw new Error('queue down');
      });
      const { push } = recordingPush();

      const result = await handleUpdateEvent(withGoogle(push, schedulePush), {
        event_id: event.id,
        title: 'Planning v2',
      });

      expect(result.success).toBe(true);
      expect(schedulePush).toHaveBeenCalledWith(USER_ID, event.id, 'update');
    });

    test('the group-scope result carries the do-not-repeat hint with the queued notification count', async () => {
      const event = ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Offsite',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
        owner_type: 'group',
        group_id: GROUP_CHAT_ID,
        created_by: USER_ID,
      });
      const groupMemberRepo = new GroupMemberRepository(db);
      groupMemberRepo.upsert(GROUP_CHAT_ID, USER_ID);
      groupMemberRepo.upsert(GROUP_CHAT_ID, OTHER_GROUP_MEMBER);
      const { pushed, push } = recordingPush();
      const groupCtx: AgentContext = {
        ...withGoogle(push),
        isGroup: true,
        groupChatId: GROUP_CHAT_ID,
        chatId: GROUP_CHAT_ID,
        group: { groupMemberRepo } as unknown as AgentContext['group'],
      };

      const result = await handleUpdateEvent(groupCtx, { event_id: event.id, title: 'Offsite v2', scope: 'group' });

      expect(result.success).toBe(true);
      expect(result.agentHint).toContain('Do NOT call update_event again with identical arguments.');
      expect(pushed.map((p) => p.userId)).toEqual([OTHER_GROUP_MEMBER]);
    });
  });

  describe('handleDeleteEvent — refusal order', () => {
    test('an unknown id is "not found" before any confirmation is demanded', async () => {
      const result = await handleDeleteEvent(ctx, { event_id: 9999 });
      expect(result.success).toBe(false);
      expect(result.mutationState).toBe('not_applied');
      expect(result.error).toBe('Event 9999 not found or not owned by you.');
    });

    test('an existing own event without the user’s confirmation is refused and kept', async () => {
      const event = createOwnEvent();
      const result = await handleDeleteEvent(ctx, { event_id: event.id });
      expect(result.success).toBe(false);
      expect(result.mutationState).toBe('not_applied');
      expect(result.agentHint).toContain('Call ask_user with event_ids');
      expect(ctx.eventService.getEvent(event.id, USER_ID)).not.toBeNull();
    });

    test('group scope without a group chat is refused with the group-context error', async () => {
      const result = await handleDeleteEvent(ctx, { event_id: 1, scope: 'group' });
      expect(result.error).toBe('Group context required for group scope');
    });

    test('an unknown group event is "not found in group calendar" before the confirmation check', async () => {
      const groupCtx: AgentContext = { ...ctx, isGroup: true, groupChatId: GROUP_CHAT_ID, chatId: GROUP_CHAT_ID };
      const result = await handleDeleteEvent(groupCtx, { event_id: 9999, scope: 'group' });
      expect(result.error).toBe('Event 9999 not found in group calendar.');
    });
  });

  describe('handleDeleteEvent — Google fan-out and decline', () => {
    test('removes the event from accepted participants’ calendars, then the owner’s by Google id', async () => {
      const event = createOwnEvent('g-evt-1');
      const participantRepo = new ParticipantRepository(db);
      participantRepo.add(event.id, ACCEPTED_USER, 'accepted');
      participantRepo.add(event.id, PENDING_USER, 'pending');
      const { pushed, push } = recordingPush();
      const schedulePush = mock(async () => {});
      approveDeletes(USER_ID, ctx.chatId, [event.id]);

      const result = await handleDeleteEvent(withGoogle(push, schedulePush), { event_id: event.id });

      expect(result.success).toBe(true);
      expect(result.effect).toEqual({ kind: 'event_deleted' });
      expect(pushed).toEqual([{ userId: ACCEPTED_USER, eventId: event.id, action: 'delete' }]);
      expect(schedulePush).toHaveBeenCalledWith(USER_ID, event.id, 'delete', { googleEventId: 'g-evt-1' });
    });

    test('an event with no Google id is not scheduled for an owner-calendar delete', async () => {
      const event = createOwnEvent();
      const { push } = recordingPush();
      const schedulePush = mock(async () => {});
      approveDeletes(USER_ID, ctx.chatId, [event.id]);

      await handleDeleteEvent(withGoogle(push, schedulePush), { event_id: event.id });

      expect(schedulePush).not.toHaveBeenCalled();
    });

    test('a failing participant push does not stop the delete', async () => {
      const event = createOwnEvent();
      new ParticipantRepository(db).add(event.id, ACCEPTED_USER, 'accepted');
      const { push } = recordingPush([ACCEPTED_USER]);
      approveDeletes(USER_ID, ctx.chatId, [event.id]);

      const result = await handleDeleteEvent(withGoogle(push), { event_id: event.id });

      expect(result.success).toBe(true);
      expect(ctx.eventService.getEvent(event.id, USER_ID)).toBeNull();
    });

    test('group delete removes the event from every active member’s calendar, then deletes it', async () => {
      const event = ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Offsite',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
        owner_type: 'group',
        group_id: GROUP_CHAT_ID,
        created_by: USER_ID,
      });
      const groupMemberRepo = new GroupMemberRepository(db);
      groupMemberRepo.upsert(GROUP_CHAT_ID, USER_ID);
      groupMemberRepo.upsert(GROUP_CHAT_ID, OTHER_GROUP_MEMBER);
      const { pushed, push } = recordingPush();
      const groupCtx: AgentContext = {
        ...withGoogle(push),
        isGroup: true,
        groupChatId: GROUP_CHAT_ID,
        chatId: GROUP_CHAT_ID,
        group: { groupMemberRepo } as unknown as AgentContext['group'],
      };
      approveDeletes(USER_ID, GROUP_CHAT_ID, [event.id]);

      const result = await handleDeleteEvent(groupCtx, { event_id: event.id, scope: 'group' });

      expect(result.success).toBe(true);
      expect(pushed.map((p) => p.userId).sort()).toEqual([USER_ID, OTHER_GROUP_MEMBER].sort());
      expect(pushed.every((p) => p.action === 'delete')).toBe(true);
      expect(ctx.eventService.getEventForGroup(event.id, GROUP_CHAT_ID)).toBeNull();
    });

    test('deleting an event someone else owns and the user accepted only declines it for the user', async () => {
      const event = ctx.eventService.createEvent({
        user_id: ACCEPTED_USER,
        title: 'Their party',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
      });
      const participantRepo = new ParticipantRepository(db);
      participantRepo.add(event.id, USER_ID, 'accepted');
      const { pushed, push } = recordingPush();
      approveDeletes(USER_ID, ctx.chatId, [event.id]);

      const result = await handleDeleteEvent(withGoogle(push), { event_id: event.id });

      expect(result.success).toBe(true);
      expect(result.effect).toEqual({ kind: 'attendance_declined' });
      expect(participantRepo.findByEventAndUser(event.id, USER_ID)?.status).toBe('declined');
      expect(ctx.eventService.getEvent(event.id, ACCEPTED_USER)).not.toBeNull();
      expect(pushed).toEqual([{ userId: USER_ID, eventId: event.id, action: 'delete' }]);
    });

    test('declining without the user’s confirmation is refused and the RSVP is untouched', async () => {
      const event = ctx.eventService.createEvent({
        user_id: ACCEPTED_USER,
        title: 'Their party',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
      });
      const participantRepo = new ParticipantRepository(db);
      participantRepo.add(event.id, USER_ID, 'accepted');

      const result = await handleDeleteEvent({ ...ctx, participantRepo }, { event_id: event.id });

      expect(result.success).toBe(false);
      expect(result.mutationState).toBe('not_applied');
      expect(participantRepo.findByEventAndUser(event.id, USER_ID)?.status).toBe('accepted');
    });

    test('a user who only has a pending invitation gets "not found", not a decline', async () => {
      const event = ctx.eventService.createEvent({
        user_id: ACCEPTED_USER,
        title: 'Their party',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
      });
      const participantRepo = new ParticipantRepository(db);
      participantRepo.add(event.id, USER_ID, 'pending');

      const result = await handleDeleteEvent({ ...ctx, participantRepo }, { event_id: event.id });

      expect(result.error).toBe(`Event ${event.id} not found or not owned by you.`);
      expect(participantRepo.findByEventAndUser(event.id, USER_ID)?.status).toBe('pending');
    });
  });

  describe('handleSnoozeEvent — refusal order', () => {
    test('group scope without a group chat is refused before the event is looked up', () => {
      const result = handleSnoozeEvent(ctx, { event_id: 9999, scope: 'group' });
      expect(result).toEqual({
        success: false,
        mutationState: 'not_applied',
        error: 'Group context required for group scope',
      });
    });
  });
});
