import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../../../src/database/repositories/event.repository.ts';
import { HolidayRepository } from '../../../../src/database/repositories/holiday.repository.ts';
import { InvitationRepository } from '../../../../src/database/repositories/invitation.repository.ts';
import { ReminderRepository } from '../../../../src/database/repositories/reminder.repository.ts';
import { SharedEventRepository } from '../../../../src/database/repositories/shared-event.repository.ts';
import { SharingSettingsRepository } from '../../../../src/database/repositories/sharing-settings.repository.ts';
import { UserRepository } from '../../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../../src/database/schema.ts';
import {
  handleGetInvitationStatus,
  handleSendInvitation,
  handleSetEventVisibility,
  handleShareAgenda,
  handleShareEvent,
  handleUpdateSharingSettings,
} from '../../../../src/services/ai/tool-handlers/sharing.ts';
import type { AgentContext } from '../../../../src/services/ai/types.ts';
import { EventService } from '../../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../../src/services/holiday/holiday-service.ts';
import { InvitationService } from '../../../../src/services/sharing/invitation-service.ts';
import { PrivacyService } from '../../../../src/services/sharing/privacy-service.ts';
import { SharingService } from '../../../../src/services/sharing/sharing-service.ts';

function createTestDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

const USER_ID = 100;
const OTHER_USER_ID = 200;

describe('sharing tool handlers', () => {
  let db: Database;
  let userRepo: UserRepository;
  let eventRepo: EventRepository;
  let reminderRepo: ReminderRepository;
  let eventService: EventService;
  let sharedEventRepo: SharedEventRepository;
  let invitationRepo: InvitationRepository;
  let sharingSettingsRepo: SharingSettingsRepository;
  let invitationService: InvitationService;
  let sharingService: SharingService;
  let privacyService: PrivacyService;

  function makeCtx(overrides: Partial<AgentContext> = {}): AgentContext {
    return {
      user: userRepo.findByTelegramId(USER_ID)!,
      chatId: USER_ID,
      messageText: '',
      eventService,
      holidayService: new HolidayService(new HolidayRepository(db)),
      chatHistory: new ChatHistoryRepository(db),
      userRepo,
      reminderRepo,
      sharedEventRepo,
      invitationRepo,
      invitationService,
      sharingSettingsRepo,
      sharingService,
      ...overrides,
    };
  }

  beforeEach(() => {
    db = createTestDb();
    userRepo = new UserRepository(db);
    eventRepo = new EventRepository(db);
    reminderRepo = new ReminderRepository(db);
    sharedEventRepo = new SharedEventRepository(db);
    invitationRepo = new InvitationRepository(db);
    sharingSettingsRepo = new SharingSettingsRepository(db);
    invitationService = new InvitationService(invitationRepo, eventRepo, sharingSettingsRepo);
    privacyService = new PrivacyService(sharingSettingsRepo);
    sharingService = new SharingService(eventRepo, privacyService);
    eventService = new EventService(eventRepo, reminderRepo);

    userRepo.create({ telegram_id: USER_ID, timezone: 'UTC' });
    userRepo.create({ telegram_id: OTHER_USER_ID, timezone: 'UTC' });
  });

  // ── handleShareEvent ──

  describe('handleShareEvent', () => {
    test('returns error when sharedEventRepo is missing', () => {
      const ctx = makeCtx({ sharedEventRepo: undefined });
      const result = handleShareEvent(ctx, { event_id: 1, target_type: 'user', target_id: OTHER_USER_ID });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Sharing is not configured.');
    });

    test('returns error when event not found', () => {
      const ctx = makeCtx();
      const result = handleShareEvent(ctx, { event_id: 9999, target_type: 'user', target_id: OTHER_USER_ID });
      expect(result.success).toBe(false);
      expect(result.error).toContain('9999');
      expect(result.error).toContain('not found');
    });

    test('returns error when event belongs to another user', () => {
      const event = eventService.createEvent({
        user_id: OTHER_USER_ID,
        title: 'Not Mine',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
      });
      const ctx = makeCtx();
      const result = handleShareEvent(ctx, { event_id: event.id, target_type: 'user', target_id: 300 });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    test('shares event to user successfully', () => {
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'Team Meeting',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
      });
      const ctx = makeCtx();
      const result = handleShareEvent(ctx, { event_id: event.id, target_type: 'user', target_id: OTHER_USER_ID });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Team Meeting');
      expect(result.output).toContain('shared');
      expect(result.output).toContain(`${OTHER_USER_ID}`);
    });

    test('shares event to group successfully', () => {
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'Group Sync',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
      });
      const ctx = makeCtx();
      const result = handleShareEvent(ctx, { event_id: event.id, target_type: 'group', target_id: -1001 });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Group Sync');
      expect(result.output).toContain('group');
      expect(result.output).toContain('-1001');
    });
  });

  // ── handleSendInvitation ──

  describe('handleSendInvitation', () => {
    test('returns error when invitationService is missing', () => {
      const ctx = makeCtx({ invitationService: undefined });
      const result = handleSendInvitation(ctx, { event_id: 1, invitee_id: OTHER_USER_ID });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Invitations are not configured.');
    });

    test('returns error when event not found (via invitation service)', () => {
      const ctx = makeCtx();
      const result = handleSendInvitation(ctx, { event_id: 9999, invitee_id: OTHER_USER_ID });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Event not found');
    });

    test('returns error when inviting yourself', () => {
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'Solo',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
      });
      const ctx = makeCtx();
      const result = handleSendInvitation(ctx, { event_id: event.id, invitee_id: USER_ID });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Cannot invite yourself');
    });

    test('sends invitation successfully', () => {
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'Party',
        start_at: '2026-03-20T18:00:00Z',
        timezone: 'UTC',
      });
      const ctx = makeCtx();
      const result = handleSendInvitation(ctx, { event_id: event.id, invitee_id: OTHER_USER_ID });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Invitation sent');
      expect(result.output).toContain(`${event.id}`);
      expect(result.output).toContain(`${OTHER_USER_ID}`);
    });

    test('returns error for duplicate invitation', () => {
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'Dup Test',
        start_at: '2026-03-20T18:00:00Z',
        timezone: 'UTC',
      });
      const ctx = makeCtx();
      handleSendInvitation(ctx, { event_id: event.id, invitee_id: OTHER_USER_ID });
      const result = handleSendInvitation(ctx, { event_id: event.id, invitee_id: OTHER_USER_ID });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Invitation already sent');
    });

    test('returns error when invitee disabled invitations', () => {
      sharingSettingsRepo.ensureDefaults(OTHER_USER_ID);
      sharingSettingsRepo.update(OTHER_USER_ID, { allow_invitations: 0 });
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'Blocked',
        start_at: '2026-03-20T18:00:00Z',
        timezone: 'UTC',
      });
      const ctx = makeCtx();
      const result = handleSendInvitation(ctx, { event_id: event.id, invitee_id: OTHER_USER_ID });
      expect(result.success).toBe(false);
      expect(result.error).toBe('User has disabled invitations');
    });
  });

  // ── handleGetInvitationStatus ──

  describe('handleGetInvitationStatus', () => {
    test('returns error when invitationRepo is missing', () => {
      const ctx = makeCtx({ invitationRepo: undefined });
      const result = handleGetInvitationStatus(ctx, { event_id: 1 });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Invitations are not configured.');
    });

    test('returns error when event not found', () => {
      const ctx = makeCtx();
      const result = handleGetInvitationStatus(ctx, { event_id: 9999 });
      expect(result.success).toBe(false);
      expect(result.error).toContain('9999');
      expect(result.error).toContain('not found');
    });

    test('returns error when event belongs to another user', () => {
      const event = eventService.createEvent({
        user_id: OTHER_USER_ID,
        title: 'Not Mine',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
      });
      const ctx = makeCtx();
      const result = handleGetInvitationStatus(ctx, { event_id: event.id });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    test('returns no invitations when none exist', () => {
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'Lonely Event',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
      });
      const ctx = makeCtx();
      const result = handleGetInvitationStatus(ctx, { event_id: event.id });
      expect(result.success).toBe(true);
      expect(result.output).toContain('No invitations');
      expect(result.output).toContain('Lonely Event');
    });

    test('returns pending invitations', () => {
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'With Guests',
        start_at: '2026-03-20T10:00:00Z',
        timezone: 'UTC',
      });
      invitationRepo.create({ event_id: event.id, inviter_id: USER_ID, invitee_id: OTHER_USER_ID });
      const ctx = makeCtx();
      const result = handleGetInvitationStatus(ctx, { event_id: event.id });
      expect(result.success).toBe(true);
      expect(result.output).toContain('With Guests');
      expect(result.output).toContain(`${OTHER_USER_ID}`);
      expect(result.output).toContain('pending');
    });

    test('returns accepted invitations', () => {
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'Confirmed',
        start_at: '2026-03-20T10:00:00Z',
        timezone: 'UTC',
      });
      const inv = invitationRepo.create({ event_id: event.id, inviter_id: USER_ID, invitee_id: OTHER_USER_ID });
      invitationRepo.updateStatus(inv.id, 'accepted', 'pending');
      const ctx = makeCtx();
      const result = handleGetInvitationStatus(ctx, { event_id: event.id });
      expect(result.success).toBe(true);
      expect(result.output).toContain('accepted');
      expect(result.output).toContain(`${OTHER_USER_ID}`);
    });

    test('returns mixed pending and accepted', () => {
      const thirdUser = 300;
      userRepo.create({ telegram_id: thirdUser, timezone: 'UTC' });
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'Mixed',
        start_at: '2026-03-20T10:00:00Z',
        timezone: 'UTC',
      });
      const inv1 = invitationRepo.create({ event_id: event.id, inviter_id: USER_ID, invitee_id: OTHER_USER_ID });
      invitationRepo.updateStatus(inv1.id, 'accepted', 'pending');
      invitationRepo.create({ event_id: event.id, inviter_id: USER_ID, invitee_id: thirdUser });
      const ctx = makeCtx();
      const result = handleGetInvitationStatus(ctx, { event_id: event.id });
      expect(result.success).toBe(true);
      expect(result.output).toContain('accepted');
      expect(result.output).toContain('pending');
    });
  });

  // ── handleUpdateSharingSettings ──

  describe('handleUpdateSharingSettings', () => {
    test('returns error when sharingSettingsRepo is missing', () => {
      const ctx = makeCtx({ sharingSettingsRepo: undefined });
      const result = handleUpdateSharingSettings(ctx, { default_visibility: 'full' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Sharing settings are not configured.');
    });

    test('returns error when no settings provided', () => {
      const ctx = makeCtx();
      const result = handleUpdateSharingSettings(ctx, {});
      expect(result.success).toBe(false);
      expect(result.error).toBe('No settings provided to update.');
    });

    test('updates default_visibility', () => {
      const ctx = makeCtx();
      const result = handleUpdateSharingSettings(ctx, { default_visibility: 'full' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('default_visibility');
      expect(result.output).toContain('full');

      const settings = sharingSettingsRepo.get(USER_ID);
      expect(settings).not.toBeNull();
      expect(settings!.default_visibility).toBe('full');
    });

    test('updates inline_mode_enabled as integer', () => {
      const ctx = makeCtx();
      const result = handleUpdateSharingSettings(ctx, { inline_mode_enabled: false });
      expect(result.success).toBe(true);
      expect(result.output).toContain('inline_mode_enabled');
      expect(result.output).toContain('0');

      const settings = sharingSettingsRepo.get(USER_ID);
      expect(settings!.inline_mode_enabled).toBe(0);
    });

    test('updates allow_invitations as integer', () => {
      const ctx = makeCtx();
      const result = handleUpdateSharingSettings(ctx, { allow_invitations: true });
      expect(result.success).toBe(true);
      expect(result.output).toContain('allow_invitations');
      expect(result.output).toContain('1');
    });

    test('updates multiple settings at once', () => {
      const ctx = makeCtx();
      const result = handleUpdateSharingSettings(ctx, {
        default_visibility: 'free_busy',
        inline_mode_enabled: true,
        allow_invitations: false,
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('default_visibility');
      expect(result.output).toContain('inline_mode_enabled');
      expect(result.output).toContain('allow_invitations');

      const settings = sharingSettingsRepo.get(USER_ID);
      expect(settings!.default_visibility).toBe('free_busy');
      expect(settings!.inline_mode_enabled).toBe(1);
      expect(settings!.allow_invitations).toBe(0);
    });
  });

  // ── handleShareAgenda ──

  describe('handleShareAgenda', () => {
    test('returns error when sharingService is missing', () => {
      const ctx = makeCtx({ sharingService: undefined });
      const result = handleShareAgenda(ctx, { period: 'today', target_type: 'user', target_id: OTHER_USER_ID });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Sharing is not configured.');
    });

    test('returns error when sharedEventRepo is missing', () => {
      const ctx = makeCtx({ sharedEventRepo: undefined });
      const result = handleShareAgenda(ctx, { period: 'today', target_type: 'user', target_id: OTHER_USER_ID });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Sharing is not configured.');
    });

    test('returns no events when agenda is empty', () => {
      const ctx = makeCtx();
      const result = handleShareAgenda(ctx, { period: 'today', target_type: 'user', target_id: OTHER_USER_ID });
      expect(result.success).toBe(true);
      expect(result.output).toContain('No visible events');
    });

    test('returns no events when all events are explicitly private', () => {
      // Must explicitly set visibility to private — default is now 'full'
      sharingSettingsRepo.ensureDefaults(USER_ID);
      sharingSettingsRepo.update(USER_ID, { default_visibility: 'private' });
      const todayAt14 = new Date();
      todayAt14.setUTCHours(14, 0, 0, 0);
      eventService.createEvent({
        user_id: USER_ID,
        title: 'Secret Meeting',
        start_at: todayAt14.toISOString(),
        timezone: 'UTC',
      });
      const ctx = makeCtx();
      const result = handleShareAgenda(ctx, { period: 'today', target_type: 'user', target_id: OTHER_USER_ID });
      expect(result.success).toBe(true);
      expect(result.output).toContain('No visible events');
    });

    test('shares today agenda with visible events', () => {
      const todayAt14 = new Date();
      todayAt14.setUTCHours(14, 0, 0, 0);
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'Public Standup',
        start_at: todayAt14.toISOString(),
        timezone: 'UTC',
      });
      // Make it visible
      sharingSettingsRepo.setEventVisibility(event.id, 'full');
      const ctx = makeCtx();
      const result = handleShareAgenda(ctx, { period: 'today', target_type: 'user', target_id: OTHER_USER_ID });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Public Standup');
      expect(result.output).toContain('today');
      expect(result.output).toContain(`${OTHER_USER_ID}`);
    });

    test('shares tomorrow agenda', () => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(14, 0, 0, 0);
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'Tomorrow Talk',
        start_at: tomorrow.toISOString(),
        timezone: 'UTC',
      });
      sharingSettingsRepo.setEventVisibility(event.id, 'full');
      const ctx = makeCtx();
      const result = handleShareAgenda(ctx, { period: 'tomorrow', target_type: 'group', target_id: -5000 });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Tomorrow Talk');
      expect(result.output).toContain('tomorrow');
      expect(result.output).toContain('group');
    });

    test('shares week agenda across multiple days', () => {
      // Create events on day+1 and day+3
      const day1 = new Date();
      day1.setDate(day1.getDate() + 1);
      day1.setHours(10, 0, 0, 0);
      const day3 = new Date();
      day3.setDate(day3.getDate() + 3);
      day3.setHours(15, 0, 0, 0);
      const ev1 = eventService.createEvent({
        user_id: USER_ID,
        title: 'Monday Sync',
        start_at: day1.toISOString(),
        timezone: 'UTC',
      });
      const ev2 = eventService.createEvent({
        user_id: USER_ID,
        title: 'Wednesday Review',
        start_at: day3.toISOString(),
        timezone: 'UTC',
      });
      sharingSettingsRepo.setEventVisibility(ev1.id, 'full');
      sharingSettingsRepo.setEventVisibility(ev2.id, 'full');
      const ctx = makeCtx();
      const result = handleShareAgenda(ctx, { period: 'week', target_type: 'user', target_id: OTHER_USER_ID });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Monday Sync');
      expect(result.output).toContain('Wednesday Review');
      expect(result.output).toContain('2 events');
    });

    test('creates shared_event records for each event in agenda', () => {
      const todayAt14 = new Date();
      todayAt14.setUTCHours(14, 0, 0, 0);
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'Track Me',
        start_at: todayAt14.toISOString(),
        timezone: 'UTC',
      });
      sharingSettingsRepo.setEventVisibility(event.id, 'full');
      const ctx = makeCtx();
      handleShareAgenda(ctx, { period: 'today', target_type: 'user', target_id: OTHER_USER_ID });

      const shares = sharedEventRepo.getByEvent(event.id);
      expect(shares.length).toBe(1);
      expect(shares[0].shared_to_type).toBe('user');
      expect(shares[0].shared_to_id).toBe(OTHER_USER_ID);
      expect(shares[0].share_type).toBe('agenda');
    });
  });

  // ── handleSetEventVisibility ──

  describe('handleSetEventVisibility', () => {
    test('returns error when sharingSettingsRepo is missing', () => {
      const ctx = makeCtx({ sharingSettingsRepo: undefined });
      const result = handleSetEventVisibility(ctx, { event_id: 1, visibility: 'full' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Sharing settings are not configured.');
    });

    test('returns error when event not found', () => {
      const ctx = makeCtx();
      const result = handleSetEventVisibility(ctx, { event_id: 9999, visibility: 'full' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('9999');
      expect(result.error).toContain('not found');
    });

    test('returns error when event belongs to another user', () => {
      const event = eventService.createEvent({
        user_id: OTHER_USER_ID,
        title: 'Not Mine',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
      });
      const ctx = makeCtx();
      const result = handleSetEventVisibility(ctx, { event_id: event.id, visibility: 'full' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    test('sets visibility to full', () => {
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'Visible Event',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
      });
      const ctx = makeCtx();
      const result = handleSetEventVisibility(ctx, { event_id: event.id, visibility: 'full' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Visible Event');
      expect(result.output).toContain('"full"');

      const stored = sharingSettingsRepo.getEventVisibility(event.id);
      expect(stored).toBe('full');
    });

    test('sets visibility to free_busy', () => {
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'Busy Event',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
      });
      const ctx = makeCtx();
      const result = handleSetEventVisibility(ctx, { event_id: event.id, visibility: 'free_busy' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('"free_busy"');
    });

    test('sets visibility to private', () => {
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'Private Event',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
      });
      const ctx = makeCtx();
      // First make it full, then set back to private
      handleSetEventVisibility(ctx, { event_id: event.id, visibility: 'full' });
      const result = handleSetEventVisibility(ctx, { event_id: event.id, visibility: 'private' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('"private"');

      const stored = sharingSettingsRepo.getEventVisibility(event.id);
      expect(stored).toBe('private');
    });

    test('output includes event id', () => {
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'ID Check',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
      });
      const ctx = makeCtx();
      const result = handleSetEventVisibility(ctx, { event_id: event.id, visibility: 'full' });
      expect(result.success).toBe(true);
      expect(result.output).toContain(`id: ${event.id}`);
    });
  });
});
