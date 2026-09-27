// Regression tests for #508: a direct private-chat request must never end in silence
// (a '[SKIP]' final deleting the execution log) or a bare '...' just because the model
// produced no answer of its own; legitimate silence paths must stay silent.
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type OpenAI from 'openai';
import { t } from '../../../src/config/constants.ts';
import { migrations } from '../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../src/database/repositories/chat-history.repository.ts';
import { EditProposalRepository } from '../../../src/database/repositories/edit-proposal.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../../src/database/repositories/event-reminder.repository.ts';
import { HolidayRepository } from '../../../src/database/repositories/holiday.repository.ts';
import { InvitationRepository } from '../../../src/database/repositories/invitation.repository.ts';
import { SharedEventRepository } from '../../../src/database/repositories/shared-event.repository.ts';
import { SharingSettingsRepository } from '../../../src/database/repositories/sharing-settings.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { aiFailureNotices, CalendarBotAgent } from '../../../src/services/ai/agent.ts';
import type { StreamCallbacks, StreamRoundOptions, StreamRoundResult } from '../../../src/services/ai/streaming.ts';
import { _resetToolThrottleForTest } from '../../../src/services/ai/tool-executor.ts';
import type { AgentContext, TelegramSender } from '../../../src/services/ai/types.ts';
import { ConversationLogger } from '../../../src/services/conversation-logger.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../src/services/holiday/holiday-service.ts';
import { InvitationService } from '../../../src/services/sharing/invitation-service.ts';
import { PrivacyService } from '../../../src/services/sharing/privacy-service.ts';
import { SharingService } from '../../../src/services/sharing/sharing-service.ts';

const USER_ID = 5081;
const INVITEE_ID = 5082;
const GROUP_ID = -1005080;

type Round = { text: string } | { tool: string; input: () => { [key: string]: unknown } };

/** One scripted model round per call; the response validator is always approved. */
function scripted(rounds: Round[]) {
  let index = 0;
  return async (opts: StreamRoundOptions, cbs: StreamCallbacks = {}): Promise<StreamRoundResult> => {
    const system = opts.messages[0];
    if (typeof system?.content === 'string' && system.content.includes('strict QA validator')) {
      return {
        text: 'APPROVE',
        toolCalls: [],
        finishReason: 'stop',
        assistantMessage: { role: 'assistant', content: 'APPROVE' },
        providerUsed: 'mock-validator',
      };
    }
    const round = rounds[index++];
    if (!round) throw new Error(`Scripted stream ran out of rounds (call ${index})`);
    if ('text' in round) {
      cbs.onTextDelta?.(round.text);
      return {
        text: round.text,
        toolCalls: [],
        finishReason: 'stop',
        assistantMessage: { role: 'assistant', content: round.text },
        providerUsed: 'mock',
      };
    }
    const id = `call-${index}`;
    const args = JSON.stringify(round.input());
    cbs.onToolCallStart?.(round.tool);
    const assistantMessage: OpenAI.ChatCompletionMessageParam = {
      role: 'assistant',
      content: null,
      tool_calls: [{ id, type: 'function', function: { name: round.tool, arguments: args } }],
    };
    return {
      text: '',
      toolCalls: [{ id, name: round.tool, arguments: args }],
      finishReason: 'tool_calls',
      assistantMessage,
      providerUsed: 'mock',
    };
  };
}

describe('silent final guard (#508)', () => {
  let db: Database;
  let ctx: AgentContext;
  let sender: TelegramSender;
  let delivered: string[];
  let deleted: number[];

  beforeEach(() => {
    _resetToolThrottleForTest();
    aiFailureNotices.reset();
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, migrations);
    const userRepo = new UserRepository(db);
    const eventRepo = new EventRepository(db);
    const chatHistory = new ChatHistoryRepository(db);
    userRepo.create({ telegram_id: USER_ID, timezone: 'Europe/Belgrade', language: 'ru' });
    userRepo.create({ telegram_id: INVITEE_ID, timezone: 'Europe/Belgrade', language: 'ru' });
    const eventService = new EventService({ eventRepo });
    const invitationRepo = new InvitationRepository(db);
    const sharingSettingsRepo = new SharingSettingsRepository(db);
    const privacyService = new PrivacyService(sharingSettingsRepo);
    ctx = {
      user: userRepo.findByTelegramId(USER_ID)!,
      chatId: USER_ID,
      messageText: 'создай встречу завтра в 10 и пригласи коллегу',
      isGroup: false,
      eventService,
      holidayService: new HolidayService(new HolidayRepository(db)),
      chatHistory,
      conversationLogger: new ConversationLogger(chatHistory),
      userRepo,
      eventReminderRepo: new EventReminderRepository(db),
      incomingMessageId: 900,
      verifiedRecipientIds: new Set([INVITEE_ID]),
      sharing: {
        invitationRepo,
        sharingSettingsRepo,
        privacyService,
        invitationService: new InvitationService(invitationRepo, eventRepo, sharingSettingsRepo),
        sharedEventRepo: new SharedEventRepository(db),
        editProposalRepo: new EditProposalRepository(db),
        sharingService: new SharingService(
          (id, start, end) => eventService.getEventsInRange(id, start, end),
          privacyService,
        ),
      },
    };
    delivered = [];
    deleted = [];
    sender = {
      sendMessage: mock(async (_chatId: number, text: string) => {
        delivered.push(text);
        return { message_id: 42 };
      }),
      editMessageText: mock(async (_chatId: number, _messageId: number, text: string) => {
        delivered.push(text);
      }),
      deleteMessage: mock(async (_chatId: number, messageId: number) => {
        deleted.push(messageId);
      }),
      sendInvitation: async () => ({ message_id: 77 }),
      setReaction: async () => {},
      sendButtons: async () => ({ message_id: 43 }),
    };
    chatHistory.save(USER_ID, 'user', ctx.messageText);
  });

  const lastEventId = () => {
    const row = db.query<{ id: number }, []>('SELECT id FROM events ORDER BY id DESC LIMIT 1').get();
    if (!row) throw new Error('create_event did not persist an event');
    return row.id;
  };
  const tomorrowAt10 = () => {
    const at = new Date(Date.now() + 86_400_000);
    at.setUTCHours(10, 0, 0, 0);
    return at.toISOString();
  };
  /** Raw assistant rows of chat_history — what the next turn's model will read. */
  const assistantHistory = () =>
    ctx.chatHistory
      .getRecent(USER_ID, 30)
      .filter((row) => row.role === 'assistant')
      .map((row) => row.content ?? '')
      .join('\n');
  const run = (rounds: Round[]) => new CalendarBotAgent({}, sender, { streamImpl: scripted(rounds) }).run(ctx);

  test("writes then '[SKIP]' in a private chat: the reply names the completed writes and keeps the execution log", async () => {
    const result = await run([
      { tool: 'create_event', input: () => ({ title: 'Синтетическая встреча', start_at: tomorrowAt10() }) },
      { tool: 'send_invitation', input: () => ({ event_id: lastEventId(), invitee_id: INVITEE_ID }) },
      { text: '[SKIP]' },
    ]);

    const invitations = db.query('SELECT id FROM invitations WHERE event_id = ?').all(lastEventId());
    expect(invitations).toHaveLength(1);
    const tr = t('ru').writeOutcomes;
    const reply = delivered.at(-1) ?? '';
    expect(deleted).toEqual([]);
    expect(reply).toContain('Ход выполнения');
    expect(reply).toContain(t('ru').ai_unanswered_writes('').trim());
    expect(reply).toContain(`${tr.completed}: ${tr.operations.create_event}`);
    expect(reply).toContain(tr.invitationDelivered);
    expect(reply).not.toContain('[SKIP]');
    expect(result.responseText).toContain(tr.operations.create_event);
    // The next turn's model must see what the user was told, not the skip token.
    const history = assistantHistory();
    expect(history).toContain(tr.invitationDelivered);
    expect(history).not.toContain('[SKIP]');
  });

  test.each([
    ['[SKIP]', '[SKIP]'],
    ['empty', ''],
  ])('reads only then %s final in a private chat: an honest could-not-answer line', async (_label, finalText) => {
    await run([
      { tool: 'get_events', input: () => ({ start_date: '2026-09-28', end_date: '2026-09-28' }) },
      { text: finalText },
    ]);

    const reply = delivered.at(-1) ?? '';
    expect(deleted).toEqual([]);
    expect(reply).toContain(t('ru').ai_unanswered);
    expect(reply.endsWith('...')).toBe(false);
    expect(assistantHistory()).toContain(t('ru').ai_unanswered);
  });

  test('end_conversation without any text in a private chat is not finalized as a bare "..."', async () => {
    await run([{ tool: 'end_conversation', input: () => ({}) }]);

    const reply = delivered.at(-1) ?? '';
    expect(reply).toContain(t('ru').ai_unanswered);
    expect(reply.endsWith('...')).toBe(false);
  });

  test('a retry of a user message is answered like the original message, not left silent', async () => {
    ctx.retryAttempt = 1;
    await run([{ text: '[SKIP]' }]);

    expect(delivered.at(-1)).toContain(t('ru').ai_unanswered);
    expect(deleted).toEqual([]);
  });

  describe('legitimate silence stays silent', () => {
    const expectSilent = () => {
      expect(delivered.join('\n')).not.toContain(t('ru').ai_unanswered);
      expect(assistantHistory()).not.toContain(t('ru').ai_unanswered);
    };

    test("set_reaction then '[SKIP]' in a private chat deletes the placeholder and says nothing", async () => {
      const result = await run([{ tool: 'set_reaction', input: () => ({ emoji: '👍' }) }, { text: '[SKIP]' }]);

      expect(result.responseText).toBe('');
      expect(deleted).toEqual([42]);
      expectSilent();
    });

    test("'[SKIP]' in a group chat sends nothing", async () => {
      ctx.isGroup = true;
      ctx.chatId = GROUP_ID;
      ctx.groupChatId = GROUP_ID;
      ctx.groupTitle = 'Synthetic group';
      const result = await run([{ text: '[SKIP]' }]);

      expect(result.responseText).toBe('');
      expect(delivered).toEqual([]);
      expectSilent();
    });

    test('supplement_skip in supplement mode sends nothing', async () => {
      ctx.supplementMode = true;
      const result = await run([{ tool: 'supplement_skip', input: () => ({}) }]);

      expect(result.responseText).toBe('');
      expect(delivered).toEqual([]);
      expectSilent();
    });

    test('ask_user already delivered its question: no extra notice', async () => {
      const result = await run([
        { tool: 'ask_user', input: () => ({ question: 'Во сколько?', options: ['10:00', '11:00'] }) },
      ]);

      expect(result.responseText).toBe('');
      expectSilent();
    });

    test("an unprompted scheduled run that ends with '[SKIP]' stays silent", async () => {
      ctx.unprompted = true;
      const result = await run([{ text: '[SKIP]' }]);

      expect(result.responseText).toBe('');
      expectSilent();
    });
  });
});
