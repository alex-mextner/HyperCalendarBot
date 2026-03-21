import { describe, expect, test } from 'bun:test';
import type { ChatHistoryRepository } from '../../src/database/repositories/chat-history.repository.ts';
import { formatActivityEvent } from '../../src/services/ai/activity-event.ts';
import { ConversationLogger } from '../../src/services/conversation-logger.ts';

function makeRepo() {
  const calls: unknown[][] = [];
  const repo = {
    save: (...args: unknown[]) => {
      calls.push(args);
    },
    _calls: calls,
  } as unknown as ChatHistoryRepository & { _calls: unknown[][] };
  return repo;
}

describe('ConversationLogger', () => {
  test('logUserMessage saves plain text as user role without chatId', () => {
    const repo = makeRepo();
    new ConversationLogger(repo).logUserMessage(123, 'hello');
    expect(repo._calls).toHaveLength(1);
    expect(repo._calls[0]).toEqual([123, 'user', 'hello', undefined]);
  });

  test('logUserMessage passes chatId when provided', () => {
    const repo = makeRepo();
    new ConversationLogger(repo).logUserMessage(123, 'hi', 456);
    expect(repo._calls[0]).toEqual([123, 'user', 'hi', 456]);
  });

  test('logBotResponse saves assistant role with kind:bot wrapper', () => {
    const repo = makeRepo();
    new ConversationLogger(repo).logBotResponse(123, 'Done!');
    expect(repo._calls[0]![1]).toBe('assistant');
    expect(JSON.parse(repo._calls[0]![2] as string)).toEqual({ kind: 'bot', text: 'Done!' });
  });

  test('logCommand saves user role with kind:command wrapper', () => {
    const repo = makeRepo();
    new ConversationLogger(repo).logCommand(123, '/start');
    expect(JSON.parse(repo._calls[0]![2] as string)).toEqual({ kind: 'command', name: '/start' });
  });

  test('logCommand includes args when provided', () => {
    const repo = makeRepo();
    new ConversationLogger(repo).logCommand(123, '/today', '15 марта');
    expect(JSON.parse(repo._calls[0]![2] as string)).toEqual({ kind: 'command', name: '/today', args: '15 марта' });
  });

  test('logCommand omits args key when args is undefined', () => {
    const repo = makeRepo();
    new ConversationLogger(repo).logCommand(123, '/start', undefined);
    const saved = JSON.parse(repo._calls[0]![2] as string);
    expect(saved).not.toHaveProperty('args');
  });

  test('logCommand passes chatId as 4th param', () => {
    const repo = makeRepo();
    new ConversationLogger(repo).logCommand(123, '/cal', 'text', 456);
    expect(repo._calls[0]![3]).toBe(456);
  });

  test('logButtonPress saves user role with kind:button wrapper', () => {
    const repo = makeRepo();
    new ConversationLogger(repo).logButtonPress(123, 'accept', 'id:42');
    expect(JSON.parse(repo._calls[0]![2] as string)).toEqual({ kind: 'button', label: 'accept', detail: 'id:42' });
  });

  test('logButtonPress passes chatId', () => {
    const repo = makeRepo();
    new ConversationLogger(repo).logButtonPress(123, 'ok', undefined, 999);
    expect(repo._calls[0]![3]).toBe(999);
  });

  test('logBotEdit saves assistant role with kind:bot_edit wrapper', () => {
    const repo = makeRepo();
    new ConversationLogger(repo).logBotEdit(123, 'corrected');
    expect(repo._calls[0]![1]).toBe('assistant');
    expect(JSON.parse(repo._calls[0]![2] as string)).toEqual({ kind: 'bot_edit', text: 'corrected' });
  });

  test('logEditedMessage saves user role with kind:edited wrapper', () => {
    const repo = makeRepo();
    new ConversationLogger(repo).logEditedMessage(123, 'corrected');
    expect(JSON.parse(repo._calls[0]![2] as string)).toEqual({ kind: 'edited', text: 'corrected' });
  });

  test('logAiTurn saves assistant role with JSON-stringified blocks', () => {
    const repo = makeRepo();
    const blocks = [{ type: 'text', text: 'hello' }];
    new ConversationLogger(repo).logAiTurn(123, blocks as never);
    expect(repo._calls[0]![1]).toBe('assistant');
    expect(JSON.parse(repo._calls[0]![2] as string)).toEqual(blocks);
  });

  test('logToolResults saves tool role', () => {
    const repo = makeRepo();
    new ConversationLogger(repo).logToolResults(123, [] as never);
    expect(repo._calls[0]![1]).toBe('tool');
  });
});

// Verify every format written by ConversationLogger is readable by get_history's formatContent.
// formatContent is module-private; test via formatActivityEvent which it delegates to for kind objects.
describe('ConversationLogger — get_history format compatibility', () => {
  test('logBotResponse format renders via formatActivityEvent', () => {
    expect(formatActivityEvent({ kind: 'bot', text: 'Hello!' })).toBe('[Bot: Hello!]');
  });

  test('logCommand format renders via formatActivityEvent', () => {
    expect(formatActivityEvent({ kind: 'command', name: '/agenda' })).toBe('[Command: /agenda]');
  });

  test('logButtonPress format renders via formatActivityEvent', () => {
    expect(formatActivityEvent({ kind: 'button', label: 'accept', detail: '42' })).toBe('[Button: "accept"] (42)');
  });

  test('logBotEdit format renders via formatActivityEvent', () => {
    expect(formatActivityEvent({ kind: 'bot_edit', text: 'corrected reply' })).toBe('[Bot edited: corrected reply]');
  });

  test('logEditedMessage format renders via formatActivityEvent', () => {
    expect(formatActivityEvent({ kind: 'edited', text: 'fixed text' })).toBe('[Edited: fixed text]');
  });
});
