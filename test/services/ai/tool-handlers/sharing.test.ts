import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../../src/database/repositories/chat-history.repository.ts';
import { DeepLinkRepository } from '../../../../src/database/repositories/deep-link.repository.ts';
import { EditProposalRepository } from '../../../../src/database/repositories/edit-proposal.repository.ts';
import { EventRepository } from '../../../../src/database/repositories/event.repository.ts';
import { HolidayRepository } from '../../../../src/database/repositories/holiday.repository.ts';
import { InvitationRepository } from '../../../../src/database/repositories/invitation.repository.ts';
import { ParticipantRepository } from '../../../../src/database/repositories/participant.repository.ts';
import { ReminderRepository } from '../../../../src/database/repositories/reminder.repository.ts';
import { SharedEventRepository } from '../../../../src/database/repositories/shared-event.repository.ts';
import { SharingSettingsRepository } from '../../../../src/database/repositories/sharing-settings.repository.ts';
import { UserRepository } from '../../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../../src/database/schema.ts';
import { handleManageSettings } from '../../../../src/services/ai/tool-handlers/settings.ts';
import {
  handleGetInvitationStatus,
  handleProposeEdit,
  handleSendInvitation,
  handleSetEventVisibility,
  handleShareAgenda,
  handleShareEvent,
} from '../../../../src/services/ai/tool-handlers/sharing.ts';
import type { AgentContext } from '../../../../src/services/ai/types.ts';
import { EventService } from '../../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../../src/services/holiday/holiday-service.ts';
import { DeepLinkService } from '../../../../src/services/sharing/deep-link-service.ts';
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
  let deepLinkService: DeepLinkService;

  function makeCtx(overrides: Partial<AgentContext> = {}): AgentContext {
    return {
      user: userRepo.findByTelegramId(USER_ID)!,
      chatId: USER_ID,
      messageText: '',
      isGroup: false,
      eventService,
      holidayService: new HolidayService(new HolidayRepository(db)),
      chatHistory: new ChatHistoryRepository(db),
      userRepo,
      reminderRepo,
      sharing: {
        sharedEventRepo,
        invitationRepo,
        invitationService,
        sharingSettingsRepo,
        sharingService,
        privacyService,
        editProposalRepo: undefined as never,
      },
      conversationLogger: null as never,
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
    eventService = new EventService({ eventRepo, reminderRepo });
    deepLinkService = new DeepLinkService(new DeepLinkRepository(db));

    userRepo.create({ telegram_id: USER_ID, timezone: 'UTC' });
    userRepo.create({ telegram_id: OTHER_USER_ID, timezone: 'UTC' });
  });

  // ── handleShareEvent ──

  describe('handleShareEvent', () => {
    test('returns error when sharedEventRepo is missing', () => {
      const ctx = makeCtx({
        sharing: {
          sharedEventRepo: undefined as never,
          invitationRepo,
          invitationService,
          sharingSettingsRepo,
          sharingService,
          privacyService: privacyService,
          editProposalRepo: undefined as never,
        },
      });
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
      const ctx = makeCtx({
        sharing: {
          sharedEventRepo,
          invitationRepo,
          invitationService: undefined as never,
          sharingSettingsRepo,
          sharingService,
          privacyService: privacyService,
          editProposalRepo: undefined as never,
        },
      });
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
      expect(result.output).toContain('Invitation');
      expect(result.output).toContain(`${event.id}`);
      expect(result.output).toContain(`${OTHER_USER_ID}`);
    });

    test('delivers Telegram message to invitee when sender available', async () => {
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'Delivered Party',
        start_at: '2026-03-20T18:00:00Z',
        timezone: 'UTC',
      });
      let deliveredTo: number | undefined;
      let deliveredText: string | undefined;
      let deliveredInvId: number | undefined;
      const ctx = makeCtx({
        sender: {
          sendMessage: async () => ({ message_id: 1 }),
          editMessageText: async () => {},
          sendInvitation: async (inviteeId, text, invitationId) => {
            deliveredTo = inviteeId;
            deliveredText = text;
            deliveredInvId = invitationId;
            return { message_id: 42 };
          },
        },
      });
      const result = handleSendInvitation(ctx, { event_id: event.id, invitee_id: OTHER_USER_ID });
      expect(result.success).toBe(true);

      // Wait for async delivery
      await new Promise((r) => setTimeout(r, 50));

      expect(deliveredTo).toBe(OTHER_USER_ID);
      expect(deliveredText).toContain('Delivered Party');
      expect(deliveredInvId).toBeGreaterThan(0);

      // Check message_id was saved
      const inv = invitationRepo.findById(deliveredInvId!);
      expect(inv?.message_id).toBe(42);
      expect(inv?.chat_id).toBe(OTHER_USER_ID);
    });

    test('falls back to MTProto when bot delivery fails', async () => {
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'MTProto Fallback',
        start_at: '2026-03-20T18:00:00Z',
        timezone: 'UTC',
      });
      let mtprotoCalledWith: { userId: number; text: string } | undefined;
      const ctx = makeCtx({
        sender: {
          sendMessage: async () => ({ message_id: 1 }),
          editMessageText: async () => {},
          sendInvitation: async () => null,
          sendAsUser: async (userId, text) => {
            mtprotoCalledWith = { userId, text };
            return true;
          },
        },
        deepLinkService,
        botUsername: 'TestBot',
      });
      const result = handleSendInvitation(ctx, { event_id: event.id, invitee_id: OTHER_USER_ID });
      expect(result.success).toBe(true);

      await new Promise((r) => setTimeout(r, 100));

      expect(mtprotoCalledWith).toBeDefined();
      expect(mtprotoCalledWith!.userId).toBe(OTHER_USER_ID);
      expect(mtprotoCalledWith!.text).toContain('t.me/TestBot');
    });

    test('sends deep link to inviter when bot and MTProto both fail', async () => {
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'Both Failed',
        start_at: '2026-03-20T18:00:00Z',
        timezone: 'UTC',
      });
      const sentMessages: { chatId: number; text: string }[] = [];
      const ctx = makeCtx({
        sender: {
          sendMessage: async (chatId, text) => {
            sentMessages.push({ chatId, text });
            return { message_id: 1 };
          },
          editMessageText: async () => {},
          sendInvitation: async () => null,
          sendAsUser: async () => false,
        },
        deepLinkService,
        botUsername: 'TestBot',
      });
      const result = handleSendInvitation(ctx, { event_id: event.id, invitee_id: OTHER_USER_ID });
      expect(result.success).toBe(true);

      await new Promise((r) => setTimeout(r, 100));

      const followUp = sentMessages.find((m) => m.chatId === USER_ID && m.text.includes('t.me/TestBot'));
      expect(followUp).toBeDefined();
    });

    test('sends deep link to inviter when no MTProto available', async () => {
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'No MTProto',
        start_at: '2026-03-20T18:00:00Z',
        timezone: 'UTC',
      });
      const sentMessages: { chatId: number; text: string }[] = [];
      const ctx = makeCtx({
        sender: {
          sendMessage: async (chatId, text) => {
            sentMessages.push({ chatId, text });
            return { message_id: 1 };
          },
          editMessageText: async () => {},
          sendInvitation: async () => null,
        },
        deepLinkService,
        botUsername: 'TestBot',
      });
      const result = handleSendInvitation(ctx, { event_id: event.id, invitee_id: OTHER_USER_ID });
      expect(result.success).toBe(true);

      await new Promise((r) => setTimeout(r, 100));

      const followUp = sentMessages.find((m) => m.chatId === USER_ID && m.text.includes('t.me/TestBot'));
      expect(followUp).toBeDefined();
    });

    test('does not crash when sender.sendInvitation returns null (no deep link service)', async () => {
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'Blocked User Party',
        start_at: '2026-03-20T18:00:00Z',
        timezone: 'UTC',
      });
      const ctx = makeCtx({
        sender: {
          sendMessage: async () => ({ message_id: 1 }),
          editMessageText: async () => {},
          sendInvitation: async () => null,
        },
      });
      const result = handleSendInvitation(ctx, { event_id: event.id, invitee_id: OTHER_USER_ID });
      expect(result.success).toBe(true);

      await new Promise((r) => setTimeout(r, 50));

      // Invitation created but message_id stays null
      const inv = invitationRepo.findActiveByEventAndInvitee(event.id, OTHER_USER_ID);
      expect(inv).not.toBeNull();
      expect(inv!.message_id).toBeNull();
    });

    test('still succeeds when sender is not available (no delivery)', () => {
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'No Sender Party',
        start_at: '2026-03-20T18:00:00Z',
        timezone: 'UTC',
      });
      const ctx = makeCtx({ sender: undefined });
      const result = handleSendInvitation(ctx, { event_id: event.id, invitee_id: OTHER_USER_ID });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Invitation');
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
      const ctx = makeCtx({
        sharing: {
          sharedEventRepo,
          invitationRepo: undefined as never,
          invitationService,
          sharingSettingsRepo,
          sharingService,
          privacyService: privacyService,
          editProposalRepo: undefined as never,
        },
      });
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

  // ── privacy settings via manage_settings ──

  describe('manage_settings privacy category', () => {
    test('returns error when sharingSettingsRepo is missing', () => {
      const ctx = makeCtx({
        sharing: {
          sharedEventRepo,
          invitationRepo,
          invitationService,
          sharingSettingsRepo: undefined as never,
          sharingService,
          privacyService: privacyService,
          editProposalRepo: undefined as never,
        },
      });
      const result = handleManageSettings(ctx, {
        action: 'update',
        category: 'privacy',
        updates: { default_visibility: 'full' },
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Sharing settings are not configured.');
    });

    test('returns error when no settings provided', () => {
      const ctx = makeCtx();
      const result = handleManageSettings(ctx, {
        action: 'update',
        category: 'privacy',
        updates: {},
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('updates');
    });

    test('updates default_visibility', () => {
      const ctx = makeCtx();
      const result = handleManageSettings(ctx, {
        action: 'update',
        category: 'privacy',
        updates: { default_visibility: 'full' },
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('default_visibility');
      expect(result.output).toContain('full');

      const settings = sharingSettingsRepo.get(USER_ID);
      expect(settings).not.toBeNull();
      expect(settings!.default_visibility).toBe('full');
    });

    test('updates inline_mode_enabled as integer', () => {
      const ctx = makeCtx();
      const result = handleManageSettings(ctx, {
        action: 'update',
        category: 'privacy',
        updates: { inline_mode_enabled: false },
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('inline_mode_enabled');
      expect(result.output).toContain('0');

      const settings = sharingSettingsRepo.get(USER_ID);
      expect(settings!.inline_mode_enabled).toBe(0);
    });

    test('updates allow_invitations as integer', () => {
      const ctx = makeCtx();
      const result = handleManageSettings(ctx, {
        action: 'update',
        category: 'privacy',
        updates: { allow_invitations: true },
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('allow_invitations');
      expect(result.output).toContain('1');
    });

    test('updates multiple settings at once', () => {
      const ctx = makeCtx();
      const result = handleManageSettings(ctx, {
        action: 'update',
        category: 'privacy',
        updates: { default_visibility: 'free_busy', inline_mode_enabled: true, allow_invitations: false },
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
      const ctx = makeCtx({ sharing: undefined });
      const result = handleShareAgenda(ctx, { period: 'today', target_type: 'user', target_id: OTHER_USER_ID });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Sharing is not configured.');
    });

    test('returns error when sharedEventRepo is missing', () => {
      const ctx = makeCtx({ sharing: undefined });
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
      expect(shares[0]!.shared_to_type).toBe('user');
      expect(shares[0]!.shared_to_id).toBe(OTHER_USER_ID);
      expect(shares[0]!.share_type).toBe('agenda');
    });
  });

  // ── handleSetEventVisibility ──

  describe('handleSetEventVisibility', () => {
    test('returns error when sharingSettingsRepo is missing', () => {
      const ctx = makeCtx({
        sharing: {
          sharedEventRepo,
          invitationRepo,
          invitationService,
          sharingSettingsRepo: undefined as never,
          sharingService,
          privacyService: privacyService,
          editProposalRepo: undefined as never,
        },
      });
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

  // ── handleProposeEdit ──

  describe('handleProposeEdit', () => {
    test('returns error when participantRepo is missing', () => {
      const ctx = makeCtx({ participantRepo: undefined });
      const result = handleProposeEdit(ctx, { event_id: 1, changes: { title: 'New' } });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not configured');
    });

    test('returns error when editProposalRepo is missing', () => {
      const participantRepo = new ParticipantRepository(db);
      const ctx = makeCtx({
        participantRepo,
        sharing: {
          sharedEventRepo,
          invitationRepo,
          invitationService,
          sharingSettingsRepo,
          sharingService,
          privacyService: privacyService,
          editProposalRepo: undefined as never,
        },
      });
      const result = handleProposeEdit(ctx, { event_id: 1, changes: { title: 'New' } });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not configured');
    });

    test('returns error when user is not a participant', () => {
      const participantRepo = new ParticipantRepository(db);
      const editProposalRepo = new EditProposalRepository(db);
      const event = eventService.createEvent({
        user_id: OTHER_USER_ID,
        title: 'Not My Event',
        start_at: '2026-03-20T10:00:00Z',
        timezone: 'UTC',
      });

      const ctx = makeCtx({
        participantRepo,
        sharing: {
          sharedEventRepo,
          invitationRepo,
          invitationService,
          sharingSettingsRepo,
          sharingService,
          privacyService,
          editProposalRepo,
        },
      });
      const result = handleProposeEdit(ctx, { event_id: event.id, changes: { title: 'Change' } });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not an accepted participant');
    });

    test('stores proposal and returns success', () => {
      const participantRepo = new ParticipantRepository(db);
      const editProposalRepo = new EditProposalRepository(db);
      const event = eventService.createEvent({
        user_id: OTHER_USER_ID,
        title: 'Shared Event',
        start_at: '2026-03-20T10:00:00Z',
        timezone: 'UTC',
      });
      participantRepo.add(event.id, USER_ID, 'accepted');

      const ctx = makeCtx({
        participantRepo,
        sharing: {
          sharedEventRepo,
          invitationRepo,
          invitationService,
          sharingSettingsRepo,
          sharingService,
          privacyService,
          editProposalRepo,
        },
      });
      const result = handleProposeEdit(ctx, {
        event_id: event.id,
        changes: { start_at: '2026-03-20T11:00:00Z' },
        reason: 'Conflict with another meeting',
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('proposal submitted');

      const pending = editProposalRepo.getPendingForEvent(event.id);
      expect(pending).toHaveLength(1);
      expect(pending[0]!.proposer_id).toBe(USER_ID);
      expect(JSON.parse(pending[0]!.changes)).toEqual({ start_at: '2026-03-20T11:00:00Z' });
      expect(pending[0]!.reason).toBe('Conflict with another meeting');
    });

    test('sends notification to event creator when sender available', () => {
      const participantRepo = new ParticipantRepository(db);
      const editProposalRepo = new EditProposalRepository(db);
      const event = eventService.createEvent({
        user_id: OTHER_USER_ID,
        title: 'Creator Gets Notified',
        start_at: '2026-03-20T10:00:00Z',
        timezone: 'UTC',
      });
      participantRepo.add(event.id, USER_ID, 'accepted');

      let sentTo: number | undefined;
      const ctx = makeCtx({
        participantRepo,
        sharing: {
          sharedEventRepo,
          invitationRepo,
          invitationService,
          sharingSettingsRepo,
          sharingService,
          privacyService,
          editProposalRepo,
        },
        sender: {
          sendMessage: async () => ({ message_id: 1 }),
          editMessageText: async () => {},
          sendEditProposal: async (creatorId) => {
            sentTo = creatorId;
            return { message_id: 42 };
          },
        },
      });

      handleProposeEdit(ctx, { event_id: event.id, changes: { title: 'Better Name' } });
      expect(sentTo).toBe(OTHER_USER_ID);
    });
  });
});
