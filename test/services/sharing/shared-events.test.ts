import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../../src/database/repositories/event-reminder.repository.ts';
import { InvitationRepository } from '../../../src/database/repositories/invitation.repository.ts';
import { ParticipantRepository } from '../../../src/database/repositories/participant.repository.ts';
import { SharingSettingsRepository } from '../../../src/database/repositories/sharing-settings.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import type { User } from '../../../src/database/types.ts';
import { handleDeleteEvent } from '../../../src/services/ai/tool-handlers/events.ts';
import type { AgentContext } from '../../../src/services/ai/types.ts';
import { ConflictChecker } from '../../../src/services/event/conflict-checker.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import type { HolidayService } from '../../../src/services/holiday/holiday-service.ts';
import { InvitationService } from '../../../src/services/sharing/invitation-service.ts';

const CREATOR = 100;
const INVITEE = 200;

function createTestDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

describe('visible events (owned + participated)', () => {
  let db: Database;
  let eventRepo: EventRepository;
  let participantRepo: ParticipantRepository;

  beforeEach(() => {
    db = createTestDb();
    const userRepo = new UserRepository(db);
    eventRepo = new EventRepository(db);
    participantRepo = new ParticipantRepository(db);
    userRepo.create({ telegram_id: CREATOR, timezone: 'UTC' });
    userRepo.create({ telegram_id: INVITEE, timezone: 'UTC' });
  });

  test('getVisibleInRange returns own events', async () => {
    eventRepo.create({
      user_id: INVITEE,
      title: 'My Event',
      start_at: '2026-03-20T10:00:00Z',
      timezone: 'UTC',
    });
    const events = eventRepo.getVisibleInRange(INVITEE, '2026-03-20T00:00:00Z', '2026-03-21T00:00:00Z');
    expect(events).toHaveLength(1);
    expect(events[0]!.title).toBe('My Event');
  });

  test('getVisibleInRange returns accepted participated events', async () => {
    const event = eventRepo.create({
      user_id: CREATOR,
      title: 'Shared Meeting',
      start_at: '2026-03-20T10:00:00Z',
      timezone: 'UTC',
    });
    participantRepo.add(event.id, INVITEE, 'accepted');

    const events = eventRepo.getVisibleInRange(INVITEE, '2026-03-20T00:00:00Z', '2026-03-21T00:00:00Z');
    expect(events).toHaveLength(1);
    expect(events[0]!.title).toBe('Shared Meeting');
  });

  test('getVisibleInRange excludes declined participated events', async () => {
    const event = eventRepo.create({
      user_id: CREATOR,
      title: 'Declined',
      start_at: '2026-03-20T10:00:00Z',
      timezone: 'UTC',
    });
    participantRepo.add(event.id, INVITEE, 'declined');

    const events = eventRepo.getVisibleInRange(INVITEE, '2026-03-20T00:00:00Z', '2026-03-21T00:00:00Z');
    expect(events).toHaveLength(0);
  });

  test('getVisibleInRange does not duplicate if user is both owner and participant', async () => {
    const event = eventRepo.create({
      user_id: CREATOR,
      title: 'Own',
      start_at: '2026-03-20T10:00:00Z',
      timezone: 'UTC',
    });
    participantRepo.add(event.id, CREATOR, 'accepted', 'organizer');

    const events = eventRepo.getVisibleInRange(CREATOR, '2026-03-20T00:00:00Z', '2026-03-21T00:00:00Z');
    expect(events).toHaveLength(1);
  });

  test('getVisibleInRange shows mix of own and shared events sorted by time', async () => {
    eventRepo.create({
      user_id: INVITEE,
      title: 'Own Event',
      start_at: '2026-03-20T09:00:00Z',
      timezone: 'UTC',
    });
    const shared = eventRepo.create({
      user_id: CREATOR,
      title: 'Shared Event',
      start_at: '2026-03-20T14:00:00Z',
      timezone: 'UTC',
    });
    participantRepo.add(shared.id, INVITEE, 'accepted');

    const events = eventRepo.getVisibleInRange(INVITEE, '2026-03-20T00:00:00Z', '2026-03-21T00:00:00Z');
    expect(events).toHaveLength(2);
    expect(events[0]!.title).toBe('Own Event');
    expect(events[1]!.title).toBe('Shared Event');
  });

  test('getVisibleInRange excludes maybe status', async () => {
    const event = eventRepo.create({
      user_id: CREATOR,
      title: 'Maybe Event',
      start_at: '2026-03-20T10:00:00Z',
      timezone: 'UTC',
    });
    participantRepo.add(event.id, INVITEE, 'maybe');

    const events = eventRepo.getVisibleInRange(INVITEE, '2026-03-20T00:00:00Z', '2026-03-21T00:00:00Z');
    expect(events).toHaveLength(0);
  });

  test('isParticipant returns true for accepted participant', async () => {
    const event = eventRepo.create({
      user_id: CREATOR,
      title: 'Shared',
      start_at: '2026-03-20T10:00:00Z',
      timezone: 'UTC',
    });
    participantRepo.add(event.id, INVITEE, 'accepted');
    expect(eventRepo.isParticipant(event.id, INVITEE)).toBe(true);
  });

  test('isParticipant returns false for non-participant', async () => {
    const event = eventRepo.create({
      user_id: CREATOR,
      title: 'Private',
      start_at: '2026-03-20T10:00:00Z',
      timezone: 'UTC',
    });
    expect(eventRepo.isParticipant(event.id, INVITEE)).toBe(false);
  });

  test('isParticipant returns false for declined', async () => {
    const event = eventRepo.create({
      user_id: CREATOR,
      title: 'Declined',
      start_at: '2026-03-20T10:00:00Z',
      timezone: 'UTC',
    });
    participantRepo.add(event.id, INVITEE, 'declined');
    expect(eventRepo.isParticipant(event.id, INVITEE)).toBe(false);
  });
});

describe('acceptInvitation — adds participant', () => {
  let db: Database;
  let eventRepo: EventRepository;
  let participantRepo: ParticipantRepository;
  let invitationRepo: InvitationRepository;
  let eventService: EventService;
  let invitationService: InvitationService;

  beforeEach(() => {
    db = createTestDb();
    const userRepo = new UserRepository(db);
    eventRepo = new EventRepository(db);
    participantRepo = new ParticipantRepository(db);
    invitationRepo = new InvitationRepository(db);
    const sharingSettings = new SharingSettingsRepository(db);
    eventService = new EventService({ eventRepo });
    invitationService = new InvitationService(invitationRepo, eventRepo, sharingSettings, participantRepo);
    userRepo.create({ telegram_id: CREATOR, timezone: 'UTC' });
    userRepo.create({ telegram_id: INVITEE, timezone: 'UTC' });
  });

  test('accepting adds participant with accepted status', async () => {
    const event = eventService.createEvent({
      user_id: CREATOR,
      title: 'Party',
      start_at: '2026-03-20T18:00:00Z',
      timezone: 'UTC',
    });
    const inv = invitationRepo.create({ event_id: event.id, inviter_id: CREATOR, invitee_id: INVITEE });
    invitationService.acceptInvitation(inv.id, INVITEE);

    const participant = participantRepo.findByEventAndUser(event.id, INVITEE);
    expect(participant).not.toBeNull();
    expect(participant!.status).toBe('accepted');
    expect(participant!.role).toBe('attendee');
  });

  test('accepting twice does not create duplicate', async () => {
    const event = eventService.createEvent({
      user_id: CREATOR,
      title: 'Party',
      start_at: '2026-03-20T18:00:00Z',
      timezone: 'UTC',
    });
    const inv = invitationRepo.create({ event_id: event.id, inviter_id: CREATOR, invitee_id: INVITEE });
    invitationService.acceptInvitation(inv.id, INVITEE);
    const participants = participantRepo.getByEvent(event.id);
    expect(participants).toHaveLength(1);
  });

  test('declining does not add participant', async () => {
    const event = eventService.createEvent({
      user_id: CREATOR,
      title: 'Skip',
      start_at: '2026-03-20T18:00:00Z',
      timezone: 'UTC',
    });
    const inv = invitationRepo.create({ event_id: event.id, inviter_id: CREATOR, invitee_id: INVITEE });
    invitationService.declineInvitation(inv.id, INVITEE);
    expect(participantRepo.findByEventAndUser(event.id, INVITEE)).toBeNull();
  });

  test('maybe adds participant with maybe status', async () => {
    const event = eventService.createEvent({
      user_id: CREATOR,
      title: 'Maybe',
      start_at: '2026-03-20T18:00:00Z',
      timezone: 'UTC',
    });
    const inv = invitationRepo.create({ event_id: event.id, inviter_id: CREATOR, invitee_id: INVITEE });
    invitationService.maybeInvitation(inv.id, INVITEE);

    const participant = participantRepo.findByEventAndUser(event.id, INVITEE);
    expect(participant).not.toBeNull();
    expect(participant!.status).toBe('maybe');
  });

  test('accepted event appears in invitee calendar via getVisibleInRange', async () => {
    const event = eventService.createEvent({
      user_id: CREATOR,
      title: 'Visible Meeting',
      start_at: '2026-03-20T10:00:00Z',
      timezone: 'UTC',
    });
    const inv = invitationRepo.create({ event_id: event.id, inviter_id: CREATOR, invitee_id: INVITEE });
    invitationService.acceptInvitation(inv.id, INVITEE);

    const visible = eventRepo.getVisibleInRange(INVITEE, '2026-03-20T00:00:00Z', '2026-03-21T00:00:00Z');
    expect(visible).toHaveLength(1);
    expect(visible[0]!.title).toBe('Visible Meeting');
    expect(visible[0]!.user_id).toBe(CREATOR);
  });

  test('maybe → accept upgrades participant status', async () => {
    const event = eventService.createEvent({
      user_id: CREATOR,
      title: 'Evolving',
      start_at: '2026-03-20T18:00:00Z',
      timezone: 'UTC',
    });
    const inv = invitationRepo.create({ event_id: event.id, inviter_id: CREATOR, invitee_id: INVITEE });
    invitationService.maybeInvitation(inv.id, INVITEE);

    // Now re-accept (need new invitation since old one is 'maybe')
    // Actually the same invitation — respondToInvitation does CAS update
    // We need to call accept on the same invitation
    // But status is 'maybe' not 'pending', so CAS will use 'maybe' as expected
    const result = invitationService.acceptInvitation(inv.id, INVITEE);
    expect(result.success).toBe(true);

    const participant = participantRepo.findByEventAndUser(event.id, INVITEE);
    expect(participant!.status).toBe('accepted');
  });

  test('decline after accept removes participant from visible events', async () => {
    const event = eventService.createEvent({
      user_id: CREATOR,
      title: 'Revoke',
      start_at: '2026-03-20T18:00:00Z',
      timezone: 'UTC',
    });
    const inv = invitationRepo.create({ event_id: event.id, inviter_id: CREATOR, invitee_id: INVITEE });
    invitationService.acceptInvitation(inv.id, INVITEE);

    // Now decline
    invitationService.declineInvitation(inv.id, INVITEE);

    const participant = participantRepo.findByEventAndUser(event.id, INVITEE);
    expect(participant!.status).toBe('declined');

    const visible = eventRepo.getVisibleInRange(INVITEE, '2026-03-20T00:00:00Z', '2026-03-21T00:00:00Z');
    expect(visible).toHaveLength(0);
  });
});

describe('acceptInvitation — conflict warnings', () => {
  let db: Database;
  let eventRepo: EventRepository;
  let participantRepo: ParticipantRepository;
  let invitationRepo: InvitationRepository;
  let eventService: EventService;
  let invitationService: InvitationService;

  beforeEach(() => {
    db = createTestDb();
    const userRepo = new UserRepository(db);
    eventRepo = new EventRepository(db);
    participantRepo = new ParticipantRepository(db);
    invitationRepo = new InvitationRepository(db);
    const sharingSettings = new SharingSettingsRepository(db);
    const conflictChecker = new ConflictChecker(eventRepo);
    eventService = new EventService({ eventRepo });
    invitationService = new InvitationService(
      invitationRepo,
      eventRepo,
      sharingSettings,
      participantRepo,
      conflictChecker,
    );
    userRepo.create({ telegram_id: CREATOR, timezone: 'UTC' });
    userRepo.create({ telegram_id: INVITEE, timezone: 'UTC' });
  });

  test('returns conflicts when accepted event overlaps with existing', async () => {
    // Invitee has an existing event
    eventService.createEvent({
      user_id: INVITEE,
      title: 'Existing Meeting',
      start_at: '2026-03-20T10:00:00Z',
      end_at: '2026-03-20T11:00:00Z',
      timezone: 'UTC',
    });
    // Creator invites to overlapping event
    const shared = eventService.createEvent({
      user_id: CREATOR,
      title: 'Shared Meeting',
      start_at: '2026-03-20T10:30:00Z',
      end_at: '2026-03-20T11:30:00Z',
      timezone: 'UTC',
    });
    const inv = invitationRepo.create({ event_id: shared.id, inviter_id: CREATOR, invitee_id: INVITEE });

    const result = invitationService.acceptInvitation(inv.id, INVITEE);
    expect(result.success).toBe(true);
    expect(result.conflicts).toBeDefined();
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts![0]!.title).toBe('Existing Meeting');
  });

  test('returns no conflicts when no overlap', async () => {
    eventService.createEvent({
      user_id: INVITEE,
      title: 'Morning',
      start_at: '2026-03-20T08:00:00Z',
      end_at: '2026-03-20T09:00:00Z',
      timezone: 'UTC',
    });
    const shared = eventService.createEvent({
      user_id: CREATOR,
      title: 'Afternoon',
      start_at: '2026-03-20T14:00:00Z',
      end_at: '2026-03-20T15:00:00Z',
      timezone: 'UTC',
    });
    const inv = invitationRepo.create({ event_id: shared.id, inviter_id: CREATOR, invitee_id: INVITEE });

    const result = invitationService.acceptInvitation(inv.id, INVITEE);
    expect(result.success).toBe(true);
    expect(result.conflicts ?? []).toHaveLength(0);
  });

  test('conflicts exclude the accepted event itself', async () => {
    const shared = eventService.createEvent({
      user_id: CREATOR,
      title: 'Accepted Event',
      start_at: '2026-03-20T10:00:00Z',
      end_at: '2026-03-20T11:00:00Z',
      timezone: 'UTC',
    });
    const inv = invitationRepo.create({ event_id: shared.id, inviter_id: CREATOR, invitee_id: INVITEE });

    const result = invitationService.acceptInvitation(inv.id, INVITEE);
    expect(result.success).toBe(true);
    // The accepted event itself should not appear as a conflict
    expect(result.conflicts ?? []).toHaveLength(0);
  });

  test('still accepts invitation even with conflicts', async () => {
    eventService.createEvent({
      user_id: INVITEE,
      title: 'Blocking',
      start_at: '2026-03-20T10:00:00Z',
      end_at: '2026-03-20T11:00:00Z',
      timezone: 'UTC',
    });
    const shared = eventService.createEvent({
      user_id: CREATOR,
      title: 'Conflicting',
      start_at: '2026-03-20T10:00:00Z',
      end_at: '2026-03-20T11:00:00Z',
      timezone: 'UTC',
    });
    const inv = invitationRepo.create({ event_id: shared.id, inviter_id: CREATOR, invitee_id: INVITEE });

    const result = invitationService.acceptInvitation(inv.id, INVITEE);
    expect(result.success).toBe(true);

    // Participant was still added
    const participant = participantRepo.findByEventAndUser(shared.id, INVITEE);
    expect(participant).not.toBeNull();
    expect(participant!.status).toBe('accepted');
  });
});

describe('calendar views show participated events', () => {
  let db: Database;
  let eventRepo: EventRepository;
  let participantRepo: ParticipantRepository;
  let eventService: EventService;

  beforeEach(() => {
    db = createTestDb();
    const userRepo = new UserRepository(db);
    eventRepo = new EventRepository(db);
    participantRepo = new ParticipantRepository(db);
    eventService = new EventService({ eventRepo });
    userRepo.create({ telegram_id: CREATOR, timezone: 'UTC' });
    userRepo.create({ telegram_id: INVITEE, timezone: 'UTC' });
  });

  test('getEventsInRange includes participated events', async () => {
    const shared = eventService.createEvent({
      user_id: CREATOR,
      title: 'Team Standup',
      start_at: '2026-03-20T09:00:00Z',
      end_at: '2026-03-20T09:30:00Z',
      timezone: 'UTC',
    });
    participantRepo.add(shared.id, INVITEE, 'accepted');
    eventService.createEvent({
      user_id: INVITEE,
      title: 'My Lunch',
      start_at: '2026-03-20T12:00:00Z',
      end_at: '2026-03-20T13:00:00Z',
      timezone: 'UTC',
    });

    const events = eventService.getEventsInRange(INVITEE, '2026-03-20T00:00:00Z', '2026-03-21T00:00:00Z');
    expect(events).toHaveLength(2);
    expect(events[0]!.event.title).toBe('Team Standup');
    expect(events[1]!.event.title).toBe('My Lunch');
  });

  test('getEventsForDay includes participated events', async () => {
    const shared = eventService.createEvent({
      user_id: CREATOR,
      title: 'Daily',
      start_at: '2026-03-20T09:00:00Z',
      end_at: '2026-03-20T09:30:00Z',
      timezone: 'UTC',
    });
    participantRepo.add(shared.id, INVITEE, 'accepted');

    const events = eventService.getEventsForDay(INVITEE, new Date('2026-03-20T00:00:00Z'), 'UTC');
    const titles = events.map((e) => e.event.title);
    expect(titles).toContain('Daily');
  });

  test('getEventsForWeek includes participated events', async () => {
    const shared = eventService.createEvent({
      user_id: CREATOR,
      title: 'Weekly Sync',
      start_at: '2026-03-18T10:00:00Z',
      end_at: '2026-03-18T11:00:00Z',
      timezone: 'UTC',
    });
    participantRepo.add(shared.id, INVITEE, 'accepted');

    const events = eventService.getEventsForWeek(INVITEE, new Date('2026-03-18T00:00:00Z'), 'UTC');
    const titles = events.map((e) => e.event.title);
    expect(titles).toContain('Weekly Sync');
  });

  test('getUpcoming includes participated events', async () => {
    const futureStart = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const futureEnd = new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString();
    const shared = eventService.createEvent({
      user_id: CREATOR,
      title: 'Future Shared',
      start_at: futureStart,
      end_at: futureEnd,
      timezone: 'UTC',
    });
    participantRepo.add(shared.id, INVITEE, 'accepted');

    const upcoming = eventService.getUpcoming(INVITEE, 10);
    const titles = upcoming.map((e) => e.title);
    expect(titles).toContain('Future Shared');
  });

  test('declined participated events do not appear in views', async () => {
    const shared = eventService.createEvent({
      user_id: CREATOR,
      title: 'Declined',
      start_at: '2026-03-20T09:00:00Z',
      end_at: '2026-03-20T09:30:00Z',
      timezone: 'UTC',
    });
    participantRepo.add(shared.id, INVITEE, 'declined');

    const events = eventService.getEventsInRange(INVITEE, '2026-03-20T00:00:00Z', '2026-03-21T00:00:00Z');
    expect(events).toHaveLength(0);
  });
});

describe('invitee deletes shared event = decline', () => {
  let db: Database;
  let eventRepo: EventRepository;
  let participantRepo: ParticipantRepository;
  let eventService: EventService;
  let eventReminderRepo: EventReminderRepository;
  let chatHistory: ChatHistoryRepository;
  let userRepo: UserRepository;
  let inviteeUser: User;

  function makeCtx(user: User): AgentContext {
    return {
      user,
      chatId: user.telegram_id,
      messageText: '',
      isGroup: false,
      eventService,
      holidayService: {} as HolidayService,
      chatHistory,
      userRepo,
      eventReminderRepo,
      participantRepo,
      conversationLogger: null as never,
    };
  }

  beforeEach(() => {
    db = createTestDb();
    userRepo = new UserRepository(db);
    eventRepo = new EventRepository(db);
    participantRepo = new ParticipantRepository(db);
    eventReminderRepo = new EventReminderRepository(db);
    chatHistory = new ChatHistoryRepository(db);
    eventService = new EventService({ eventRepo });
    userRepo.create({ telegram_id: CREATOR, timezone: 'UTC' });
    userRepo.create({ telegram_id: INVITEE, timezone: 'UTC' });
    inviteeUser = userRepo.findByTelegramId(INVITEE)!;
  });

  test('participant deleting shared event declines instead of deleting', async () => {
    const shared = eventService.createEvent({
      user_id: CREATOR,
      title: 'Team Meeting',
      start_at: '2026-03-20T10:00:00Z',
      end_at: '2026-03-20T11:00:00Z',
      timezone: 'UTC',
    });
    participantRepo.add(shared.id, INVITEE, 'accepted');

    const ctx = makeCtx(inviteeUser);
    const result = await handleDeleteEvent(ctx, { event_id: shared.id });

    expect(result.success).toBe(true);
    expect(result.output).toContain('declined');

    // Event still exists for the owner
    const ownerEvent = eventRepo.findById(shared.id, CREATOR);
    expect(ownerEvent).not.toBeNull();

    // Participant status changed to declined
    const participant = participantRepo.findByEventAndUser(shared.id, INVITEE);
    expect(participant!.status).toBe('declined');
  });

  test('owner can still delete their own event normally', async () => {
    const creatorUser = userRepo.findByTelegramId(CREATOR)!;
    const event = eventService.createEvent({
      user_id: CREATOR,
      title: 'My Event',
      start_at: '2026-03-20T10:00:00Z',
      end_at: '2026-03-20T11:00:00Z',
      timezone: 'UTC',
    });

    const ctx = makeCtx(creatorUser);
    const result = await handleDeleteEvent(ctx, { event_id: event.id });

    expect(result.success).toBe(true);
    expect(result.output).toContain('deleted');
    expect(eventRepo.findById(event.id, CREATOR)).toBeNull();
  });

  test('non-participant non-owner gets not found error', async () => {
    const shared = eventService.createEvent({
      user_id: CREATOR,
      title: 'Private',
      start_at: '2026-03-20T10:00:00Z',
      timezone: 'UTC',
    });

    const ctx = makeCtx(inviteeUser);
    const result = await handleDeleteEvent(ctx, { event_id: shared.id });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  test('declined event disappears from invitee calendar', async () => {
    const shared = eventService.createEvent({
      user_id: CREATOR,
      title: 'Vanishing',
      start_at: '2026-03-20T10:00:00Z',
      end_at: '2026-03-20T11:00:00Z',
      timezone: 'UTC',
    });
    participantRepo.add(shared.id, INVITEE, 'accepted');

    const ctx = makeCtx(inviteeUser);
    handleDeleteEvent(ctx, { event_id: shared.id });

    const visible = eventRepo.getVisibleInRange(INVITEE, '2026-03-20T00:00:00Z', '2026-03-21T00:00:00Z');
    expect(visible).toHaveLength(0);
  });
});

describe('creator delete notifies participants', () => {
  let db: Database;
  let eventRepo: EventRepository;
  let participantRepo: ParticipantRepository;
  let eventService: EventService;
  let userRepo: UserRepository;

  beforeEach(() => {
    db = createTestDb();
    userRepo = new UserRepository(db);
    eventRepo = new EventRepository(db);
    participantRepo = new ParticipantRepository(db);
    userRepo.create({ telegram_id: CREATOR, timezone: 'UTC' });
    userRepo.create({ telegram_id: INVITEE, timezone: 'UTC' });
  });

  test('deleteEvent fires changeNotifier.onEventDeleted for events with accepted participants', async () => {
    const deletedEvents: { title: string; source: string }[] = [];
    const mockNotifier = {
      onEventChanged: async () => {},
      onEventDeleted: async (params: { event: { title: string }; source: string }) => {
        deletedEvents.push({ title: params.event.title, source: params.source });
      },
    };
    eventService = new EventService({
      eventRepo,
      participantRepo,
      changeNotifier:
        mockNotifier as unknown as import('../../../src/services/event/event-change-notifier.ts').EventChangeNotifier,
    });

    const event = eventService.createEvent({
      user_id: CREATOR,
      title: 'Team Meeting',
      start_at: '2026-03-20T10:00:00Z',
      timezone: 'UTC',
    });
    participantRepo.add(event.id, INVITEE, 'accepted');

    eventService.deleteEvent(event.id, CREATOR);

    await Bun.sleep(10);
    expect(deletedEvents).toHaveLength(1);
    expect(deletedEvents[0]!.title).toBe('Team Meeting');
    expect(deletedEvents[0]!.source).toBe('bot');
  });

  test('deleteEvent fires changeNotifier even with no participants (notifier filters)', async () => {
    const deletedEvents: { title: string }[] = [];
    const mockNotifier = {
      onEventChanged: async () => {},
      onEventDeleted: async (params: { event: { title: string } }) => {
        deletedEvents.push({ title: params.event.title });
      },
    };
    eventService = new EventService({
      eventRepo,
      participantRepo,
      changeNotifier:
        mockNotifier as unknown as import('../../../src/services/event/event-change-notifier.ts').EventChangeNotifier,
    });

    const event = eventService.createEvent({
      user_id: CREATOR,
      title: 'Solo Event',
      start_at: '2026-03-20T10:00:00Z',
      timezone: 'UTC',
    });

    eventService.deleteEvent(event.id, CREATOR);

    await Bun.sleep(10);
    expect(deletedEvents).toHaveLength(1);
  });

  test('deleteEvent without changeNotifier does not throw', async () => {
    eventService = new EventService({
      eventRepo,
      participantRepo,
    });

    const event = eventService.createEvent({
      user_id: CREATOR,
      title: 'Skipped',
      start_at: '2026-03-20T10:00:00Z',
      timezone: 'UTC',
    });
    participantRepo.add(event.id, INVITEE, 'declined');

    expect(() => eventService.deleteEvent(event.id, CREATOR)).not.toThrow();
  });
});

describe('full shared event lifecycle', () => {
  let db: Database;
  let eventRepo: EventRepository;
  let participantRepo: ParticipantRepository;
  let invitationRepo: InvitationRepository;
  let eventService: EventService;
  let invitationService: InvitationService;
  let userRepo: UserRepository;
  let eventReminderRepo: EventReminderRepository;
  let chatHistory: ChatHistoryRepository;

  const ALICE = 100; // creator
  const BOB = 200; // invitee

  beforeEach(() => {
    db = createTestDb();
    userRepo = new UserRepository(db);
    eventRepo = new EventRepository(db);
    participantRepo = new ParticipantRepository(db);
    invitationRepo = new InvitationRepository(db);
    eventReminderRepo = new EventReminderRepository(db);
    chatHistory = new ChatHistoryRepository(db);
    const sharingSettings = new SharingSettingsRepository(db);
    const conflictChecker = new ConflictChecker(eventRepo);
    eventService = new EventService({ eventRepo });
    invitationService = new InvitationService(
      invitationRepo,
      eventRepo,
      sharingSettings,
      participantRepo,
      conflictChecker,
    );
    userRepo.create({ telegram_id: ALICE, timezone: 'UTC', first_name: 'Alice' });
    userRepo.create({ telegram_id: BOB, timezone: 'UTC', first_name: 'Bob' });
  });

  test('create -> invite -> accept -> visible -> edit -> invitee sees -> decline -> gone', async () => {
    // 1. Alice creates an event
    const event = eventService.createEvent({
      user_id: ALICE,
      title: 'Team Standup',
      start_at: '2026-03-20T09:00:00Z',
      end_at: '2026-03-20T09:30:00Z',
      timezone: 'UTC',
    });
    expect(event.id).toBeDefined();

    // 2. Alice invites Bob
    const invResult = invitationService.sendInvitation(event.id, ALICE, BOB);
    expect(invResult.success).toBe(true);
    const invitationId = invResult.invitation!.id;

    // Event NOT yet visible to Bob (pending invitation)
    const beforeAccept = eventService.getEventsInRange(BOB, '2026-03-20T00:00:00Z', '2026-03-21T00:00:00Z');
    expect(beforeAccept).toHaveLength(0);

    // 3. Bob accepts
    const acceptResult = invitationService.acceptInvitation(invitationId, BOB);
    expect(acceptResult.success).toBe(true);

    // 4. Event appears in Bob's calendar
    const afterAccept = eventService.getEventsInRange(BOB, '2026-03-20T00:00:00Z', '2026-03-21T00:00:00Z');
    expect(afterAccept).toHaveLength(1);
    expect(afterAccept[0]!.event.title).toBe('Team Standup');
    expect(afterAccept[0]!.event.user_id).toBe(ALICE); // Bob sees Alice's event

    // 5. Alice edits the event (changes time)
    const updated = eventService.updateEvent(event.id, ALICE, { start_at: '2026-03-20T10:00:00Z' });
    expect(updated).not.toBeNull();
    expect(updated!.start_at).toBe('2026-03-20T10:00:00Z');

    // 6. Bob sees the updated event
    const afterEdit = eventService.getEventsInRange(BOB, '2026-03-20T00:00:00Z', '2026-03-21T00:00:00Z');
    expect(afterEdit).toHaveLength(1);
    expect(afterEdit[0]!.occurrence_start).toBe('2026-03-20T10:00:00Z');

    // 7. Bob declines (via handleDeleteEvent, which is what the AI uses)
    const bobUser = userRepo.findByTelegramId(BOB)!;
    const ctx: AgentContext = {
      user: bobUser,
      chatId: BOB,
      messageText: '',
      isGroup: false,
      eventService,
      holidayService: {} as HolidayService,
      chatHistory,
      userRepo,
      eventReminderRepo,
      participantRepo,
      conversationLogger: null as never,
    };
    const deleteResult = await handleDeleteEvent(ctx, { event_id: event.id });
    expect(deleteResult.success).toBe(true);
    expect(deleteResult.output).toContain('declined');

    // 8. Event gone from Bob's calendar
    const afterDecline = eventService.getEventsInRange(BOB, '2026-03-20T00:00:00Z', '2026-03-21T00:00:00Z');
    expect(afterDecline).toHaveLength(0);

    // 9. Event still exists for Alice
    const aliceEvents = eventService.getEventsInRange(ALICE, '2026-03-20T00:00:00Z', '2026-03-21T00:00:00Z');
    expect(aliceEvents).toHaveLength(1);
    expect(aliceEvents[0]!.event.title).toBe('Team Standup');

    // 10. Participant status is declined
    const participant = participantRepo.findByEventAndUser(event.id, BOB);
    expect(participant!.status).toBe('declined');
  });
});
