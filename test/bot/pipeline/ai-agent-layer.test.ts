import { describe, expect, mock, test } from 'bun:test';
import { createAiAgentLayer } from '../../../src/bot/pipeline/ai-agent-layer.ts';
import type { BotCommandContext } from '../../../src/bot/types.ts';
import type { User } from '../../../src/database/types.ts';
import type { CalendarBotAgent } from '../../../src/services/ai/agent.ts';
import type { AgentContext } from '../../../src/services/ai/types.ts';
import type { IntentLearner } from '../../../src/services/intent/intent-learner.ts';

function makeUser(): User {
  return { telegram_id: 1, language: 'ru', timezone: 'UTC' } as User;
}

function makeCtx(chatId: number | null = 1): BotCommandContext {
  return {
    dbUser: makeUser(),
    chatId,
    send: mock(() => Promise.resolve()),
  } as unknown as BotCommandContext;
}

function makeAgentRun(toolCalls: { name: string; input: Record<string, unknown> }[] = []) {
  return mock(() =>
    Promise.resolve({
      responseText: 'done',
      toolCalls,
      toolResults: toolCalls.map(() => ({ success: true, output: 'ok' })),
    }),
  );
}

function makeAgent(toolCalls: { name: string; input: Record<string, unknown> }[] = []): CalendarBotAgent {
  return { run: makeAgentRun(toolCalls) } as unknown as CalendarBotAgent;
}

function makeContextBuilder() {
  return (_user: User, chatId: number, messageText: string): AgentContext =>
    ({ user: makeUser(), chatId, messageText }) as unknown as AgentContext;
}

function makeIntentLearner(analyzeFn = mock(() => Promise.resolve(null))): IntentLearner {
  return { analyze: analyzeFn } as unknown as IntentLearner;
}

describe('createAiAgentLayer', () => {
  test('returns handled:true after agent runs', async () => {
    const layer = createAiAgentLayer({ agent: makeAgent(), agentContextBuilder: makeContextBuilder() });
    const result = await layer(makeCtx(), 'add event');
    expect(result.handled).toBe(true);
  });

  test('returns handled:false when chatId is missing', async () => {
    const layer = createAiAgentLayer({ agent: makeAgent(), agentContextBuilder: makeContextBuilder() });
    const result = await layer(makeCtx(null), 'add event');
    expect(result.handled).toBe(false);
  });

  test('IntentLearner.analyze fires after AI response with tool calls', async () => {
    const analyzeFn = mock(() => Promise.resolve(null));
    const learner = makeIntentLearner(analyzeFn);
    const toolCalls = [{ name: 'create_event', input: { title: 'Meeting' } }];
    const agent = makeAgent(toolCalls);

    const layer = createAiAgentLayer({
      agent,
      agentContextBuilder: makeContextBuilder(),
      intentLearner: learner,
    });

    await layer(makeCtx(), 'add meeting');
    await Bun.sleep(10);

    expect(analyzeFn).toHaveBeenCalledTimes(1);
    const [msg, calls, results] = (analyzeFn as ReturnType<typeof mock>).mock.calls[0] as [
      string,
      { name: string; input: Record<string, unknown> }[],
      { success: boolean }[],
    ];
    expect(msg).toBe('add meeting');
    expect(calls).toEqual(toolCalls);
    expect(results[0]?.success).toBe(true);
  });

  test('IntentLearner.analyze does not fire when there are no tool calls', async () => {
    const analyzeFn = mock(() => Promise.resolve(null));
    const learner = makeIntentLearner(analyzeFn);
    const agent = makeAgent([]); // no tool calls

    const layer = createAiAgentLayer({
      agent,
      agentContextBuilder: makeContextBuilder(),
      intentLearner: learner,
    });

    await layer(makeCtx(), 'hello');
    await Bun.sleep(10);

    expect(analyzeFn).toHaveBeenCalledTimes(0);
  });

  test('IntentLearner does not block AI response', async () => {
    const analyzeFn = mock(() => new Promise<null>((r) => setTimeout(() => r(null), 5000)));
    const learner = makeIntentLearner(analyzeFn);
    const toolCalls = [{ name: 'create_event', input: {} }];
    const agent = makeAgent(toolCalls);

    const layer = createAiAgentLayer({
      agent,
      agentContextBuilder: makeContextBuilder(),
      intentLearner: learner,
    });

    const start = Date.now();
    await layer(makeCtx(), 'add event');
    expect(Date.now() - start).toBeLessThan(1000);
  });

  test('IntentLearner errors are caught and do not throw', async () => {
    const analyzeFn = mock(() => Promise.reject(new Error('learner boom')));
    const learner = makeIntentLearner(analyzeFn);
    const toolCalls = [{ name: 'create_event', input: {} }];
    const agent = makeAgent(toolCalls);

    const layer = createAiAgentLayer({
      agent,
      agentContextBuilder: makeContextBuilder(),
      intentLearner: learner,
    });

    await layer(makeCtx(), 'add event');
    await Bun.sleep(10);
    // no throw — test passes
  });

  test('works without intentLearner (no crash)', async () => {
    const toolCalls = [{ name: 'create_event', input: {} }];
    const agent = makeAgent(toolCalls);

    const layer = createAiAgentLayer({ agent, agentContextBuilder: makeContextBuilder() });
    const result = await layer(makeCtx(), 'add event');
    expect(result.handled).toBe(true);
  });

  test('sends error message when agent throws', async () => {
    const agent = {
      run: mock(() => Promise.reject(new Error('agent explosion'))),
    } as unknown as CalendarBotAgent;
    const ctx = makeCtx();

    const layer = createAiAgentLayer({ agent, agentContextBuilder: makeContextBuilder() });
    const result = await layer(ctx, 'add event');

    expect(result.handled).toBe(true);
    expect(ctx.send).toHaveBeenCalledTimes(1);
  });
});
