import { describe, expect, mock, test } from 'bun:test';
import type { Intent, User } from '../../src/database/types.ts';
import type { AgentContext, ToolResult } from '../../src/services/ai/types.ts';
import type { EventSummary } from '../../src/services/intent/variable-resolver.ts';
import { createSyntheticIntentRun, type SyntheticIntentRunDeps } from '../../src/worker/synthetic-intent-runner.ts';

/** Match result shape from IntentMatcher.match() */
interface MatchResult {
  intentId: number;
  captures: Record<string, string>;
}

/** Executor result shape returned by IntentExecutor.run() */
interface ExecutorResult {
  success: boolean;
  response?: string;
  responseEvents?: EventSummary[];
}

/**
 * Mock interfaces matching what createSyntheticIntentRun uses from its dependencies.
 * IntentMatcher, IntentRepository, IntentExecutor are classes with private members,
 * so structural mocks need a boundary assertion.
 */
interface MockMatcher {
  match: ReturnType<typeof mock<(text: string) => MatchResult | null>>;
}

interface MockIntentRepo {
  getById: ReturnType<typeof mock<(id: number) => Partial<Intent> | null>>;
}

interface MockExecutor {
  run: ReturnType<typeof mock<(...args: unknown[]) => Promise<ExecutorResult>>>;
}

function makeMatcher(match: MatchResult | null = null): MockMatcher {
  return { match: mock(() => match) };
}

function makeIntentRepo(intent: Partial<Intent> | null = null): MockIntentRepo {
  return { getById: mock(() => intent) };
}

function makeExecutor(result: ExecutorResult = { success: true, response: 'done' }): MockExecutor {
  return { run: mock(() => Promise.resolve(result)) };
}

function makeExecuteTool() {
  return mock((_agentCtx: AgentContext, _name: string, _input: unknown): ToolResult | Promise<ToolResult> => ({
    success: true,
    output: 'ok',
  }));
}

function makeUser(overrides: Partial<User> = {}): User {
  return {
    telegram_id: 1,
    timezone: 'UTC',
    language: 'ru',
    username: null,
    first_name: null,
    ...overrides,
  } as User;
}

function makeSendMessage() {
  return mock((_chatId: number, _text: string) => Promise.resolve({ message_id: 1 }));
}

function makeAgentCtx(user: User, sendMessage = makeSendMessage()): AgentContext {
  return { user, sender: { sendMessage } } as unknown as AgentContext;
}

/** Single boundary cast for createSyntheticIntentRun dependencies.
 *  IntentMatcher, IntentRepository, IntentExecutor all have private fields,
 *  so structural mocks need `as unknown as` at this one place. */
function makeRunner(
  matcher: MockMatcher,
  repo: MockIntentRepo,
  executor: MockExecutor,
  executeTool = makeExecuteTool(),
) {
  const deps = { intentMatcher: matcher, intentRepo: repo, intentExecutor: executor, executeTool };
  return createSyntheticIntentRun(deps as unknown as SyntheticIntentRunDeps);
}

describe('createSyntheticIntentRun', () => {
  test('formats structured tool output before sending — raw AI-facing text never leaks to the user', async () => {
    const match: MatchResult = { intentId: 1, captures: {} };
    const intent: Partial<Intent> = {
      id: 1,
      format: 'events_list',
      workflow: JSON.stringify({ tools: [{ name: 'get_events', input: {} }] }),
    };
    // AI-facing text written for the agent — the exact leak shape from the issue: raw
    // internal id/title/start/created_by fields, never fit to show a user verbatim.
    const aiFacingText = 'id: 239, title: Standup, start: 2026-03-17T10:00:00Z, created_by: @alex';
    const responseEvents = [{ id: 239, title: 'Standup', date: '2026-03-17', time: '10:00', all_day: false }];
    const sendMessage = makeSendMessage();
    const agentCtx = makeAgentCtx(makeUser({ timezone: 'UTC' }), sendMessage);

    const run = makeRunner(
      makeMatcher(match),
      makeIntentRepo(intent),
      makeExecutor({ success: true, response: aiFacingText, responseEvents }),
    );

    const result = await run(agentCtx, 'что у меня сегодня');

    expect(result.handled).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const sentText = sendMessage.mock.calls[0]?.[1];
    expect(sentText).toContain('10:00');
    expect(sentText).toContain('Standup');
    expect(sentText).not.toContain('id: 239');
    expect(sentText).not.toContain('created_by');
    expect(sentText).not.toBe(aiFacingText);
  });

  test('no matched intent — returns handled:false, sender never called', async () => {
    const sendMessage = makeSendMessage();
    const agentCtx = makeAgentCtx(makeUser(), sendMessage);

    const run = makeRunner(makeMatcher(null), makeIntentRepo(), makeExecutor());
    const result = await run(agentCtx, 'random unrelated text');

    expect(result).toEqual({ handled: false });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test('intent not found in repo — returns handled:false', async () => {
    const match: MatchResult = { intentId: 99, captures: {} };
    const sendMessage = makeSendMessage();
    const agentCtx = makeAgentCtx(makeUser(), sendMessage);

    const run = makeRunner(makeMatcher(match), makeIntentRepo(null), makeExecutor());
    const result = await run(agentCtx, 'query');

    expect(result).toEqual({ handled: false });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test('unparseable workflow JSON on the intent row — returns handled:false', async () => {
    const match: MatchResult = { intentId: 1, captures: {} };
    const intent: Partial<Intent> = { id: 1, format: 'text', workflow: '{not valid json' };
    const sendMessage = makeSendMessage();
    const agentCtx = makeAgentCtx(makeUser(), sendMessage);

    const run = makeRunner(makeMatcher(match), makeIntentRepo(intent), makeExecutor());
    const result = await run(agentCtx, 'query');

    expect(result).toEqual({ handled: false });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test('format: text with plain non-JSON tool response sends through unchanged', async () => {
    const match: MatchResult = { intentId: 2, captures: {} };
    const intent: Partial<Intent> = {
      id: 2,
      format: 'text',
      workflow: JSON.stringify({ tools: [{ name: 'do_thing', input: {} }] }),
    };
    const sendMessage = makeSendMessage();
    const agentCtx = makeAgentCtx(makeUser(), sendMessage);

    const run = makeRunner(
      makeMatcher(match),
      makeIntentRepo(intent),
      makeExecutor({ success: true, response: 'Готово!' }),
    );

    const result = await run(agentCtx, 'сделай что-нибудь');

    expect(result).toEqual({ handled: true, response: 'Готово!' });
    expect(sendMessage).toHaveBeenCalledWith(agentCtx.user.telegram_id, 'Готово!');
  });
});
