// sharing tool handlers: share_event and send_invitation.
import { beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { executeTool } from '../../../../src/services/ai/tool-executor.ts';
import { handleSendInvitation, handleShareEvent } from '../../../../src/services/ai/tool-handlers/sharing.ts';
import type { TelegramSender } from '../../../../src/services/ai/types.ts';
import { flushPromises } from '../../../helpers/mock-context.ts';
import {
  createSharingFixture,
  futureStartAt,
  GROUP_CHAT_ID,
  OTHER_USER_ID,
  type SharingFixture,
  USER_ID,
} from './sharing-fixtures.ts';

describe('sharing tool handlers', () => {
  let db: SharingFixture['db'];
  let userRepo: SharingFixture['userRepo'];
  let eventService: SharingFixture['eventService'];
  let sharedEventRepo: SharingFixture['sharedEventRepo'];
  let invitationRepo: SharingFixture['invitationRepo'];
  let sharingSettingsRepo: SharingFixture['sharingSettingsRepo'];
  let invitationService: SharingFixture['invitationService'];
  let sharingService: SharingFixture['sharingService'];
  let privacyService: SharingFixture['privacyService'];
  let deepLinkService: SharingFixture['deepLinkService'];
  let makeCtx: SharingFixture['makeCtx'];

  beforeEach(() => {
    ({
      db,
      userRepo,
      eventService,
      sharedEventRepo,
      invitationRepo,
      sharingSettingsRepo,
      invitationService,
      sharingService,
      privacyService,
      deepLinkService,
      makeCtx,
    } = createSharingFixture());
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

    test("falls back to the inviter's connected account when bot delivery fails", async () => {
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'Session Fallback',
        start_at: futureStartAt(),
        timezone: 'UTC',
      });
      let sessionCalledWith: { inviterId: number; targetId: number; text: string } | undefined;
      const ctx = makeCtx({
        sender: {
          sendMessage: async () => ({ message_id: 1 }),
          editMessageText: async () => {},
          sendInvitation: async () => null,
          sendAsConnectedUser: async (inviterId, targetId, text) => {
            sessionCalledWith = { inviterId, targetId, text };
            return true;
          },
        },
        deepLinkService,
        botUsername: 'TestBot',
      });
      const result = await handleSendInvitation(ctx, { event_id: event.id, invitee_id: OTHER_USER_ID });
      expect(result.success).toBe(true);

      await flushPromises();

      expect(sessionCalledWith).toBeDefined();
      expect(sessionCalledWith!.inviterId).toBe(USER_ID);
      expect(sessionCalledWith!.targetId).toBe(OTHER_USER_ID);
      expect(sessionCalledWith!.text).toContain('t.me/TestBot');
    });

    test("sends deep link to inviter when bot and the inviter's account both fail", async () => {
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
          sendAsConnectedUser: async () => false,
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

    test('sends deep link to inviter when no connected account is available', async () => {
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'No Session',
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

    test('resolves an explicit @username through the local users table', async () => {
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'Resolve Party',
        start_at: '2026-03-20T18:00:00Z',
        timezone: 'UTC',
      });
      userRepo.create({ telegram_id: 300, timezone: 'UTC', username: 'targetuser', first_name: 'Target' });
      const ctx = makeCtx({ messageText: 'Invite @targetuser' });
      const result = await handleSendInvitation(ctx, {
        event_id: event.id,
        invitee_username: 'targetuser',
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('300');
    });

    test('without the service account, an unknown @username opens pick_users without claiming the person is missing, and spawns nothing', async () => {
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'Picker Party',
        start_at: '2026-03-20T18:00:00Z',
        timezone: 'UTC',
      });
      let pickerPrompt = '';
      const spawn = spyOn(Bun, 'spawn');
      const ctx = makeCtx({
        messageText: 'Invite @nobody',
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
      }).finally(() => spawn.mockRestore());
      expect(result.success).toBe(true);
      expect(result.stopLoop).toBe(true);
      expect(pickerPrompt).toContain('@nobody');
      expect(pickerPrompt).not.toMatch(/not found|started/i);
      expect(spawn).not.toHaveBeenCalled();
    });

    describe('with the service account', () => {
      function pickerCapture(): { prompts: string[]; sender: TelegramSender } {
        const prompts: string[] = [];
        return {
          prompts,
          sender: {
            sendMessage: async () => ({ message_id: 1 }),
            editMessageText: async () => {},
            sendUserPicker: async (_chatId: number, prompt: string) => {
              prompts.push(prompt);
              return { message_id: 1 };
            },
          },
        };
      }

      test('an @username unknown to the bot resolves through it, is verified and invited', async () => {
        const event = eventService.createEvent({
          user_id: USER_ID,
          title: 'Resolve Party',
          start_at: futureStartAt(),
          timezone: 'UTC',
        });
        const asked: string[] = [];
        const ctx = makeCtx({
          messageText: 'Invite @TargetUser',
          resolveUsername: async (username) => {
            asked.push(username);
            return { id: 5000000030, firstName: 'Target', username: 'targetuser' };
          },
        });
        const result = await handleSendInvitation(ctx, { event_id: event.id, invitee_username: '@TargetUser' });
        expect(result.success).toBe(true);
        expect(asked).toEqual(['targetuser']);
        expect(ctx.verifiedRecipientIds?.has(5000000030)).toBe(true);
        expect(invitationRepo.findActiveByEventAndInvitee(event.id, 5000000030)).not.toBeNull();
      });

      test('a username Telegram does not know opens the picker saying it is not on Telegram', async () => {
        const event = eventService.createEvent({
          user_id: USER_ID,
          title: 'Picker Party',
          start_at: futureStartAt(),
          timezone: 'UTC',
        });
        const picker = pickerCapture();
        const ctx = makeCtx({
          messageText: 'Invite @nobody',
          resolveUsername: async () => null,
          sender: picker.sender,
        });
        const result = await handleSendInvitation(ctx, { event_id: event.id, invitee_username: 'nobody' });
        expect(result).toMatchObject({ success: true, stopLoop: true });
        expect(picker.prompts).toEqual([expect.stringContaining('@nobody not found on Telegram')]);
        expect(invitationRepo.getByEvent(event.id)).toHaveLength(0);
      });

      test('a lookup that could not run opens the picker without claiming the person is missing', async () => {
        const event = eventService.createEvent({
          user_id: USER_ID,
          title: 'Picker Party',
          start_at: futureStartAt(),
          timezone: 'UTC',
        });
        const picker = pickerCapture();
        const ctx = makeCtx({
          messageText: 'Invite @nobody',
          resolveUsername: async () => {
            throw new Error('synthetic resolve timeout');
          },
          sender: picker.sender,
        });
        const result = await handleSendInvitation(ctx, { event_id: event.id, invitee_username: 'nobody' });
        expect(result).toMatchObject({ success: true, stopLoop: true });
        expect(picker.prompts).toEqual([expect.stringContaining("couldn't look up @nobody")]);
        expect(picker.prompts[0]).not.toMatch(/not found|started|timeout/i);
        expect(invitationRepo.getByEvent(event.id)).toHaveLength(0);
      });
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
      userRepo.create({ telegram_id: 300, timezone: 'UTC', username: 'targetuser', first_name: 'Target' });
      const ctx = makeCtx({ messageText: 'Invite @targetuser' });

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

    test('auto-adds resolved user as contact', async () => {
      const { ContactRepository } = await import('../../../../src/database/repositories/contact.repository.ts');
      const contactRepo = new ContactRepository(db);
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'Contact Party',
        start_at: '2026-03-20T18:00:00Z',
        timezone: 'UTC',
      });
      userRepo.create({ telegram_id: 400, timezone: 'UTC', username: 'resolved_user', first_name: 'Resolved' });
      const ctx = makeCtx({ messageText: 'Invite @resolved_user', contactRepo });
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

    test('reports a failed @username lookup without exposing the internal error', async () => {
      const event = eventService.createEvent({
        user_id: USER_ID,
        title: 'Error Party',
        start_at: '2026-03-20T18:00:00Z',
        timezone: 'UTC',
      });
      const lookup = spyOn(userRepo, 'findByUsername').mockImplementation(() => {
        throw new Error('database is locked');
      });
      const ctx = makeCtx({ messageText: 'Invite @broken' });
      const result = await handleSendInvitation(ctx, {
        event_id: event.id,
        invitee_username: 'broken',
      }).finally(() => lookup.mockRestore());
      expect(result.success).toBe(false);
      expect(result.error).toContain('@broken');
      expect(result.error).not.toContain('database is locked');
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
});
