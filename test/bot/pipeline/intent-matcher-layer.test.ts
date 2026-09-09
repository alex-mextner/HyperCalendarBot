import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createIntentMatcherLayer } from '../../../src/bot/pipeline/intent-matcher-layer.ts';
import type { WorkflowSession, WorkflowSessionStore } from '../../../src/bot/pipeline/types.ts';
import type { BotCommandContext } from '../../../src/bot/types.ts';
import type { Intent, User } from '../../../src/database/types.ts';
import type { ToolResult } from '../../../src/services/ai/types.ts';
import type { Workflow } from '../../../src/services/intent/workflow-schema.ts';

const TTL_MS = 5 * 60 * 1000;

// In-memory WorkflowSessionStore for tests. Also exposes has() for assertions.
function makeWorkflowStore(): WorkflowSessionStore & { has(chatId: number, userId: number): boolean } {
  const m = new Map<string, WorkflowSession>();
  const k = (c: number, u: number) => `${c}:${u}`;
  return {
    get(chatId, userId) {
      const s = m.get(k(chatId, userId));
      if (!s || Date.now() - s.createdAt >= TTL_MS) {
        m.delete(k(chatId, userId));
        return null;
      }
      return s;
    },
    set(chatId, userId, s) {
      m.set(k(chatId, userId), s);
    },
    delete(chatId, userId) {
      m.delete(k(chatId, userId));
    },
    deleteByUser(userId) {
      for (const key of [...m.keys()]) {
        if (key.endsWith(`:${userId}`)) m.delete(key);
      }
    },
    has(chatId, userId) {
      return m.has(k(chatId, userId));
    },
  };
}

/** Executor result shape returned by IntentExecutor.run() */
interface ExecutorResult {
  success: boolean;
  response?: string;
  responseEvents?: { id: number; title: string; date: string; time?: string; all_day: boolean }[];
  suspended?: boolean;
  suspendedAt?: number;
  stepResults?: { [key: string]: unknown };
  mentionedEventId?: number;
}

/** Match result shape from IntentMatcher.match() */
interface MatchResult {
  intentId: number;
  captures: { [key: string]: string };
}

/**
 * Mock interfaces matching what createIntentMatcherLayer uses from its dependencies.
 * IntentMatcher, IntentRepository, IntentExecutor are classes with private members,
 * so structural mocks need a boundary assertion.
 */
interface MockMatcher {
  match: ReturnType<typeof mock<(text: string) => MatchResult | null>>;
  load: ReturnType<typeof mock<(intents: Intent[]) => void>>;
}

interface MockIntentRepo {
  getById: ReturnType<typeof mock<(id: number) => Partial<Intent> | null>>;
}

interface MockExecutor {
  run: ReturnType<typeof mock<(...args: unknown[]) => Promise<ExecutorResult>>>;
}

function makeUser(overrides: Partial<User> = {}): Partial<User> {
  return { telegram_id: 1, timezone: 'UTC', language: 'ru', ...overrides };
}

// chatId defaults to telegram_id — mirrors the layer's fallback for private chats.
// BotCommandContext extends MessageContext (many methods); the layer only uses dbUser, chatId, send.
function makeCtx(user = makeUser()): BotCommandContext {
  return {
    dbUser: user as User,
    chatId: user.telegram_id,
    send: mock(() => Promise.resolve()),
  } as unknown as BotCommandContext;
}

function makeMatcher(match: MatchResult | null = null): MockMatcher {
  return { match: mock(() => match), load: mock(() => {}) };
}

function makeIntentRepo(intent: Partial<Intent> | null = null): MockIntentRepo {
  return { getById: mock(() => intent) };
}

function makeExecutor(result: ExecutorResult = { success: true, response: 'done' }): MockExecutor {
  return { run: mock(() => Promise.resolve(result)) };
}

function makeToolExecutor() {
  return mock((_name: string, _input: unknown): ToolResult => ({ success: true, output: 'ok' }));
}

/** Single boundary cast for createIntentMatcherLayer arguments.
 *  IntentMatcher, IntentRepository, IntentExecutor all have private fields,
 *  so structural mocks need `as unknown as` at this one place. */
function callLayer(
  matcher: MockMatcher,
  repo: MockIntentRepo,
  executor: MockExecutor,
  toolExecutor: ReturnType<typeof makeToolExecutor>,
  sessions: ReturnType<typeof makeWorkflowStore>,
  notifyAdmin?: (text: string) => Promise<void>,
) {
  return createIntentMatcherLayer(
    matcher as unknown as Parameters<typeof createIntentMatcherLayer>[0],
    repo as unknown as Parameters<typeof createIntentMatcherLayer>[1],
    executor as unknown as Parameters<typeof createIntentMatcherLayer>[2],
    toolExecutor,
    sessions,
    notifyAdmin,
  );
}

describe('createIntentMatcherLayer', () => {
  let workflowSessions: ReturnType<typeof makeWorkflowStore>;

  beforeEach(() => {
    workflowSessions = makeWorkflowStore();
  });

  test('returns handled:false when matcher finds no match', async () => {
    const layer = callLayer(makeMatcher(null), makeIntentRepo(), makeExecutor(), makeToolExecutor(), workflowSessions);

    const result = await layer(makeCtx(), 'hello');
    expect(result.handled).toBe(false);
  });

  test('returns handled:true when intent matches and executor returns response', async () => {
    const match = { intentId: 1, captures: {} };
    const intent: Partial<Intent> = {
      id: 1,
      workflow: JSON.stringify({ tools: [{ name: 'get_events', input: {} }], format: 'text' }),
      format: 'text',
    };
    const ctx = makeCtx();

    const layer = callLayer(
      makeMatcher(match),
      makeIntentRepo(intent),
      makeExecutor({ success: true, response: 'Events found' }),
      makeToolExecutor(),
      workflowSessions,
    );

    const result = await layer(ctx, 'покажи события');
    expect(result.handled).toBe(true);
    expect(ctx.send).toHaveBeenCalledWith('Events found');
  });

  test('returns handled:false when intent not found in repo', async () => {
    const match = { intentId: 99, captures: {} };

    const layer = callLayer(
      makeMatcher(match),
      makeIntentRepo(null),
      makeExecutor(),
      makeToolExecutor(),
      workflowSessions,
    );

    const result = await layer(makeCtx(), 'query');
    expect(result.handled).toBe(false);
  });

  test('handles workflow suspension: stores session and returns handled:true', async () => {
    const userId = 42;
    const match = { intentId: 5, captures: { $1: 'tomorrow' } };
    const intent: Partial<Intent> = {
      id: 5,
      workflow: JSON.stringify({ steps: [{ call: 'ask_user' }] }),
      format: 'text',
    };
    const executor = makeExecutor({ success: false, suspended: true, suspendedAt: 0, stepResults: {} });
    const ctx = makeCtx(makeUser({ telegram_id: userId }));

    const layer = callLayer(makeMatcher(match), makeIntentRepo(intent), executor, makeToolExecutor(), workflowSessions);

    const result = await layer(ctx, 'create event tomorrow');
    expect(result.handled).toBe(true);
    expect(workflowSessions.has(userId, userId)).toBe(true);
    const session = workflowSessions.get(userId, userId)!;
    expect(session.intentId).toBe(5);
    expect(session.captures).toEqual({ $1: 'tomorrow' });
  });

  test('resumes workflow session when active session exists', async () => {
    const userId = 7;
    const workflow = { steps: [{ call: 'ask_user', as: 'answer' }] };
    const executor = makeExecutor({ success: true, response: 'Created!' });
    const ctx = makeCtx(makeUser({ telegram_id: userId }));

    // Seed an active session
    workflowSessions.set(userId, userId, {
      intentId: 3,
      stepIndex: 0,
      stepResults: {},
      workflow,
      captures: {},
      createdAt: Date.now(),
    });

    const layer = callLayer(makeMatcher(null), makeIntentRepo(null), executor, makeToolExecutor(), workflowSessions);

    const result = await layer(ctx, 'yes');
    expect(result.handled).toBe(true);
    expect(ctx.send).toHaveBeenCalledWith('Created!');
    // Session must be deleted after use
    expect(workflowSessions.has(userId, userId)).toBe(false);
  });

  test('formats structured events when a resumed workflow ends in get_events', async () => {
    const userId = 71;
    const workflow = { steps: [{ call: 'ask_user', as: 'answer' }, { call: 'get_events' }] };
    const executor = makeExecutor({
      success: true,
      response: 'id: 239, title: Английский, start: 2026-06-01T10:30:00.000Z, created_by: @someone',
      responseEvents: [{ id: 239, title: 'Английский', date: '2026-06-01', time: '12:30', all_day: false }],
    });
    const ctx = makeCtx(makeUser({ telegram_id: userId }));

    workflowSessions.set(userId, userId, {
      intentId: 3,
      stepIndex: 0,
      stepResults: {},
      workflow,
      captures: {},
      createdAt: Date.now(),
    });

    const layer = callLayer(
      makeMatcher(null),
      makeIntentRepo({ id: 3, workflow: JSON.stringify(workflow), format: 'text', canonical_name: 'x' }),
      executor,
      makeToolExecutor(),
      workflowSessions,
    );
    await layer(ctx, 'да');

    expect(ctx.send).toHaveBeenCalledWith('2026-06-01 12:30  Английский');
  });

  test('ignores expired workflow session and falls through to matcher', async () => {
    const userId = 8;
    const matcher = makeMatcher(null);
    const ctx = makeCtx(makeUser({ telegram_id: userId }));

    // Seed an expired session (>5 min old)
    workflowSessions.set(userId, userId, {
      intentId: 1,
      stepIndex: 0,
      stepResults: {},
      workflow: { steps: [] },
      captures: {},
      createdAt: Date.now() - 6 * 60 * 1000, // 6 minutes ago
    });

    const layer = callLayer(matcher, makeIntentRepo(null), makeExecutor(), makeToolExecutor(), workflowSessions);

    const result = await layer(ctx, 'too late');
    expect(result.handled).toBe(false);
    // Session should be removed even though expired
    expect(workflowSessions.has(userId, userId)).toBe(false);
    // Matcher is called (no session short-circuit)
    expect(matcher.match).toHaveBeenCalled();
  });

  test('returns handled:false and calls notifyAdmin when executor fails', async () => {
    const match = { intentId: 3, captures: {} };
    const intent: Partial<Intent> = {
      id: 3,
      canonical_name: 'invite_user',
      workflow: JSON.stringify({ tools: [{ name: 'find_user', input: {} }] }),
      format: 'text',
    };
    const notifyAdmin = mock((_text: string) => Promise.resolve());

    const layer = callLayer(
      makeMatcher(match),
      makeIntentRepo(intent),
      makeExecutor({ success: false, response: 'tool error: user not found' }),
      makeToolExecutor(),
      workflowSessions,
      notifyAdmin,
    );

    const result = await layer(makeCtx(), 'invite @bob');
    expect(result.handled).toBe(false);
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
    const msg = notifyAdmin.mock.calls[0]![0];
    expect(msg).toContain('invite_user');
    expect(msg).toContain('id=3');
    expect(msg).toContain('tool error: user not found');
  });

  test('does not send response when executor returns no response', async () => {
    const match = { intentId: 2, captures: {} };
    const intent: Partial<Intent> = {
      id: 2,
      workflow: JSON.stringify({ tools: [{ name: 'noop', input: {} }] }),
      format: 'text',
    };
    const ctx = makeCtx();

    const layer = callLayer(
      makeMatcher(match),
      makeIntentRepo(intent),
      makeExecutor({ success: true }),
      makeToolExecutor(),
      workflowSessions,
    );

    const result = await layer(ctx, 'noop');
    expect(result.handled).toBe(true);
    expect(ctx.send).not.toHaveBeenCalled();
  });

  test('sends ask_user question to user when workflow suspends', async () => {
    const userId = 13;
    const match = { intentId: 5, captures: {} };
    const intent: Partial<Intent> = {
      id: 5,
      workflow: JSON.stringify({ steps: [{ call: 'ask_user', input: { question: 'Date or time?' }, as: 'ans' }] }),
      format: 'text',
    };
    const executor = makeExecutor({
      success: false,
      suspended: true,
      suspendedAt: 0,
      stepResults: {},
      response: 'Date or time?',
    });
    const ctx = makeCtx(makeUser({ telegram_id: userId }));

    const layer = callLayer(makeMatcher(match), makeIntentRepo(intent), executor, makeToolExecutor(), workflowSessions);

    const result = await layer(ctx, 'create event');
    expect(result.handled).toBe(true);
    expect(ctx.send).toHaveBeenCalledWith('Date or time?');
    expect(workflowSessions.has(userId, userId)).toBe(true);
  });

  test('trims whitespace when resuming workflow', async () => {
    const userId = 15;
    const workflow: Workflow = {
      steps: [
        { call: 'ask_user', input: { question: 'дата или время?' }, as: 'choice' },
        { when: 'choice == "время"', call: 'create_event', input: { title: 'Встреча' } },
      ],
    };
    const executor = makeExecutor({ success: true, response: 'created' });
    const ctx = makeCtx(makeUser({ telegram_id: userId }));

    workflowSessions.set(userId, userId, {
      intentId: 7,
      stepIndex: 0,
      stepResults: {},
      workflow,
      captures: {},
      createdAt: Date.now(),
    });

    const layer = callLayer(makeMatcher(null), makeIntentRepo(null), executor, makeToolExecutor(), workflowSessions);

    await layer(ctx, '  Время  ');

    const runCallArgs = executor.run.mock.calls[0]!;
    const resumeState = runCallArgs[4] as { userAnswer: string };
    expect(resumeState.userAnswer).toBe('Время');
  });

  test('does not send message when ask_user has no question text', async () => {
    const userId = 14;
    const match = { intentId: 6, captures: {} };
    const intent: Partial<Intent> = {
      id: 6,
      workflow: JSON.stringify({ steps: [{ call: 'ask_user', as: 'ans' }] }),
      format: 'text',
    };
    const executor = makeExecutor({ success: false, suspended: true, suspendedAt: 0, stepResults: {} });
    const ctx = makeCtx(makeUser({ telegram_id: userId }));

    const layer = callLayer(makeMatcher(match), makeIntentRepo(intent), executor, makeToolExecutor(), workflowSessions);

    await layer(ctx, 'create event');
    expect(ctx.send).not.toHaveBeenCalled();
  });

  test('passes groupContext to executor as groupIsGroup and groupChatId', async () => {
    const match = { intentId: 10, captures: {} };
    const intent: Partial<Intent> = {
      id: 10,
      workflow: JSON.stringify({ tools: [{ name: 'create_event', input: { scope: 'group' } }] }),
      format: 'text',
    };
    const executor = makeExecutor({ success: true, response: 'event created' });

    const layer = callLayer(makeMatcher(match), makeIntentRepo(intent), executor, makeToolExecutor(), workflowSessions);

    await layer(makeCtx(), 'сделай пьянку сегодня на 23', {
      groupContext: { isGroup: true, groupChatId: -100555, groupTitle: 'Test group' },
    });

    const runCallArgs = executor.run.mock.calls[0]!;
    const userCtx = runCallArgs[2] as { groupIsGroup: boolean; groupChatId: number };
    expect(userCtx.groupIsGroup).toBe(true);
    expect(userCtx.groupChatId).toBe(-100555);
  });
});

describe('needsSupplement', () => {
  test('successful completed intent returns needsSupplement:true', async () => {
    const matcher = makeMatcher({ intentId: 1, captures: {} });
    const repo = makeIntentRepo({ id: 1, workflow: '{"steps":[]}', format: 'text', canonical_name: 'test' });
    const executor = makeExecutor({ success: true, response: 'done' });

    const layer = callLayer(matcher, repo, executor, makeToolExecutor(), makeWorkflowStore());
    const result = await layer(makeCtx(), 'покажи события');

    expect(result.handled).toBe(true);
    expect('needsSupplement' in result).toBe(true);
  });

  test('hands the sent text to the supplement run', async () => {
    const matcher = makeMatcher({ intentId: 1, captures: {} });
    const repo = makeIntentRepo({ id: 1, workflow: '{"steps":[]}', format: 'text', canonical_name: 'test' });
    const executor = makeExecutor({ success: true, response: 'Готово!' });

    const layer = callLayer(matcher, repo, executor, makeToolExecutor(), makeWorkflowStore());
    const ctx = makeCtx();
    const result = await layer(ctx, 'покажи события');

    // The supplement agent reads the auto-response from here, not from chat history.
    expect(result).toMatchObject({ needsSupplement: true, supplementAutoResponse: 'Готово!' });
    expect(ctx.send).toHaveBeenCalledWith('Готово!');
  });

  test('suspended intent (ask_user) does NOT return needsSupplement', async () => {
    const matcher = makeMatcher({ intentId: 1, captures: {} });
    const repo = makeIntentRepo({ id: 1, workflow: '{"steps":[]}', format: 'text', canonical_name: 'test' });
    const executor = makeExecutor({ success: false, suspended: true, suspendedAt: 0, response: 'Утро или вечер?' });

    const workflowStore = makeWorkflowStore();
    const layer = callLayer(matcher, repo, executor, makeToolExecutor(), workflowStore);
    const result = await layer(makeCtx(), 'добавь встречу в 8');

    expect(result.handled).toBe(true);
    expect('needsSupplement' in result).toBe(false);
  });

  test('session resume does NOT return needsSupplement', async () => {
    const sessionStore = makeWorkflowStore();
    sessionStore.set(1, 1, {
      intentId: 1,
      stepIndex: 1,
      stepResults: {},
      workflow: { steps: [] },
      captures: {},
      createdAt: Date.now(),
    });
    const repo = makeIntentRepo({ id: 1, workflow: '{"steps":[]}', format: 'text', canonical_name: 'test' });
    const executor = makeExecutor({ success: true, response: 'done' });

    const layer = callLayer(makeMatcher(), repo, executor, makeToolExecutor(), sessionStore);
    const result = await layer(makeCtx(), 'утро');

    expect(result.handled).toBe(true);
    expect('needsSupplement' in result).toBe(false);
  });
});
