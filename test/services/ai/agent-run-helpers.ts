// Shared fixtures for the CalendarBotAgent.run() suites (agent-run-*.test.ts): scripted
// stream implementations, a fresh per-test agent context and event/invitation builders.
import { Database } from 'bun:sqlite';
import { type Mock, mock } from 'bun:test';
import type OpenAI from 'openai';
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
import { aiFailureNotices } from '../../../src/services/ai/agent.ts';
import type { StreamCallbacks, StreamRoundOptions, StreamRoundResult } from '../../../src/services/ai/streaming.ts';
import { _resetToolThrottleForTest } from '../../../src/services/ai/tool-executor.ts';
import type { AgentConfig, AgentContext, TelegramSender } from '../../../src/services/ai/types.ts';
import { ConversationLogger } from '../../../src/services/conversation-logger.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../src/services/holiday/holiday-service.ts';
import { InvitationService } from '../../../src/services/sharing/invitation-service.ts';
import { PrivacyService } from '../../../src/services/sharing/privacy-service.ts';
import { SharingService } from '../../../src/services/sharing/sharing-service.ts';

export function createTestDb() {
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

export type ScriptedRound =
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

export function fakeMetrics(provider: 'zai' | 'hf', promptTokens: number, completionTokens: number) {
  return {
    provider,
    model: provider === 'hf' ? 'validator-model' : 'agent-model',
    chain: provider === 'hf' ? ('fast' as const) : ('smart' as const),
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

export function isValidatorCall(opts: StreamRoundOptions): boolean {
  // The response validator always sends a 2-message payload (system + user)
  // whose system prompt starts with "You are a strict QA validator".
  const system = opts.messages[0];
  if (!system || system.role !== 'system' || typeof system.content !== 'string') return false;
  return system.content.includes('strict QA validator');
}

/** Every text the stream writer showed through message edits, in order. */
export function shownEdits(sender: TelegramSender): string[] {
  return (sender.editMessageText as Mock<TelegramSender['editMessageText']>).mock.calls.map((call) => String(call[2]));
}

export function makeStreamImpl(script: ScriptedRound[]): {
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
        metrics: fakeMetrics('hf', 10, 2),
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

export const USER_ID = 456;

export interface AgentRunFixture {
  db: Database;
  ctx: AgentContext;
  config: AgentConfig;
  sender: TelegramSender;
}

/** Fresh database, agent context and fake sender; call from each suite's beforeEach. */
export function createAgentRunFixture(): AgentRunFixture {
  // Module-level throttle state must be reset between tests so repeated
  // (tool, args) combinations across tests don't cross-contaminate.
  _resetToolThrottleForTest();
  // Per-user stall/honest notices are rate limited at module scope — reset so
  // one test's apology does not silence the next test's.
  aiFailureNotices.reset();
  const db = createTestDb();
  const userRepo = new UserRepository(db);
  const eventRepo = new EventRepository(db);
  const eventReminderRepo = new EventReminderRepository(db);
  const chatHistoryRepo = new ChatHistoryRepository(db);
  const holidayRepo = new HolidayRepository(db);
  userRepo.create({ telegram_id: USER_ID, timezone: 'UTC', language: 'en' });
  const eventService = new EventService({ eventRepo });
  const holidayService = new HolidayService(holidayRepo);
  const ctx: AgentContext = {
    user: userRepo.findByTelegramId(USER_ID)!,
    chatId: USER_ID,
    // No day word: tests here script tool calls on arbitrary dates, and a named day
    // ("today") would make the weekday guard reject them.
    messageText: 'Show my events',
    isGroup: false,
    eventService,
    holidayService,
    chatHistory: chatHistoryRepo,
    conversationLogger: new ConversationLogger(chatHistoryRepo),
    userRepo,
    eventReminderRepo,
    // A stall phrase promises a comeback, so the agent only sends one when a
    // retry is actually scheduled. Wire a no-op enqueue for the error tests.
    retryEnqueue: async () => true,
  };
  const config: AgentConfig = {};
  const sender: TelegramSender = {
    sendMessage: mock(() => Promise.resolve({ message_id: 42 })),
    editMessageText: mock(() => Promise.resolve()),
  };
  return { db, ctx, config, sender };
}

/** Wires the sharing services onto ctx and returns an event owned by the test user. */
export function setupInvitations(db: Database, ctx: AgentContext) {
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
  return createOwnedEvent(ctx);
}

export function createOwnedEvent(ctx: AgentContext) {
  return ctx.eventService.createEvent({
    user_id: USER_ID,
    title: '<b>private title</b>',
    start_at: new Date(Date.now() + 86400000).toISOString(),
    timezone: 'UTC',
  });
}
