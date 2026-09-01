import { describe, expect, mock, test } from 'bun:test';
import type { AgentLayerDeps } from '../../../src/bot/pipeline/ai-agent-layer.ts';
import { createAiAgentLayer } from '../../../src/bot/pipeline/ai-agent-layer.ts';
import type { BotCommandContext } from '../../../src/bot/types.ts';
import type { User } from '../../../src/database/types.ts';
import type { AgentRunResult, AgentToolCallRecord, AgentToolResultRecord } from '../../../src/services/ai/agent.ts';
import { aiFailureNotices } from '../../../src/services/ai/agent.ts';
import type { AgentContext } from '../../../src/services/ai/types.ts';

/** Signature matching IntentLearner.analyze() for properly typed mock.calls access */
type AnalyzeFn = (
  message: string,
  toolCalls: AgentToolCallRecord[],
  toolResults: AgentToolResultRecord[],
) => Promise<null>;

/**
 * Test-only interface matching what createAiAgentLayer actually uses from CalendarBotAgent.
 * CalendarBotAgent has private members so direct structural mocking is impossible.
 * We type-assert once at the AgentLayerDeps boundary instead of per-call-site.
 */
interface MockAgentLayerDeps {
  agent: { run: ReturnType<typeof mock<(ctx: AgentContext) => Promise<AgentRunResult>>> };
  agentContextBuilder: (user: User, chatId: number, messageText: string) => AgentContext;
  intentLearner?: { analyze: ReturnType<typeof mock<AnalyzeFn>> };
}

function makeUser(): Partial<User> {
  return { telegram_id: 1, language: 'ru', timezone: 'UTC' };
}

/** Create a minimal BotCommandContext for pipeline tests.
 *  BotCommandContext extends MessageContext (many methods); pipeline only uses dbUser, chatId, send.
 *  Single boundary cast — unavoidable because MessageContext methods aren't mocked. */
function makeCtx(chatId: number | null = 1): BotCommandContext {
  return {
    dbUser: makeUser() as User,
    chatId,
    send: mock(() => Promise.resolve()),
  } as unknown as BotCommandContext;
}

function makeAgentRun(toolCalls: AgentToolCallRecord[] = []) {
  return mock(
    (_ctx: AgentContext): Promise<AgentRunResult> =>
      Promise.resolve({
        responseText: 'done',
        toolCalls,
        toolResults: toolCalls.map(() => ({ success: true, output: 'ok' })),
      }),
  );
}

function makeAgent(toolCalls: AgentToolCallRecord[] = []): MockAgentLayerDeps['agent'] {
  return { run: makeAgentRun(toolCalls) };
}

function makeContextBuilder(): MockAgentLayerDeps['agentContextBuilder'] {
  return (_user: User, chatId: number, messageText: string): AgentContext =>
    ({ user: makeUser(), chatId, messageText }) as AgentContext;
}

function makeAnalyzeMock(): ReturnType<typeof mock<AnalyzeFn>> {
  return mock((_msg: string, _calls: AgentToolCallRecord[], _results: AgentToolResultRecord[]) =>
    Promise.resolve(null),
  );
}

function makeIntentLearner(
  analyzeFn: ReturnType<typeof mock<AnalyzeFn>> = makeAnalyzeMock(),
): MockAgentLayerDeps['intentLearner'] {
  return { analyze: analyzeFn };
}

/** Assemble deps with a single boundary assertion. CalendarBotAgent has private members,
 *  so a plain `{ run }` object cannot satisfy the nominal type directly.
 *  All 11 original `as unknown as` casts collapse into this one factory. */
function makeDeps(overrides: Partial<MockAgentLayerDeps> = {}): AgentLayerDeps {
  return {
    agent: overrides.agent ?? makeAgent(),
    agentContextBuilder: overrides.agentContextBuilder ?? makeContextBuilder(),
    intentLearner: overrides.intentLearner,
  } as unknown as AgentLayerDeps;
}

describe('createAiAgentLayer', () => {
  test('returns handled:true after agent runs', async () => {
    const layer = createAiAgentLayer(makeDeps());
    const result = await layer(makeCtx(), 'add event');
    expect(result.handled).toBe(true);
  });

  test('returns handled:false when chatId is missing', async () => {
    const layer = createAiAgentLayer(makeDeps());
    const result = await layer(makeCtx(null), 'add event');
    expect(result.handled).toBe(false);
  });

  test('IntentLearner.analyze fires after AI response with tool calls', async () => {
    const analyzeFn = makeAnalyzeMock();
    const toolCalls: AgentToolCallRecord[] = [{ name: 'create_event', input: { title: 'Meeting' } }];

    const layer = createAiAgentLayer(
      makeDeps({ agent: makeAgent(toolCalls), intentLearner: makeIntentLearner(analyzeFn) }),
    );

    await layer(makeCtx(), 'add meeting');
    await Bun.sleep(10);

    expect(analyzeFn).toHaveBeenCalledTimes(1);
    const callArgs = analyzeFn.mock.calls[0]!;
    expect(callArgs[0]).toBe('add meeting');
    expect(callArgs[1]).toEqual(toolCalls);
    expect(callArgs[2][0]).toMatchObject({ success: true });
  });

  test('IntentLearner.analyze does not fire when there are no tool calls', async () => {
    const analyzeFn = makeAnalyzeMock();

    const layer = createAiAgentLayer(makeDeps({ agent: makeAgent([]), intentLearner: makeIntentLearner(analyzeFn) }));

    await layer(makeCtx(), 'hello');
    await Bun.sleep(10);

    expect(analyzeFn).toHaveBeenCalledTimes(0);
  });

  test('IntentLearner does not block AI response', async () => {
    const analyzeFn = mock(
      (_msg: string, _calls: AgentToolCallRecord[], _results: AgentToolResultRecord[]) =>
        new Promise<null>((r) => setTimeout(() => r(null), 5000)),
    );
    const toolCalls: AgentToolCallRecord[] = [{ name: 'create_event', input: {} }];

    const layer = createAiAgentLayer(
      makeDeps({ agent: makeAgent(toolCalls), intentLearner: makeIntentLearner(analyzeFn) }),
    );

    const start = Date.now();
    await layer(makeCtx(), 'add event');
    expect(Date.now() - start).toBeLessThan(1000);
  });

  test('IntentLearner errors are caught and do not throw', async () => {
    const analyzeFn = mock((_msg: string, _calls: AgentToolCallRecord[], _results: AgentToolResultRecord[]) =>
      Promise.reject(new Error('learner boom')),
    );
    const toolCalls: AgentToolCallRecord[] = [{ name: 'create_event', input: {} }];

    const layer = createAiAgentLayer(
      makeDeps({ agent: makeAgent(toolCalls), intentLearner: makeIntentLearner(analyzeFn) }),
    );

    await layer(makeCtx(), 'add event');
    await Bun.sleep(10);
    // no throw — test passes
  });

  test('works without intentLearner (no crash)', async () => {
    const toolCalls: AgentToolCallRecord[] = [{ name: 'create_event', input: {} }];
    const layer = createAiAgentLayer(makeDeps({ agent: makeAgent(toolCalls) }));
    const result = await layer(makeCtx(), 'add event');
    expect(result.handled).toBe(true);
  });

  test('sends error message when agent throws', async () => {
    const failingAgent = { run: mock(() => Promise.reject(new Error('agent explosion'))) };
    const ctx = makeCtx();

    const layer = createAiAgentLayer(makeDeps({ agent: failingAgent }));
    const result = await layer(ctx, 'add event');

    expect(result.handled).toBe(true);
    expect(ctx.send).toHaveBeenCalledTimes(1);
  });
});

describe('supplement mode', () => {
  function makeSupplementAgent(result: AgentRunResult): MockAgentLayerDeps['agent'] {
    return { run: mock((_ctx: AgentContext) => Promise.resolve(result)) };
  }

  test('sends responseText with parse_mode HTML when supplement_skip not called', async () => {
    const agent = makeSupplementAgent({
      responseText: '<b>Кстати</b>, событие повторяется.',
      toolCalls: [],
      toolResults: [],
    });
    const ctx = makeCtx();

    const layer = createAiAgentLayer(makeDeps({ agent }));
    await layer(ctx, 'покажи события', { supplementMode: true });

    expect(ctx.send).toHaveBeenCalledTimes(1);
    const sendMock = ctx.send as ReturnType<typeof mock>;
    const callArgs = sendMock.mock.calls[0]!;
    expect(callArgs[0]).toBe('<b>Кстати</b>, событие повторяется.');
    expect((callArgs[1] as { parse_mode?: string })?.parse_mode).toBe('HTML');
  });

  test('does NOT send when supplement_skip was called', async () => {
    const agent = makeSupplementAgent({
      responseText: 'some text',
      toolCalls: [{ name: 'supplement_skip', input: {} }],
      toolResults: [{ success: true }],
    });
    const ctx = makeCtx();

    const layer = createAiAgentLayer(makeDeps({ agent }));
    await layer(ctx, 'покажи события', { supplementMode: true });

    expect(ctx.send).not.toHaveBeenCalled();
  });

  test('does NOT send when responseText is empty', async () => {
    const agent = makeSupplementAgent({
      responseText: '',
      toolCalls: [],
      toolResults: [],
    });
    const ctx = makeCtx();

    const layer = createAiAgentLayer(makeDeps({ agent }));
    await layer(ctx, 'покажи события', { supplementMode: true });

    expect(ctx.send).not.toHaveBeenCalled();
  });

  test('IntentLearner is NOT called in supplement mode', async () => {
    const analyzeFn = makeAnalyzeMock();
    const toolCalls: AgentToolCallRecord[] = [{ name: 'create_event', input: {} }];
    const agent: MockAgentLayerDeps['agent'] = {
      run: mock((_ctx: AgentContext) => Promise.resolve({ responseText: 'ok', toolCalls, toolResults: [] })),
    };

    const layer = createAiAgentLayer(makeDeps({ agent, intentLearner: makeIntentLearner(analyzeFn) }));

    await layer(makeCtx(), 'добавь встречу', { supplementMode: true });
    await Bun.sleep(10);

    expect(analyzeFn).not.toHaveBeenCalled();
  });

  test('agent error in supplement mode: stays silent, returns handled:true', async () => {
    const agent: MockAgentLayerDeps['agent'] = {
      run: mock(() => Promise.reject(new Error('agent boom'))),
    };
    const ctx = makeCtx();

    const layer = createAiAgentLayer(makeDeps({ agent }));
    const result = await layer(ctx, 'покажи события', { supplementMode: true });

    expect(result.handled).toBe(true);
    expect(ctx.send).not.toHaveBeenCalled(); // no error message to user
  });

  test('sets supplementMode on agentContext', async () => {
    let capturedContext: AgentContext | undefined;
    const agent: MockAgentLayerDeps['agent'] = {
      run: mock((agentCtx: AgentContext) => {
        capturedContext = agentCtx;
        return Promise.resolve({ responseText: '', toolCalls: [], toolResults: [] });
      }),
    };

    const layer = createAiAgentLayer(makeDeps({ agent }));
    await layer(makeCtx(), 'hello', { supplementMode: true });

    expect(capturedContext?.supplementMode).toBe(true);
  });
});

describe('retry / backoff', () => {
  function makeRetrySetup(jobStoreGetImpl: () => Promise<string | null> = async () => null) {
    const captured: { ctx?: AgentContext } = {};
    const addDelayed = mock(async (_data: unknown, _delay: number): Promise<string> => 'job-123');
    const removeJobById = mock(async (_jobId: string): Promise<void> => {});
    const jobStoreGet = mock(jobStoreGetImpl);
    const jobStoreDel = mock(async (_userId: number): Promise<void> => {});
    const jobStoreSet = mock(async (_userId: number, _jobId: string): Promise<void> => {});

    const agent: MockAgentLayerDeps['agent'] = {
      run: mock((agentCtx: AgentContext) => {
        captured.ctx = agentCtx;
        return Promise.resolve({ responseText: 'ok', toolCalls: [], toolResults: [] });
      }),
    };

    const deps = {
      agent,
      agentContextBuilder: makeContextBuilder(),
      retryQueue: { addDelayed, removeJobById },
      retryJobStore: { get: jobStoreGet, del: jobStoreDel, set: jobStoreSet },
    } as unknown as AgentLayerDeps;

    return { deps, addDelayed, removeJobById, jobStoreGet, jobStoreDel, jobStoreSet, captured };
  }

  test('retryEnqueue is wired on agentContext when retryQueue is provided', async () => {
    const { deps, captured } = makeRetrySetup();
    await createAiAgentLayer(deps)(makeCtx(), 'msg');
    expect(captured.ctx?.retryEnqueue).toBeFunction();
  });

  test('attempt=0 → addDelayed called with 30s delay', async () => {
    const { deps, addDelayed, captured } = makeRetrySetup();
    await createAiAgentLayer(deps)(makeCtx(), 'msg', { retryAttempt: 0 });
    await captured.ctx!.retryEnqueue!('retry msg');
    const [, delay] = addDelayed.mock.calls[0] as unknown as [unknown, number];
    expect(delay).toBe(30_000);
  });

  test('attempt=1 → addDelayed called with 60s delay', async () => {
    const { deps, addDelayed, captured } = makeRetrySetup();
    await createAiAgentLayer(deps)(makeCtx(), 'msg', { retryAttempt: 1 });
    await captured.ctx!.retryEnqueue!('retry msg');
    const [, delay] = addDelayed.mock.calls[0] as unknown as [unknown, number];
    expect(delay).toBe(60_000);
  });

  test('attempt=2 → addDelayed called with 120s delay', async () => {
    const { deps, addDelayed, captured } = makeRetrySetup();
    await createAiAgentLayer(deps)(makeCtx(), 'msg', { retryAttempt: 2 });
    await captured.ctx!.retryEnqueue!('retry msg');
    const [, delay] = addDelayed.mock.calls[0] as unknown as [unknown, number];
    expect(delay).toBe(120_000);
  });

  test('retryEnqueue passes retryAttempt+1 in job data', async () => {
    const { deps, addDelayed, captured } = makeRetrySetup();
    await createAiAgentLayer(deps)(makeCtx(), 'msg', { retryAttempt: 1 });
    await captured.ctx!.retryEnqueue!('retry msg');
    const [jobData] = addDelayed.mock.calls[0] as unknown as [{ retryAttempt: number }, number];
    expect(jobData.retryAttempt).toBe(2);
  });

  test('retryEnqueue stores returned jobId in jobStore', async () => {
    const { deps, jobStoreSet, captured } = makeRetrySetup();
    await createAiAgentLayer(deps)(makeCtx(), 'msg', { retryAttempt: 0 });
    await captured.ctx!.retryEnqueue!('retry msg');
    expect(jobStoreSet).toHaveBeenCalledWith(1, 'job-123');
  });

  test('graceful fail when MAX_RETRY_ATTEMPTS exhausted: sends agent_give_up, no addDelayed', async () => {
    const { deps, addDelayed, jobStoreDel, captured } = makeRetrySetup();
    const ctx = makeCtx();
    // MAX_RETRY_ATTEMPTS = 3
    await createAiAgentLayer(deps)(ctx, 'msg', { retryAttempt: 3 });
    await captured.ctx!.retryEnqueue!('retry msg');
    expect(addDelayed).not.toHaveBeenCalled();
    expect(ctx.send).toHaveBeenCalledTimes(1);
    const [sentText] = (ctx.send as ReturnType<typeof mock>).mock.calls[0] as unknown as [string];
    expect(typeof sentText).toBe('string');
    expect(sentText.length).toBeGreaterThan(0);
    expect(jobStoreDel).toHaveBeenCalledWith(1);
  });

  test('give-up after a promised comeback acknowledges the promise and lists the commands', async () => {
    aiFailureNotices.reset();
    // The bot told this user "one sec, be right back" on the first failure.
    aiFailureNotices.decide(1, 'ru', { hardOutage: false, willRetry: true });

    const { deps, captured } = makeRetrySetup();
    const ctx = makeCtx();
    await createAiAgentLayer(deps)(ctx, 'msg', { retryAttempt: 3 });
    await captured.ctx!.retryEnqueue!('retry msg');

    const [sentText] = (ctx.send as ReturnType<typeof mock>).mock.calls[0] as unknown as [string];
    expect(sentText).toContain('Обещал вернуться');
    expect(sentText).toContain('/today');
    expect(sentText).toContain('/help');
  });

  test('give-up stays quiet when the user was already told the AI is unavailable', async () => {
    aiFailureNotices.reset();
    // Hard outage: the bot already sent the honest notice with the command list.
    aiFailureNotices.decide(1, 'ru', { hardOutage: true, willRetry: true });

    const { deps, jobStoreDel, captured } = makeRetrySetup();
    const ctx = makeCtx();
    await createAiAgentLayer(deps)(ctx, 'msg', { retryAttempt: 3 });
    await captured.ctx!.retryEnqueue!('retry msg');

    expect(ctx.send).not.toHaveBeenCalled();
    // The Redis retry state is still cleared even when nothing is sent.
    expect(jobStoreDel).toHaveBeenCalledWith(1);
  });

  test('cancels pending retry job when fresh message arrives (attempt=0)', async () => {
    const { deps, removeJobById } = makeRetrySetup(async () => 'pending-job-id');
    await createAiAgentLayer(deps)(makeCtx(), 'new message', { retryAttempt: 0 });
    expect(removeJobById).toHaveBeenCalledWith('pending-job-id');
  });

  test('does NOT cancel pending job when retryAttempt > 0', async () => {
    const { deps, removeJobById } = makeRetrySetup(async () => 'pending-job-id');
    await createAiAgentLayer(deps)(makeCtx(), 'retry attempt', { retryAttempt: 1 });
    expect(removeJobById).not.toHaveBeenCalled();
  });

  test('Redis failure in cancel block does not break pipeline', async () => {
    const { deps } = makeRetrySetup(async () => {
      throw new Error('Redis connection refused');
    });
    const result = await createAiAgentLayer(deps)(makeCtx(), 'msg', { retryAttempt: 0 });
    expect(result.handled).toBe(true);
  });
});
