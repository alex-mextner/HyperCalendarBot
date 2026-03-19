import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createIntentMatcherLayer } from '../../../src/bot/pipeline/intent-matcher-layer.ts';
import type { BotCommandContext } from '../../../src/bot/types.ts';
import type { IntentRepository } from '../../../src/database/repositories/intent.repository.ts';
import type { IntentExecutor } from '../../../src/services/intent/intent-executor.ts';
import type { IntentMatcher } from '../../../src/services/intent/intent-matcher.ts';

function makeUser(overrides: Record<string, unknown> = {}) {
  return { telegram_id: 1, timezone: 'UTC', language: 'ru', ...overrides };
}

function makeCtx(user = makeUser()): BotCommandContext {
  return {
    dbUser: user,
    send: mock(() => Promise.resolve()),
  } as unknown as BotCommandContext;
}

function makeMatcher(match: ReturnType<IntentMatcher['match']> = null): IntentMatcher {
  return { match: mock(() => match), load: mock(() => {}) } as unknown as IntentMatcher;
}

function makeIntentRepo(intent: Record<string, unknown> | null = null): IntentRepository {
  return { getById: mock(() => intent) } as unknown as IntentRepository;
}

function makeExecutor(result: Record<string, unknown> = { success: true, response: 'done' }): IntentExecutor {
  return { run: mock(() => Promise.resolve(result)) } as unknown as IntentExecutor;
}

function makeToolExecutor() {
  return mock((_name: string, _input: Record<string, unknown>) => ({ success: true, output: 'ok' }));
}

describe('createIntentMatcherLayer', () => {
  let workflowSessions: Map<
    number,
    Parameters<typeof createIntentMatcherLayer>[4] extends Map<number, infer V> ? V : never
  >;

  beforeEach(() => {
    workflowSessions = new Map();
  });

  test('returns handled:false when matcher finds no match', async () => {
    const layer = createIntentMatcherLayer(
      makeMatcher(null),
      makeIntentRepo(),
      makeExecutor(),
      makeToolExecutor(),
      workflowSessions,
    );

    const result = await layer(makeCtx(), 'hello');
    expect(result.handled).toBe(false);
  });

  test('returns handled:true when intent matches and executor returns response', async () => {
    const match = { intentId: 1, captures: {} };
    const intent = {
      id: 1,
      workflow: JSON.stringify({ tools: [{ name: 'get_events', input: {} }], format: 'text' }),
      format: 'text',
    };
    const ctx = makeCtx();

    const layer = createIntentMatcherLayer(
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

    const layer = createIntentMatcherLayer(
      makeMatcher(match),
      makeIntentRepo(null), // repo returns null
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
    const intent = {
      id: 5,
      workflow: JSON.stringify({ steps: [{ call: 'ask_user' }] }),
      format: 'text',
    };
    const executor = makeExecutor({ success: false, suspended: true, suspendedAt: 0, stepResults: {} });
    const ctx = makeCtx(makeUser({ telegram_id: userId }));

    const layer = createIntentMatcherLayer(
      makeMatcher(match),
      makeIntentRepo(intent),
      executor,
      makeToolExecutor(),
      workflowSessions,
    );

    const result = await layer(ctx, 'create event tomorrow');
    expect(result.handled).toBe(true);
    expect(workflowSessions.has(userId)).toBe(true);
    const session = workflowSessions.get(userId)!;
    expect(session.intentId).toBe(5);
    expect(session.captures).toEqual({ $1: 'tomorrow' });
  });

  test('resumes workflow session when active session exists', async () => {
    const userId = 7;
    const workflow = { steps: [{ call: 'ask_user', as: 'answer' }] };
    const executor = makeExecutor({ success: true, response: 'Created!' });
    const ctx = makeCtx(makeUser({ telegram_id: userId }));

    // Seed an active session
    workflowSessions.set(userId, {
      intentId: 3,
      stepIndex: 0,
      stepResults: {},
      workflow,
      captures: {},
      createdAt: Date.now(),
    });

    const layer = createIntentMatcherLayer(
      makeMatcher(null), // matcher returns null — but session should take priority
      makeIntentRepo(null),
      executor,
      makeToolExecutor(),
      workflowSessions,
    );

    const result = await layer(ctx, 'yes');
    expect(result.handled).toBe(true);
    expect(ctx.send).toHaveBeenCalledWith('Created!');
    // Session must be deleted after use
    expect(workflowSessions.has(userId)).toBe(false);
  });

  test('ignores expired workflow session and falls through to matcher', async () => {
    const userId = 8;
    const matcher = makeMatcher(null);
    const ctx = makeCtx(makeUser({ telegram_id: userId }));

    // Seed an expired session (>5 min old)
    workflowSessions.set(userId, {
      intentId: 1,
      stepIndex: 0,
      stepResults: {},
      workflow: { steps: [] },
      captures: {},
      createdAt: Date.now() - 6 * 60 * 1000, // 6 minutes ago
    });

    const layer = createIntentMatcherLayer(
      matcher,
      makeIntentRepo(null),
      makeExecutor(),
      makeToolExecutor(),
      workflowSessions,
    );

    const result = await layer(ctx, 'too late');
    expect(result.handled).toBe(false);
    // Session should be removed even though expired
    expect(workflowSessions.has(userId)).toBe(false);
    // Matcher is called (no session short-circuit)
    expect(matcher.match).toHaveBeenCalled();
  });

  test('returns handled:false and calls notifyAdmin when executor fails', async () => {
    const match = { intentId: 3, captures: {} };
    const intent = {
      id: 3,
      canonical_name: 'invite_user',
      workflow: JSON.stringify({ tools: [{ name: 'find_user', input: {} }] }),
      format: 'text',
    };
    const notifyAdmin = mock(() => Promise.resolve());

    const layer = createIntentMatcherLayer(
      makeMatcher(match),
      makeIntentRepo(intent),
      makeExecutor({ success: false, response: 'tool error: user not found' }),
      makeToolExecutor(),
      workflowSessions,
      undefined,
      notifyAdmin,
    );

    const result = await layer(makeCtx(), 'invite @bob');
    expect(result.handled).toBe(false);
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
    const msg = (notifyAdmin.mock.calls[0] as string[])[0];
    expect(msg).toContain('invite_user');
    expect(msg).toContain('id=3');
    expect(msg).toContain('tool error: user not found');
  });

  test('does not send response when executor returns no response', async () => {
    const match = { intentId: 2, captures: {} };
    const intent = {
      id: 2,
      workflow: JSON.stringify({ tools: [{ name: 'noop', input: {} }] }),
      format: 'text',
    };
    const ctx = makeCtx();

    const layer = createIntentMatcherLayer(
      makeMatcher(match),
      makeIntentRepo(intent),
      makeExecutor({ success: true }), // no response field
      makeToolExecutor(),
      workflowSessions,
    );

    const result = await layer(ctx, 'noop');
    expect(result.handled).toBe(true);
    expect(ctx.send).not.toHaveBeenCalled();
  });
});
