import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type OpenAI from 'openai';
import { createCallbackHandler } from '../../../src/bot/handlers/callback.handler.ts';
import { migrations } from '../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../src/database/repositories/chat-history.repository.ts';
import { ContactRepository } from '../../../src/database/repositories/contact.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../../src/database/repositories/event-reminder.repository.ts';
import { HolidayRepository } from '../../../src/database/repositories/holiday.repository.ts';
import { InvitationRepository } from '../../../src/database/repositories/invitation.repository.ts';
import { SharingSettingsRepository } from '../../../src/database/repositories/sharing-settings.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import type { User } from '../../../src/database/types.ts';
import { aiFailureNotices, CalendarBotAgent } from '../../../src/services/ai/agent.ts';
import { issueRecipientApproval } from '../../../src/services/ai/recipient-confirmation.ts';
import type { StreamCallbacks, StreamRoundOptions, StreamRoundResult } from '../../../src/services/ai/streaming.ts';
import { _resetToolThrottleForTest } from '../../../src/services/ai/tool-executor.ts';
import type { AgentContext, TelegramSender } from '../../../src/services/ai/types.ts';
import { ConversationLogger } from '../../../src/services/conversation-logger.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../src/services/holiday/holiday-service.ts';
import { InvitationService } from '../../../src/services/sharing/invitation-service.ts';

const ORGANIZER_ID = 1001;
// Not a bot user and not a saved contact: sending needs the confirm-recipient button.
const RECIPIENT_ID = 5000000002;
const CONFIRMATION = `Confirmed recipient Telegram ID ${RECIPIENT_ID}`;

function isValidator(opts: StreamRoundOptions): boolean {
  const system = opts.messages[0];
  return typeof system?.content === 'string' && system.content.includes('strict QA validator');
}

function lastUserText(messages: OpenAI.ChatCompletionMessageParam[]): string {
  const last = [...messages].reverse().find((m) => m.role === 'user');
  return typeof last?.content === 'string' ? last.content : '';
}

describe('confirm-recipient button continues the conversation', () => {
  let db: Database;
  let chatHistory: ChatHistoryRepository;
  let invitationRepo: InvitationRepository;
  let eventService: EventService;
  let organizer: User;
  let buildContext: (user: User, chatId: number, messageText: string) => AgentContext;
  let sender: TelegramSender;

  beforeEach(() => {
    _resetToolThrottleForTest();
    aiFailureNotices.reset();
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, migrations);
    const userRepo = new UserRepository(db);
    const eventRepo = new EventRepository(db);
    chatHistory = new ChatHistoryRepository(db);
    invitationRepo = new InvitationRepository(db);
    eventService = new EventService({ eventRepo });
    userRepo.create({ telegram_id: ORGANIZER_ID, timezone: 'UTC', language: 'en' });
    organizer = userRepo.findByTelegramId(ORGANIZER_ID)!;
    const conversationLogger = new ConversationLogger(chatHistory);
    const invitationService = new InvitationService(invitationRepo, eventRepo, new SharingSettingsRepository(db));
    buildContext = (user, chatId, messageText) => ({
      user,
      chatId,
      messageText,
      isGroup: false,
      eventService,
      holidayService: new HolidayService(new HolidayRepository(db)),
      chatHistory,
      conversationLogger,
      userRepo,
      eventReminderRepo: new EventReminderRepository(db),
      contactRepo: new ContactRepository(db),
      sharing: { invitationRepo, invitationService } as AgentContext['sharing'],
    });
    sender = {
      sendMessage: mock(() => Promise.resolve({ message_id: 42 })),
      editMessageText: mock(() => Promise.resolve()),
      sendInvitation: mock(() => Promise.resolve({ message_id: 43 })),
    };
  });
  afterEach(() => db.close());

  test('the confirmation reaches the model in the same turn, is saved once, and sends with force=true', async () => {
    const event = eventService.createEvent({
      user_id: ORGANIZER_ID,
      title: 'Standup',
      start_at: new Date(Date.now() + 86_400_000).toISOString(),
      timezone: 'UTC',
    });
    // The turn that asked for confirmation, then the button press as the logging middleware saves it.
    const conversationLogger = new ConversationLogger(chatHistory);
    conversationLogger.logUserMessage(ORGANIZER_ID, `invite ${RECIPIENT_ID} to the standup`);
    const approvalId = issueRecipientApproval(ORGANIZER_ID, event.id, RECIPIENT_ID);
    conversationLogger.logButtonPress(ORGANIZER_ID, 'ric', approvalId);

    // Scripted model: it can only act on a confirmation it actually receives.
    const requests: OpenAI.ChatCompletionMessageParam[][] = [];
    const confirmationRowsAtFirstRequest: number[] = [];
    const streamImpl = async (opts: StreamRoundOptions, cbs: StreamCallbacks = {}): Promise<StreamRoundResult> => {
      if (isValidator(opts)) {
        return {
          text: 'APPROVE',
          toolCalls: [],
          finishReason: 'stop',
          assistantMessage: { role: 'assistant', content: 'APPROVE' },
          providerUsed: 'mock',
        };
      }
      requests.push(opts.messages);
      if (requests.length === 1) {
        confirmationRowsAtFirstRequest.push(
          chatHistory.getRecent(ORGANIZER_ID, 30).filter((r) => r.role === 'user' && r.content.includes(CONFIRMATION))
            .length,
        );
      }
      if (requests.length === 1 && lastUserText(opts.messages).includes(CONFIRMATION)) {
        const args = JSON.stringify({ event_id: event.id, invitee_id: RECIPIENT_ID, force: true });
        cbs.onToolCallStart?.('send_invitation');
        return {
          text: '',
          toolCalls: [{ id: 'invite', name: 'send_invitation', arguments: args }],
          finishReason: 'tool_calls',
          assistantMessage: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'invite', type: 'function', function: { name: 'send_invitation', arguments: args } }],
          },
          providerUsed: 'mock',
        };
      }
      const text = requests.length === 1 ? 'Which event do you mean?' : 'Invitation sent.';
      cbs.onTextDelta?.(text);
      return {
        text,
        toolCalls: [],
        finishReason: 'stop',
        assistantMessage: { role: 'assistant', content: text },
        providerUsed: 'mock',
      };
    };
    const agent = new CalendarBotAgent({}, sender, { streamImpl });

    const handler = createCallbackHandler(eventService, {} as never, {} as never, {} as never, {
      agentContinuation: { agent, buildContext },
    });
    await handler({
      data: `ric:${approvalId}`,
      dbUser: organizer,
      from: { id: ORGANIZER_ID },
      chatId: ORGANIZER_ID,
      answer: async () => {},
    } as never);

    // First provider request already carries the confirmation, saved before the model ran.
    expect(lastUserText(requests[0]!)).toContain(`${CONFIRMATION} for event ${event.id}.`);
    expect(confirmationRowsAtFirstRequest).toEqual([1]);
    const confirmationRows = chatHistory
      .getRecent(ORGANIZER_ID, 30)
      .filter((r) => r.role === 'user' && r.content.includes(CONFIRMATION));
    expect(confirmationRows).toHaveLength(1);

    // The model's force=true send consumed the approval and created the invitation.
    const invitations = invitationRepo.getByEvent(event.id);
    expect(invitations).toHaveLength(1);
    expect(invitations[0]!.invitee_id).toBe(RECIPIENT_ID);
    expect(sender.sendInvitation).toHaveBeenCalledTimes(1);
  });
});
