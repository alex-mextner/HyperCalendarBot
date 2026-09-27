// send_invitation decides deterministically whether to suggest /connect_telegram (#511):
// only when the bot could not reach the invitee, the inviter has no connected account and
// has not dismissed the suggestion recently. The model no longer checks connect_telegram_status.
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { t } from '../../../../src/config/constants.ts';
import { migrations } from '../../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../../src/database/repositories/chat-history.repository.ts';
import { DeepLinkRepository } from '../../../../src/database/repositories/deep-link.repository.ts';
import { EventRepository } from '../../../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../../../src/database/repositories/event-reminder.repository.ts';
import { HolidayRepository } from '../../../../src/database/repositories/holiday.repository.ts';
import { InvitationRepository } from '../../../../src/database/repositories/invitation.repository.ts';
import { SharedEventRepository } from '../../../../src/database/repositories/shared-event.repository.ts';
import { SharingSettingsRepository } from '../../../../src/database/repositories/sharing-settings.repository.ts';
import { TelegramSessionRepository } from '../../../../src/database/repositories/telegram-session.repository.ts';
import { UserRepository } from '../../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../../src/database/schema.ts';
import { handleDismissConnectTelegramPrompt } from '../../../../src/services/ai/tool-handlers/settings.ts';
import { handleSendInvitation } from '../../../../src/services/ai/tool-handlers/sharing.ts';
import type { AgentContext, TelegramSender } from '../../../../src/services/ai/types.ts';
import { EventService } from '../../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../../src/services/holiday/holiday-service.ts';
import { DeepLinkService } from '../../../../src/services/sharing/deep-link-service.ts';
import { InvitationService } from '../../../../src/services/sharing/invitation-service.ts';
import { PrivacyService } from '../../../../src/services/sharing/privacy-service.ts';
import { SharingService } from '../../../../src/services/sharing/sharing-service.ts';

const INVITER_ID = 100;
const INVITEE_ID = 200;
const MASTER_KEY = Buffer.alloc(32, 7);
const DAY_MS = 24 * 60 * 60 * 1000;
const SUGGESTION = t('en').botTips.connect_telegram;

/** Telegram refuses a bot DM to someone who never started the bot; the admin session still reaches them. */
const unreachableByBot: TelegramSender = {
  sendMessage: async () => ({ message_id: 1 }),
  editMessageText: async () => {},
  sendInvitation: async () => null,
  sendAsUser: async () => true,
};

const reachableByBot: TelegramSender = {
  sendMessage: async () => ({ message_id: 1 }),
  editMessageText: async () => {},
  sendInvitation: async () => ({ message_id: 42 }),
};

describe('send_invitation /connect_telegram suggestion', () => {
  let db: Database;
  let userRepo: UserRepository;
  let eventService: EventService;
  let sessionRepo: TelegramSessionRepository;
  let invitationRepo: InvitationRepository;
  let invitationService: InvitationService;
  let eventId: number;

  function makeCtx(overrides: Partial<AgentContext> = {}): AgentContext {
    const sharingSettingsRepo = new SharingSettingsRepository(db);
    const privacyService = new PrivacyService(sharingSettingsRepo);
    return {
      user: userRepo.findByTelegramId(INVITER_ID)!,
      chatId: INVITER_ID,
      messageText: `Invite Telegram ID ${INVITEE_ID}`,
      isGroup: false,
      eventService,
      holidayService: new HolidayService(new HolidayRepository(db)),
      chatHistory: new ChatHistoryRepository(db),
      userRepo,
      eventReminderRepo: new EventReminderRepository(db),
      sharing: {
        sharedEventRepo: new SharedEventRepository(db),
        invitationRepo,
        invitationService,
        sharingSettingsRepo,
        sharingService: new SharingService(
          (userId, startUtc, endUtc) => eventService.getEventsInRange(userId, startUtc, endUtc),
          privacyService,
        ),
        privacyService,
        editProposalRepo: undefined as never,
      },
      sender: unreachableByBot,
      deepLinkService: new DeepLinkService(new DeepLinkRepository(db)),
      botUsername: 'TestBot',
      telegramSessionRepo: sessionRepo,
      telegramMasterKey: MASTER_KEY,
      conversationLogger: null as never,
      ...overrides,
    };
  }

  function mentionsSuggestion(result: { output?: string; agentHint?: string }): boolean {
    return `${result.output ?? ''}\n${result.agentHint ?? ''}`.includes('/connect_telegram');
  }

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, migrations);
    userRepo = new UserRepository(db);
    const eventRepo = new EventRepository(db);
    eventService = new EventService({ eventRepo });
    sessionRepo = new TelegramSessionRepository(db);
    invitationRepo = new InvitationRepository(db);
    invitationService = new InvitationService(invitationRepo, eventRepo, new SharingSettingsRepository(db));
    userRepo.create({ telegram_id: INVITER_ID, timezone: 'UTC', language: 'en' });
    eventId = eventService.createEvent({
      user_id: INVITER_ID,
      title: 'Dinner',
      start_at: new Date(Date.now() + 7 * DAY_MS).toISOString(),
      timezone: 'UTC',
    }).id;
  });

  test('an invitee the bot cannot reach, from an unconnected user, gets the suggestion as the last line', async () => {
    const result = await handleSendInvitation(makeCtx(), { event_id: eventId, invitee_id: INVITEE_ID });
    expect(result.success).toBe(true);
    expect(result.output?.split('\n').at(-1)).toBe(SUGGESTION);
    // The dismissal path lives with the suggestion, not in the system prompt.
    expect(result.agentHint).toContain('dismiss_connect_telegram_prompt');
  });

  test('the suggestion comes back after a dismissal older than 30 days', async () => {
    userRepo.setConnectTelegramDismissedAt(INVITER_ID, new Date(Date.now() - 31 * DAY_MS).toISOString());
    const result = await handleSendInvitation(makeCtx(), { event_id: eventId, invitee_id: INVITEE_ID });
    expect(result.output?.split('\n').at(-1)).toBe(SUGGESTION);
  });

  test('a user with a connected account gets no suggestion', async () => {
    sessionRepo.upsert(INVITER_ID, Buffer.from('session'), '+7 ••• 4567', 'hash');
    const result = await handleSendInvitation(makeCtx(), { event_id: eventId, invitee_id: INVITEE_ID });
    expect(result.success).toBe(true);
    expect(mentionsSuggestion(result)).toBe(false);
  });

  test('a user who dismissed the suggestion recently gets none', async () => {
    userRepo.setConnectTelegramDismissedAt(INVITER_ID, new Date(Date.now() - 5 * DAY_MS).toISOString());
    const result = await handleSendInvitation(makeCtx(), { event_id: eventId, invitee_id: INVITEE_ID });
    expect(result.success).toBe(true);
    expect(mentionsSuggestion(result)).toBe(false);
  });

  test('an invitee who uses the bot gets none', async () => {
    userRepo.create({ telegram_id: INVITEE_ID, timezone: 'UTC' });
    const result = await handleSendInvitation(makeCtx({ sender: reachableByBot }), {
      event_id: eventId,
      invitee_id: INVITEE_ID,
    });
    expect(result.success).toBe(true);
    expect(mentionsSuggestion(result)).toBe(false);
  });

  test('no suggestion when the connect feature is disabled on this deployment', async () => {
    const result = await handleSendInvitation(makeCtx({ telegramMasterKey: undefined }), {
      event_id: eventId,
      invitee_id: INVITEE_ID,
    });
    expect(result.success).toBe(true);
    expect(mentionsSuggestion(result)).toBe(false);
  });

  test('no suggestion in a group chat, where /connect_telegram does not work', async () => {
    const result = await handleSendInvitation(makeCtx({ isGroup: true, groupChatId: -100500 }), {
      event_id: eventId,
      invitee_id: INVITEE_ID,
    });
    expect(result.success).toBe(true);
    expect(mentionsSuggestion(result)).toBe(false);
  });

  test('several invitations in one run carry the suggestion only once', async () => {
    const ctx = makeCtx({ messageText: `Invite Telegram IDs ${INVITEE_ID} and ${INVITEE_ID + 1}` });
    const first = await handleSendInvitation(ctx, { event_id: eventId, invitee_id: INVITEE_ID });
    const second = await handleSendInvitation(ctx, { event_id: eventId, invitee_id: INVITEE_ID + 1 });
    expect(first.output?.split('\n').at(-1)).toBe(SUGGESTION);
    expect(second.success).toBe(true);
    expect(mentionsSuggestion(second)).toBe(false);
  });

  test('a dismissal in an earlier workflow step suppresses the suggestion in a later one', async () => {
    // Intent workflows build a fresh context per step around the same message-level user object.
    const messageUser = userRepo.findByTelegramId(INVITER_ID)!;
    handleDismissConnectTelegramPrompt(makeCtx({ user: messageUser }));
    const inviteStep = makeCtx({ user: messageUser });
    const result = await handleSendInvitation(inviteStep, { event_id: eventId, invitee_id: INVITEE_ID });
    expect(result.success).toBe(true);
    expect(mentionsSuggestion(result)).toBe(false);
  });

  test('a dismissal earlier in the same run suppresses the suggestion', async () => {
    const ctx = makeCtx();
    handleDismissConnectTelegramPrompt(ctx);
    const result = await handleSendInvitation(ctx, { event_id: eventId, invitee_id: INVITEE_ID });
    expect(result.success).toBe(true);
    expect(mentionsSuggestion(result)).toBe(false);
  });

  test('the suggestion also follows a delivery that reached nobody', async () => {
    // Bot API refused, the admin session failed and the inviter could not get the forward link.
    const failing: TelegramSender = {
      ...unreachableByBot,
      sendAsUser: async () => false,
      sendMessage: async () => {
        throw new Error('Forbidden: bot was blocked by the user');
      },
    };
    const result = await handleSendInvitation(makeCtx({ sender: failing }), {
      event_id: eventId,
      invitee_id: INVITEE_ID,
    });
    expect(result.effect).toEqual({ kind: 'invitation', delivery: 'failed' });
    expect(result.output?.split('\n').at(-1)).toBe(SUGGESTION);
  });

  test('a Bot API error for an invitee who uses the bot still counts as not reached', async () => {
    userRepo.create({ telegram_id: INVITEE_ID, timezone: 'UTC' });
    const flaky: TelegramSender = {
      ...unreachableByBot,
      sendInvitation: async () => {
        throw new Error('ETIMEDOUT');
      },
    };
    const result = await handleSendInvitation(makeCtx({ sender: flaky }), {
      event_id: eventId,
      invitee_id: INVITEE_ID,
    });
    expect(result.output?.split('\n').at(-1)).toBe(SUGGESTION);
  });

  test.each([
    ['no sender at all', undefined],
    [
      'a sender that cannot send invitations',
      { sendMessage: reachableByBot.sendMessage, editMessageText: async () => {} },
    ],
  ])('no suggestion when nothing was attempted: %s', async (_name, sender) => {
    const result = await handleSendInvitation(makeCtx({ sender }), { event_id: eventId, invitee_id: INVITEE_ID });
    expect(result.success).toBe(true);
    expect(mentionsSuggestion(result)).toBe(false);
  });
});
