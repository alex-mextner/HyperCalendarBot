import { describe, expect, mock, test } from 'bun:test';
import type { AgentLayerDeps } from '../../../src/bot/pipeline/ai-agent-layer.ts';
import { createAiAgentLayer } from '../../../src/bot/pipeline/ai-agent-layer.ts';
import type { BotCommandContext } from '../../../src/bot/types.ts';
import type { User } from '../../../src/database/types.ts';
import type { AgentRunResult, AgentToolCallRecord, AgentToolResultRecord } from '../../../src/services/ai/agent.ts';
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
