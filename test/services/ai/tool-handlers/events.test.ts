import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { migrations } from '../../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../../../src/database/repositories/event.repository.ts';
import { GroupChatRepository } from '../../../../src/database/repositories/group-chat.repository.ts';
import { HolidayRepository } from '../../../../src/database/repositories/holiday.repository.ts';
import { ParticipantRepository } from '../../../../src/database/repositories/participant.repository.ts';
import { ReminderRepository } from '../../../../src/database/repositories/reminder.repository.ts';
import { UserRepository } from '../../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../../src/database/schema.ts';
import {
  handleCreateEvent,
  handleDeleteEvent,
  handleGetEvent,
  handleGetEvents,
  handleGetUpcoming,
  handleNotifyParticipants,
  handleSearchEvents,
  handleSnoozeEvent,
  handleUpdateEvent,
} from '../../../../src/services/ai/tool-handlers/events.ts';
import type { AgentContext } from '../../../../src/services/ai/types.ts';
import { ConflictChecker } from '../../../../src/services/event/conflict-checker.ts';
import { EventService } from '../../../../src/services/event/event-service.ts';
import type { GroupMemberService } from '../../../../src/services/group/member-service.ts';
import { HolidayService } from '../../../../src/services/holiday/holiday-service.ts';

function createTestDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

describe('event tool handlers', () => {
  let db: Database;
  let ctx: AgentContext;
  const USER_ID = 123;

  beforeEach(() => {
    db = createTestDb();
    const userRepo = new UserRepository(db);
    const eventRepo = new EventRepository(db);
    const reminderRepo = new ReminderRepository(db);
    const chatHistoryRepo = new ChatHistoryRepository(db);
    const holidayRepo = new HolidayRepository(db);
    userRepo.create({ telegram_id: USER_ID, timezone: 'UTC' });
    const eventService = new EventService({ eventRepo, reminderRepo });
    const holidayService = new HolidayService(holidayRepo);
    ctx = {
      user: userRepo.findByTelegramId(USER_ID)!,
      chatId: USER_ID,
      messageText: '',
      isGroup: false,
      eventService,
      holidayService,
      chatHistory: chatHistoryRepo,
      userRepo,
      reminderRepo,
      conversationLogger: null as never,
    };
  });

  describe('handleGetEvents', () => {
    test('returns events in range', () => {
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Test Event',
        start_at: '2026-03-15T10:00:00Z',
        end_at: '2026-03-15T11:00:00Z',
        timezone: 'UTC',
      });
      const result = handleGetEvents(ctx, {
        start_date: '2026-03-15T00:00:00Z',
        end_date: '2026-03-15T23:59:59Z',
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Test Event');
    });

    test('returns message when no events found', () => {
      const result = handleGetEvents(ctx, {
        start_date: '2026-03-15T00:00:00Z',
        end_date: '2026-03-15T23:59:59Z',
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('No events');
    });

    test('accepts date-only format (YYYY-MM-DD) and finds events on that day', () => {
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Morning Meeting',
        start_at: '2026-03-15T10:00:00Z',
        end_at: '2026-03-15T11:00:00Z',
        timezone: 'UTC',
      });
      const result = handleGetEvents(ctx, {
        start_date: '2026-03-15',
        end_date: '2026-03-15',
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Morning Meeting');
    });

    test('populates data with EventSummary array', () => {
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Standup',
        start_at: '2026-03-15T09:00:00Z',
        end_at: '2026-03-15T09:30:00Z',
        timezone: 'UTC',
      });
      const result = handleGetEvents(ctx, {
        start_date: '2026-03-15T00:00:00Z',
        end_date: '2026-03-15T23:59:59Z',
      });
      expect(result.success).toBe(true);
      expect(Array.isArray(result.data)).toBe(true);
      const data = result.data as Array<{ id: number; title: string; date: string; time: string }>;
      expect(data).toHaveLength(1);
      expect(data[0]!.title).toBe('Standup');
      expect(data[0]!.date).toBe('2026-03-15');
      expect(data[0]!.time).toBe('09:00');
      expect(typeof data[0]!.id).toBe('number');
    });

    test('data is empty array when no events found', () => {
      const result = handleGetEvents(ctx, {
        start_date: '2026-03-15T00:00:00Z',
        end_date: '2026-03-15T23:59:59Z',
      });
      expect(result.success).toBe(true);
      expect(result.data).toEqual([]);
    });
  });

  describe('handleCreateEvent', () => {
    const futureDate = new Date(Date.now() + 86400000).toISOString().slice(0, 11);

    test('creates event and returns details', () => {
      const result = handleCreateEvent(ctx, {
        title: 'New Meeting',
        start_at: `${futureDate}14:00:00Z`,
        end_at: `${futureDate}15:00:00Z`,
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('New Meeting');
      expect(result.output).toContain('id');
    });

    test('creates event with description and location', () => {
      const result = handleCreateEvent(ctx, {
        title: 'Lunch',
        start_at: `${futureDate}12:00:00Z`,
        description: 'Team lunch',
        location: 'Cafe',
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Lunch');
    });

    test('rejects past event without force', () => {
      const result = handleCreateEvent(ctx, {
        title: 'Past Event',
        start_at: '2020-01-01T10:00:00Z',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('PAST_EVENT');
    });

    test('allows past event with force: true', () => {
      const result = handleCreateEvent(ctx, {
        title: 'Past Event',
        start_at: '2020-01-01T10:00:00Z',
        force: true,
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Past Event');
    });

    test('allows all-day past event without force', () => {
      const result = handleCreateEvent(ctx, {
        title: 'Past Holiday',
        start_at: '2020-01-01T00:00:00Z',
        all_day: true,
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Past Holiday');
    });

    test('returns agentHint with conflict info when new event overlaps existing', () => {
      const eventRepo = new EventRepository(db);
      const conflictCtx = {
        ...ctx,
        conflictChecker: new ConflictChecker(eventRepo),
        domainEvents: { emit: mock(() => {}) },
      } as unknown as AgentContext;

      // Create existing event
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Урок с Настей',
        start_at: `${futureDate}11:00:00Z`,
        end_at: `${futureDate}12:00:00Z`,
        timezone: 'UTC',
      });

      // Create overlapping event
      const result = handleCreateEvent(conflictCtx, {
        title: 'Новое событие',
        start_at: `${futureDate}11:30:00Z`,
        end_at: `${futureDate}12:30:00Z`,
      });

      expect(result.success).toBe(true);
      expect(result.agentHint).toContain('⚠️');
      expect(result.agentHint).toContain('Урок с Настей');
      expect(result.agentHint).toContain('11:00');
    });

    test('no agentHint when no conflict', () => {
      const eventRepo = new EventRepository(db);
      const conflictCtx = {
        ...ctx,
        conflictChecker: new ConflictChecker(eventRepo),
        domainEvents: { emit: mock(() => {}) },
      } as unknown as AgentContext;

      const result = handleCreateEvent(conflictCtx, {
        title: 'Без конфликта',
        start_at: `${futureDate}09:00:00Z`,
        end_at: `${futureDate}10:00:00Z`,
      });

      expect(result.success).toBe(true);
      expect(result.agentHint).toBeUndefined();
    });
  });

  describe('handleUpdateEvent', () => {
    test('updates event title', () => {
      const event = ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Old Title',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
      });
      const result = handleUpdateEvent(ctx, {
        event_id: event.id,
        title: 'New Title',
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('New Title');
    });

    test('returns error for non-existent event', () => {
      const result = handleUpdateEvent(ctx, {
        event_id: 9999,
        title: 'Whatever',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('handleDeleteEvent', () => {
    test('deletes event', () => {
      const event = ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'To Delete',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
      });
      const result = handleDeleteEvent(ctx, { event_id: event.id });
      expect(result.success).toBe(true);
    });

    test('returns error for non-existent event', () => {
      const result = handleDeleteEvent(ctx, { event_id: 9999 });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('handleSearchEvents', () => {
    test('finds events by title', () => {
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Team Standup',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
      });
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Lunch Break',
        start_at: '2026-03-15T12:00:00Z',
        timezone: 'UTC',
      });
      const result = handleSearchEvents(ctx, { query: 'Standup' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Team Standup');
      expect(result.output).not.toContain('Lunch Break');
    });

    test('returns message when nothing found', () => {
      const result = handleSearchEvents(ctx, { query: 'nonexistent' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('No events');
    });

    test('event_type=birthday returns only birthday events', () => {
      const eventRepo = new EventRepository(db);
      eventRepo.create({
        user_id: USER_ID,
        title: 'Д/р Иван',
        start_at: '2026-05-10T00:00:00Z',
        all_day: true,
        timezone: 'UTC',
        event_type: 'birthday',
      });
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Team Meeting',
        start_at: '2026-05-10T10:00:00Z',
        timezone: 'UTC',
      });
      const result = handleSearchEvents(ctx, { event_type: 'birthday' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Д/р Иван');
      expect(result.output).not.toContain('Team Meeting');
    });

    test('event_type=regular excludes birthday events', () => {
      const eventRepo = new EventRepository(db);
      eventRepo.create({
        user_id: USER_ID,
        title: 'Д/р Иван',
        start_at: '2026-05-10T00:00:00Z',
        all_day: true,
        timezone: 'UTC',
        event_type: 'birthday',
      });
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Team Meeting',
        start_at: '2026-05-10T10:00:00Z',
        timezone: 'UTC',
      });
      const result = handleSearchEvents(ctx, { event_type: 'regular' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Team Meeting');
      expect(result.output).not.toContain('Д/р Иван');
    });
  });

  describe('handleUpdateEvent — participant info', () => {
    test('output mentions participant count when event has accepted participants', () => {
      const participantRepo = new ParticipantRepository(db);
      const otherUserId = 999;
      const userRepo = new UserRepository(db);
      userRepo.create({ telegram_id: otherUserId, timezone: 'UTC' });

      const event = ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Shared Meeting',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
      });
      participantRepo.add(event.id, otherUserId, 'accepted');

      const ctxWithParticipants = { ...ctx, participantRepo };
      const result = handleUpdateEvent(ctxWithParticipants, {
        event_id: event.id,
        title: 'Renamed Meeting',
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('1 participant');
      expect(result.output).toContain('notify');
    });

    test('output does not mention participants when event has none', () => {
      const participantRepo = new ParticipantRepository(db);
      const event = ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Solo Event',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
      });

      const ctxWithParticipants = { ...ctx, participantRepo };
      const result = handleUpdateEvent(ctxWithParticipants, {
        event_id: event.id,
        title: 'Still Solo',
      });
      expect(result.success).toBe(true);
      expect(result.output).not.toContain('participant');
    });
  });

  describe('handleNotifyParticipants', () => {
    test('sends message to accepted participants', () => {
      const participantRepo = new ParticipantRepository(db);
      const otherUserId = 999;
      const userRepo = new UserRepository(db);
      userRepo.create({ telegram_id: otherUserId, timezone: 'UTC' });

      const event = ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Team Standup',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
      });
      participantRepo.add(event.id, otherUserId, 'accepted');

      const sent: { chatId: number; text: string }[] = [];
      const ctxWithSender = {
        ...ctx,
        participantRepo,
        sender: {
          sendMessage: async (chatId: number, text: string) => {
            sent.push({ chatId, text });
            return { message_id: 1 };
          },
          editMessageText: async () => {},
        },
      };

      const result = handleNotifyParticipants(ctxWithSender, {
        event_id: event.id,
        message: 'Meeting moved to 11:00',
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('1 participant');
    });

    test('returns error when event not found', () => {
      const result = handleNotifyParticipants(ctx, {
        event_id: 9999,
        message: 'hello',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    test('returns error when no participants', () => {
      const participantRepo = new ParticipantRepository(db);
      const event = ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Solo',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
      });

      const ctxWithParticipants = { ...ctx, participantRepo };
      const result = handleNotifyParticipants(ctxWithParticipants, {
        event_id: event.id,
        message: 'Test',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('no accepted participants');
    });
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

    test('handleGetEvents with scope=group queries group calendar', () => {
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Personal Event',
        start_at: '2026-03-15T10:00:00Z',
        end_at: '2026-03-15T11:00:00Z',
        timezone: 'UTC',
      });
      createGroupEvent('Group Event', '2026-03-15T14:00:00Z', '2026-03-15T15:00:00Z');

      const gCtx = makeGroupCtx();
      const result = handleGetEvents(gCtx, {
        start_date: '2026-03-15T00:00:00Z',
        end_date: '2026-03-15T23:59:59Z',
        scope: 'group',
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Group Event');
      expect(result.output).not.toContain('Personal Event');
    });

    test('handleCreateEvent with scope=group creates group event', () => {
      const gCtx = makeGroupCtx();
      const result = handleCreateEvent(gCtx, {
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

    test('handleUpdateEvent with scope=group updates group event', () => {
      const event = createGroupEvent('Old Group Title', '2026-03-15T10:00:00Z');
      const gCtx = makeGroupCtx();
      const result = handleUpdateEvent(gCtx, {
        event_id: event.id,
        title: 'New Group Title',
        scope: 'group',
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('New Group Title');
    });

    test('handleDeleteEvent with scope=group deletes from group calendar', () => {
      const event = createGroupEvent('To Delete Group', '2026-03-15T10:00:00Z');
      const gCtx = makeGroupCtx();
      const result = handleDeleteEvent(gCtx, { event_id: event.id, scope: 'group' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('To Delete Group');

      const found = ctx.eventService.getEventForGroup(event.id, GROUP_CHAT_ID);
      expect(found).toBeNull();
    });

    test('handleSearchEvents with scope=group searches group calendar', () => {
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Personal Standup',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
      });
      createGroupEvent('Group Standup', '2026-03-15T10:00:00Z');

      const gCtx = makeGroupCtx();
      const result = handleSearchEvents(gCtx, { query: 'Standup', scope: 'group' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Group Standup');
      expect(result.output).not.toContain('Personal Standup');
    });

    test('handleGetEvent with scope=group fetches group event', () => {
      const event = createGroupEvent('Group Detail', '2026-03-15T10:00:00Z');
      const gCtx = makeGroupCtx();
      const result = handleGetEvent(gCtx, { event_id: event.id, scope: 'group' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Group Detail');
    });

    test('handleGetUpcoming with scope=group returns group events', () => {
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Personal Soon',
        start_at: new Date(Date.now() + 3600_000).toISOString(),
        timezone: 'UTC',
      });
      createGroupEvent('Group Soon', new Date(Date.now() + 7200_000).toISOString());

      const gCtx = makeGroupCtx();
      const result = handleGetUpcoming(gCtx, { scope: 'group' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Group Soon');
      expect(result.output).not.toContain('Personal Soon');
    });

    test('handleSnoozeEvent with scope=group snoozes group event', () => {
      const event = createGroupEvent('Group Snooze', '2026-03-15T10:00:00Z', '2026-03-15T11:00:00Z');
      const gCtx = makeGroupCtx();
      const result = handleSnoozeEvent(gCtx, { event_id: event.id, minutes: 15, scope: 'group' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('snoozed by 15 min');
    });

    test('scope defaults to group when isGroup=true and scope not specified', () => {
      createGroupEvent('Group Default', '2026-03-15T14:00:00Z', '2026-03-15T15:00:00Z');
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Personal Default',
        start_at: '2026-03-15T14:00:00Z',
        timezone: 'UTC',
      });

      const gCtx = makeGroupCtx();
      const result = handleGetEvents(gCtx, {
        start_date: '2026-03-15T00:00:00Z',
        end_date: '2026-03-15T23:59:59Z',
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Group Default');
      expect(result.output).not.toContain('Personal Default');
    });

    test('scope defaults to personal when isGroup=false', () => {
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Personal Visible',
        start_at: '2026-03-15T14:00:00Z',
        timezone: 'UTC',
      });

      // isGroup=false, no scope => personal path
      const result = handleGetEvents(ctx, {
        start_date: '2026-03-15T00:00:00Z',
        end_date: '2026-03-15T23:59:59Z',
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Personal Visible');
    });

    test('handleDeleteEvent with scope=group returns error for non-existent group event', () => {
      const gCtx = makeGroupCtx();
      const result = handleDeleteEvent(gCtx, { event_id: 9999, scope: 'group' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    test('handleGetEvents includes group title and created_by in output', () => {
      const groupChatRepo = new GroupChatRepository(db);
      groupChatRepo.upsertGroup({ chat_id: GROUP_CHAT_ID, title: 'Test Group', added_by: USER_ID });
      createGroupEvent('Team Drinks', '2026-03-15T20:00:00Z');

      const gCtx: AgentContext = {
        ...makeGroupCtx(),
        groupChatRepo,
      };
      const result = handleGetEvents(gCtx, {
        start_date: '2026-03-15T00:00:00Z',
        end_date: '2026-03-15T23:59:59Z',
        scope: 'group',
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Team Drinks');
      expect(result.output).toContain('Test Group');
      expect(result.output).toContain('created_by');
    });

    test('handleGetEvent includes group title and created_by in output', () => {
      const groupChatRepo = new GroupChatRepository(db);
      groupChatRepo.upsertGroup({ chat_id: GROUP_CHAT_ID, title: 'Test Group', added_by: USER_ID });
      const event = createGroupEvent('Group Detail Event', '2026-03-15T10:00:00Z');

      const gCtx: AgentContext = {
        ...makeGroupCtx(),
        groupChatRepo,
      };
      const result = handleGetEvent(gCtx, { event_id: event.id, scope: 'group' });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Group Detail Event');
      expect(result.output).toContain('Test Group');
      expect(result.output).toContain('created_by');
    });

    function makeMemberService(memberIds: number[]): GroupMemberService {
      return { getRegisteredMembers: mock(async () => memberIds) } as unknown as GroupMemberService;
    }

    test('handleCreateEvent notifies all group members including creator', async () => {
      const MEMBER_ID = 456;
      const groupMemberService = makeMemberService([USER_ID, MEMBER_ID]);

      const sent: { chatId: number; text: string; parseMode?: string }[] = [];
      const sender = {
        sendMessage: mock(async (chatId: number, text: string, parseMode?: string) => {
          sent.push({ chatId, text, parseMode });
          return { message_id: 1 };
        }),
        editMessageText: mock(async () => {}),
      };

      const gCtx: AgentContext = { ...makeGroupCtx(), groupMemberService, sender };
      const result = handleCreateEvent(gCtx, {
        title: 'Party',
        start_at: '2026-03-20T18:00:00Z',
        scope: 'group',
        force: true,
      });

      expect(result.success).toBe(true);
      await new Promise((r) => setTimeout(r, 0));
      expect(sent.length).toBe(2);
      const chatIds = sent.map((s) => s.chatId).sort();
      expect(chatIds).toEqual([USER_ID, MEMBER_ID].sort());
      expect(sent.every((s) => s.text.includes('Party'))).toBe(true);
      expect(sent.every((s) => s.text.includes('Test Group'))).toBe(true);
      expect(sent.every((s) => s.text.includes('18:00'))).toBe(true);
      expect(sent.every((s) => s.parseMode === 'HTML')).toBe(true);
    });

    test('handleCreateEvent sends notification in recipient language', async () => {
      const RU_MEMBER_ID = 789;
      const userRepo = ctx.userRepo as UserRepository;
      userRepo.create({ telegram_id: RU_MEMBER_ID, timezone: 'UTC', language: 'ru' });
      const groupMemberService = makeMemberService([USER_ID, RU_MEMBER_ID]);

      const sent: { chatId: number; text: string }[] = [];
      const sender = {
        sendMessage: mock(async (chatId: number, text: string) => {
          sent.push({ chatId, text });
          return { message_id: 1 };
        }),
        editMessageText: mock(async () => {}),
      };

      handleCreateEvent({ ...makeGroupCtx(), groupMemberService, sender } as AgentContext, {
        title: 'Встреча',
        start_at: '2026-03-20T10:00:00Z',
        scope: 'group',
        force: true,
      });

      await new Promise((r) => setTimeout(r, 0));
      expect(sent.length).toBe(2);
      const ruNotification = sent.find((s) => s.chatId === RU_MEMBER_ID);
      expect(ruNotification?.text).toContain('Новое событие');
    });

    test('handleUpdateEvent notifies group members on group update', async () => {
      const MEMBER_ID = 456;
      const groupMemberService = makeMemberService([USER_ID, MEMBER_ID]);

      const event = createGroupEvent('Sprint Planning', '2026-03-21T09:00:00Z');

      const sent: { chatId: number; text: string; parseMode?: string }[] = [];
      const sender = {
        sendMessage: mock(async (chatId: number, text: string, parseMode?: string) => {
          sent.push({ chatId, text, parseMode });
          return { message_id: 1 };
        }),
        editMessageText: mock(async () => {}),
      };

      const result = handleUpdateEvent({ ...makeGroupCtx(), groupMemberService, sender } as AgentContext, {
        event_id: event.id,
        title: 'Sprint Planning Updated',
        scope: 'group',
      });

      expect(result.success).toBe(true);
      await new Promise((r) => setTimeout(r, 0));
      expect(sent.length).toBe(2);
      const chatIds = sent.map((s) => s.chatId).sort();
      expect(chatIds).toEqual([USER_ID, MEMBER_ID].sort());
      expect(sent.every((s) => s.text.includes('Sprint Planning Updated'))).toBe(true);
      expect(sent.every((s) => s.text.includes('Test Group'))).toBe(true);
      expect(sent.every((s) => s.parseMode === 'HTML')).toBe(true);
    });

    test('handleCreateEvent uses invite link as clickable group link when available', async () => {
      const INVITE_LINK = 'https://t.me/+abc123';
      const groupChatRepo = new GroupChatRepository(db);
      groupChatRepo.upsertGroup({ chat_id: GROUP_CHAT_ID, title: 'Test Group', added_by: USER_ID });
      groupChatRepo.setInviteLink(GROUP_CHAT_ID, INVITE_LINK);

      const groupMemberService = makeMemberService([USER_ID]);
      const sent: { text: string }[] = [];
      const sender = {
        sendMessage: mock(async (_chatId: number, text: string) => {
          sent.push({ text });
          return { message_id: 1 };
        }),
        editMessageText: mock(async () => {}),
      };

      const gCtx: AgentContext = { ...makeGroupCtx(), groupMemberService, sender, groupChatRepo };
      handleCreateEvent(gCtx, { title: 'Drinks', start_at: '2026-03-20T19:00:00Z', scope: 'group', force: true });

      await new Promise((r) => setTimeout(r, 0));
      expect(sent.length).toBe(1);
      expect(sent[0]!.text).toContain(`href="${INVITE_LINK}"`);
      expect(sent[0]!.text).toContain('Test Group');
    });
  });

  describe('personal scope isolation from group events', () => {
    const GROUP_ID = -100888;

    test('handleGetEvents (personal) returns group-owned events created by the user', () => {
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

      const result = handleGetEvents(ctx, {
        start_date: '2026-03-18T00:00:00Z',
        end_date: '2026-03-18T23:59:59Z',
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Personal Dinner');
      expect(result.output).toContain('Group Drinks');
    });

    test('handleGetEvents (personal) does not return group-owned events created by another user', () => {
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

      const result = handleGetEvents(ctx, {
        start_date: '2026-03-18T00:00:00Z',
        end_date: '2026-03-18T23:59:59Z',
      });

      expect(result.success).toBe(true);
      expect(result.output).not.toContain('Group Drinks By Other');
    });

    test('handleDeleteEvent (personal) succeeds for group-owned events created by the user', () => {
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

      const result = handleDeleteEvent(ctx, { event_id: event.id });

      expect(result.success).toBe(true);
    });

    test('handleDeleteEvent (personal) refuses to delete group-owned events created by another user', () => {
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

      const result = handleDeleteEvent(ctx, { event_id: event.id });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    test('handleSearchEvents (personal) returns group-owned events created by the user', () => {
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

      const result = handleSearchEvents(ctx, { query: 'Planning' });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Personal Planning');
      expect(result.output).toContain('Group Planning');
    });

    test('handleSearchEvents (personal) does not return group-owned events created by another user', () => {
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

      const result = handleSearchEvents(ctx, { query: 'Planning' });

      expect(result.success).toBe(true);
      expect(result.output).not.toContain('Group Planning By Other');
    });

    test('handleUpdateEvent (personal) succeeds for group-owned events created by the user', () => {
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

      const result = handleUpdateEvent(ctx, { event_id: event.id, title: 'Updated Group Meeting' });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Updated Group Meeting');
    });

    test('handleUpdateEvent (personal) refuses to update group-owned events created by another user', () => {
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

      const result = handleUpdateEvent(ctx, { event_id: event.id, title: 'Tampered' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });
});
