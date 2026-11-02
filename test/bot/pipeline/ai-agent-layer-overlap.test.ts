// The 2026-11-01 incident, replayed through the real AI agent layer and the real CalendarBotAgent:
// quick confirmations in one private chat while the first run is still busy on a slow host. Only
// the model is scripted (a function of what it is shown); the layer, the agent, the tools, the
// 5 s repeated-call throttle and the database are real.
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { AgentLayerDeps } from '../../../src/bot/pipeline/ai-agent-layer.ts';
import { createAiAgentLayer } from '../../../src/bot/pipeline/ai-agent-layer.ts';
import type { PipelineLayer } from '../../../src/bot/pipeline/types.ts';
import type { BotCommandContext } from '../../../src/bot/types.ts';
import { ActionLogRepository } from '../../../src/database/repositories/action-log.repository.ts';
import { CalendarBotAgent } from '../../../src/services/ai/agent.ts';
import type { ChatTurnReservation } from '../../../src/services/ai/chat-run-gate.ts';
import { withChatTurn } from '../../../src/services/ai/chat-turn-context.ts';
import { executeTool } from '../../../src/services/ai/tool-executor.ts';
import type { AgentContext } from '../../../src/services/ai/types.ts';
import { cmdLogger } from '../../../src/utils/logger.ts';
import {
  type ModelRequest,
  REVIEW,
  recordDelivery,
  SlowHost,
  STANDUP,
  settle,
  titlesInCalendar,
  userTurn,
} from '../../helpers/overlap-fixtures.ts';
import { type AgentRunFixture, createAgentRunFixture, USER_ID } from '../../services/ai/agent-run-helpers.ts';

describe('overlapping confirmations in one private chat (2026-11-01)', () => {
  let fixture: AgentRunFixture;
  let host: SlowHost;
  let chatHistoryIds: Map<number, number>;
  let nextUpdateId: number;
  let agentInUse: CalendarBotAgent;
  const reservations = new Map<number, ChatTurnReservation>();

  beforeEach(() => {
    fixture = createAgentRunFixture();
    host = new SlowHost();
    chatHistoryIds = new Map();
    nextUpdateId = 900;
    const { ctx } = fixture;
    ctx.conversationLogger.logUserMessage(USER_ID, 'Plan the Synthetic Standup and the Synthetic Review');
    ctx.conversationLogger.logAiTurn(USER_ID, { role: 'assistant', content: 'Shall I add both events?' });
  });

  afterEach(() => host.restore());

  /** What the chat-logging middleware does on receipt: the message is saved, its row id remembered, its place reserved. */
  function receive(text: string): number {
    const chatHistoryId = fixture.ctx.conversationLogger.logUserMessage(USER_ID, text);
    chatHistoryIds.set(USER_ID, chatHistoryId);
    reservations.set(chatHistoryId, agentInUse.reserveChatTurn(USER_ID, chatHistoryId));
    return chatHistoryId;
  }

  /** What the message handler does with a received message: hands it to the layer. */
  function deliver(layer: PipelineLayer, text: string, chatHistoryId: number) {
    const { ctx } = fixture;
    const updateId = nextUpdateId++;
    const incoming = {
      dbUser: ctx.user,
      chatId: USER_ID,
      id: updateId + 500,
      updateId,
      chatHistoryId,
      send: async () => {},
    } as unknown as BotCommandContext;
    const run = () => layer(incoming, text, { incomingMessageId: updateId + 500, chatHistoryId });
    const reservation = reservations.get(chatHistoryId);
    return reservation ? withChatTurn(reservation, run) : run();
  }

  function arrive(layer: PipelineLayer, text: string) {
    return deliver(layer, text, receive(text));
  }

  function layerFor(agent: CalendarBotAgent) {
    agentInUse = agent;
    const build: AgentLayerDeps['agentContextBuilder'] = (user, chatId, messageText, _group, incomingMessageId) =>
      ({
        ...fixture.ctx,
        user,
        chatId,
        messageText,
        incomingMessageId,
        chatHistoryId: chatHistoryIds.get(user.telegram_id),
        wasExplicitInvocation: true,
      }) satisfies AgentContext;
    return createAiAgentLayer({ agent, agentContextBuilder: build });
  }

  test('the second confirmation waits, is handled on the first run’s history and creates nothing', async () => {
    const shown = recordDelivery(fixture.sender);
    const layer = layerFor(new CalendarBotAgent(fixture.config, fixture.sender, { streamImpl: host.model }));

    const first = arrive(layer, 'Yes');
    await host.reached;
    const second = arrive(layer, 'Yes');
    await settle();
    host.release();
    await Promise.all([first, second]);

    // One set of rows: the second run saw the first run's creates and did not repeat them.
    expect(titlesInCalendar(fixture)).toEqual([STANDUP.title, REVIEW.title]);

    // The second run's transcript: the created events come first, its own «Yes» is the newest turn.
    const secondRun = host.requests.find(
      (request) => userTurn(request.messages.at(-1)) === 'Yes' && request.messages.some((m) => m.role === 'tool'),
    );
    expect(secondRun).toBeDefined();
    const roles = secondRun?.messages.map((m) => m.role) ?? [];
    expect(roles.lastIndexOf('tool')).toBeLessThan(roles.lastIndexOf('user'));
    expect(roles.at(-1)).toBe('user');

    // Ordered replies: the first run's report is out before the second run says anything.
    const firstReport = shown.findIndex((text) => text.includes('Done:'));
    const secondReport = shown.findIndex((text) => text.includes('already exist'));
    expect(firstReport).toBeGreaterThan(-1);
    expect(secondReport).toBeGreaterThan(firstReport);
  });

  test('a third message waits for the second, and each run is shown only the turns up to its own', async () => {
    const layer = layerFor(new CalendarBotAgent(fixture.config, fixture.sender, { streamImpl: host.model }));

    const pending = [arrive(layer, 'Yes')];
    await host.reached;
    pending.push(arrive(layer, 'Yes, both'));
    pending.push(arrive(layer, 'Thanks'));
    await settle();
    host.release();
    await Promise.all(pending);

    expect(titlesInCalendar(fixture)).toEqual([STANDUP.title, REVIEW.title]);

    const userTexts = (request: ModelRequest) => request.messages.filter((m) => m.role === 'user').map(userTurn);
    const lastUserOf = (request: ModelRequest) => userTexts(request).at(-1);
    // First requests of the three runs come in arrival order.
    const order = host.requests.map(lastUserOf).filter((text, index, all) => all.indexOf(text) === index);
    expect(order).toEqual(['Yes', 'Yes, both', 'Thanks']);
    // A run is not shown the messages queued behind it.
    for (const request of host.requests) {
      const last = lastUserOf(request);
      if (last === 'Yes') expect(userTexts(request)).not.toContain('Yes, both');
      if (last !== 'Thanks') expect(userTexts(request)).not.toContain('Thanks');
    }
    // The last run reads the conversation in the order things happened: the first confirmation, what the
    // first run did, the second confirmation, and only then its own message.
    const lastRun = host.requests.filter((request) => lastUserOf(request) === 'Thanks').at(-1);
    const seen = lastRun?.messages.map((m) => (m.role === 'user' ? userTurn(m) : m.role)) ?? [];
    const at = (needle: string) => seen.indexOf(needle);
    expect(at('Yes')).toBeGreaterThan(-1);
    expect(at('tool')).toBeGreaterThan(at('Yes'));
    expect(at('Yes, both')).toBeGreaterThan(at('tool'));
    expect(at('Thanks')).toBe(seen.length - 1);
  });

  test('a message received but still parked before the agent is not read by the run ahead of it', async () => {
    const layer = layerFor(new CalendarBotAgent(fixture.config, fixture.sender, { streamImpl: host.model }));

    const firstRow = receive('Yes');
    const parkedText = 'actually cancel everything';
    const parkedRow = receive(parkedText); // saved, but its handler is delayed before it reaches the agent
    const first = deliver(layer, 'Yes', firstRow);
    await host.reached;
    host.release();
    await first;

    const everyUserTurnShown = host.requests.flatMap((request) => request.messages.filter((m) => m.role === 'user'));
    expect(everyUserTurnShown.map(userTurn)).not.toContain(parkedText);

    // The parked message is then handled in its own run, which does read it.
    await deliver(layer, parkedText, parkedRow);
    expect(host.requests.at(-1)?.messages.map((m) => (m.role === 'user' ? userTurn(m) : m.role))).toContain(parkedText);
  });

  test('a message whose handler reaches the agent late is still answered in the order the messages were saved', async () => {
    const layer = layerFor(new CalendarBotAgent(fixture.config, fixture.sender, { streamImpl: host.model }));

    const firstRow = receive('Yes'); // saved first, its handler is slow (a scene or retry lookup)
    const secondRow = receive('Thanks'); // saved second, its handler is quick
    const second = deliver(layer, 'Thanks', secondRow);
    await settle();
    expect(host.requests).toHaveLength(0); // the quick one waits for the place saved before it
    const first = deliver(layer, 'Yes', firstRow);
    await host.reached;
    host.release();
    await Promise.all([first, second]);

    const userTexts = (request: ModelRequest) => request.messages.filter((m) => m.role === 'user').map(userTurn);
    const order = host.requests
      .map((request) => userTexts(request).at(-1))
      .filter((text, i, all) => all.indexOf(text) === i);
    expect(order).toEqual(['Yes', 'Thanks']);
    expect(userTexts(host.requests[0]!)).not.toContain('Thanks');
    expect(titlesInCalendar(fixture)).toEqual([STANDUP.title, REVIEW.title]);
  });

  test('ids held by the pipeline stay valid after a message waited and was placed after the earlier run', async () => {
    const layer = layerFor(new CalendarBotAgent(fixture.config, fixture.sender, { streamImpl: host.model }));

    const first = arrive(layer, 'Yes');
    await host.reached;
    const secondRow = receive('Yes, both');
    const second = deliver(layer, 'Yes, both', secondRow);
    await settle();
    host.release();
    await Promise.all([first, second]);

    // A scheduled run or button built from the per-user map after the move writes an audit row against it.
    const held = chatHistoryIds.get(USER_ID);
    expect(held).toBe(secondRow);
    const audited = await executeTool(
      { ...fixture.ctx, actionLogRepo: new ActionLogRepository(fixture.db), chatHistoryId: held, messageText: '' },
      'create_event',
      {
        title: 'Synthetic Scheduled',
        start_at: '2031-01-01T10:00:00Z',
        allow_duplicate: true,
      },
    );
    expect(audited.success).toBe(true);
    expect(
      fixture.db.prepare('SELECT chat_history_id FROM user_action_log WHERE action_name = ?').all('create_event'),
    ).toContainEqual({ chat_history_id: secondRow });
  });

  describe('the order of runs alone, with every copy asked for deliberately', () => {
    // allow_duplicate switches the calendar's own repeat check off, so the one set of rows below can only
    // come from the second run being shown what the first one did and not creating again.
    beforeEach(() => {
      host.restore();
      host = new SlowHost({ allowDuplicates: true });
    });

    test('a queued confirmation creates nothing the first run already created', async () => {
      const layer = layerFor(new CalendarBotAgent(fixture.config, fixture.sender, { streamImpl: host.model }));

      const first = arrive(layer, 'Yes');
      await host.reached;
      const second = arrive(layer, 'Yes');
      await settle();
      host.release();
      await Promise.all([first, second]);

      expect(titlesInCalendar(fixture)).toEqual([STANDUP.title, REVIEW.title]);
    });
  });

  test('the routing log line carries the Telegram update id and message id next to the message text it already had', async () => {
    const info = spyOn(cmdLogger, 'info').mockImplementation(() => {});
    try {
      const layer = layerFor(new CalendarBotAgent(fixture.config, fixture.sender, { streamImpl: host.model }));
      const done = arrive(layer, 'Yes');
      await host.reached;
      host.release();
      await done;
      const routing = info.mock.calls.find((call) => call[1] === 'Routing to AI agent');
      expect(routing).toBeDefined();
      expect(routing?.[0]).toMatchObject({ userId: USER_ID, messageText: 'Yes', updateId: 900, messageId: 1400 });
    } finally {
      info.mockRestore();
    }
  });
});
