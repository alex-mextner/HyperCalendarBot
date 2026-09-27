// test/services/ai/provider-request-transcript.test.ts
// Regression for the 2026-09-27 incident: after a pick_users exchange the
// 30-row chat_history window began on a stored tool result whose assistant
// tool_calls row had just fallen out of the window. That orphan result reached
// the providers, so Groq (gpt-oss) answered 400 "HarmonyError ... Tools should
// have a name!" — a tool message's name is resolved from its tool_call_id — and
// Gemini's OpenAI-compatible route answered 400 with no body, on every round.
// The requests are captured at the provider client, exactly as serialized.

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type OpenAI from 'openai';
import { migrations } from '../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../../src/database/repositories/event-reminder.repository.ts';
import { HolidayRepository } from '../../../src/database/repositories/holiday.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { CalendarBotAgent } from '../../../src/services/ai/agent.ts';
import { closeGeminiQuotaStores } from '../../../src/services/ai/gemini-quota.ts';
import { resetProviderCircuit } from '../../../src/services/ai/provider-circuit.ts';
import { resetEligibility } from '../../../src/services/ai/provider-eligibility.ts';
import { providerClients } from '../../../src/services/ai/streaming.ts';
import type { AgentContext, TelegramSender } from '../../../src/services/ai/types.ts';
import { ConversationLogger } from '../../../src/services/conversation-logger.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../src/services/holiday/holiday-service.ts';

type ProviderUnderTest = 'groq' | 'gemini';

interface CapturedRequest {
  messages: OpenAI.ChatCompletionMessageParam[];
  tools?: OpenAI.ChatCompletionTool[];
}

interface FakeClient {
  chat: {
    completions: {
      create: (params: CapturedRequest) => Promise<AsyncIterable<OpenAI.ChatCompletionChunk>>;
    };
  };
}

/** The agent only touches chat.completions.create; the partial fake is presented as a client here only. */
function asOpenAIClient(fake: FakeClient): OpenAI {
  return fake as unknown as OpenAI;
}

function chunk(delta: { content?: string }, finishReason: 'stop' | null): OpenAI.ChatCompletionChunk {
  return {
    id: 'chunk',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'fake',
    choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
  };
}

/** Records every serialized request and answers with a silent [SKIP] so the run ends after one round. */
function capturingClient(captured: CapturedRequest[]): FakeClient {
  return {
    chat: {
      completions: {
        create: async (params) => {
          captured.push(structuredClone({ messages: params.messages, tools: params.tools }));
          async function* stream(): AsyncGenerator<OpenAI.ChatCompletionChunk> {
            yield chunk({ content: '[SKIP]' }, null);
            yield chunk({}, 'stop');
          }
          return stream();
        },
      },
    },
  };
}

function refusingClient(): FakeClient {
  return {
    chat: {
      completions: {
        create: async () => {
          throw new Error('provider outside this test must not be called');
        },
      },
    },
  };
}

/**
 * Harmony renders a tool result under the name of the call it answers, found by
 * tool_call_id in the assistant tool_calls block directly above it. Returns every
 * way the request would leave a tool, call or result without a name.
 */
function namelessToolItems(request: CapturedRequest): string[] {
  const problems: string[] = [];
  for (const tool of request.tools ?? []) {
    if (tool.type !== 'function' || !tool.function.name) problems.push(`tool definition ${JSON.stringify(tool)}`);
  }
  let openCalls = new Map<string, string>();
  request.messages.forEach((message, index) => {
    if (message.role === 'assistant') {
      openCalls = new Map();
      for (const call of message.tool_calls ?? []) {
        const name = call.type === 'function' ? call.function.name : '';
        if (!call.id || !name) problems.push(`message ${index}: tool call without id or name`);
        openCalls.set(call.id, name);
      }
      return;
    }
    if (message.role !== 'tool') {
      openCalls = new Map();
      return;
    }
    const name = openCalls.get(message.tool_call_id);
    if (!name) problems.push(`message ${index}: tool result ${message.tool_call_id} answers no call above it`);
    openCalls.delete(message.tool_call_id);
  });
  return problems;
}

const USER_ID = 900_001;

function toolCallTurn(id: string, name: string, args: string): string {
  return JSON.stringify({
    role: 'assistant',
    content: null,
    tool_calls: [{ id, type: 'function', function: { name, arguments: args } }],
  });
}

function toolResultRow(id: string, content: string): string {
  return JSON.stringify([{ role: 'tool', tool_call_id: id, content }]);
}

/**
 * Anonymized shape of the incident chat, oldest first: an older settings
 * exchange, then a meeting request that ends in pick_users and the picker's
 * acknowledgement. 36 rows, so the 30-row window starts on the result of
 * `call_old_2` while the assistant turn that made that call is cut off.
 */
function seedIncidentHistory(history: ChatHistoryRepository): void {
  const rows: ['user' | 'assistant' | 'tool', string][] = [
    ['user', 'Do not send the morning agenda'],
    ['assistant', toolCallTurn('call_old_1', 'manage_settings', '{"key":"morning_agenda","value":"off"}')],
    ['tool', toolResultRow('call_old_1', 'Setting updated')],
    ['assistant', JSON.stringify({ role: 'assistant', content: 'Done, no morning agenda.' })],
    ['user', 'Only send it when there are events'],
    ['assistant', toolCallTurn('call_old_2', 'manage_settings', '{"key":"morning_agenda","value":"on"}')],
    ['tool', toolResultRow('call_old_2', 'Setting updated')],
    ['assistant', toolCallTurn('call_old_3', 'manage_settings', '{"key":"skip_empty_agenda","value":"on"}')],
    ['tool', toolResultRow('call_old_3', 'Setting updated')],
    ['assistant', JSON.stringify({ role: 'assistant', content: 'Agenda only on days with events.' })],
    ['user', '/settings'],
    ['assistant', 'Settings menu'],
    ['user', '[Button: "Agenda"]'],
    ['assistant', 'Agenda settings'],
    ['user', '[Button: "Back"]'],
    ['assistant', 'Settings menu'],
    ['user', '[Button: "Close"]'],
    ['assistant', 'Closed'],
    ['assistant', 'Morning agenda'],
    ['user', 'Add a meeting today at 15 with Anna, Boris, Clara and me'],
    ['assistant', toolCallTurn('call_1', 'calculate', '{"expression":"15-2"}')],
    ['tool', toolResultRow('call_1', '13')],
    ['assistant', toolCallTurn('call_2', 'create_event', '{"title":"Meeting","start_at":"today 15:00"}')],
    ['tool', toolResultRow('call_2', 'Event created (id 1)')],
    ['assistant', toolCallTurn('call_3', 'get_contacts', '{}')],
    ['tool', toolResultRow('call_3', 'No contacts')],
    ['assistant', toolCallTurn('call_4', 'find_contact', '{"query":"Anna"}')],
    ['tool', toolResultRow('call_4', 'Not found')],
    ['assistant', toolCallTurn('call_5', 'find_contact', '{"query":"Boris"}')],
    ['tool', toolResultRow('call_5', 'Not found')],
    ['assistant', toolCallTurn('call_6', 'find_contact', '{"query":"Clara"}')],
    ['tool', toolResultRow('call_6', 'Not found')],
    ['assistant', toolCallTurn('call_7', 'pick_users', '{"event_id":1}')],
    ['tool', toolResultRow('call_7', 'Picker shown, waiting for the user')],
    ['assistant', 'Sending invitations to 3 people'],
    ['assistant', 'Invitations: 3 sent'],
  ];
  for (const [role, content] of rows) history.save(USER_ID, role, content);
}

const PICKER_RESULT =
  '[User picker result] Delivery was attempted for the selected people. Selected: Anna id:900002, ' +
  'Boris id:900003, Clara id:900004. Delivery results:\n- Anna: delivered\n- Boris: delivered\n- Clara: link sent';

const realProviderClients = { ...providerClients };
const savedEnv = { ...process.env };

let ctx: AgentContext;
let sender: TelegramSender;

beforeEach(() => {
  Object.assign(process.env, {
    BOT_TOKEN: 'test-token',
    REDIS_URL: 'redis://localhost:6379',
    ZAI_API_KEY: 'zai-key',
    ZAI_BASE_URL: 'https://zai.example/v1',
    ZAI_MODEL: 'zai-main',
    ZAI_FAST_MODEL: 'zai-fast',
    GROQ_API_KEY: 'groq-key',
    GROQ_MODEL: 'openai/gpt-oss-120b',
    GROQ_FAST_MODEL: 'openai/gpt-oss-20b',
    // Production account limit; the on-demand default would skip the full-catalog request as too large.
    GROQ_TPM_LIMITS: '{"openai/gpt-oss-120b":250000,"openai/gpt-oss-20b":250000}',
    GEMINI_API_KEY: 'gemini-key',
    GEMINI_BASE_URL: 'https://gemini.example/v1',
    GEMINI_MODEL: 'models/gemini-2.5-flash',
    GEMINI_FAST_MODEL: 'models/gemini-2.5-flash',
    HF_TOKEN: 'hf-token',
    HF_BASE_URL: 'https://hf.example/v1',
    HF_MODEL: 'hf-main',
    HF_FAST_MODEL: 'hf-fast',
  });
  resetEligibility();
  resetProviderCircuit();

  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  const userRepo = new UserRepository(db);
  const chatHistory = new ChatHistoryRepository(db);
  userRepo.create({ telegram_id: USER_ID, timezone: 'Europe/Belgrade', language: 'en' });
  seedIncidentHistory(chatHistory);
  ctx = {
    user: userRepo.findByTelegramId(USER_ID)!,
    chatId: USER_ID,
    messageText: PICKER_RESULT,
    isGroup: false,
    eventService: new EventService({ eventRepo: new EventRepository(db) }),
    holidayService: new HolidayService(new HolidayRepository(db)),
    chatHistory,
    conversationLogger: new ConversationLogger(chatHistory),
    userRepo,
    eventReminderRepo: new EventReminderRepository(db),
  };
  sender = {
    sendMessage: mock(() => Promise.resolve({ message_id: 1 })),
    editMessageText: mock(() => Promise.resolve()),
  };
});

afterEach(() => {
  closeGeminiQuotaStores();
  resetProviderCircuit();
  process.env = { ...savedEnv };
  Object.assign(providerClients, realProviderClients);
});

describe('serialized provider request after a pick_users exchange', () => {
  test('the incident window starts on a tool result whose call was cut off', () => {
    const window = ctx.chatHistory.getRecent(USER_ID, 30);
    expect(window[0]?.role).toBe('tool');
    expect(window[0]?.content).toContain('call_old_2');
  });

  for (const provider of ['groq', 'gemini'] satisfies ProviderUnderTest[]) {
    for (const toolSchemaMode of ['full', 'lazy'] as const) {
      test(`${provider} (${toolSchemaMode} tools): every tool, call and result carries a resolvable name`, async () => {
        process.env.AI_SMART_CHAIN = provider;
        process.env.AI_FAST_CHAIN = provider;
        const captured: CapturedRequest[] = [];
        providerClients.zai = () => asOpenAIClient(refusingClient());
        providerClients.hf = () => asOpenAIClient(refusingClient());
        providerClients.groq = () => asOpenAIClient(provider === 'groq' ? capturingClient(captured) : refusingClient());
        providerClients.gemini = () =>
          asOpenAIClient(provider === 'gemini' ? capturingClient(captured) : refusingClient());

        await new CalendarBotAgent({ toolSchemaMode }, sender).run(ctx);

        expect(captured.length).toBeGreaterThan(0);
        const request = captured[0]!;
        expect(request.tools?.length ?? 0).toBeGreaterThan(0);
        for (const sent of captured) expect(namelessToolItems(sent)).toEqual([]);
        // The complete pick_users exchange still reaches the model.
        const pickResult = request.messages.findIndex((m) => m.role === 'tool' && m.tool_call_id === 'call_7');
        expect(pickResult).toBeGreaterThan(0);
        const pickCall = request.messages[pickResult - 1];
        expect(pickCall?.role === 'assistant' && pickCall.tool_calls?.[0]?.id).toBe('call_7');
      });
    }
  }
});
