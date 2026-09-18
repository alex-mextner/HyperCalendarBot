import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type OpenAI from 'openai';
import { EN_AGENT_ERROR_PHRASES, RU_AGENT_ERROR_PHRASES } from '../../../src/config/constants.ts';
import { migrations } from '../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../src/database/repositories/chat-history.repository.ts';
import { DeepLinkRepository } from '../../../src/database/repositories/deep-link.repository.ts';
import { EditProposalRepository } from '../../../src/database/repositories/edit-proposal.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../../src/database/repositories/event-reminder.repository.ts';
import { GroupMemberRepository } from '../../../src/database/repositories/group-member.repository.ts';
import { HolidayRepository } from '../../../src/database/repositories/holiday.repository.ts';
import { InvitationRepository } from '../../../src/database/repositories/invitation.repository.ts';
import { ParticipantRepository } from '../../../src/database/repositories/participant.repository.ts';
import { SharedEventRepository } from '../../../src/database/repositories/shared-event.repository.ts';
import { SharingSettingsRepository } from '../../../src/database/repositories/sharing-settings.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { AssistantMessageCodec, aiFailureNotices, CalendarBotAgent } from '../../../src/services/ai/agent.ts';
import type { AiDebugLogger } from '../../../src/services/ai/debug-logger.ts';
import type { StreamCallbacks, StreamRoundOptions, StreamRoundResult } from '../../../src/services/ai/streaming.ts';
import { _resetToolThrottleForTest, executeTool } from '../../../src/services/ai/tool-executor.ts';
import type { AgentConfig, AgentContext, TelegramSender } from '../../../src/services/ai/types.ts';
import { ConversationLogger } from '../../../src/services/conversation-logger.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../src/services/holiday/holiday-service.ts';
import { DeepLinkService } from '../../../src/services/sharing/deep-link-service.ts';
import { InvitationService } from '../../../src/services/sharing/invitation-service.ts';
import { PrivacyService } from '../../../src/services/sharing/privacy-service.ts';
import { SharingService } from '../../../src/services/sharing/sharing-service.ts';

function createTestDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

// ── Scripted stream mocks ────────────────────────────────────────────────
// makeStreamImpl takes a list of canned StreamRoundResults — one per round —
// and returns a function with the same signature as aiStreamRound. Each call
// consumes one canned result and invokes onTextDelta/onToolCallStart to simulate
// the live streaming behaviour. No module mocking — the agent accepts the impl
// via constructor options, so tests don't leak across files.

type ScriptedRound =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; callId: string; name: string; input: { [key: string]: unknown }; text?: string }
  | { kind: 'error'; error: Error; text?: string };

function asAssistantMessage(round: ScriptedRound): OpenAI.ChatCompletionMessageParam {
  if (round.kind === 'tool') {
    return {
      role: 'assistant',
      content: round.text ?? null,
      tool_calls: [
        {
          id: round.callId,
          type: 'function',
          function: { name: round.name, arguments: JSON.stringify(round.input) },
        },
      ],
    };
  }
  if (round.kind === 'text') {
    return { role: 'assistant', content: round.text };
  }
  // Unused for 'error' — the impl throws before constructing a message.
  return { role: 'assistant', content: '' };
}

function fakeMetrics(provider: 'zai' | 'groq', promptTokens: number, completionTokens: number) {
  return {
    provider,
    model: provider === 'groq' ? 'validator-model' : 'agent-model',
    chain: provider === 'groq' ? ('fast' as const) : ('smart' as const),
    firstUsableSinceAttemptMs: 5,
    providerDurationMs: 10,
    totalDurationMs: 12,
    attemptCount: 1,
    fallbackCount: 0,
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      cachedTokens: null,
      reasoningTokens: null,
    },
  };
}

function isValidatorCall(opts: StreamRoundOptions): boolean {
  // The response validator always sends a 2-message payload (system + user)
  // whose system prompt starts with "You are a strict QA validator".
  const system = opts.messages[0];
  if (!system || system.role !== 'system' || typeof system.content !== 'string') return false;
  return system.content.includes('strict QA validator');
}

function makeStreamImpl(script: ScriptedRound[]): {
  impl: (opts: StreamRoundOptions, cbs?: StreamCallbacks) => Promise<StreamRoundResult>;
  calls: { messages: OpenAI.ChatCompletionMessageParam[] }[];
} {
  const calls: { messages: OpenAI.ChatCompletionMessageParam[] }[] = [];
  let round = 0;
  const impl = async (opts: StreamRoundOptions, cbs: StreamCallbacks = {}) => {
    // Auto-approve validator calls so tests don't have to pre-script them.
    // Validator invocations are opaque to the script — they're a side channel
    // that only fires when the agent produces text with no tool calls.
    if (isValidatorCall(opts)) {
      const validatorMsg: OpenAI.ChatCompletionMessageParam = { role: 'assistant', content: 'APPROVE' };
      return {
        text: 'APPROVE',
        toolCalls: [],
        finishReason: 'stop',
        assistantMessage: validatorMsg,
        providerUsed: 'mock-validator',
        metrics: fakeMetrics('groq', 10, 2),
      };
    }

    calls.push({ messages: opts.messages });
    const current = script[round++];
    if (!current) throw new Error(`Scripted stream ran out of rounds (call ${round})`);
    if (current.kind === 'error') {
      cbs.onTextDelta?.(current.text ?? '');
      throw current.error;
    }

    if (current.kind === 'text') {
      cbs.onTextDelta?.(current.text);
      const msg = asAssistantMessage(current);
      return {
        text: current.text,
        toolCalls: [],
        finishReason: 'stop',
        assistantMessage: msg,
        providerUsed: 'mock',
        metrics: fakeMetrics('zai', 100, 20),
      };
    }

    // tool round
    cbs.onTextDelta?.(current.text ?? '');
    cbs.onToolCallStart?.(current.name);
    const msg = asAssistantMessage(current);
    return {
      text: current.text ?? '',
      toolCalls: [
        {
          id: current.callId,
          name: current.name,
          arguments: JSON.stringify(current.input),
        },
      ],
      finishReason: 'tool_calls',
      assistantMessage: msg,
      providerUsed: 'mock',
    };
  };
  return { impl, calls };
}

describe('CalendarBotAgent.run()', () => {
  let db: Database;
  let ctx: AgentContext;
  let config: AgentConfig;
  let sender: TelegramSender;
  const USER_ID = 456;

  beforeEach(() => {
    // Module-level throttle state must be reset between tests so repeated
    // (tool, args) combinations across tests don't cross-contaminate.
    _resetToolThrottleForTest();
    // Per-user stall/honest notices are rate limited at module scope — reset so
    // one test's apology does not silence the next test's.
    aiFailureNotices.reset();
    db = createTestDb();
    const userRepo = new UserRepository(db);
    const eventRepo = new EventRepository(db);
    const eventReminderRepo = new EventReminderRepository(db);
    const chatHistoryRepo = new ChatHistoryRepository(db);
    const holidayRepo = new HolidayRepository(db);
    userRepo.create({ telegram_id: USER_ID, timezone: 'UTC', language: 'en' });
    const eventService = new EventService({ eventRepo });
    const holidayService = new HolidayService(holidayRepo);
    ctx = {
      user: userRepo.findByTelegramId(USER_ID)!,
      chatId: USER_ID,
      messageText: 'Show my events today',
      isGroup: false,
      eventService,
      holidayService,
      chatHistory: chatHistoryRepo,
      conversationLogger: new ConversationLogger(chatHistoryRepo),
      userRepo,
      eventReminderRepo,
      // A stall phrase promises a comeback, so the agent only sends one when a
      // retry is actually scheduled. Wire a no-op enqueue for the error tests.
      retryEnqueue: async () => {},
    };
    config = {};
    sender = {
      sendMessage: mock(() => Promise.resolve({ message_id: 42 })),
      editMessageText: mock(() => Promise.resolve()),
    };
  });

  function setupInvitations() {
    const eventRepo = new EventRepository(db);
    const invitationRepo = new InvitationRepository(db);
    const sharingSettingsRepo = new SharingSettingsRepository(db);
    const privacyService = new PrivacyService(sharingSettingsRepo);
    ctx.sharing = {
      invitationRepo,
      sharingSettingsRepo,
      privacyService,
      invitationService: new InvitationService(invitationRepo, eventRepo, sharingSettingsRepo),
      sharedEventRepo: new SharedEventRepository(db),
      editProposalRepo: new EditProposalRepository(db),
      sharingService: new SharingService(
        (id, start, end) => ctx.eventService.getEventsInRange(id, start, end),
        privacyService,
      ),
    };
    return createOwnedEvent();
  }

  function createOwnedEvent() {
    return ctx.eventService.createEvent({
      user_id: USER_ID,
      title: '<b>private title</b>',
      start_at: new Date(Date.now() + 86400000).toISOString(),
      timezone: 'UTC',
    });
  }

  test.each([
    'create_event',
    'update_event',
    'send_invitation',
  ])('known preflight rejection is not an uncertain write: %s', async (name) => {
    const input =
      name === 'create_event'
        ? { title: 'Synthetic', start_at: new Date(Date.now() - 3600000).toISOString() }
        : name === 'update_event'
          ? { event_id: 999999, title: 'Synthetic' }
          : { event_id: 999999, invitee_id: 456 };
    const enqueue = mock(async () => {});
    ctx.retryEnqueue = enqueue;
    const script = makeStreamImpl([
      { kind: 'tool', callId: 'rejected', name, input },
      { kind: 'error', error: new Error('Synthetic provider interruption') },
    ]);
    const result = await new CalendarBotAgent(config, sender, { streamImpl: script.impl }).run(ctx);
    expect(result.responseText).toContain('Not completed:');
    expect(result.responseText).toContain('request rejected before applying changes');
    expect(result.responseText).not.toContain('Outcome unknown');
    expect(result.responseText).not.toContain('Confirmed changes remain');
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  test('production metrics include hidden validator call and sanitized delivery result', async () => {
    ctx.chatHistory.save(USER_ID, 'user', 'hello');
    const scripted = makeStreamImpl([{ kind: 'text', text: 'hello back' }]);
    const result = await new CalendarBotAgent(config, sender, { streamImpl: scripted.impl }).run(ctx);
    expect(result.metrics).toMatchObject({
      modelCalls: 2,
      modelAttempts: 2,
      promptTokens: 110,
      completionTokens: 22,
      termination: 'normal',
      deliveryOutcome: 'delivered',
    });
    expect(result.metrics?.usagePartialRounds).toBe(2);
    expect(JSON.stringify(result.metrics)).not.toContain(String(USER_ID));
  });

  test('post-update loss of read visibility is uncertain, never a pre-apply rejection', async () => {
    const groupId = -1007755;
    new GroupMemberRepository(db).upsert(groupId, USER_ID);
    db.run('UPDATE group_members SET joined_at=? WHERE chat_id=? AND user_id=?', [
      '2030-01-01T11:00:00Z',
      groupId,
      USER_ID,
    ]);
    const event = ctx.eventService.createEvent({
      user_id: USER_ID,
      owner_type: 'group',
      group_id: groupId,
      created_by: USER_ID,
      title: 'Synthetic group event',
      start_at: '2030-01-01T12:00:00Z',
      timezone: 'UTC',
    });
    const enqueue = mock(async () => {});
    ctx.retryEnqueue = enqueue;
    const script = makeStreamImpl([
      {
        kind: 'tool',
        callId: 'move',
        name: 'update_event',
        input: { event_id: event.id, scope: 'personal', start_at: '2030-01-01T10:00:00Z' },
      },
      { kind: 'error', error: new Error('Synthetic provider interruption') },
    ]);
    const result = await new CalendarBotAgent(config, sender, { streamImpl: script.impl }).run(ctx);
    const stored = db.query('SELECT start_at FROM events WHERE id=?').get(event.id) as { start_at: string };
    expect(stored.start_at).toBe('2030-01-01T10:00:00Z');
    expect(result.responseText).toContain('Outcome unknown');
    expect(result.responseText).not.toContain('request rejected before applying changes');
    expect(enqueue).not.toHaveBeenCalled();
  });

  test('nested invitation picker remains a waiting handoff', async () => {
    const event = setupInvitations();
    ctx.messageText = 'Invite @private_name';
    ctx.resolveUsername = async () => null;
    sender.sendUserPicker = mock(async () => ({ message_id: 43 }));
    const script = makeStreamImpl([
      { kind: 'tool', callId: 'bad', name: 'delete_event', input: { event_id: 999999 } },
      {
        kind: 'tool',
        callId: 'picker',
        name: 'send_invitation',
        input: { event_id: event.id, invitee_username: 'private_name' },
      },
    ]);
    const result = await new CalendarBotAgent(config, sender, { streamImpl: script.impl }).run(ctx);
    expect(result.responseText).toBe('');
    expect(sender.sendUserPicker).toHaveBeenCalledTimes(1);
    expect(db.query('SELECT id FROM invitations WHERE event_id = ?').all(event.id)).toHaveLength(0);
    expect(JSON.stringify(ctx.chatHistory.getRecent(USER_ID))).not.toContain('Completed: Send invitation');
  });

  test.each([
    'failed',
    'manual',
    'delivered',
  ])('invitation reports actual %s delivery in a mixed group report', async (delivery) => {
    const event = setupInvitations();
    ctx.isGroup = true;
    ctx.chatId = -1009988;
    ctx.groupChatId = ctx.chatId;
    ctx.userRepo.create({ telegram_id: 789, timezone: 'UTC', language: 'en' });
    ctx.verifiedRecipientIds = new Set([789]); // The user selected this numeric recipient.
    sender.sendInvitation = async () => (delivery === 'delivered' ? { message_id: 55 } : null);
    const privateMessages: string[] = [];
    sender.sendMessage = async (chatId, text) => {
      if (chatId === USER_ID) privateMessages.push(text);
      return { message_id: 55 };
    };
    if (delivery === 'manual') {
      ctx.deepLinkService = new DeepLinkService(new DeepLinkRepository(db));
      ctx.botUsername = 'synthetic_bot';
    }
    const script = makeStreamImpl([
      { kind: 'tool', callId: 'bad', name: 'delete_event', input: { event_id: 999999 } },
      { kind: 'tool', callId: 'invite', name: 'send_invitation', input: { event_id: event.id, invitee_id: 789 } },
      { kind: 'text', text: 'Everything sent.' },
    ]);
    const result = await new CalendarBotAgent(config, sender, { streamImpl: script.impl }).run(ctx);
    expect(db.query('SELECT id FROM invitations WHERE event_id = ?').all(event.id)).toHaveLength(1);
    expect(result.responseText).toContain(delivery === 'delivered' ? 'Invitation delivered' : 'Invitation created');
    expect(result.responseText).toContain(
      delivery === 'manual' ? 'forward' : delivery === 'failed' ? 'not delivered' : 'delivered',
    );
    expect(result.responseText).not.toContain('789');
    expect(result.responseText).not.toContain('<b>private');
    expect(result.responseText).not.toContain('https://');
    if (delivery === 'manual') expect(privateMessages.join('')).toContain('https://t.me/');
    const groupHistory = ctx.chatHistory.getRecentByChat(ctx.chatId);
    expect(groupHistory.some((row) => row.role === 'tool')).toBe(true);
    expect(JSON.stringify(groupHistory)).toContain(
      delivery === 'delivered' ? 'Invitation delivered' : 'Invitation created',
    );
    expect(JSON.stringify(groupHistory)).not.toContain('Everything sent.');
  });

  test('participant delete reports attendance decline while retaining the event', async () => {
    ctx.userRepo.create({ telegram_id: 789, timezone: 'UTC' });
    const event = ctx.eventService.createEvent({
      user_id: 789,
      title: 'Shared',
      start_at: new Date(Date.now() + 86400000).toISOString(),
      timezone: 'UTC',
    });
    ctx.participantRepo = new ParticipantRepository(db);
    ctx.participantRepo.add(event.id, USER_ID, 'accepted');
    const script = makeStreamImpl([
      { kind: 'tool', callId: 'bad', name: 'delete_event', input: { event_id: 999999 } },
      { kind: 'tool', callId: 'decline', name: 'delete_event', input: { event_id: event.id } },
      { kind: 'text', text: 'Deleted everything.' },
    ]);
    const result = await new CalendarBotAgent(config, sender, { streamImpl: script.impl }).run(ctx);
    expect(ctx.eventService.getEvent(event.id, 789)).not.toBeNull();
    expect(ctx.participantRepo.findByEventAndUser(event.id, USER_ID)?.status).toBe('declined');
    expect(result.responseText).toContain('Attendance declined');
    expect(result.responseText).not.toContain('Completed: Delete event');
  });

  test.each([false, true])('live call speaks actual ask_user question, validation retry=%s', async (retry) => {
    ctx.inputMode = 'live_call';
    const question = 'Which afternoon works?';
    const script = makeStreamImpl([
      ...(retry ? [{ kind: 'text' as const, text: 'Unverified completion' }] : []),
      {
        kind: 'tool',
        callId: 'ask',
        name: 'ask_user',
        input: { question, options: ['Monday', 'Tuesday'] },
        text: 'Provisional prose',
      },
    ]);
    const impl = async (opts: StreamRoundOptions, callbacks?: StreamCallbacks): Promise<StreamRoundResult> => {
      if (retry && isValidatorCall(opts))
        return {
          text: 'REJECT: use tools',
          toolCalls: [],
          finishReason: 'stop',
          assistantMessage: { role: 'assistant', content: 'REJECT: use tools' },
          providerUsed: 'mock',
          metrics: fakeMetrics('zai', 100, 20),
        };
      return script.impl(opts, callbacks);
    };
    const result = await new CalendarBotAgent(config, sender, { streamImpl: impl }).run(ctx);
    expect(result.responseText).toContain(question);
    expect(result.responseText).toContain('Monday');
    expect(result.responseText).not.toContain('Provisional prose');
  });

  test('title correction does not clear failed all_day and timezone metadata', async () => {
    const event = createOwnedEvent();
    const script = makeStreamImpl([
      {
        kind: 'tool',
        callId: 'bad',
        name: 'update_event',
        input: { event_id: event.id, title: 123, all_day: true, timezone: 'Europe/Belgrade', category: 'work' },
      },
      { kind: 'tool', callId: 'fix', name: 'update_event', input: { event_id: event.id, title: 'Fixed' } },
      { kind: 'text', text: 'All updated.' },
    ]);
    const result = await new CalendarBotAgent(config, sender, { streamImpl: script.impl }).run(ctx);
    expect(ctx.eventService.getEvent(event.id, USER_ID)?.all_day).toBe(0);
    expect(ctx.eventService.getEvent(event.id, USER_ID)?.title).toBe('Fixed');
    expect(result.responseText).toContain('all day');
    expect(result.responseText).toContain('timezone');
    expect(result.responseText).toContain('category');
  });

  test('confirmed write survives provider interruption without whole-request retry', async () => {
    const event = createOwnedEvent();
    const enqueue = mock(async () => {});
    ctx.retryEnqueue = enqueue;
    const script = makeStreamImpl([
      { kind: 'tool', callId: 'delete', name: 'delete_event', input: { event_id: event.id } },
      { kind: 'error', error: new Error('private provider details') },
    ]);
    const result = await new CalendarBotAgent(config, sender, { streamImpl: script.impl }).run(ctx);
    expect(ctx.eventService.getEvent(event.id, USER_ID)).toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
    expect(result.responseText).toContain('Completed: Delete event');
    expect(result.responseText).toContain('interrupted');
    expect(result.responseText).not.toContain('private provider');
  });

  test('receipts persist before next provider request without provisional success prose', async () => {
    const event = createOwnedEvent();
    const script = makeStreamImpl([
      {
        kind: 'tool',
        callId: 'delete',
        name: 'delete_event',
        input: { event_id: event.id },
        text: 'Everything completed provisionally',
      },
      { kind: 'text', text: 'Done.' },
    ]);
    let receipts = '';
    const impl = async (opts: StreamRoundOptions, callbacks?: StreamCallbacks) => {
      if (!isValidatorCall(opts) && script.calls.length === 1)
        receipts = JSON.stringify(ctx.chatHistory.getRecent(USER_ID));
      return script.impl(opts, callbacks);
    };
    await new CalendarBotAgent(config, sender, { streamImpl: impl }).run(ctx);
    expect(receipts).toContain('delete');
    expect(receipts).toContain('tool_call_id');
    expect(receipts).not.toContain('Everything completed provisionally');
  });

  test('failed write cannot be narrated as success', async () => {
    const { impl } = makeStreamImpl([
      { kind: 'tool', callId: 'failed-delete', name: 'delete_event', input: { event_id: '999999' } },
      { kind: 'text', text: 'Successfully deleted everything.' },
    ]);
    const result = await new CalendarBotAgent(config, sender, { streamImpl: impl }).run(ctx);
    expect(result.responseText).toContain('Not completed: Delete event');
    expect(result.responseText).not.toContain('Successfully deleted everything.');
    const history = ctx.chatHistory.getRecent(USER_ID);
    expect(JSON.stringify(history)).not.toContain('Successfully deleted everything.');
  });

  test('later success for the same operation and target clears the failure', async () => {
    const event = ctx.eventService.createEvent({
      user_id: USER_ID,
      title: 'Synthetic',
      start_at: '2030-01-01T10:00:00Z',
      timezone: 'UTC',
    });
    const { impl } = makeStreamImpl([
      { kind: 'tool', callId: 'bad-update', name: 'update_event', input: { event_id: String(event.id), title: 123 } },
      { kind: 'tool', callId: 'good-update', name: 'update_event', input: { event_id: event.id, title: 'Corrected' } },
      { kind: 'text', text: 'Updated.' },
    ]);
    const result = await new CalendarBotAgent(config, sender, { streamImpl: impl }).run(ctx);
    expect(result.responseText).not.toContain('Not completed:');
    expect(ctx.eventService.getEvent(event.id, USER_ID)?.title).toBe('Corrected');
  });

  test('retry loop guards failed writes without replaying a successful write', async () => {
    const event = ctx.eventService.createEvent({
      user_id: USER_ID,
      title: 'Synthetic',
      start_at: '2030-01-01T10:00:00Z',
      timezone: 'UTC',
    });
    const script = makeStreamImpl([
      { kind: 'text', text: 'Unverified answer' },
      { kind: 'tool', callId: 'retry-delete', name: 'delete_event', input: { event_id: String(event.id) } },
      { kind: 'tool', callId: 'retry-duplicate', name: 'delete_event', input: { event_id: String(event.id) } },
      { kind: 'tool', callId: 'retry-failed', name: 'delete_event', input: { event_id: '999999' } },
      { kind: 'text', text: 'Everything succeeded.' },
    ]);
    const impl = async (opts: StreamRoundOptions, callbacks?: StreamCallbacks): Promise<StreamRoundResult> => {
      if (isValidatorCall(opts))
        return {
          text: 'REJECT: missing evidence',
          toolCalls: [],
          finishReason: 'stop',
          assistantMessage: { role: 'assistant', content: 'REJECT: missing evidence' },
          providerUsed: 'synthetic',
        };
      return script.impl(opts, callbacks);
    };
    const result = await new CalendarBotAgent(config, sender, { streamImpl: impl }).run(ctx);
    expect(script.calls).toHaveLength(5);
    expect(result.toolResults.map((entry) => entry.success)).toEqual([true, true, false]);
    expect(result.responseText).toContain('Completed: Delete event');
    expect(result.responseText).toContain('Not completed: Delete event');
    expect(result.responseText).not.toContain('Everything succeeded.');
    expect(JSON.stringify(ctx.chatHistory.getRecent(USER_ID))).not.toContain('Everything succeeded.');
    expect(ctx.eventService.getEvent(event.id, USER_ID)).toBeNull();
  });

  test.each(['ask_user', 'pick_users', 'supplement_skip'])('failed write preserves %s stop behavior', async (name) => {
    const script = makeStreamImpl([
      { kind: 'tool', callId: 'failure', name: 'delete_event', input: { event_id: '999999' } },
      {
        kind: 'tool',
        callId: 'stop',
        name,
        input: { question: 'Which event?', options: ['A', 'B'], event_id: 999999, prompt: 'Who?' },
      },
    ]);
    if (name === 'pick_users') sender.sendUserPicker = mock(() => Promise.resolve({ message_id: 43 }));
    if (name === 'ask_user') sender.sendButtons = mock(() => Promise.resolve({ message_id: 43 }));
    if (name === 'supplement_skip') ctx.supplementMode = true;
    const result = await new CalendarBotAgent(config, sender, { streamImpl: script.impl }).run(ctx);
    expect(script.calls).toHaveLength(2);
    expect(result.responseText).not.toContain('Not completed:');
    if (name === 'ask_user') expect(sender.sendButtons).toHaveBeenCalledTimes(1);
    if (name === 'pick_users') expect(sender.sendUserPicker).toHaveBeenCalledTimes(1);
    if (name === 'supplement_skip') expect(sender.editMessageText).not.toHaveBeenCalled();
  });

  test.each([
    'end',
    'rounds',
    'throw',
    'quiet-retry',
    'timeout',
  ])('final evidence survives %s termination', async (ending) => {
    const failure: ScriptedRound = {
      kind: 'tool',
      callId: 'failure',
      name: 'delete_event',
      input: { event_id: 999999 },
    };
    const tail: ScriptedRound[] =
      ending === 'end'
        ? [
            {
              kind: 'tool',
              callId: 'stop',
              name: 'end_conversation',
              input: {},
              text: 'Successfully deleted everything.',
            },
          ]
        : ending === 'rounds'
          ? Array.from({ length: 14 }, (_, i) => ({ ...failure, callId: `failure-${i}` }))
          : [{ kind: 'error', text: 'Successfully deleted everything.', error: new Error('provider secret') }];
    if (ending === 'quiet-retry') ctx.retryAttempt = 1;
    const enqueue = mock(async () => {});
    ctx.retryEnqueue = enqueue;
    let delivered = '';
    sender.editMessageText = async (_chatId, _messageId, text) => {
      delivered = text;
    };
    const script = makeStreamImpl([failure, ...tail]);
    const now = Date.now();
    const date = spyOn(Date, 'now').mockImplementation(() =>
      ending === 'timeout' && script.calls.length >= 1 ? now + 300001 : now,
    );
    let result: Awaited<ReturnType<CalendarBotAgent['run']>>;
    try {
      result = await new CalendarBotAgent(config, sender, { streamImpl: script.impl }).run(ctx);
    } finally {
      date.mockRestore();
    }
    if (ending === 'quiet-retry') expect(enqueue).toHaveBeenCalledTimes(1);
    expect(result.responseText).toContain('Not completed:');
    expect(result.responseText).not.toContain('Successfully deleted');
    const history = JSON.stringify(ctx.chatHistory.getRecent(USER_ID));
    expect(history).toContain('Not completed:');
    expect(history).not.toContain('Successfully deleted');
    expect(delivered).toContain('Not completed:');
    expect(delivered).not.toContain('Successfully deleted');
  });

  test('a cross-run throttle cannot invent a new completed write', async () => {
    const event = ctx.eventService.createEvent({
      user_id: USER_ID,
      title: 'Before',
      start_at: '2030-01-01T10:00:00Z',
      timezone: 'UTC',
    });
    const input = { event_id: event.id, title: 'After' };
    expect((await executeTool(ctx, 'update_event', input)).success).toBe(true);
    const update = spyOn(ctx.eventService, 'updateEvent');
    let delivered = '';
    sender.editMessageText = async (_chatId, _messageId, text) => {
      delivered = text;
    };
    const { impl } = makeStreamImpl([
      { kind: 'tool', callId: 'skipped', name: 'update_event', input },
      { kind: 'text', text: 'Updated successfully again.' },
    ]);
    try {
      const result = await new CalendarBotAgent(config, sender, { streamImpl: impl }).run(ctx);
      expect(update).not.toHaveBeenCalled();
      expect(ctx.eventService.getEvent(event.id, USER_ID)?.title).toBe('After');
      expect(result.responseText).toContain('skipped');
      expect(result.responseText).not.toContain('Updated successfully');
      expect(delivered).not.toContain('Updated successfully');
      expect(JSON.stringify(ctx.chatHistory.getRecent(USER_ID))).not.toContain('Updated successfully');
    } finally {
      update.mockRestore();
    }
  });

  test.each(['end', 'rounds', 'throw', 'timeout'])('validation retry shares final guard on %s', async (ending) => {
    const failure: ScriptedRound = {
      kind: 'tool',
      callId: 'failure',
      name: 'delete_event',
      input: { event_id: 999999 },
    };
    const tail: ScriptedRound[] =
      ending === 'end'
        ? [{ kind: 'tool', callId: 'stop', name: 'end_conversation', input: {}, text: 'Deleted successfully.' }]
        : ending === 'rounds'
          ? Array.from({ length: 14 }, (_, i) => ({ ...failure, callId: `f-${i}` }))
          : [{ kind: 'error', text: 'Deleted successfully.', error: new Error('provider secret') }];
    const script = makeStreamImpl([{ kind: 'text', text: 'Unverified answer' }, failure, ...tail]);
    const now = Date.now();
    const date = spyOn(Date, 'now').mockImplementation(() =>
      ending === 'timeout' && script.calls.length >= 2 ? now + 300001 : now,
    );
    let delivered = '';
    sender.editMessageText = async (_chatId, _messageId, text) => {
      delivered = text;
    };
    const impl = async (opts: StreamRoundOptions, callbacks?: StreamCallbacks): Promise<StreamRoundResult> => {
      if (isValidatorCall(opts))
        return {
          text: 'REJECT',
          toolCalls: [],
          finishReason: 'stop',
          assistantMessage: { role: 'assistant', content: 'REJECT' },
          providerUsed: 'synthetic',
        };
      return script.impl(opts, callbacks);
    };
    try {
      const result = await new CalendarBotAgent(config, sender, { streamImpl: impl }).run(ctx);
      expect(result.responseText).toContain('Not completed:');
      expect(delivered).toContain('Not completed:');
      expect(delivered).not.toContain('Deleted successfully');
      const history = JSON.stringify(ctx.chatHistory.getRecent(USER_ID));
      expect(history).toContain('Not completed:');
      expect(history).not.toContain('Deleted successfully');
      expect(history).not.toContain('Unverified answer');
    } finally {
      date.mockRestore();
    }
  });

  test('successful location update retains failed title and time intent in real SQLite', async () => {
    const event = ctx.eventService.createEvent({
      user_id: USER_ID,
      title: 'Before',
      start_at: '2030-01-01T10:00:00Z',
      timezone: 'UTC',
    });
    const { impl } = makeStreamImpl([
      { kind: 'tool', callId: 'bad', name: 'update_event', input: { event_id: event.id, title: 123, start_at: 123 } },
      { kind: 'tool', callId: 'good', name: 'update_event', input: { event_id: event.id, location: 'Office' } },
      { kind: 'text', text: 'Everything updated.' },
    ]);
    let delivered = '';
    sender.editMessageText = async (_chatId, _messageId, text) => {
      delivered = text;
    };
    const result = await new CalendarBotAgent(config, sender, { streamImpl: impl }).run(ctx);
    expect(result.responseText).toContain('title');
    expect(result.responseText).toContain('start time');
    expect(delivered).toContain('Not completed:');
    const saved = ctx.eventService.getEvent(event.id, USER_ID);
    expect(saved?.title).toBe('Before');
    expect(saved?.location).toBe('Office');
    expect(JSON.stringify(ctx.chatHistory.getRecent(USER_ID))).not.toContain('Everything updated.');
  });

  test('implicit failure stays silent and persists authoritative evidence', async () => {
    ctx.wasExplicitInvocation = false;
    sender.deleteMessage = mock(async () => {});
    const enqueue = mock(async () => {});
    ctx.retryEnqueue = enqueue;
    const { impl } = makeStreamImpl([
      { kind: 'tool', callId: 'failed', name: 'delete_event', input: { event_id: 999999 } },
      { kind: 'error', text: 'Deleted successfully.', error: new Error('provider secret') },
    ]);
    const result = await new CalendarBotAgent(config, sender, { streamImpl: impl }).run(ctx);
    expect(result.responseText).toBe('');
    expect(sender.deleteMessage).toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    const history = JSON.stringify(ctx.chatHistory.getRecent(USER_ID));
    expect(history).toContain('Not completed:');
    expect(history).not.toContain('Deleted successfully');
  });

  test('failed create is also guarded by structured write evidence', async () => {
    const { impl } = makeStreamImpl([
      { kind: 'tool', callId: 'bad-create', name: 'create_event', input: { title: 'Synthetic' } },
      { kind: 'text', text: 'Created successfully.' },
    ]);
    const result = await new CalendarBotAgent(config, sender, { streamImpl: impl }).run(ctx);
    expect(result.responseText).toContain('Not completed: Create event');
    expect(result.responseText).not.toContain('Created successfully.');
    expect(JSON.stringify(ctx.chatHistory.getRecent(USER_ID))).not.toContain('Created successfully.');
  });

  test('run() with simple text response streams and saves history', async () => {
    const { impl } = makeStreamImpl([{ kind: 'text', text: 'No events today.' }]);
    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });

    ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);
    await agent.run(ctx);

    expect(sender.sendMessage).toHaveBeenCalledTimes(1); // init placeholder
    expect(sender.editMessageText).toHaveBeenCalled(); // finalize

    const history = ctx.chatHistory.getRecent(USER_ID);
    expect(history.length).toBe(2);
    expect(history[0]!.role).toBe('user');
    expect(history[0]!.content).toBe('Show my events today');
    expect(history[1]!.role).toBe('assistant');
    const parsed = JSON.parse(history[1]!.content) as OpenAI.ChatCompletionMessageParam;
    expect(parsed.role).toBe('assistant');
    expect(parsed.content).toBe('No events today.');
  });

  test('run() with tool use executes tool and continues loop', async () => {
    const { impl, calls } = makeStreamImpl([
      {
        kind: 'tool',
        callId: 'call-1',
        name: 'get_events',
        input: { start_date: '2026-03-15', end_date: '2026-03-15' },
      },
      { kind: 'text', text: 'You have 0 events.' },
    ]);

    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });
    ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);

    await agent.run(ctx);

    expect(calls.length).toBe(2);

    // Second call should carry the assistant tool_calls message + the tool result
    const secondCall = calls[1]!;
    const hasAssistantWithTools = secondCall.messages.some(
      (m) => m.role === 'assistant' && 'tool_calls' in m && Array.isArray(m.tool_calls) && m.tool_calls.length > 0,
    );
    expect(hasAssistantWithTools).toBe(true);
    const hasToolMessage = secondCall.messages.some((m) => m.role === 'tool');
    expect(hasToolMessage).toBe(true);

    const history = ctx.chatHistory.getRecent(USER_ID);
    // user + assistant-with-tool-calls + tool result row + assistant text
    expect(history.length).toBe(4);
    expect(history[0]!.role).toBe('user');
    expect(history[1]!.role).toBe('assistant');
    expect(history[2]!.role).toBe('tool');
    expect(history[3]!.role).toBe('assistant');
  });

  test('run() handles streaming errors and sends error message in user language', async () => {
    const { impl } = makeStreamImpl([{ kind: 'error', error: new Error('all providers failed') }]);
    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });

    ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);
    await agent.run(ctx);

    expect(sender.sendMessage).toHaveBeenCalledTimes(1); // init
    expect(sender.editMessageText).toHaveBeenCalled(); // finalize with stall text

    // User row + stall message saved so the model can play along if the user reacts
    const history = ctx.chatHistory.getRecent(USER_ID);
    expect(history.length).toBe(2);
    expect(history[0]!.role).toBe('user');
    expect(history[1]!.role).toBe('assistant');
    const parseResult = AssistantMessageCodec.safeParse(history[1]!.content);
    expect(parseResult.success).toBe(true);
    const stallContent = parseResult.success ? (parseResult.data.content ?? '') : '';
    expect(stallContent).toBeTruthy();
    expect(stallContent).not.toContain('An error occurred');
  });

  test('run() handles error with Russian language user', async () => {
    ctx.user = { ...ctx.user, language: 'ru' };
    const { impl } = makeStreamImpl([{ kind: 'error', error: new Error('boom') }]);
    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });

    await agent.run(ctx);

    const editCalls = (sender.editMessageText as ReturnType<typeof mock>).mock.calls;
    const lastEditText = editCalls[editCalls.length - 1]?.[2] as string;
    // Russian cute phrases are shown — verify non-empty, not English, contains Cyrillic
    expect(lastEditText).toBeTruthy();
    expect(lastEditText).not.toContain('An error occurred');
    expect(/[а-яёА-ЯЁ]/.test(lastEditText)).toBe(true);
  });

  test('run() breaks loop when model returns text without tool calls', async () => {
    const { impl, calls } = makeStreamImpl([{ kind: 'text', text: 'Done.' }]);
    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });
    await agent.run(ctx);
    expect(calls.length).toBe(1);
  });

  test('run() injects system prompt as the first message', async () => {
    const { impl, calls } = makeStreamImpl([{ kind: 'text', text: 'hi' }]);
    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });

    await agent.run(ctx);
    const firstCall = calls[0]!;
    const system = firstCall.messages.find((m) => m.role === 'system');
    expect(system).toBeDefined();
    expect(system!.content as string).toContain('calendar assistant');
  });

  test('buildMessages uses per-chat history in group context', async () => {
    const GROUP_CHAT_ID = -1001234;
    ctx.chatHistory.save(USER_ID, 'user', 'personal message');
    ctx.chatHistory.save(USER_ID, 'user', 'group message', GROUP_CHAT_ID);
    ctx.chatHistory.save(
      USER_ID,
      'assistant',
      JSON.stringify({ role: 'assistant', content: 'group reply' } satisfies OpenAI.ChatCompletionMessageParam),
      GROUP_CHAT_ID,
    );
    ctx.chatHistory.save(USER_ID, 'user', ctx.messageText, GROUP_CHAT_ID);

    ctx.isGroup = true;
    ctx.groupChatId = GROUP_CHAT_ID;
    ctx.groupTitle = 'Test Group';

    const agent = new CalendarBotAgent(config, sender);
    const personalHistory = ctx.chatHistory.getRecent(USER_ID);
    const { messages } = await agent.buildMessages(ctx, personalHistory);

    expect(messages.length).toBe(3);
    expect(messages[0]!.content as string).toContain('group message');
    expect(messages[1]!.content as string).toContain('group reply');
    expect(messages[2]!.content as string).toContain('Show my events today');
  });

  test('[SKIP] response in group sends nothing (no placeholder, no delete)', async () => {
    const { impl } = makeStreamImpl([{ kind: 'text', text: '[SKIP]' }]);
    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });
    const deleteMessage = mock(() => Promise.resolve());
    (sender as TelegramSender).deleteMessage = deleteMessage;

    ctx.isGroup = true;
    ctx.groupChatId = -100999;
    ctx.groupTitle = 'Test Group';

    await agent.run(ctx);

    expect(sender.sendMessage).toHaveBeenCalledTimes(0);
    expect(deleteMessage).toHaveBeenCalledTimes(0);
  });

  test('response containing [SKIP] anywhere is discarded in group', async () => {
    const { impl } = makeStreamImpl([{ kind: 'text', text: 'Got it [SKIP]' }]);
    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });
    const deleteMessage = mock(() => Promise.resolve());
    (sender as TelegramSender).deleteMessage = deleteMessage;

    ctx.isGroup = true;
    ctx.groupChatId = -100999;

    const result = await agent.run(ctx);

    expect(result.responseText).toBe('');
    expect(sender.sendMessage).toHaveBeenCalledTimes(0);
    expect(deleteMessage).toHaveBeenCalledTimes(0);
  });

  test('[SKIP] response in DM is discarded (placeholder deleted)', async () => {
    const { impl } = makeStreamImpl([{ kind: 'text', text: '[SKIP]' }]);
    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });
    const deleteMessage = mock(() => Promise.resolve());
    (sender as TelegramSender).deleteMessage = deleteMessage;

    ctx.isGroup = false;
    const result = await agent.run(ctx);

    expect(result.responseText).toBe('');
    expect(deleteMessage).toHaveBeenCalledTimes(1);
    expect(sender.editMessageText).not.toHaveBeenCalled();
  });

  test('[SKIP] with trailing whitespace is still discarded in group', async () => {
    const { impl } = makeStreamImpl([{ kind: 'text', text: '[SKIP]\n' }]);
    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });
    const deleteMessage = mock(() => Promise.resolve());
    (sender as TelegramSender).deleteMessage = deleteMessage;
    ctx.isGroup = true;
    ctx.groupChatId = -100999;
    ctx.groupTitle = 'Test Group';
    await agent.run(ctx);
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(sender.sendMessage).not.toHaveBeenCalled();
  });

  test('onBotResponse callback is called after finalize with message ID', async () => {
    const { impl } = makeStreamImpl([{ kind: 'text', text: 'Hello' }]);
    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });

    const onBotResponse = mock(() => {});
    ctx.onBotResponse = onBotResponse;

    await agent.run(ctx);

    expect(onBotResponse).toHaveBeenCalledTimes(1);
    expect(onBotResponse).toHaveBeenCalledWith(42);
  });

  test('onBotResponse is NOT called after [SKIP] discard', async () => {
    const { impl } = makeStreamImpl([{ kind: 'text', text: '[SKIP]' }]);
    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });

    const deleteMessage = mock(() => Promise.resolve());
    (sender as TelegramSender).deleteMessage = deleteMessage;

    const onBotResponse = mock(() => {});
    ctx.isGroup = true;
    ctx.groupChatId = -100999;
    ctx.groupTitle = 'Test Group';
    ctx.onBotResponse = onBotResponse;

    await agent.run(ctx);

    expect(onBotResponse).not.toHaveBeenCalled();
  });

  test('"..." response in group is discarded like [SKIP]', async () => {
    const { impl } = makeStreamImpl([{ kind: 'text', text: '...' }]);
    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });
    const deleteMessage = mock(() => Promise.resolve());
    (sender as TelegramSender).deleteMessage = deleteMessage;

    ctx.isGroup = true;
    ctx.groupChatId = -100999;
    ctx.groupTitle = 'Test Group';

    const result = await agent.run(ctx);

    expect(result.responseText).toBe('');
    expect(sender.sendMessage).toHaveBeenCalledTimes(0);
    expect(deleteMessage).toHaveBeenCalledTimes(0);
  });

  test('Unicode ellipsis "…" response in group is discarded like [SKIP]', async () => {
    const { impl } = makeStreamImpl([{ kind: 'text', text: '…' }]);
    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });
    const deleteMessage = mock(() => Promise.resolve());
    (sender as TelegramSender).deleteMessage = deleteMessage;

    ctx.isGroup = true;
    ctx.groupChatId = -100999;
    ctx.groupTitle = 'Test Group';

    const result = await agent.run(ctx);

    expect(result.responseText).toBe('');
    expect(sender.sendMessage).toHaveBeenCalledTimes(0);
    expect(deleteMessage).toHaveBeenCalledTimes(0);
  });

  test('set_reaction tool does not create a status message in group (silent tool)', async () => {
    const setReaction = mock(() => Promise.resolve());
    (sender as TelegramSender).setReaction = setReaction;
    const deleteMessage = mock(() => Promise.resolve());
    (sender as TelegramSender).deleteMessage = deleteMessage;

    const { impl } = makeStreamImpl([
      { kind: 'tool', callId: 'call-react', name: 'set_reaction', input: { emoji: '👌' } },
      { kind: 'text', text: '[SKIP]' },
    ]);
    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });

    ctx.isGroup = true;
    ctx.groupChatId = -100999;
    ctx.groupTitle = 'Test Group';
    ctx.incomingMessageId = 777;

    const result = await agent.run(ctx);

    expect(result.responseText).toBe('');
    // Silent tool must not create any placeholder message
    expect(sender.sendMessage).not.toHaveBeenCalled();
    // Reaction itself was executed
    expect(setReaction).toHaveBeenCalledTimes(1);
  });

  test('set_reaction tool in DM discards placeholder after [SKIP]', async () => {
    const setReaction = mock(() => Promise.resolve());
    (sender as TelegramSender).setReaction = setReaction;
    const deleteMessage = mock(() => Promise.resolve());
    (sender as TelegramSender).deleteMessage = deleteMessage;

    const { impl } = makeStreamImpl([
      { kind: 'tool', callId: 'call-react', name: 'set_reaction', input: { emoji: '👍' } },
      { kind: 'text', text: '[SKIP]' },
    ]);
    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });

    ctx.isGroup = false;
    ctx.incomingMessageId = 888;

    const result = await agent.run(ctx);

    expect(result.responseText).toBe('');
    // Placeholder ⏳ was created in init, then deleted by [SKIP] discard
    expect(sender.sendMessage).toHaveBeenCalledTimes(1);
    expect(deleteMessage).toHaveBeenCalledTimes(1);
    // No tool label should have been shown
    expect(sender.editMessageText).not.toHaveBeenCalled();
  });

  test('logAiTurn via ConversationLogger saves the assistant message with chatId in group context', () => {
    const GROUP_CHAT_ID = -1001234;
    ctx.isGroup = true;
    ctx.groupChatId = GROUP_CHAT_ID;

    const agent = new CalendarBotAgent(config, sender);
    const assistant: OpenAI.ChatCompletionMessageParam = { role: 'assistant', content: 'Group response' };
    agent.saveAssistantTurn(ctx, assistant);

    const chatHistory = ctx.chatHistory.getRecentByChat(GROUP_CHAT_ID, 10);
    expect(chatHistory.length).toBe(1);
    expect(chatHistory[0]!.role).toBe('assistant');
    const parsed = JSON.parse(chatHistory[0]!.content) as OpenAI.ChatCompletionMessageParam;
    expect(parsed.role).toBe('assistant');
    expect(parsed.content).toBe('Group response');
  });

  test('end_conversation tool stops loop and calls debugLogger.endSession', async () => {
    const { impl, calls } = makeStreamImpl([{ kind: 'tool', callId: 'call-end', name: 'end_conversation', input: {} }]);
    const endSession = mock(() => {});
    const debugLogger = {
      createRunContext: mock(() => null),
      endSession,
    } as Partial<AiDebugLogger> as AiDebugLogger;

    const agent = new CalendarBotAgent({ ...config, debugLogger }, sender, { streamImpl: impl });
    ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);

    const result = await agent.run(ctx);

    // Only one stream round — end_conversation has stopLoop=true via the tool handler
    expect(calls.length).toBe(1);
    expect(result.toolCalls.some((tc) => tc.name === 'end_conversation')).toBe(true);
    expect(endSession).toHaveBeenCalledWith(USER_ID);
  });

  // ── Regression: removing flush from onToolCallStart must not break normal tools ──

  test('normal tool in group still creates placeholder and shows tool label', async () => {
    const { impl } = makeStreamImpl([
      {
        kind: 'tool',
        callId: 'call-ev',
        name: 'get_events',
        input: { start_date: '2026-04-13', end_date: '2026-04-13' },
      },
      { kind: 'text', text: 'You have 0 events today.' },
    ]);
    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });

    ctx.isGroup = true;
    ctx.groupChatId = -100999;
    ctx.groupTitle = 'Test Group';

    await agent.run(ctx);

    // Tool loop flush MUST create a placeholder (noPlaceholder lazy create)
    // and edit it with the tool label.
    expect(sender.sendMessage).toHaveBeenCalled();
    expect(sender.editMessageText).toHaveBeenCalled();
    // Finalize edits the message with the final response
    const lastEdit = (sender.editMessageText as ReturnType<typeof mock>).mock.calls.at(-1)!;
    const finalHtml = lastEdit[2] as string;
    expect(finalHtml).toContain('0 events');
  });

  test('normal tool in DM shows tool label via edit (no extra messages)', async () => {
    const { impl } = makeStreamImpl([
      {
        kind: 'tool',
        callId: 'call-ev',
        name: 'get_events',
        input: { start_date: '2026-04-13', end_date: '2026-04-13' },
      },
      { kind: 'text', text: 'No events.' },
    ]);
    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });
    ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);

    await agent.run(ctx);

    // DM: 1 sendMessage (init placeholder), edits for tool label + finalize
    expect(sender.sendMessage).toHaveBeenCalledTimes(1);
    expect(sender.editMessageText).toHaveBeenCalled();
    const firstEdit = (sender.editMessageText as ReturnType<typeof mock>).mock.calls[0]!;
    const labelHtml = firstEdit[2] as string;
    // The tool label should contain the human-readable name, not raw "get_events"
    expect(labelHtml).toContain('📅');
  });

  // ── Regressions for bugs found by code review ─────────────────────────────

  test('rejected tool-less answer is NOT persisted to chat_history', async () => {
    // Scripted rounds: round 1 = text (will be rejected by forced validator), round 2 = text (retry passes)
    // But we need to override validator behaviour. Use a custom impl that:
    //   - Round 1: plain text (agent loop)
    //   - Validator call: REJECT
    //   - Round 2 (retry): plain text (no tools — retry loop breaks)
    //   - Second validator call: APPROVE (a second REJECT must not be persisted)
    let round = 0;
    let validationCalls = 0;
    const impl = async (opts: StreamRoundOptions) => {
      if (isValidatorCall(opts)) {
        const verdict = validationCalls++ === 0 ? 'REJECT: no tool used' : 'APPROVE';
        const msg: OpenAI.ChatCompletionMessageParam = { role: 'assistant', content: verdict };
        return {
          text: verdict,
          toolCalls: [],
          finishReason: 'stop' as const,
          assistantMessage: msg,
          providerUsed: 'mock-validator',
        };
      }
      round++;
      const text = round === 1 ? 'hallucinated answer' : 'corrected answer';
      const msg: OpenAI.ChatCompletionMessageParam = { role: 'assistant', content: text };
      return {
        text,
        toolCalls: [],
        finishReason: 'stop' as const,
        assistantMessage: msg,
        providerUsed: 'mock',
      };
    };

    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });
    ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);
    await agent.run(ctx);

    const history = ctx.chatHistory.getRecent(USER_ID);
    // Must contain the user message and the corrected answer, NOT the hallucination
    const assistantRows = history.filter((h) => h.role === 'assistant');
    const hasHallucination = assistantRows.some((h) => h.content.includes('hallucinated answer'));
    expect(hasHallucination).toBe(false);
    const hasCorrected = assistantRows.some((h) => h.content.includes('corrected answer'));
    expect(hasCorrected).toBe(true);
  });

  test('legacy Anthropic content-block assistant rows are flattened to readable text', async () => {
    const legacyBlocks = JSON.stringify([
      { type: 'text', text: 'Hello from the old SDK' },
      { type: 'tool_use', id: 'x', name: 'get_events', input: {} },
    ]);
    ctx.chatHistory.save(USER_ID, 'user', 'hi');
    ctx.chatHistory.save(USER_ID, 'assistant', legacyBlocks);

    const agent = new CalendarBotAgent(config, sender);
    const history = ctx.chatHistory.getRecent(USER_ID);
    const { messages } = await agent.buildMessages(ctx, history);

    const assistantMsg = messages.find((m) => m.role === 'assistant');
    expect(assistantMsg).toBeDefined();
    // Must be a plain string containing the legacy text — NOT the raw JSON blob
    expect(typeof assistantMsg!.content).toBe('string');
    expect(assistantMsg!.content as string).toContain('Hello from the old SDK');
    expect(assistantMsg!.content as string).not.toContain('"type":"text"');
  });

  test('voice_message mode returns plain text without execution log HTML', async () => {
    const { impl } = makeStreamImpl([
      {
        kind: 'tool',
        callId: 'call-1',
        name: 'get_events',
        input: { start_date: '2026-03-20', end_date: '2026-03-20' },
      },
      { kind: 'text', text: 'You have 0 events today.' },
    ]);
    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });

    const result = await agent.run({ ...ctx, inputMode: 'voice_message' });

    expect(result.responseText).toBe('You have 0 events today.');
    expect(result.responseText).not.toContain('<blockquote');
    expect(result.responseText).not.toContain('✅');
  });

  // ── In-run tool call dedup ─────────────────────────────────────────────────
  // Regression: a model that keeps calling render_day_image with the same date
  // (or any other tool with identical args) must NOT trigger the real handler
  // on every repeat — otherwise fire-and-forget render handlers spam the user
  // with duplicate photos inside a single agent run.

  test('duplicate tool calls with identical args are deduped within a run (no real execution)', async () => {
    const { impl } = makeStreamImpl([
      {
        kind: 'tool',
        callId: 'call-1',
        name: 'get_events',
        input: { start_date: '2026-04-16', end_date: '2026-04-16' },
      },
      {
        kind: 'tool',
        callId: 'call-2',
        name: 'get_events',
        // Same args — should be deduped
        input: { start_date: '2026-04-16', end_date: '2026-04-16' },
      },
      {
        kind: 'tool',
        callId: 'call-3',
        name: 'get_events',
        // Key-order variant — must still be detected as duplicate
        input: { end_date: '2026-04-16', start_date: '2026-04-16' },
      },
      { kind: 'text', text: 'No events.' },
    ]);

    // Spy on eventService.getEventsForDay — the real backing call for get_events.
    // It should fire exactly once; the other two are deduped.
    const originalGetEvents = ctx.eventService.getEventsInRange.bind(ctx.eventService);
    let realCallCount = 0;
    ctx.eventService.getEventsInRange = ((userId: number, start: string, end: string) => {
      realCallCount++;
      return originalGetEvents(userId, start, end);
    }) as typeof ctx.eventService.getEventsInRange;

    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });
    ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);

    const result = await agent.run(ctx);

    // All three tool calls recorded in the run result…
    expect(result.toolCalls.length).toBe(3);
    // …but the real backing service was invoked once.
    expect(realCallCount).toBe(1);
    // Two of the three results are synthetic DUPLICATE markers.
    const duplicateResults = result.toolResults.filter((r) => (r.output ?? '').includes('DUPLICATE'));
    expect(duplicateResults.length).toBe(2);
  });

  test('dedup key normalizes argument key order', async () => {
    // Two calls with same semantic args but different key order must be deduped.
    const { impl } = makeStreamImpl([
      {
        kind: 'tool',
        callId: 'call-1',
        name: 'get_events',
        input: { start_date: '2026-04-16', end_date: '2026-04-16' },
      },
      {
        kind: 'tool',
        callId: 'call-2',
        name: 'get_events',
        input: { end_date: '2026-04-16', start_date: '2026-04-16' },
      },
      { kind: 'text', text: 'ok' },
    ]);

    let realCallCount = 0;
    const originalGetEvents = ctx.eventService.getEventsInRange.bind(ctx.eventService);
    ctx.eventService.getEventsInRange = ((userId: number, start: string, end: string) => {
      realCallCount++;
      return originalGetEvents(userId, start, end);
    }) as typeof ctx.eventService.getEventsInRange;

    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });
    ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);
    await agent.run(ctx);

    expect(realCallCount).toBe(1);
  });

  test('run() error skips stall phrase and retry when wasExplicitInvocation is false', async () => {
    const { impl } = makeStreamImpl([{ kind: 'error', error: new Error('provider failed') }]);
    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });

    const retryEnqueue = mock(() => Promise.resolve());
    ctx.wasExplicitInvocation = false;
    ctx.retryEnqueue = retryEnqueue;
    ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);

    await agent.run(ctx);

    // No retry queued for non-explicit invocation
    expect(retryEnqueue).not.toHaveBeenCalled();
    // No stall assistant turn saved — history has only the user message
    const history = ctx.chatHistory.getRecent(USER_ID);
    const assistantRows = history.filter((h) => h.role === 'assistant');
    expect(assistantRows.length).toBe(0);
  });

  test('different args with same tool name are NOT deduped', async () => {
    const { impl } = makeStreamImpl([
      {
        kind: 'tool',
        callId: 'call-1',
        name: 'get_events',
        input: { start_date: '2026-04-16', end_date: '2026-04-16' },
      },
      {
        kind: 'tool',
        callId: 'call-2',
        name: 'get_events',
        // Different date — must execute for real
        input: { start_date: '2026-04-17', end_date: '2026-04-17' },
      },
      { kind: 'text', text: 'ok' },
    ]);

    let realCallCount = 0;
    const originalGetEvents = ctx.eventService.getEventsInRange.bind(ctx.eventService);
    ctx.eventService.getEventsInRange = ((userId: number, start: string, end: string) => {
      realCallCount++;
      return originalGetEvents(userId, start, end);
    }) as typeof ctx.eventService.getEventsInRange;

    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });
    ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);
    await agent.run(ctx);

    expect(realCallCount).toBe(2);
  });

  test('duplicate tool result is passed back to the model in the next round', async () => {
    // Model sees the DUPLICATE marker in the tool result and should use it to
    // understand the call was skipped. Verify the model input on round 3
    // contains the synthetic tool result for call-2.
    const { impl, calls } = makeStreamImpl([
      {
        kind: 'tool',
        callId: 'call-1',
        name: 'get_events',
        input: { start_date: '2026-04-16', end_date: '2026-04-16' },
      },
      {
        kind: 'tool',
        callId: 'call-2',
        name: 'get_events',
        input: { start_date: '2026-04-16', end_date: '2026-04-16' },
      },
      { kind: 'text', text: 'final' },
    ]);

    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });
    ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);
    await agent.run(ctx);

    // The third model call (after 2 tool rounds) must see call-2's result,
    // and that result must contain DUPLICATE.
    const thirdCall = calls[2];
    expect(thirdCall).toBeDefined();
    const toolMessagesInThirdCall = thirdCall!.messages.filter((m) => m.role === 'tool');
    const call2Result = toolMessagesInThirdCall.find(
      (m) => 'tool_call_id' in m && (m as { tool_call_id: string }).tool_call_id === 'call-2',
    );
    expect(call2Result).toBeDefined();
    const content = (call2Result as { content: string }).content;
    expect(content).toContain('DUPLICATE');
  });

  // ── Regression: error delivery guarantee ────────────────────────────────

  test('run() catches stream error and delivers stall phrase to user', async () => {
    const { impl } = makeStreamImpl([{ kind: 'error', error: new Error('All providers failed') }]);
    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });
    ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);

    const result = await agent.run(ctx);

    // REGRESSION: before the fix, an unhandled error could leave the user
    // with just ⏳ and no response. On error, a stall phrase from the declared
    // phrase set is appended (wasExplicitInvocation defaults to undefined, treated as explicit).
    const editCalls = (sender.editMessageText as ReturnType<typeof mock>).mock.calls;
    const finalEdit = editCalls[editCalls.length - 1] as unknown[];
    const finalText = finalEdit[2] as string;
    // The delivered text must be a member of the English stall-phrase set.
    const allPhrases = [...EN_AGENT_ERROR_PHRASES, ...RU_AGENT_ERROR_PHRASES];
    expect(allPhrases.some((phrase) => finalText.includes(phrase))).toBe(true);
    expect(allPhrases.some((phrase) => result.responseText.includes(phrase))).toBe(true);
  });

  test('run() in group mode (noPlaceholder) handles error without leaving orphan messages', async () => {
    const { impl } = makeStreamImpl([{ kind: 'error', error: new Error('Provider timeout') }]);
    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });
    ctx.isGroup = true;
    ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);

    const result = await agent.run(ctx);

    // In group mode (noPlaceholder), no ⏳ is sent. On error, the stall phrase
    // is delivered as a single message (no orphan ⏳ left behind).
    const sendCalls = (sender.sendMessage as ReturnType<typeof mock>).mock.calls;
    expect(sendCalls.length).toBe(1);
    const sentText = (sendCalls[0] as unknown[])[1] as string;
    const allPhrases = [...EN_AGENT_ERROR_PHRASES, ...RU_AGENT_ERROR_PHRASES];
    expect(allPhrases.some((phrase) => sentText.includes(phrase))).toBe(true);
    expect(allPhrases.some((phrase) => result.responseText.includes(phrase))).toBe(true);
  });

  test('agent catch block stall phrase is localized via t() for both languages', async () => {
    // Verify English stall phrase comes from the English phrase set.
    const { impl: implEn } = makeStreamImpl([{ kind: 'error', error: new Error('All providers failed') }]);
    const agentEn = new CalendarBotAgent(config, sender, { streamImpl: implEn });
    ctx.user = { ...ctx.user, language: 'en' };
    ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);
    const resultEn = await agentEn.run(ctx);
    expect(
      EN_AGENT_ERROR_PHRASES.some((phrase) => resultEn.responseText.includes(phrase)),
      `EN responseText "${resultEn.responseText}" must contain an English stall phrase`,
    ).toBe(true);

    // Verify Russian stall phrase comes from the Russian phrase set. The
    // notice tracker deliberately suppresses a second apology within the
    // cooldown, so this second outage starts from a clean slate.
    aiFailureNotices.reset();
    const { impl: implRu } = makeStreamImpl([{ kind: 'error', error: new Error('All providers failed') }]);
    const agentRu = new CalendarBotAgent(config, sender, { streamImpl: implRu });
    ctx.user = { ...ctx.user, language: 'ru' };
    const resultRu = await agentRu.run(ctx);
    expect(
      RU_AGENT_ERROR_PHRASES.some((phrase) => resultRu.responseText.includes(phrase)),
      `RU responseText "${resultRu.responseText}" must contain a Russian stall phrase`,
    ).toBe(true);
  });
});
