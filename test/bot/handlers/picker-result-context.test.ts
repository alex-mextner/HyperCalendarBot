import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type OpenAI from 'openai';
import { continuePickerWithAgent, pickerAiLine } from '../../../src/bot/handlers/picker-invitation.ts';
import { migrations } from '../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../../src/database/repositories/event-reminder.repository.ts';
import { HolidayRepository } from '../../../src/database/repositories/holiday.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import type { User } from '../../../src/database/types.ts';
import { aiFailureNotices, CalendarBotAgent } from '../../../src/services/ai/agent.ts';
import type { StreamCallbacks, StreamRoundOptions, StreamRoundResult } from '../../../src/services/ai/streaming.ts';
import type { AgentContext, TelegramSender } from '../../../src/services/ai/types.ts';
import { ConversationLogger } from '../../../src/services/conversation-logger.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../src/services/holiday/holiday-service.ts';

const INVITER_ID = 1001;
const INVITEE = { userId: 2002, firstName: 'Alice', username: 'alice_test' };
const DELIVERED_LINE = pickerAiLine('Alice', INVITEE.userId, { kind: 'delivered' });

/** Records every agent-round request (validator calls are auto-approved and not recorded). */
function recordingStream(calls: OpenAI.ChatCompletionMessageParam[][]) {
  return async (opts: StreamRoundOptions, cbs: StreamCallbacks = {}): Promise<StreamRoundResult> => {
    const system = opts.messages[0];
    const isValidator = typeof system?.content === 'string' && system.content.includes('strict QA validator');
    const text = isValidator ? 'APPROVE' : 'Invitation for Alice created and being sent.';
    if (!isValidator) {
      calls.push(opts.messages);
      cbs.onTextDelta?.(text);
    }
    return {
      text,
      toolCalls: [],
      finishReason: 'stop',
      assistantMessage: { role: 'assistant', content: text },
      providerUsed: 'mock',
    };
  };
}

describe('continuePickerWithAgent', () => {
  let chatHistory: ChatHistoryRepository;
  let inviter: User;
  let buildContext: (user: User, chatId: number, messageText: string) => AgentContext;
  let sender: TelegramSender;

  beforeEach(() => {
    aiFailureNotices.reset();
    const db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, migrations);
    const userRepo = new UserRepository(db);
    chatHistory = new ChatHistoryRepository(db);
    userRepo.create({ telegram_id: INVITER_ID, timezone: 'UTC', language: 'en' });
    inviter = userRepo.findByTelegramId(INVITER_ID)!;
    // The turn that opened the picker was persisted by the text middleware.
    chatHistory.save(INVITER_ID, 'user', 'invite Alice to the standup');
    buildContext = (user, chatId, messageText) => ({
      user,
      chatId,
      messageText,
      isGroup: false,
      eventService: new EventService({ eventRepo: new EventRepository(db) }),
      holidayService: new HolidayService(new HolidayRepository(db)),
      chatHistory,
      conversationLogger: new ConversationLogger(chatHistory),
      userRepo,
      eventReminderRepo: new EventReminderRepository(db),
    });
    sender = {
      sendMessage: mock(() => Promise.resolve({ message_id: 42 })),
      editMessageText: mock(() => Promise.resolve()),
    };
  });

  test('the picker result reaches the provider in the same turn and persists in chat_history', async () => {
    const calls: OpenAI.ChatCompletionMessageParam[][] = [];
    const agent = new CalendarBotAgent({}, sender, { streamImpl: recordingStream(calls) });
    const runContexts: AgentContext[] = [];
    const run = (ctx: AgentContext) => {
      runContexts.push(ctx);
      return agent.run(ctx);
    };

    await continuePickerWithAgent(
      { inviter, chatId: INVITER_ID, invitees: [INVITEE], aiResultLines: [DELIVERED_LINE] },
      { agent: { run }, buildContext },
    );

    const firstRequest = calls[0]!;
    const last = firstRequest[firstRequest.length - 1]!;
    expect(last.role).toBe('user');
    expect(String(last.content)).toContain('[User picker result]');
    expect(String(last.content)).toContain('Alice id:2002 @alice_test');
    expect(String(last.content)).toContain(DELIVERED_LINE);

    const pickerRows = chatHistory
      .getRecent(INVITER_ID, 30)
      .filter((row) => row.role === 'user' && row.content.includes('[User picker result]'));
    expect(pickerRows).toHaveLength(1);
    expect(pickerRows[0]!.content).toContain(DELIVERED_LINE);
    // Tool calls of this turn link to the picker row in the action log.
    expect(runContexts[0]!.chatHistoryId).toBe(pickerRows[0]!.id);
  });
});
