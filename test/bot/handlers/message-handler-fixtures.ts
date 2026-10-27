// test/bot/handlers/message-handler-fixtures.ts
// Shared dependency and context factories for the message handler test files.

import { mock } from 'bun:test';

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
