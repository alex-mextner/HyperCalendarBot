// event tool handlers: group-calendar scope and personal-scope isolation from group events.
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { GoogleCalendarRepository } from '../../../../src/database/repositories/google-calendar.repository.ts';
import { GroupChatRepository } from '../../../../src/database/repositories/group-chat.repository.ts';
import { GroupMemberRepository } from '../../../../src/database/repositories/group-member.repository.ts';
import { ParticipantRepository } from '../../../../src/database/repositories/participant.repository.ts';
import { UserRepository } from '../../../../src/database/repositories/user.repository.ts';
import { approveDeletes } from '../../../../src/services/ai/delete-confirmation.ts';
import {
  handleCreateEvent,
  handleDeleteEvent,
  handleGetEvent,
  handleGetEvents,
  handleGetUpcoming,
  handleSearchEvents,
  handleSnoozeEvent,
  handleUpdateEvent,
} from '../../../../src/services/ai/tool-handlers/events.ts';
import type { AgentContext, GroupCapability } from '../../../../src/services/ai/types.ts';
import type { GroupMemberService } from '../../../../src/services/group/member-service.ts';
import { createEventToolFixture, type EventToolFixture, USER_ID } from './events-fixtures.ts';

describe('event tool handlers', () => {
  let db: EventToolFixture['db'];
  let ctx: AgentContext;

  beforeEach(() => {
    ({ db, ctx } = createEventToolFixture());
  });

  describe('group scope', () => {
    const GROUP_CHAT_ID = -100999;

    function makeGroupCtx(): AgentContext {
      return {
        ...ctx,
        isGroup: true,
        groupChatId: GROUP_CHAT_ID,
        chatId: GROUP_CHAT_ID,
        groupTitle: 'Test Group',
      };
    }

    function createGroupEvent(title: string, startAt: string, endAt?: string) {
      return ctx.eventService.createEvent({
        user_id: USER_ID,
        title,
        start_at: startAt,
        end_at: endAt,
        timezone: 'UTC',
        owner_type: 'group',
        group_id: GROUP_CHAT_ID,
        created_by: USER_ID,
      });
    }

    test('handleGetEvents with scope=group queries group calendar', async () => {
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Personal Event',
        start_at: '2026-03-15T10:00:00Z',
        end_at: '2026-03-15T11:00:00Z',
        timezone: 'UTC',
      });
      createGroupEvent('Group Event', '2026-03-15T14:00:00Z', '2026-03-15T15:00:00Z');

      const gCtx = makeGroupCtx();
      const result = await handleGetEvents(gCtx, {
        start_date: '2026-03-15T00:00:00Z',
        end_date: '2026-03-15T23:59:59Z',
        scope: 'group',
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Group Event');
      expect(result.output).not.toContain('Personal Event');
    });

    test('handleCreateEvent with scope=group creates group event', async () => {
      const gCtx = makeGroupCtx();
      const result = await handleCreateEvent(gCtx, {
        title: 'Group Meeting',
        start_at: '2026-03-15T14:00:00Z',
        scope: 'group',
        force: true,
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Group Meeting');

      const events = ctx.eventService.getEventsInRangeForGroup(
        GROUP_CHAT_ID,
        '2026-03-15T00:00:00Z',
        '2026-03-15T23:59:59Z',
      );
      expect(events.length).toBe(1);
      expect(events[0]!.event.owner_type).toBe('group');
      expect(events[0]!.event.group_id).toBe(GROUP_CHAT_ID);
      expect(events[0]!.event.created_by).toBe(USER_ID);
    });

    test('handleUpdateEvent with scope=group updates group event', async () => {
      const event = createGroupEvent('Old Group Title', '2026-03-15T10:00:00Z');
      const gCtx = makeGroupCtx();
      const result = await handleUpdateEvent(gCtx, {
        event_id: event.id,
        title: 'New Group Title',
        scope: 'group',
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('New Group Title');
    });

    test('handleDeleteEvent with scope=group deletes from group calendar', async () => {
      const event = createGroupEvent('To Delete Group', '2026-03-15T10:00:00Z');
      const gCtx = makeGroupCtx();
      approveDeletes(gCtx.user.telegram_id, gCtx.chatId, [event.id]);
      const result = await handleDeleteEvent(gCtx, { event_id: event.id, scope: 'group' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('To Delete Group');

      const found = ctx.eventService.getEventForGroup(event.id, GROUP_CHAT_ID);
      expect(found).toBeNull();
    });

    test('handleSearchEvents with scope=group searches group calendar', async () => {
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Personal Standup',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
      });
      createGroupEvent('Group Standup', '2026-03-15T10:00:00Z');

      const gCtx = makeGroupCtx();
      const result = await handleSearchEvents(gCtx, { query: 'Standup', scope: 'group' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Group Standup');
      expect(result.output).not.toContain('Personal Standup');
    });

    test('handleGetEvent with scope=group fetches group event', async () => {
      const event = createGroupEvent('Group Detail', '2026-03-15T10:00:00Z');
      const gCtx = makeGroupCtx();
      const result = await handleGetEvent(gCtx, { event_id: event.id, scope: 'group' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Group Detail');
    });

    test('handleGetUpcoming with scope=group returns group events', async () => {
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Personal Soon',
        start_at: new Date(Date.now() + 3600_000).toISOString(),
        timezone: 'UTC',
      });
      createGroupEvent('Group Soon', new Date(Date.now() + 7200_000).toISOString());

      const gCtx = makeGroupCtx();
      const result = await handleGetUpcoming(gCtx, { scope: 'group' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Group Soon');
      expect(result.output).not.toContain('Personal Soon');
    });

    test('handleSnoozeEvent with scope=group snoozes group event', async () => {
      const event = createGroupEvent('Group Snooze', '2026-03-15T10:00:00Z', '2026-03-15T11:00:00Z');
      const gCtx = makeGroupCtx();
      const result = handleSnoozeEvent(gCtx, { event_id: event.id, minutes: 15, scope: 'group' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('snoozed by 15 min');
    });

    test('scope defaults to group when isGroup=true and scope not specified', async () => {
      createGroupEvent('Group Default', '2026-03-15T14:00:00Z', '2026-03-15T15:00:00Z');
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Personal Default',
        start_at: '2026-03-15T14:00:00Z',
        timezone: 'UTC',
      });

      const gCtx = makeGroupCtx();
      const result = await handleGetEvents(gCtx, {
        start_date: '2026-03-15T00:00:00Z',
        end_date: '2026-03-15T23:59:59Z',
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Group Default');
      expect(result.output).not.toContain('Personal Default');
    });

    test('scope defaults to personal when isGroup=false', async () => {
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Personal Visible',
        start_at: '2026-03-15T14:00:00Z',
        timezone: 'UTC',
      });

      // isGroup=false, no scope => personal path
      const result = await handleGetEvents(ctx, {
        start_date: '2026-03-15T00:00:00Z',
        end_date: '2026-03-15T23:59:59Z',
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Personal Visible');
    });

    test('handleDeleteEvent with scope=group returns error for non-existent group event', async () => {
      const gCtx = makeGroupCtx();
      const result = await handleDeleteEvent(gCtx, { event_id: 9999, scope: 'group' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    test('handleGetEvents includes group title and created_by in output', async () => {
      const groupChatRepo = new GroupChatRepository(db);
      groupChatRepo.upsertGroup({ chat_id: GROUP_CHAT_ID, title: 'Test Group', added_by: USER_ID });
      createGroupEvent('Team Drinks', '2026-03-15T20:00:00Z');

      const gCtx: AgentContext = {
        ...makeGroupCtx(),
        group: {
          groupChatRepo,
          groupMemberRepo: undefined as never,
          groupMemberService: undefined as never,
          checkGroupMembership: undefined as never,
        },
      };
      const result = await handleGetEvents(gCtx, {
        start_date: '2026-03-15T00:00:00Z',
        end_date: '2026-03-15T23:59:59Z',
        scope: 'group',
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Team Drinks');
      expect(result.output).toContain('Test Group');
      expect(result.output).toContain('created_by');
    });

    test('handleGetEvent includes group title and created_by in output', async () => {
      const groupChatRepo = new GroupChatRepository(db);
      groupChatRepo.upsertGroup({ chat_id: GROUP_CHAT_ID, title: 'Test Group', added_by: USER_ID });
      const event = createGroupEvent('Group Detail Event', '2026-03-15T10:00:00Z');

      const gCtx: AgentContext = {
        ...makeGroupCtx(),
        group: {
          groupChatRepo,
          groupMemberRepo: undefined as never,
          groupMemberService: undefined as never,
          checkGroupMembership: undefined as never,
        },
      };
      const result = await handleGetEvent(gCtx, { event_id: event.id, scope: 'group' });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Group Detail Event');
      expect(result.output).toContain('Test Group');
      expect(result.output).toContain('created_by');
    });

    function makeMemberService(memberIds: number[]): GroupMemberService {
      return { getRegisteredMembers: mock(async () => memberIds) } as Partial<GroupMemberService> as GroupMemberService;
    }

    // Collect enqueued broadcast jobs via a shared captor. Each test that
    // exercises the group-notification path wires this into ctx.broadcast so
    // we can assert on exactly what was queued for delivery.
    interface CapturedJob {
      recipientId: number;
      text: string;
      parseMode?: string;
      origin: string;
    }
    function makeCapturingBroadcast(): {
      captured: CapturedJob[];
      broadcast: { enqueue: (d: CapturedJob) => Promise<void>; enqueueBatch: (items: CapturedJob[]) => Promise<void> };
    } {
      const captured: CapturedJob[] = [];
      return {
        captured,
        broadcast: {
          enqueue: async (d) => {
            captured.push(d);
          },
          enqueueBatch: async (items) => {
            captured.push(...items);
          },
        },
      };
    }

    test('handleCreateEvent enqueues notifications for all group members including creator', async () => {
      const MEMBER_ID = 456;
      const groupMemberService = makeMemberService([USER_ID, MEMBER_ID]);
      const { captured, broadcast } = makeCapturingBroadcast();

      const mockGroupChatRepo = { findByChatId: () => null } as never;
      const gCtx: AgentContext = {
        ...makeGroupCtx(),
        group: {
          groupChatRepo: mockGroupChatRepo,
          groupMemberRepo: undefined as never,
          groupMemberService,
          checkGroupMembership: undefined as never,
        },
        broadcast,
      };
      const result = await handleCreateEvent(gCtx, {
        title: 'Party',
        start_at: '2026-03-20T18:00:00Z',
        scope: 'group',
        force: true,
      });

      expect(result.success).toBe(true);
      expect(captured.length).toBe(2);
      const chatIds = captured.map((j) => j.recipientId).sort();
      expect(chatIds).toEqual([USER_ID, MEMBER_ID].sort());
      expect(captured.every((j) => j.text.includes('Party'))).toBe(true);
      expect(captured.every((j) => j.text.includes('Test Group'))).toBe(true);
      expect(captured.every((j) => j.text.includes('18:00'))).toBe(true);
      expect(captured.every((j) => j.parseMode === 'HTML')).toBe(true);
      expect(captured.every((j) => j.origin.startsWith('group_event_created:'))).toBe(true);
    });

    test('handleCreateEvent renders notification in recipient language at enqueue time', async () => {
      const RU_MEMBER_ID = 789;
      const userRepo = ctx.userRepo as UserRepository;
      userRepo.create({ telegram_id: RU_MEMBER_ID, timezone: 'UTC', language: 'ru' });
      const groupMemberService = makeMemberService([USER_ID, RU_MEMBER_ID]);
      const { captured, broadcast } = makeCapturingBroadcast();

      await handleCreateEvent(
        {
          ...makeGroupCtx(),
          group: {
            groupChatRepo: { findByChatId: () => null } as never,
            groupMemberRepo: undefined as never,
            groupMemberService,
            checkGroupMembership: undefined as never,
          },
          broadcast,
        } as AgentContext,
        {
          title: 'Встреча',
          start_at: '2026-03-20T10:00:00Z',
          scope: 'group',
          force: true,
        },
      );

      expect(captured.length).toBe(2);
      const ruJob = captured.find((j) => j.recipientId === RU_MEMBER_ID);
      expect(ruJob?.text).toContain('Новое событие');
    });

    test('handleUpdateEvent enqueues notifications for group members on update', async () => {
      const MEMBER_ID = 456;
      const groupMemberService = makeMemberService([USER_ID, MEMBER_ID]);
      const { captured, broadcast } = makeCapturingBroadcast();

      const event = createGroupEvent('Sprint Planning', '2026-03-21T09:00:00Z');

      const result = await handleUpdateEvent(
        {
          ...makeGroupCtx(),
          group: {
            groupChatRepo: { findByChatId: () => null } as never,
            groupMemberRepo: undefined as never,
            groupMemberService,
            checkGroupMembership: undefined as never,
          },
          broadcast,
        } as AgentContext,
        {
          event_id: event.id,
          title: 'Sprint Planning Updated',
          scope: 'group',
        },
      );

      expect(result.success).toBe(true);
      expect(captured.length).toBe(2);
      const chatIds = captured.map((j) => j.recipientId).sort();
      expect(chatIds).toEqual([USER_ID, MEMBER_ID].sort());
      expect(captured.every((j) => j.text.includes('Sprint Planning Updated'))).toBe(true);
      expect(captured.every((j) => j.text.includes('Test Group'))).toBe(true);
      expect(captured.every((j) => j.parseMode === 'HTML')).toBe(true);
      expect(captured.every((j) => j.origin.startsWith('group_event_updated:'))).toBe(true);
    });

    // Centralized partial-mock factory: the Google fanout path only touches
    // groupMemberRepo, so the other GroupCapability members are supplied as a
    // partial mock per the test-only cast exception in CLAUDE.md.
    function makeGroupCapability(overrides: Partial<GroupCapability>): GroupCapability {
      return overrides as unknown as GroupCapability;
    }

    test('handleUpdateEvent (group) skips declined members in Google fanout, pushes undecided members', async () => {
      const DECLINED_MEMBER = 501;
      const PENDING_MEMBER = 502;
      const NO_ROW_MEMBER = 503;

      const event = createGroupEvent('Quarterly Review', '2026-03-22T09:00:00Z');

      const groupMemberRepo = new GroupMemberRepository(db);
      groupMemberRepo.upsert(GROUP_CHAT_ID, USER_ID);
      groupMemberRepo.upsert(GROUP_CHAT_ID, DECLINED_MEMBER);
      groupMemberRepo.upsert(GROUP_CHAT_ID, PENDING_MEMBER);
      groupMemberRepo.upsert(GROUP_CHAT_ID, NO_ROW_MEMBER);

      // RSVP state: one explicitly declined, one tapped-but-not-declined,
      // one who never tapped anything (no participant row at all).
      const participantRepo = new ParticipantRepository(db);
      participantRepo.add(event.id, DECLINED_MEMBER, 'declined');
      participantRepo.add(event.id, PENDING_MEMBER, 'pending');

      const pushed: { userId: number; action: string }[] = [];
      const scheduleParticipantPush = mock(
        async (userId: number, _eventId: number, action: 'create' | 'update' | 'delete') => {
          pushed.push({ userId, action });
        },
      );

      const gCtx: AgentContext = {
        ...makeGroupCtx(),
        participantRepo,
        group: makeGroupCapability({ groupMemberRepo }),
        google: { googleCalendarRepo: new GoogleCalendarRepository(db), scheduleParticipantPush },
      };

      const result = await handleUpdateEvent(gCtx, {
        event_id: event.id,
        title: 'Quarterly Review Updated',
        scope: 'group',
      });

      expect(result.success).toBe(true);
      const updatedIds = pushed.filter((p) => p.action === 'update').map((p) => p.userId);
      // Declined member's "Not going" must NOT be undone by an edit.
      expect(updatedIds).not.toContain(DECLINED_MEMBER);
      // Members who never declined still receive the edit.
      expect(updatedIds).toContain(PENDING_MEMBER);
      expect(updatedIds).toContain(NO_ROW_MEMBER);
      // Organizer is never part of the member fanout.
      expect(updatedIds).not.toContain(USER_ID);
    });

    test('handleCreateEvent uses invite link as clickable group link when available', async () => {
      const INVITE_LINK = 'https://t.me/+abc123';
      const groupChatRepo = new GroupChatRepository(db);
      groupChatRepo.upsertGroup({ chat_id: GROUP_CHAT_ID, title: 'Test Group', added_by: USER_ID });
      groupChatRepo.setInviteLink(GROUP_CHAT_ID, INVITE_LINK);

      const groupMemberService = makeMemberService([USER_ID]);
      const { captured, broadcast } = makeCapturingBroadcast();

      const gCtx: AgentContext = {
        ...makeGroupCtx(),
        group: {
          groupChatRepo,
          groupMemberRepo: undefined as never,
          groupMemberService,
          checkGroupMembership: undefined as never,
        },
        broadcast,
      };
      await handleCreateEvent(gCtx, {
        title: 'Drinks',
        start_at: '2026-03-20T19:00:00Z',
        scope: 'group',
        force: true,
      });

      expect(captured.length).toBe(1);
      expect(captured[0]!.text).toContain(`href="${INVITE_LINK}"`);
      expect(captured[0]!.text).toContain('Test Group');
    });
  });

  describe('personal scope isolation from group events', () => {
    const GROUP_ID = -100888;

    test('handleGetEvents (personal) returns group-owned events created by the user', async () => {
      db.run('INSERT INTO group_members (chat_id, user_id) VALUES (?, ?)', [GROUP_ID, USER_ID]);
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Group Drinks',
        start_at: '2026-03-18T18:00:00Z',
        timezone: 'UTC',
        owner_type: 'group',
        group_id: GROUP_ID,
        created_by: USER_ID,
      });
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Personal Dinner',
        start_at: '2026-03-18T19:00:00Z',
        timezone: 'UTC',
      });

      const result = await handleGetEvents(ctx, {
        start_date: '2026-03-18T00:00:00Z',
        end_date: '2026-03-18T23:59:59Z',
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Personal Dinner');
      expect(result.output).toContain('Group Drinks');
    });

    test('handleGetEvents (personal) does not return group-owned events created by another user', async () => {
      const OTHER_USER = 999;
      new UserRepository(db).create({ telegram_id: OTHER_USER });
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Group Drinks By Other',
        start_at: '2026-03-18T18:00:00Z',
        timezone: 'UTC',
        owner_type: 'group',
        group_id: GROUP_ID,
        created_by: OTHER_USER,
      });

      const result = await handleGetEvents(ctx, {
        start_date: '2026-03-18T00:00:00Z',
        end_date: '2026-03-18T23:59:59Z',
      });

      expect(result.success).toBe(true);
      expect(result.output).not.toContain('Group Drinks By Other');
    });

    test('handleDeleteEvent (personal) succeeds for group-owned events created by the user', async () => {
      db.run('INSERT INTO group_members (chat_id, user_id) VALUES (?, ?)', [GROUP_ID, USER_ID]);
      const event = ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Group Meeting',
        start_at: '2026-03-18T10:00:00Z',
        timezone: 'UTC',
        owner_type: 'group',
        group_id: GROUP_ID,
        created_by: USER_ID,
      });

      approveDeletes(ctx.user.telegram_id, ctx.chatId, [event.id]);
      const result = await handleDeleteEvent(ctx, { event_id: event.id });

      expect(result.success).toBe(true);
    });

    test('handleDeleteEvent (personal) refuses to delete group-owned events created by another user', async () => {
      const OTHER_USER = 998;
      new UserRepository(db).create({ telegram_id: OTHER_USER });
      const event = ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Group Meeting By Other',
        start_at: '2026-03-18T10:00:00Z',
        timezone: 'UTC',
        owner_type: 'group',
        group_id: GROUP_ID,
        created_by: OTHER_USER,
      });

      const result = await handleDeleteEvent(ctx, { event_id: event.id });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    test('handleSearchEvents (personal) returns group-owned events created by the user', async () => {
      db.run('INSERT INTO group_members (chat_id, user_id) VALUES (?, ?)', [GROUP_ID, USER_ID]);
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Group Planning',
        start_at: '2026-03-18T10:00:00Z',
        timezone: 'UTC',
        owner_type: 'group',
        group_id: GROUP_ID,
        created_by: USER_ID,
      });
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Personal Planning',
        start_at: '2026-03-18T11:00:00Z',
        timezone: 'UTC',
      });

      const result = await handleSearchEvents(ctx, { query: 'Planning' });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Personal Planning');
      expect(result.output).toContain('Group Planning');
    });

    test('handleSearchEvents (personal) does not return group-owned events created by another user', async () => {
      const OTHER_USER = 997;
      new UserRepository(db).create({ telegram_id: OTHER_USER });
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Group Planning By Other',
        start_at: '2026-03-18T10:00:00Z',
        timezone: 'UTC',
        owner_type: 'group',
        group_id: GROUP_ID,
        created_by: OTHER_USER,
      });

      const result = await handleSearchEvents(ctx, { query: 'Planning' });

      expect(result.success).toBe(true);
      expect(result.output).not.toContain('Group Planning By Other');
    });

    test('handleUpdateEvent (personal) succeeds for group-owned events created by the user', async () => {
      db.run('INSERT INTO group_members (chat_id, user_id) VALUES (?, ?)', [GROUP_ID, USER_ID]);
      const event = ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Group Meeting',
        start_at: '2026-03-18T10:00:00Z',
        timezone: 'UTC',
        owner_type: 'group',
        group_id: GROUP_ID,
        created_by: USER_ID,
      });

      const result = await handleUpdateEvent(ctx, { event_id: event.id, title: 'Updated Group Meeting' });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Updated Group Meeting');
    });

    test('handleUpdateEvent (personal) refuses to update group-owned events created by another user', async () => {
      const OTHER_USER = 996;
      new UserRepository(db).create({ telegram_id: OTHER_USER });
      const event = ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Group Meeting By Other',
        start_at: '2026-03-18T10:00:00Z',
        timezone: 'UTC',
        owner_type: 'group',
        group_id: GROUP_ID,
        created_by: OTHER_USER,
      });

      const result = await handleUpdateEvent(ctx, { event_id: event.id, title: 'Tampered' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });
});
