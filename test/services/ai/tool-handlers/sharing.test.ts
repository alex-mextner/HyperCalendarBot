import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../../src/database/repositories/chat-history.repository.ts';
import { DeepLinkRepository } from '../../../../src/database/repositories/deep-link.repository.ts';
import { EditProposalRepository } from '../../../../src/database/repositories/edit-proposal.repository.ts';
import { EventRepository } from '../../../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../../../src/database/repositories/event-reminder.repository.ts';
import { GroupChatRepository } from '../../../../src/database/repositories/group-chat.repository.ts';
import { GroupMemberRepository } from '../../../../src/database/repositories/group-member.repository.ts';
import { HolidayRepository } from '../../../../src/database/repositories/holiday.repository.ts';
import { InvitationRepository } from '../../../../src/database/repositories/invitation.repository.ts';
import { ParticipantRepository } from '../../../../src/database/repositories/participant.repository.ts';
import { SharedEventRepository } from '../../../../src/database/repositories/shared-event.repository.ts';
import { SharingSettingsRepository } from '../../../../src/database/repositories/sharing-settings.repository.ts';
import { UserRepository } from '../../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../../src/database/schema.ts';
import { executeTool } from '../../../../src/services/ai/tool-executor.ts';
import { handleManageSettings } from '../../../../src/services/ai/tool-handlers/settings.ts';
import {
  handleGetInvitationStatus,
  handleProposeEdit,
  handleResendInvitation,
  handleSendInvitation,
  handleSetEventVisibility,
  handleShareAgenda,
  handleShareEvent,
} from '../../../../src/services/ai/tool-handlers/sharing.ts';
import type { AgentContext, InvitationKeyboardVariant } from '../../../../src/services/ai/types.ts';
import { EventService } from '../../../../src/services/event/event-service.ts';
import { GroupMemberService } from '../../../../src/services/group/member-service.ts';
import { HolidayService } from '../../../../src/services/holiday/holiday-service.ts';
import { DeepLinkService } from '../../../../src/services/sharing/deep-link-service.ts';
import { InvitationService } from '../../../../src/services/sharing/invitation-service.ts';
import { PrivacyService } from '../../../../src/services/sharing/privacy-service.ts';
import { SharingService } from '../../../../src/services/sharing/sharing-service.ts';
import { flushPromises } from '../../../helpers/mock-context.ts';
import { addAsPre064Image, ageAnswers, answerAsPre064Image } from '../../../helpers/pre-064-image.ts';

function createTestDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

const USER_ID = 100;
const OTHER_USER_ID = 200;
const GROUP_CHAT_ID = -1009999;

function futureStartAt(): string {
  return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
}

describe('sharing tool handlers', () => {
  let db: Database;
  let userRepo: UserRepository;
  let eventRepo: EventRepository;
  let eventReminderRepo: EventReminderRepository;
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
      // Delivery tests exercise a user-supplied recipient, not an invented global ID.
      messageText: `Invite Telegram ID ${OTHER_USER_ID}`,
      isGroup: false,
      eventService,
      holidayService: new HolidayService(new HolidayRepository(db)),
      chatHistory: new ChatHistoryRepository(db),
      userRepo,
      eventReminderRepo,
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
    eventReminderRepo = new EventReminderRepository(db);
    sharedEventRepo = new SharedEventRepository(db);
    invitationRepo = new InvitationRepository(db);
    sharingSettingsRepo = new SharingSettingsRepository(db);
    invitationService = new InvitationService(invitationRepo, eventRepo, sharingSettingsRepo);
    privacyService = new PrivacyService(sharingSettingsRepo);
    eventService = new EventService({ eventRepo });
    sharingService = new SharingService(
      (userId, startUtc, endUtc) => eventService.getEventsInRange(userId, startUtc, endUtc),
      privacyService,
    );
    deepLinkService = new DeepLinkService(new DeepLinkRepository(db));

    userRepo.create({ telegram_id: USER_ID, timezone: 'UTC' });
    userRepo.create({ telegram_id: OTHER_USER_ID, timezone: 'UTC' });
  });

  // ── handleShareEvent ──

  describe('handleShareEvent', () => {
    test('returns error when sharedEventRepo is missing', async () => {
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

    test('returns error when event not found', async () => {
      const ctx = makeCtx();
      const result = handleShareEvent(ctx, { event_id: 9999, target_type: 'user', target_id: OTHER_USER_ID });
      expect(result.success).toBe(false);
      expect(result.error).toContain('9999');
      expect(result.error).toContain('not found');
    });

    test('returns error when event belongs to another user', async () => {
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

    test('shares event to user successfully', async () => {
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

    test('shares event to group successfully', async () => {
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
    test('returns error when invitationService is missing', async () => {
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
      const result = await handleSendInvitation(ctx, { event_id: 1, invitee_id: OTHER_USER_ID });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Invitations are not configured.');
    });

    test('returns error when event not found (via invitation service)', async () => {
      const ctx = makeCtx();
      const result = await handleSendInvitation(ctx, { event_id: 9999, invitee_id: OTHER_USER_ID });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Event not found');
    });

    test('returns error when inviting yourself', async () => {
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'Solo',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
      });
      const ctx = makeCtx();
      const result = await handleSendInvitation(ctx, { event_id: event.id, invitee_id: USER_ID });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Cannot invite yourself');
    });

    test('sends invitation successfully', async () => {
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'Party',
        start_at: '2026-03-20T18:00:00Z',
        timezone: 'UTC',
      });
      const ctx = makeCtx();
      const result = await handleSendInvitation(ctx, { event_id: event.id, invitee_id: OTHER_USER_ID });
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
      const result = await handleSendInvitation(ctx, { event_id: event.id, invitee_id: OTHER_USER_ID });
      expect(result.success).toBe(true);

      // Wait for async delivery
      await flushPromises();

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
      const result = await handleSendInvitation(ctx, { event_id: event.id, invitee_id: OTHER_USER_ID });
      expect(result.success).toBe(true);

      await flushPromises();

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
      const result = await handleSendInvitation(ctx, { event_id: event.id, invitee_id: OTHER_USER_ID });
      expect(result.success).toBe(true);

      await flushPromises();

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
      const result = await handleSendInvitation(ctx, { event_id: event.id, invitee_id: OTHER_USER_ID });
      expect(result.success).toBe(true);

      await flushPromises();

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
      const result = await handleSendInvitation(ctx, { event_id: event.id, invitee_id: OTHER_USER_ID });
      expect(result.success).toBe(true);

      await flushPromises();

      // Invitation created but message_id stays null
      const inv = invitationRepo.findActiveByEventAndInvitee(event.id, OTHER_USER_ID);
      expect(inv).not.toBeNull();
      expect(inv!.message_id).toBeNull();
    });

    test('still succeeds when sender is not available (no delivery)', async () => {
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'No Sender Party',
        start_at: '2026-03-20T18:00:00Z',
        timezone: 'UTC',
      });
      const ctx = makeCtx({ sender: undefined });
      const result = await handleSendInvitation(ctx, { event_id: event.id, invitee_id: OTHER_USER_ID });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Invitation');
    });

    test('deep-link fallback goes to inviter private chat, never the group chatId (security #94)', async () => {
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'Group Party',
        start_at: futureStartAt(),
        timezone: 'UTC',
      });
      const sentMessages: { chatId: number; text: string }[] = [];
      const ctx = makeCtx({
        // The bot was invoked from inside a group: ctx.chatId is the group, not the inviter.
        chatId: GROUP_CHAT_ID,
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
      const result = await handleSendInvitation(ctx, { event_id: event.id, invitee_id: OTHER_USER_ID });
      expect(result.success).toBe(true);

      await flushPromises();

      // The private invitation deep-link must land in the inviter's private chat,
      // NEVER in the group it was triggered from (would leak to all members).
      const fallback = sentMessages.find((m) => m.text.includes('t.me/TestBot'));
      expect(fallback).toBeDefined();
      expect(fallback!.chatId).toBe(USER_ID);
      expect(sentMessages.some((m) => m.chatId === GROUP_CHAT_ID)).toBe(false);
    });

    test('returns error for duplicate invitation', async () => {
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'Dup Test',
        start_at: '2026-03-20T18:00:00Z',
        timezone: 'UTC',
      });
      const ctx = makeCtx();
      handleSendInvitation(ctx, { event_id: event.id, invitee_id: OTHER_USER_ID });
      const result = await handleSendInvitation(ctx, { event_id: event.id, invitee_id: OTHER_USER_ID });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Invitation already sent');
    });

    test('resolves invitee via resolveUsername when only username provided', async () => {
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'Resolve Party',
        start_at: '2026-03-20T18:00:00Z',
        timezone: 'UTC',
      });
      const ctx = makeCtx({
        messageText: 'Invite @targetuser',
        resolveUsername: async (username: string) => {
          expect(username).toBe('targetuser');
          return { id: 300, firstName: 'Target', username: 'targetuser' };
        },
      });
      const result = await handleSendInvitation(ctx, {
        event_id: event.id,
        invitee_username: 'targetuser',
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('300');
    });

    test('opens pick_users when resolve returns null', async () => {
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'Picker Party',
        start_at: '2026-03-20T18:00:00Z',
        timezone: 'UTC',
      });
      let pickerPrompt = '';
      const ctx = makeCtx({
        messageText: 'Invite @nobody',
        resolveUsername: async () => null,
        sender: {
          sendMessage: async () => ({ message_id: 1 }),
          editMessageText: async () => {},
          sendUserPicker: async (_chatId: number, prompt: string) => {
            pickerPrompt = prompt;
            return { message_id: 1 };
          },
        },
      });
      const result = await handleSendInvitation(ctx, {
        event_id: event.id,
        invitee_username: 'nobody',
      });
      expect(result.success).toBe(true);
      expect(result.stopLoop).toBe(true);
      expect(pickerPrompt).toContain('@nobody');
    });

    test("routes the picker to the inviter's private chat, not a group ctx.chatId", async () => {
      // The picker prompt names the invitee's @username; sending it to ctx.chatId when that
      // is a group would leak who is being invited to every member (agent-tools#163 finding).
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'Group Picker Party',
        start_at: '2026-03-20T18:00:00Z',
        timezone: 'UTC',
      });
      let pickerChatId: number | undefined;
      const ctx = makeCtx({
        messageText: 'Invite @nobody',
        chatId: GROUP_CHAT_ID,
        resolveUsername: async () => null,
        sender: {
          sendMessage: async () => ({ message_id: 1 }),
          editMessageText: async () => {},
          sendUserPicker: async (chatId: number) => {
            pickerChatId = chatId;
            return { message_id: 1 };
          },
        },
      });
      const result = await handleSendInvitation(ctx, {
        event_id: event.id,
        invitee_username: 'nobody',
      });
      expect(result.success).toBe(true);
      expect(pickerChatId).toBe(USER_ID);
    });

    test('dispatches through executeTool when only invitee_username is provided', async () => {
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'Dispatch Party',
        start_at: futureStartAt(),
        timezone: 'UTC',
      });
      const ctx = makeCtx({
        messageText: 'Invite @targetuser',
        resolveUsername: async () => ({ id: 300, firstName: 'Target', username: 'targetuser' }),
      });

      const result = await executeTool(ctx, 'send_invitation', {
        event_id: event.id,
        invitee_username: 'targetuser',
      });

      expect(result.success).toBe(true);
      expect(invitationRepo.findActiveByEventAndInvitee(event.id, 300)).not.toBeNull();
    });

    test('names the offending field when executeTool rejects malformed input', async () => {
      const ctx = makeCtx();
      const result = await executeTool(ctx, 'send_invitation', { invitee_id: 300 });

      expect(result.success).toBe(false);
      expect(result.error).toContain('event_id');
      // The wrapper already says "Invalid input" — the zod message must not repeat it.
      expect(result.error).not.toContain('Invalid input: Invalid input');
    });

    test('returns error when neither invitee_id nor invitee_username provided', async () => {
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'Missing ID',
        start_at: '2026-03-20T18:00:00Z',
        timezone: 'UTC',
      });
      const ctx = makeCtx();
      const result = await handleSendInvitation(ctx, { event_id: event.id });
      expect(result.success).toBe(false);
      expect(result.error).toContain('invitee_id');
    });

    test('returns error when resolveUsername unavailable and no invitee_id', async () => {
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'No Resolve',
        start_at: '2026-03-20T18:00:00Z',
        timezone: 'UTC',
      });
      const ctx = makeCtx({ messageText: 'Invite @someone' });
      const result = await handleSendInvitation(ctx, {
        event_id: event.id,
        invitee_username: 'someone',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('resolution');
    });

    test('auto-adds resolved user as contact', async () => {
      const { ContactRepository } = await import('../../../../src/database/repositories/contact.repository.ts');
      const contactRepo = new ContactRepository(db);
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'Contact Party',
        start_at: '2026-03-20T18:00:00Z',
        timezone: 'UTC',
      });
      const ctx = makeCtx({
        messageText: 'Invite @resolved_user',
        resolveUsername: async () => ({ id: 400, firstName: 'Resolved', username: 'resolved_user' }),
        contactRepo,
      });
      await handleSendInvitation(ctx, {
        event_id: event.id,
        invitee_username: 'resolved_user',
      });
      const contact = contactRepo.findByTelegramId(USER_ID, 400);
      expect(contact).not.toBeNull();
      expect(contact!.name).toBe('Resolved');
    });

    test('returns error when resolve fails and no sendUserPicker', async () => {
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'No Picker',
        start_at: '2026-03-20T18:00:00Z',
        timezone: 'UTC',
      });
      const ctx = makeCtx({
        messageText: 'Invite @nobody',
        resolveUsername: async () => null,
        sender: {
          sendMessage: async () => ({ message_id: 1 }),
          editMessageText: async () => {},
        },
      });
      const result = await handleSendInvitation(ctx, {
        event_id: event.id,
        invitee_username: 'nobody',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('picker');
    });

    test('handles resolveUsername exception gracefully', async () => {
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'Error Party',
        start_at: '2026-03-20T18:00:00Z',
        timezone: 'UTC',
      });
      const ctx = makeCtx({
        messageText: 'Invite @broken',
        resolveUsername: async () => {
          throw new Error('MTProto connection failed');
        },
      });
      const result = await handleSendInvitation(ctx, {
        event_id: event.id,
        invitee_username: 'broken',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('@broken');
    });

    test('returns error when invitee disabled invitations', async () => {
      sharingSettingsRepo.ensureDefaults(OTHER_USER_ID);
      sharingSettingsRepo.update(OTHER_USER_ID, { allow_invitations: 0 });
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'Blocked',
        start_at: '2026-03-20T18:00:00Z',
        timezone: 'UTC',
      });
      const ctx = makeCtx();
      const result = await handleSendInvitation(ctx, { event_id: event.id, invitee_id: OTHER_USER_ID });
      expect(result.success).toBe(false);
      expect(result.error).toBe('User has disabled invitations');
    });
  });

  // ── handleResendInvitation ──

  describe('handleResendInvitation', () => {
    test('deep-link fallback goes to inviter private chat, never the group chatId (security #94)', async () => {
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'Resend Party',
        start_at: futureStartAt(),
        timezone: 'UTC',
      });
      const inv = invitationRepo.create({ event_id: event.id, inviter_id: USER_ID, invitee_id: OTHER_USER_ID });
      const sentMessages: { chatId: number; text: string }[] = [];
      const ctx = makeCtx({
        chatId: GROUP_CHAT_ID,
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
      const result = await handleResendInvitation(ctx, { invitation_id: inv.id });
      expect(result.success).toBe(true);

      await flushPromises();

      const fallback = sentMessages.find((m) => m.text.includes('t.me/TestBot'));
      expect(fallback).toBeDefined();
      expect(fallback!.chatId).toBe(USER_ID);
      expect(sentMessages.some((m) => m.chatId === GROUP_CHAT_ID)).toBe(false);
    });

    test('returns error when delivery (sender) is not available', async () => {
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'No Sender Resend',
        start_at: futureStartAt(),
        timezone: 'UTC',
      });
      const inv = invitationRepo.create({ event_id: event.id, inviter_id: USER_ID, invitee_id: OTHER_USER_ID });
      const ctx = makeCtx({ sender: undefined });
      const result = await handleResendInvitation(ctx, { invitation_id: inv.id });
      expect(result.success).toBe(false);
      expect(result.error).toContain('delivery');
    });

    test('resending a pending GROUP invitation uses the group RSVP keyboard and skips MTProto', async () => {
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'Group Resend',
        start_at: futureStartAt(),
        timezone: 'UTC',
      });
      // A group invitation stores the (negative) group chat id as invitee_id.
      const inv = invitationRepo.create({ event_id: event.id, inviter_id: USER_ID, invitee_id: GROUP_CHAT_ID });
      let variant: InvitationKeyboardVariant | undefined;
      let groupRecipient: number | undefined;
      let mtprotoCalled = false;
      const sentToInviter: number[] = [];
      const ctx = makeCtx({
        isGroup: true,
        chatId: GROUP_CHAT_ID,
        groupChatId: GROUP_CHAT_ID,
        sender: {
          sendMessage: async (chatId) => {
            sentToInviter.push(chatId);
            return { message_id: 1 };
          },
          editMessageText: async () => {},
          sendInvitation: async (inviteeId, _text, _invId, _lang, v) => {
            groupRecipient = inviteeId;
            variant = v;
            return null; // bot API delivery fails so the fallback path is exercised too
          },
          sendAsUser: async () => {
            mtprotoCalled = true;
            return true;
          },
        },
        deepLinkService,
        botUsername: 'TestBot',
      });
      const result = await handleResendInvitation(ctx, { invitation_id: inv.id });
      expect(result.success).toBe(true);

      await flushPromises();

      // The group RSVP keyboard variant is delivered to the group so members can respond for
      // themselves — never the personal inv: keyboard (which authorizes a single invitee).
      expect(groupRecipient).toBe(GROUP_CHAT_ID);
      expect(variant).toEqual({ kind: 'group', eventId: event.id, place: expect.objectContaining({ id: event.id }) });
      // allowMtproto:false → no MTProto userbot for a group, and the deep-link forward fallback is
      // suppressed (a forward link can't be accepted on behalf of a group).
      expect(mtprotoCalled).toBe(false);
      expect(sentToInviter).toHaveLength(0);
    });

    test('sender without sendInvitation capability → succeeds but reports delivery failed (consistent guard)', async () => {
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'No Capability Resend',
        start_at: futureStartAt(),
        timezone: 'UTC',
      });
      const inv = invitationRepo.create({ event_id: event.id, inviter_id: USER_ID, invitee_id: OTHER_USER_ID });
      // A sender object is present but lacks sendInvitation — deliverInvitation tolerates this and
      // reports non-delivery, mirroring handleSendInvitation's `if (ctx.sender)` guard.
      const ctx = makeCtx({
        sender: {
          sendMessage: async () => ({ message_id: 1 }),
          editMessageText: async () => {},
        },
      });
      const result = await handleResendInvitation(ctx, { invitation_id: inv.id });
      expect(result.success).toBe(true);
      expect(result.agentHint).toContain('failed');
    });
  });

  // ── handleGetInvitationStatus ──

  describe('handleGetInvitationStatus', () => {
    test('returns error when invitationRepo is missing', async () => {
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

    test('returns error when event not found', async () => {
      const ctx = makeCtx();
      const result = handleGetInvitationStatus(ctx, { event_id: 9999 });
      expect(result.success).toBe(false);
      expect(result.error).toContain('9999');
      expect(result.error).toContain('not found');
    });

    test('returns error when event belongs to another user', async () => {
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

    test('returns no invitations when none exist', async () => {
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

    test('returns pending invitations', async () => {
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

    test('returns accepted invitations', async () => {
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

    test('group invitation reflects per-member RSVP state instead of a stale "pending"', async () => {
      const participantRepo = new ParticipantRepository(db);
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'Group Event',
        start_at: futureStartAt(),
        timezone: 'UTC',
      });
      // Group invite: invitee_id is the negative group chat id; the row stays "pending" forever.
      invitationRepo.create({ event_id: event.id, inviter_id: USER_ID, invitee_id: GROUP_CHAT_ID });
      // Two members RSVP'd via grsvp → recorded per-member in event_participants.
      participantRepo.add(event.id, 301, 'accepted');
      participantRepo.add(event.id, 302, 'declined');
      const ctx = makeCtx({ participantRepo });
      const result = handleGetInvitationStatus(ctx, { event_id: event.id });
      expect(result.success).toBe(true);
      expect(result.output).toContain('301');
      expect(result.output).toContain('accepted');
      expect(result.output).toContain('302');
      expect(result.output).toContain('declined');
      // The negative group chat id must NOT be shown as a stale per-invitee line.
      expect(result.output).not.toContain(`invitee: ${GROUP_CHAT_ID}`);
    });

    test("a member's answer in a withdrawn group is not reported next to a group invited later", async () => {
      const participantRepo = new ParticipantRepository(db);
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'Group Event',
        start_at: futureStartAt(),
        timezone: 'UTC',
      });
      const groupA = invitationRepo.create({ event_id: event.id, inviter_id: USER_ID, invitee_id: GROUP_CHAT_ID });
      participantRepo.add(event.id, 301, 'accepted', 'attendee', GROUP_CHAT_ID);
      invitationRepo.updateStatus(groupA.id, 'cancelled', 'pending');
      const groupB = -1007777;
      invitationRepo.create({ event_id: event.id, inviter_id: USER_ID, invitee_id: groupB });
      participantRepo.add(event.id, 302, 'accepted', 'attendee', groupB);

      for (const ctx of [
        makeCtx({ participantRepo }),
        makeCtx({ participantRepo, isGroup: true, groupChatId: groupB, chatId: groupB }),
      ]) {
        const output = handleGetInvitationStatus(ctx, { event_id: event.id }).output ?? '';
        expect(output).toContain('302');
        expect(output).not.toContain('301');
      }
    });

    test('an answer given on an image without origins is not reported in the group recorded before it', async () => {
      const participantRepo = new ParticipantRepository(db);
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'Group Event',
        start_at: futureStartAt(),
        timezone: 'UTC',
      });
      const groupB = -1007777;
      invitationRepo.create({ event_id: event.id, inviter_id: USER_ID, invitee_id: GROUP_CHAT_ID });
      invitationRepo.create({ event_id: event.id, inviter_id: USER_ID, invitee_id: groupB });
      participantRepo.add(event.id, 301, 'accepted', 'attendee', GROUP_CHAT_ID);
      ageAnswers(db, event.id);
      // Rolled back to an image from before migration 064, member 301 answers on group B's card.
      answerAsPre064Image(db, event.id, 301, 'declined');

      for (const groupChatId of [GROUP_CHAT_ID, groupB]) {
        const ctx = makeCtx({ participantRepo, isGroup: true, groupChatId, chatId: groupChatId });
        expect(handleGetInvitationStatus(ctx, { event_id: event.id }).output).not.toContain('301');
      }
    });

    test('group invitation with no responses yet notes per-member RSVP, not a stale pending line', async () => {
      const participantRepo = new ParticipantRepository(db);
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'Empty Group',
        start_at: futureStartAt(),
        timezone: 'UTC',
      });
      invitationRepo.create({ event_id: event.id, inviter_id: USER_ID, invitee_id: GROUP_CHAT_ID });
      const ctx = makeCtx({ participantRepo });
      const result = handleGetInvitationStatus(ctx, { event_id: event.id });
      expect(result.success).toBe(true);
      expect(result.output).toContain('no member RSVPs yet');
      expect(result.output).not.toContain(`invitee: ${GROUP_CHAT_ID}`);
    });

    test('a personal invitee with a participant row is not double-listed as a group member', async () => {
      const participantRepo = new ParticipantRepository(db);
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'Mixed Group',
        start_at: futureStartAt(),
        timezone: 'UTC',
      });
      // Personal accepted invite (also creates an event_participants row for OTHER_USER_ID).
      const personalInv = invitationRepo.create({ event_id: event.id, inviter_id: USER_ID, invitee_id: OTHER_USER_ID });
      invitationRepo.updateStatus(personalInv.id, 'accepted', 'pending');
      participantRepo.add(event.id, OTHER_USER_ID, 'accepted');
      // Group invite + a distinct group member.
      invitationRepo.create({ event_id: event.id, inviter_id: USER_ID, invitee_id: GROUP_CHAT_ID });
      participantRepo.add(event.id, 303, 'accepted');
      const ctx = makeCtx({ participantRepo });
      const result = handleGetInvitationStatus(ctx, { event_id: event.id });
      expect(result.success).toBe(true);
      // The distinct group member appears under the group breakdown.
      expect(result.output).toContain('303');
      // The personal invitee appears exactly once (its own invitee line), never also as a group member.
      const occurrences = result.output!.split(String(OTHER_USER_ID)).length - 1;
      expect(occurrences).toBe(1);
    });

    test('an accept-then-decline personal invitee is not mislabeled as a group member', async () => {
      const participantRepo = new ParticipantRepository(db);
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'Dual Event',
        start_at: futureStartAt(),
        timezone: 'UTC',
      });
      // Personal invite that was accepted and then declined: its invitation row ends as 'declined',
      // so it is no longer in the accepted/pending sets, but the participant row remains.
      const personalInv = invitationRepo.create({ event_id: event.id, inviter_id: USER_ID, invitee_id: OTHER_USER_ID });
      invitationRepo.updateStatus(personalInv.id, 'accepted', 'pending');
      invitationRepo.updateStatus(personalInv.id, 'declined', 'accepted');
      participantRepo.add(event.id, OTHER_USER_ID, 'declined');
      // Group invite + a distinct genuine group member.
      invitationRepo.create({ event_id: event.id, inviter_id: USER_ID, invitee_id: GROUP_CHAT_ID });
      participantRepo.add(event.id, 304, 'accepted');
      const ctx = makeCtx({ participantRepo });
      const result = handleGetInvitationStatus(ctx, { event_id: event.id });
      expect(result.success).toBe(true);
      // The genuine group member is still shown.
      expect(result.output).toContain('member: 304');
      // The declined personal invitee must NOT appear as a group member.
      expect(result.output).not.toContain(`member: ${OTHER_USER_ID}`);
    });

    test('#105: a declined-personal invitee who RSVPd going via the group appears once, going, counted', async () => {
      const participantRepo = new ParticipantRepository(db);
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'Reunion',
        start_at: futureStartAt(),
        timezone: 'UTC',
      });
      // Personal invite that the user DECLINED.
      const personalInv = invitationRepo.create({ event_id: event.id, inviter_id: USER_ID, invitee_id: OTHER_USER_ID });
      invitationRepo.updateStatus(personalInv.id, 'declined', 'pending');
      // ...then they RSVP'd "going" via the GROUP invite → participant row = accepted (source of truth).
      invitationRepo.create({ event_id: event.id, inviter_id: USER_ID, invitee_id: GROUP_CHAT_ID });
      participantRepo.add(event.id, OTHER_USER_ID, 'accepted');
      const ctx = makeCtx({ participantRepo });
      const result = handleGetInvitationStatus(ctx, { event_id: event.id });
      expect(result.success).toBe(true);
      // Appears EXACTLY once across the whole output (no vanish, no double-list).
      const occurrences = result.output!.split(String(OTHER_USER_ID)).length - 1;
      expect(occurrences).toBe(1);
      // Authoritative status is the participant row (accepted/going), annotated with the contradicting invite.
      expect(result.output).toContain('status: accepted');
      expect(result.output).toContain('(personal invite: declined)');
      // Not duplicated as a bare group member line.
      expect(result.output).not.toContain(`member: ${OTHER_USER_ID}`);
      // Counted in the attending total (computed in code, not parsed from prose).
      expect(result.output).toContain('attending (going): 1');
    });

    test('#104 (B-narrow): an accept-then-decline personal invitee shows as declined, not going', async () => {
      const participantRepo = new ParticipantRepository(db);
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'Standup',
        start_at: futureStartAt(),
        timezone: 'UTC',
      });
      const personalInv = invitationRepo.create({ event_id: event.id, inviter_id: USER_ID, invitee_id: OTHER_USER_ID });
      invitationRepo.updateStatus(personalInv.id, 'accepted', 'pending');
      invitationRepo.updateStatus(personalInv.id, 'declined', 'accepted');
      participantRepo.add(event.id, OTHER_USER_ID, 'declined');
      invitationRepo.create({ event_id: event.id, inviter_id: USER_ID, invitee_id: GROUP_CHAT_ID });
      const ctx = makeCtx({ participantRepo });
      const result = handleGetInvitationStatus(ctx, { event_id: event.id });
      expect(result.success).toBe(true);
      // The authoritative participant status (declined) is what's shown — no phantom "going".
      expect(result.output).toContain('status: declined');
      // Invite status equals participant status here, so there is no contradicting annotation.
      expect(result.output).not.toContain('(personal invite:');
      // Not counted as attending.
      expect(result.output).toContain('attending (going): 0');
    });

    test('#110 (B-narrow): a user with both a personal invite and a participant row is counted once', async () => {
      const participantRepo = new ParticipantRepository(db);
      const distinctMember = 308;
      userRepo.create({ telegram_id: distinctMember, timezone: 'UTC' });
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'Workshop',
        start_at: futureStartAt(),
        timezone: 'UTC',
      });
      // OTHER accepted a personal invite AND has a participant row (also in the group).
      const personalInv = invitationRepo.create({ event_id: event.id, inviter_id: USER_ID, invitee_id: OTHER_USER_ID });
      invitationRepo.updateStatus(personalInv.id, 'accepted', 'pending');
      participantRepo.add(event.id, OTHER_USER_ID, 'accepted');
      // Group invite + a distinct genuine group member who is going.
      invitationRepo.create({ event_id: event.id, inviter_id: USER_ID, invitee_id: GROUP_CHAT_ID });
      participantRepo.add(event.id, distinctMember, 'accepted');
      const ctx = makeCtx({ participantRepo });
      const result = handleGetInvitationStatus(ctx, { event_id: event.id });
      expect(result.success).toBe(true);
      // OTHER appears exactly once (not double-counted across personal + group sections).
      const occurrences = result.output!.split(String(OTHER_USER_ID)).length - 1;
      expect(occurrences).toBe(1);
      // Two distinct attendees, not three.
      expect(result.output).toContain('attending (going): 2');
      expect(result.output).toContain(`member: ${distinctMember}`);
    });

    test('group invitation degrades safely when the participant repository is absent', async () => {
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'No Registry',
        start_at: futureStartAt(),
        timezone: 'UTC',
      });
      // A group invite exists, but the context has no participant repository injected.
      invitationRepo.create({ event_id: event.id, inviter_id: USER_ID, invitee_id: GROUP_CHAT_ID });
      const ctx = makeCtx();
      expect(ctx.participantRepo).toBeUndefined();
      const result = handleGetInvitationStatus(ctx, { event_id: event.id });
      // No throw, sensible degraded output, and no stale group-chat invitee/member lines.
      expect(result.success).toBe(true);
      expect(result.output).toContain('participant registry unavailable');
      expect(result.output).not.toContain(`invitee: ${GROUP_CHAT_ID}`);
      expect(result.output).not.toContain('member:');
    });

    test('P1-bug1: re-invited user with stale declined participant row shows as pending', async () => {
      const participantRepo = new ParticipantRepository(db);
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'Reinvite Event',
        start_at: futureStartAt(),
        timezone: 'UTC',
      });
      // Invitation is currently pending (re-invite), but there is a stale participant row
      // with status 'declined' from a prior RSVP cycle.
      invitationRepo.create({ event_id: event.id, inviter_id: USER_ID, invitee_id: OTHER_USER_ID });
      participantRepo.add(event.id, OTHER_USER_ID, 'declined');
      const ctx = makeCtx({ participantRepo });
      const result = handleGetInvitationStatus(ctx, { event_id: event.id });
      expect(result.success).toBe(true);
      // Pending invitation wins over stale participant row.
      expect(result.output).toContain('status: pending');
      expect(result.output).not.toContain('status: declined');
      // No misleading "(personal invite: pending)" note while the invite itself is the primary.
      expect(result.output).not.toContain('(personal invite:');
      // pending is not "going"
      expect(result.output).toContain('attending (going): 0');
    });

    test('P1-bug2: maybe RSVP is not counted in attending (going)', async () => {
      const participantRepo = new ParticipantRepository(db);
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'Maybe Event',
        start_at: futureStartAt(),
        timezone: 'UTC',
      });
      invitationRepo.create({ event_id: event.id, inviter_id: USER_ID, invitee_id: GROUP_CHAT_ID });
      participantRepo.add(event.id, OTHER_USER_ID, 'maybe');
      const ctx = makeCtx({ participantRepo });
      const result = handleGetInvitationStatus(ctx, { event_id: event.id });
      expect(result.success).toBe(true);
      expect(result.output).toContain('maybe');
      // maybe is tentative, not "going"
      expect(result.output).toContain('attending (going): 0');
      expect(result.output).not.toContain('attending (going): 1');
    });

    test('P1-review: pending personal invite does not mask a confirmed group RSVP (accepted participant row wins)', async () => {
      const participantRepo = new ParticipantRepository(db);
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'Dual Channel Event',
        start_at: futureStartAt(),
        timezone: 'UTC',
      });
      // Pending personal invite + group invite where the user accepted via group.
      invitationRepo.create({ event_id: event.id, inviter_id: USER_ID, invitee_id: OTHER_USER_ID });
      invitationRepo.create({ event_id: event.id, inviter_id: USER_ID, invitee_id: GROUP_CHAT_ID });
      participantRepo.add(event.id, OTHER_USER_ID, 'accepted');
      const ctx = makeCtx({ participantRepo });
      const result = handleGetInvitationStatus(ctx, { event_id: event.id });
      expect(result.success).toBe(true);
      // The positive group RSVP is authoritative — must not be masked by the pending personal invite.
      expect(result.output).toContain('status: accepted');
      expect(result.output).not.toContain('status: pending');
      // Must be counted as attending.
      expect(result.output).toContain('attending (going): 1');
      // No spurious note about a pending invite when the confirmed RSVP is primary.
      expect(result.output).not.toContain('(personal invite:');
    });

    test('P1-bug-b: group section omits "no RSVPs yet" when all group respondents are deduped to personal section', async () => {
      const participantRepo = new ParticipantRepository(db);
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'Dedup Event',
        start_at: futureStartAt(),
        timezone: 'UTC',
      });
      // OTHER_USER_ID has a personal invite (accepted) AND a group RSVP row.
      const personalInv = invitationRepo.create({ event_id: event.id, inviter_id: USER_ID, invitee_id: OTHER_USER_ID });
      invitationRepo.updateStatus(personalInv.id, 'accepted', 'pending');
      invitationRepo.create({ event_id: event.id, inviter_id: USER_ID, invitee_id: GROUP_CHAT_ID });
      participantRepo.add(event.id, OTHER_USER_ID, 'accepted');
      const ctx = makeCtx({ participantRepo });
      const result = handleGetInvitationStatus(ctx, { event_id: event.id });
      expect(result.success).toBe(true);
      // OTHER_USER_ID RSVP'd — the "no member RSVPs yet" message must not appear.
      expect(result.output).not.toContain('no member RSVPs yet');
      // The user is still listed once in the personal section.
      expect(result.output).toContain(`${OTHER_USER_ID}`);
      expect(result.output).toContain('attending (going): 1');
    });

    test('P1-fix1: personal invitation with status maybe is shown but not counted as going', async () => {
      const participantRepo = new ParticipantRepository(db);
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'Tentative Party',
        start_at: futureStartAt(),
        timezone: 'UTC',
      });
      // Personal invite accepted as 'maybe' (tentative) — no participant row.
      const inv = invitationRepo.create({ event_id: event.id, inviter_id: USER_ID, invitee_id: OTHER_USER_ID });
      invitationRepo.updateStatus(inv.id, 'maybe', 'pending');
      const ctx = makeCtx({ participantRepo });
      const result = handleGetInvitationStatus(ctx, { event_id: event.id });
      expect(result.success).toBe(true);
      // Status appears as maybe, not as going.
      expect(result.output).toContain('status: maybe');
      // maybe is tentative — must not be included in the attending count.
      expect(result.output).toContain('attending (going): 0');
      expect(result.output).not.toContain('attending (going): 1');
    });

    test('P1-fix2: pending invitation does not override a positive (maybe) participant row', async () => {
      const participantRepo = new ParticipantRepository(db);
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'Maybe Wins Event',
        start_at: futureStartAt(),
        timezone: 'UTC',
      });
      // Pending personal invitation exists, but the participant row carries a confirmed
      // tentative signal (maybe) from a prior group RSVP cycle. The positive participant
      // status must win over the pending invitation — not be masked by it.
      invitationRepo.create({ event_id: event.id, inviter_id: USER_ID, invitee_id: OTHER_USER_ID });
      participantRepo.add(event.id, OTHER_USER_ID, 'maybe');
      const ctx = makeCtx({ participantRepo });
      const result = handleGetInvitationStatus(ctx, { event_id: event.id });
      expect(result.success).toBe(true);
      // The positive participant row (maybe) is authoritative — pending invitation must not override it.
      expect(result.output).toContain('status: maybe');
      expect(result.output).not.toContain('status: pending');
      // No spurious annotation when the invitation is still pending (not a final negative response).
      expect(result.output).not.toContain('(personal invite:');
      // maybe is tentative, not going.
      expect(result.output).toContain('attending (going): 0');
    });

    test('P1-bug3: degraded mode with personal accepted invite does not render misleading attending count', async () => {
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'Degraded Count Event',
        start_at: futureStartAt(),
        timezone: 'UTC',
      });
      // Personal invite is accepted — would show attending: 1 incorrectly (misses group RSVPs).
      const personalInv = invitationRepo.create({ event_id: event.id, inviter_id: USER_ID, invitee_id: OTHER_USER_ID });
      invitationRepo.updateStatus(personalInv.id, 'accepted', 'pending');
      // Group invite exists but no participantRepo → degraded mode.
      invitationRepo.create({ event_id: event.id, inviter_id: USER_ID, invitee_id: GROUP_CHAT_ID });
      const ctx = makeCtx(); // no participantRepo
      expect(ctx.participantRepo).toBeUndefined();
      const result = handleGetInvitationStatus(ctx, { event_id: event.id });
      expect(result.success).toBe(true);
      // Attending line must be suppressed when group RSVPs are invisible.
      expect(result.output).not.toContain('attending (going):');
      // The unavailability notice must still be present.
      expect(result.output).toContain('participant registry unavailable');
    });

    test('returns mixed pending and accepted', async () => {
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

    // The prompt answers "who takes part" only from this tool, so invitees must be able to call it
    // on the owner's event; people outside the invitation must not.
    describe('invitee access', () => {
      const THIRD_USER_ID = 300;
      const STRANGER_ID = 400;
      let participantRepo: ParticipantRepository;
      let groupMemberRepo: GroupMemberRepository;
      let invitations: InvitationService;

      function ctxFor(userId: number, groupChatId?: number): AgentContext {
        return makeCtx({
          user: userRepo.findByTelegramId(userId)!,
          chatId: groupChatId ?? userId,
          isGroup: groupChatId !== undefined,
          groupChatId,
          participantRepo,
          group: {
            groupMemberRepo,
            checkGroupMembership: () => Promise.resolve(false),
            groupChatRepo: new GroupChatRepository(db),
            groupMemberService: new GroupMemberService(groupMemberRepo, userRepo),
          },
        });
      }

      function rosterLines(output: string): string[] {
        return output.split('\n').filter((line) => line.startsWith('invitee: ') || line.startsWith('attending'));
      }

      function createDinner() {
        const event = eventService.createEvent({
          user_id: USER_ID,
          title: 'Team Dinner',
          description: 'owner-only note',
          start_at: futureStartAt(),
          timezone: 'UTC',
        });
        const accepted = invitations.sendInvitation(event.id, USER_ID, OTHER_USER_ID).invitation!;
        invitations.acceptInvitation(accepted.id, OTHER_USER_ID);
        const pending = invitations.sendInvitation(event.id, USER_ID, THIRD_USER_ID).invitation!;
        return { event, pending };
      }

      beforeEach(() => {
        participantRepo = new ParticipantRepository(db);
        groupMemberRepo = new GroupMemberRepository(db);
        invitations = new InvitationService(invitationRepo, eventRepo, sharingSettingsRepo, participantRepo);
        userRepo.create({ telegram_id: THIRD_USER_ID, timezone: 'UTC' });
        userRepo.create({ telegram_id: STRANGER_ID, timezone: 'UTC' });
      });

      test('accepted invitee sees the roster the owner sees, plus who organizes it', () => {
        const { event } = createDinner();
        const owner = handleGetInvitationStatus(ctxFor(USER_ID), { event_id: event.id });
        const invitee = handleGetInvitationStatus(ctxFor(OTHER_USER_ID), { event_id: event.id });

        expect(owner.success).toBe(true);
        expect(rosterLines(owner.output!)).toEqual([
          'attending (going): 1',
          `invitee: ${OTHER_USER_ID}, status: accepted`,
          `invitee: ${THIRD_USER_ID}, status: pending`,
        ]);
        expect(owner.output).not.toContain('organizer');

        expect(invitee.success).toBe(true);
        expect(invitee.output).toContain('Team Dinner');
        expect(rosterLines(invitee.output!)).toEqual(
          rosterLines(owner.output!).map((line) => line.replace(`invitee: ${OTHER_USER_ID},`, 'invitee: you,')),
        );
        expect(invitee.output).toContain(`organizer: ${USER_ID}`);
        expect(invitee.output).not.toContain('owner-only note');
      });

      test('pending invitee and current members of an invited group can see the roster', () => {
        const { event } = createDinner();
        invitationRepo.create({ event_id: event.id, inviter_id: USER_ID, invitee_id: GROUP_CHAT_ID });
        groupMemberRepo.upsert(GROUP_CHAT_ID, STRANGER_ID);

        expect(handleGetInvitationStatus(ctxFor(THIRD_USER_ID), { event_id: event.id }).success).toBe(true);
        // Invited through the group before answering, like a pending personal invitee.
        expect(handleGetInvitationStatus(ctxFor(STRANGER_ID), { event_id: event.id }).success).toBe(true);
        invitations.recordGroupAttendance(event.id, STRANGER_ID, 'accepted', GROUP_CHAT_ID);
        const member = handleGetInvitationStatus(ctxFor(STRANGER_ID), { event_id: event.id });
        expect(member.success).toBe(true);
        expect(member.output).toContain('member: you, status: accepted');

        // Leaving the group ends access even though the RSVP row stays behind.
        groupMemberRepo.leave(GROUP_CHAT_ID, STRANGER_ID);
        expect(handleGetInvitationStatus(ctxFor(STRANGER_ID), { event_id: event.id }).success).toBe(false);
      });

      test('stranger without an invitation is rejected', () => {
        const { event } = createDinner();
        const result = handleGetInvitationStatus(ctxFor(STRANGER_ID), { event_id: event.id });
        expect(result.success).toBe(false);
        expect(result.error).toContain('not found');
        expect(result.output).toBeUndefined();
      });

      test('an invitee asking in a group chat gets the roster only in a chat the owner invited', () => {
        const { event } = createDinner();
        const OTHER_GROUP_CHAT_ID = -1008888;
        // Refused for the chat, not for the person: the model must not tell an invitee they are not invited.
        const elsewhere = handleGetInvitationStatus(ctxFor(OTHER_USER_ID, OTHER_GROUP_CHAT_ID), { event_id: event.id });
        expect(elsewhere.success).toBe(false);
        expect(elsewhere.error).toBe(
          `Event ${event.id}: its roster can only be read in a private chat or in a group invited to it.`,
        );
        expect(elsewhere.output).toBeUndefined();
        const stranger = handleGetInvitationStatus(ctxFor(STRANGER_ID, OTHER_GROUP_CHAT_ID), { event_id: event.id });
        expect(stranger.error).toContain('not found');

        invitationRepo.create({ event_id: event.id, inviter_id: USER_ID, invitee_id: GROUP_CHAT_ID });
        expect(handleGetInvitationStatus(ctxFor(OTHER_USER_ID, GROUP_CHAT_ID), { event_id: event.id }).success).toBe(
          true,
        );
      });

      test('cancelled invitee is rejected even with a leftover RSVP row; declined invitee is still admitted', () => {
        const { event, pending } = createDinner();
        // OTHER accepted (participant row "accepted"), then the owner withdrew the invitation. OTHER is
        // not in the group invited to the same event, so that leftover row must not readmit them.
        invitationRepo.create({ event_id: event.id, inviter_id: USER_ID, invitee_id: GROUP_CHAT_ID });
        const accepted = invitationRepo.findActiveByEventAndInvitee(event.id, OTHER_USER_ID)!;
        expect(invitations.cancelInvitation(accepted.id, USER_ID).success).toBe(true);
        const cancelled = handleGetInvitationStatus(ctxFor(OTHER_USER_ID), { event_id: event.id });
        expect(cancelled.success).toBe(false);
        expect(cancelled.error).toContain('not found');

        // Same rule as propose_edit: a declined invitee was invited and keeps read access.
        invitations.declineInvitation(pending.id, THIRD_USER_ID);
        const declined = handleGetInvitationStatus(ctxFor(THIRD_USER_ID), { event_id: event.id });
        expect(declined.success).toBe(true);
        expect(declined.output).toContain(`organizer: ${USER_ID}`);
      });

      test('an invitee reads group answers from live groups only, never answers of unknown origin', () => {
        const { event } = createDinner();
        const WITHDRAWN_GROUP_CHAT_ID = -1008888;
        invitationRepo.create({ event_id: event.id, inviter_id: USER_ID, invitee_id: GROUP_CHAT_ID });
        const withdrawn = invitationRepo.create({
          event_id: event.id,
          inviter_id: USER_ID,
          invitee_id: WITHDRAWN_GROUP_CHAT_ID,
        });
        invitationRepo.updateStatus(withdrawn.id, 'cancelled', 'pending');
        participantRepo.add(event.id, 501, 'accepted', 'attendee', GROUP_CHAT_ID);
        participantRepo.add(event.id, 502, 'accepted', 'attendee', WITHDRAWN_GROUP_CHAT_ID);
        // An answer recorded before migration 064: its group is unknown.
        addAsPre064Image(db, event.id, 503, 'accepted');

        const invitee = handleGetInvitationStatus(ctxFor(THIRD_USER_ID), { event_id: event.id }).output ?? '';
        // A personal answer (no group origin either) stays in the invitee section.
        expect(invitee).toContain(`invitee: ${OTHER_USER_ID}, status: accepted`);
        expect(invitee).toContain('member: 501, status: accepted');
        expect(invitee).not.toContain('502');
        expect(invitee).not.toContain('503');
        // The organizer's own view in a private chat keeps every answer of unknown origin.
        expect(handleGetInvitationStatus(ctxFor(USER_ID), { event_id: event.id }).output).toContain('member: 503');
      });
    });
  });

  // ── privacy settings via manage_settings ──

  describe('manage_settings privacy category', () => {
    test('returns error when sharingSettingsRepo is missing', async () => {
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

    test('returns error when no settings provided', async () => {
      const ctx = makeCtx();
      const result = handleManageSettings(ctx, {
        action: 'update',
        category: 'privacy',
        updates: {},
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('updates');
    });

    test('updates default_visibility', async () => {
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

    test('updates inline_mode_enabled as integer', async () => {
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

    test('updates allow_invitations as integer', async () => {
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

    test('updates multiple settings at once', async () => {
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
    test('returns error when sharingService is missing', async () => {
      const ctx = makeCtx({ sharing: undefined });
      const result = handleShareAgenda(ctx, { period: 'today', target_type: 'user', target_id: OTHER_USER_ID });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Sharing is not configured.');
    });

    test('returns error when sharedEventRepo is missing', async () => {
      const ctx = makeCtx({ sharing: undefined });
      const result = handleShareAgenda(ctx, { period: 'today', target_type: 'user', target_id: OTHER_USER_ID });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Sharing is not configured.');
    });

    test('returns no events when agenda is empty', async () => {
      const ctx = makeCtx();
      const result = handleShareAgenda(ctx, { period: 'today', target_type: 'user', target_id: OTHER_USER_ID });
      expect(result.success).toBe(true);
      expect(result.output).toContain('No visible events');
    });

    test('returns no events when all events are explicitly private', async () => {
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

    test('shares today agenda with visible events', async () => {
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

    test('shares tomorrow agenda', async () => {
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

    test('shares week agenda across multiple days', async () => {
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

    test('creates shared_event records for each event in agenda', async () => {
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
    test('returns error when sharingSettingsRepo is missing', async () => {
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

    test('returns error when event not found', async () => {
      const ctx = makeCtx();
      const result = handleSetEventVisibility(ctx, { event_id: 9999, visibility: 'full' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('9999');
      expect(result.error).toContain('not found');
    });

    test('returns error when event belongs to another user', async () => {
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

    test('sets visibility to full', async () => {
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

    test('sets visibility to free_busy', async () => {
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

    test('sets visibility to private', async () => {
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

    test('output includes event id', async () => {
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
    test('returns error when editProposalRepo is missing', async () => {
      const ctx = makeCtx({
        sharing: {
          sharedEventRepo,
          invitationRepo,
          invitationService,
          sharingSettingsRepo,
          sharingService,
          privacyService,
          editProposalRepo: undefined as never,
        },
      });
      const result = await handleProposeEdit(ctx, { event_id: 1, changes: { title: 'New' } });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not configured');
    });

    test('returns error when caller has no invitation and is not the owner', async () => {
      const editProposalRepo = new EditProposalRepository(db);
      const event = eventService.createEvent({
        user_id: OTHER_USER_ID,
        title: 'Not My Event',
        start_at: '2026-03-20T10:00:00Z',
        timezone: 'UTC',
      });

      const ctx = makeCtx({
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
      const result = await handleProposeEdit(ctx, { event_id: event.id, changes: { title: 'Change' } });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not invited');
    });

    // Regression: group RSVP creates an event_participants row, but that must NOT grant
    // propose_edit access. Only a personal invitation (invitations table) or ownership does.
    test('group RSVP member without personal invitation is denied', async () => {
      const participantRepo = new ParticipantRepository(db);
      const editProposalRepo = new EditProposalRepository(db);
      const event = eventService.createEvent({
        user_id: OTHER_USER_ID,
        title: 'Group Event',
        start_at: '2026-03-20T10:00:00Z',
        timezone: 'UTC',
      });
      // Simulate group RSVP: participant row exists for USER_ID, but no invitation row.
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
      const result = await handleProposeEdit(ctx, { event_id: event.id, changes: { title: 'Change' } });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not invited');
    });

    test('personal invitee can propose edit', async () => {
      const editProposalRepo = new EditProposalRepository(db);
      const event = eventService.createEvent({
        user_id: OTHER_USER_ID,
        title: 'Shared Event',
        start_at: '2026-03-20T10:00:00Z',
        timezone: 'UTC',
      });
      invitationRepo.create({ event_id: event.id, inviter_id: OTHER_USER_ID, invitee_id: USER_ID });

      const ctx = makeCtx({
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
      const result = await handleProposeEdit(ctx, {
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

    test('declined personal invitee can still propose edit', async () => {
      const editProposalRepo = new EditProposalRepository(db);
      const event = eventService.createEvent({
        user_id: OTHER_USER_ID,
        title: 'Declined But Can Propose',
        start_at: '2026-03-20T10:00:00Z',
        timezone: 'UTC',
      });
      const inv = invitationRepo.create({ event_id: event.id, inviter_id: OTHER_USER_ID, invitee_id: USER_ID });
      invitationRepo.updateStatus(inv.id, 'declined', 'pending');

      const ctx = makeCtx({
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
      const result = await handleProposeEdit(ctx, { event_id: event.id, changes: { title: 'Actually Let Me In' } });
      expect(result.success).toBe(true);
      expect(result.output).toContain('proposal submitted');
    });

    // A declined invitation survives the event's delete (#505); it must not let the invitee, or the
    // owner, file a proposal against the deleted event and ping the owner about it.
    for (const caller of ['declined invitee', 'owner'] as const) {
      test(`${caller} cannot propose an edit to a deleted event`, async () => {
        const editProposalRepo = new EditProposalRepository(db);
        const event = eventService.createEvent({
          user_id: OTHER_USER_ID,
          title: 'Deleted Later',
          start_at: '2026-03-20T10:00:00Z',
          timezone: 'UTC',
        });
        const inv = invitationRepo.create({ event_id: event.id, inviter_id: OTHER_USER_ID, invitee_id: USER_ID });
        invitationRepo.updateStatus(inv.id, 'declined', 'pending');
        expect(eventService.deleteEvent(event.id, OTHER_USER_ID)).toBe(true);
        expect(invitationRepo.findActiveOrRespondedByEventAndInvitee(event.id, USER_ID)?.status).toBe('declined');

        const notified: number[] = [];
        const ctx = makeCtx({
          ...(caller === 'owner' ? { user: userRepo.findByTelegramId(OTHER_USER_ID)! } : {}),
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
            sendEditProposal: async (ownerId) => {
              notified.push(ownerId);
              return { message_id: 42 };
            },
          },
        });
        const result = await handleProposeEdit(ctx, { event_id: event.id, changes: { title: 'Revive It' } });
        expect(result.success).toBe(false);
        expect(result.error).toContain('not found');
        expect(editProposalRepo.getPendingForEvent(event.id)).toHaveLength(0);
        expect(notified).toEqual([]);
      });
    }

    test('cancelled invitation does not grant propose_edit access', async () => {
      const editProposalRepo = new EditProposalRepository(db);
      const event = eventService.createEvent({
        user_id: OTHER_USER_ID,
        title: 'Cancelled Invite Event',
        start_at: '2026-03-20T10:00:00Z',
        timezone: 'UTC',
      });
      const inv = invitationRepo.create({ event_id: event.id, inviter_id: OTHER_USER_ID, invitee_id: USER_ID });
      invitationRepo.updateStatus(inv.id, 'cancelled', 'pending');

      const ctx = makeCtx({
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
      const result = await handleProposeEdit(ctx, { event_id: event.id, changes: { title: 'Sneaky Edit' } });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not invited');
    });

    // Regression: a newer cancelled row must supersede an older responded row.
    // Without fetching the latest row first, the old declined row would still grant access.
    test('re-invited-then-cancelled invitation does not grant propose_edit access', async () => {
      const editProposalRepo = new EditProposalRepository(db);
      const event = eventService.createEvent({
        user_id: OTHER_USER_ID,
        title: 'Re-invite Then Cancel',
        start_at: '2026-03-20T10:00:00Z',
        timezone: 'UTC',
      });
      // First invitation: user declined.
      const first = invitationRepo.create({ event_id: event.id, inviter_id: OTHER_USER_ID, invitee_id: USER_ID });
      invitationRepo.updateStatus(first.id, 'declined', 'pending');
      // Second invitation (re-invite, 1 second later so created_at differs): inviter then cancels.
      // Insert directly to control created_at and avoid the UNIQUE(event_id, invitee_id, created_at) collision.
      const { lastInsertRowid } = db
        .prepare(
          `INSERT INTO invitations (event_id, inviter_id, invitee_id, status, created_at, updated_at)
           VALUES (?, ?, ?, 'pending', datetime('now', '+1 second'), datetime('now', '+1 second'))`,
        )
        .run(event.id, OTHER_USER_ID, USER_ID);
      invitationRepo.updateStatus(Number(lastInsertRowid), 'cancelled', 'pending');

      const ctx = makeCtx({
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
      const result = await handleProposeEdit(ctx, { event_id: event.id, changes: { title: 'Sneaky Re-edit' } });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not invited');
    });

    test('event owner can propose edit without invitation', async () => {
      const editProposalRepo = new EditProposalRepository(db);
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'My Own Event',
        start_at: '2026-03-20T10:00:00Z',
        timezone: 'UTC',
      });

      const ctx = makeCtx({
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
      const result = await handleProposeEdit(ctx, { event_id: event.id, changes: { title: 'Updated Title' } });
      expect(result.success).toBe(true);
      expect(result.output).toContain('proposal submitted');
    });

    test('sends notification to event creator when sender available', async () => {
      const editProposalRepo = new EditProposalRepository(db);
      const event = eventService.createEvent({
        user_id: OTHER_USER_ID,
        title: 'Creator Gets Notified',
        start_at: '2026-03-20T10:00:00Z',
        timezone: 'UTC',
      });
      invitationRepo.create({ event_id: event.id, inviter_id: OTHER_USER_ID, invitee_id: USER_ID });

      let sentTo: number | undefined;
      const ctx = makeCtx({
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

    // The owner's Accept applies the stored changes verbatim, so a place the model claims in a
    // proposal would become a confirmed venue without the owner ever tapping a candidate (#620).
    describe('a proposal never carries a confirmed place (#620)', () => {
      const MODEL_PLACE = {
        resolved_address: 'Far Away 1, Sample City',
        latitude: '10.5',
        longitude: '20.5',
        google_maps_url: 'https://www.google.com/maps/search/?api=1&query=10.5,20.5',
        venue_name: 'Far Away Venue',
      };

      function proposalCtx(editProposalRepo: EditProposalRepository, notices: string[]) {
        return makeCtx({
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
            sendEditProposal: async (_ownerId, text) => {
              notices.push(text);
              return { message_id: 42 };
            },
          },
        });
      }

      function ownerEvent(): number {
        const event = eventService.createEvent({
          user_id: OTHER_USER_ID,
          title: 'Shared Place',
          start_at: '2026-03-20T10:00:00Z',
          timezone: 'UTC',
        });
        invitationRepo.create({ event_id: event.id, inviter_id: OTHER_USER_ID, invitee_id: USER_ID });
        return event.id;
      }

      for (const verified of ['true', '1']) {
        test(`location_verified "${verified}" and a made-up place are dropped from the proposal`, async () => {
          const editProposalRepo = new EditProposalRepository(db);
          const notices: string[] = [];
          const eventId = ownerEvent();
          const result = await handleProposeEdit(proposalCtx(editProposalRepo, notices), {
            event_id: eventId,
            changes: { location: 'Cafe Prague', location_verified: verified, ...MODEL_PLACE },
          });

          expect(result.success).toBe(true);
          const [pending] = editProposalRepo.getPendingForEvent(eventId);
          expect(JSON.parse(pending?.changes ?? 'null')).toEqual({ location: 'Cafe Prague' });
          expect(notices).toHaveLength(1);
          expect(notices[0]).toContain('location: Cafe Prague');
          expect(notices[0]).not.toContain('Far Away');
          expect(notices[0]).not.toContain('location_verified');
        });
      }

      test('a proposal of nothing but a claimed place is refused and the owner is not pinged', async () => {
        const editProposalRepo = new EditProposalRepository(db);
        const notices: string[] = [];
        const eventId = ownerEvent();
        const result = await handleProposeEdit(proposalCtx(editProposalRepo, notices), {
          event_id: eventId,
          changes: { location_verified: 'true', ...MODEL_PLACE },
        });

        expect(result.success).toBe(false);
        expect(result.mutationState).toBe('not_applied');
        expect(editProposalRepo.getPendingForEvent(eventId)).toEqual([]);
        expect(notices).toEqual([]);
      });
    });
  });
});
