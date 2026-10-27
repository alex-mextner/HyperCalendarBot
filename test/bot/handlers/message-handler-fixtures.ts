// test/bot/handlers/message-handler-fixtures.ts
// Shared dependency and context factories for the message handler test files.

import { type Mock, mock } from 'bun:test';
import type { MessageHandlerDeps } from '../../../src/bot/handlers/message/types.ts';
import type { BotCommandContext } from '../../../src/bot/types.ts';
import { stub } from '../partial-stub.ts';
import { makeUserRow, sentMessage, telegramChat, telegramUser } from '../telegram-fixtures.ts';

export function makeDeps(overrides: { [key: string]: unknown } = {}) {
  return {
    agent: { run: mock(() => Promise.resolve()) },
    eventService: { getEventsInRange: mock(() => []), getLatestCreated: mock(() => null) },
    holidayService: {},
    chatHistory: {},
    conversationLogger: { logUserMessage: mock(() => {}), logBotResponse: mock(() => {}) },
    userRepo: {},
    eventReminderRepo: {},
    sceneStorage: { get: mock(() => Promise.resolve(null)) },
    botUsername: 'TestBot',
    ...overrides,
  };
}

export interface MockCtxOverrides {
  dbUser?: Partial<import('../../../src/database/types.ts').User> | undefined;
  text?: string | undefined;
  chatId?: number;
  chat?: { type: string; title?: string };
  from?: { firstName?: string; username?: string; id?: number; first_name?: string };
  send?: ReturnType<typeof mock>;
  voice?: { file_id: string; duration: number };
  scene?: { enter: ReturnType<typeof mock> };
  replyMessage?: { from: { id: number } };
}

export function makeCtx(overrides: MockCtxOverrides = {}) {
  return {
    dbUser: { telegram_id: 100, language: 'ru', timezone: 'UTC' },
    text: 'привет',
    chatId: 100,
    chat: { type: 'private' },
    from: { firstName: 'Alex', username: 'alex' },
    send: mock(() => Promise.resolve()),
    ...overrides,
  };
}

/** The command context a message handler receives, with `send` kept as the recording mock. */
export type MessageCtx = BotCommandContext & { send: Mock<BotCommandContext['send']> };

/**
 * A private text message from an onboarded Russian-speaking user. Members the handler probes but a plain text
 * message lacks are listed as `undefined`; anything else the handler reads must be added by the test, or the
 * double throws.
 */
export function makeMessageCtx(overrides: Partial<MessageCtx> = {}): MessageCtx {
  return stub<MessageCtx>({
    id: 1,
    threadId: undefined,
    venue: undefined,
    location: undefined,
    voice: undefined,
    replyMessage: undefined,
    text: 'привет',
    chatId: 100,
    chat: telegramChat('private', 100),
    from: telegramUser({ id: 100, first_name: 'Alex', username: 'alex' }),
    dbUser: makeUserRow({ telegram_id: 100, language: 'ru', timezone: 'UTC' }),
    send: mock<BotCommandContext['send']>(() => Promise.resolve(sentMessage())),
    ...overrides,
  });
}

/** Message handler dependencies: the required ones stubbed for a plain text turn; `overrides` replace or add. */
export function makeHandlerDeps(overrides: Partial<MessageHandlerDeps> = {}): MessageHandlerDeps {
  return {
    agent: stub({ run: mock(() => Promise.resolve({ responseText: '', toolCalls: [], toolResults: [] })) }),
    eventService: stub({ getEventsInRange: mock(() => []), getLatestCreated: mock(() => null) }),
    holidayService: stub({}),
    chatHistory: stub({}),
    conversationLogger: stub({ logUserMessage: mock(() => 1), logBotResponse: mock(() => {}) }),
    userRepo: stub({}),
    eventReminderRepo: stub({}),
    sceneStorage: stub({ get: mock(() => Promise.resolve(null)) }),
    botUsername: 'TestBot',
    ...overrides,
  };
}
