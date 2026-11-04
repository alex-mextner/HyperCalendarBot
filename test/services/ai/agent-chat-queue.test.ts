// CalendarBotAgent.run() per chat: queued runs, a hung run, a run that waited, and the calendar's own
// repeat check standing alone when nothing orders the runs. Real agents, tools and database; the model is
// scripted (see helpers/overlap-fixtures.ts).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { t } from '../../../src/config/constants.ts';
import { turnIds } from '../../../src/services/ai/agent/queued-turn.ts';
import { CalendarBotAgent } from '../../../src/services/ai/agent.ts';
import { ChatRunGate, type ChatTurnReservation } from '../../../src/services/ai/chat-run-gate.ts';
import { withChatTurn } from '../../../src/services/ai/chat-turn-context.ts';
import type { StreamRoundOptions, StreamRoundResult } from '../../../src/services/ai/streaming.ts';
import type { AgentContext } from '../../../src/services/ai/types.ts';
import { ManualTime } from '../../helpers/manual-time.ts';
import {
  REVIEW,
  recordDelivery,
  SlowHost,
  STANDUP,
  settle,
  textOf,
  titlesInCalendar,
} from '../../helpers/overlap-fixtures.ts';
import {
  type AgentRunFixture,
  createAgentRunFixture,
  fakeMetrics,
  isValidatorCall,
  USER_ID,
} from './agent-run-helpers.ts';

describe('CalendarBotAgent.run() in one chat', () => {
  let fixture: AgentRunFixture;
  let host: SlowHost;
  const reservations = new WeakMap<AgentContext, ChatTurnReservation>();

  beforeEach(() => {
    fixture = createAgentRunFixture();
    host = new SlowHost();
    fixture.ctx.conversationLogger.logUserMessage(USER_ID, 'Plan the Synthetic Standup and the Synthetic Review');
    fixture.ctx.conversationLogger.logAiTurn(USER_ID, { role: 'assistant', content: 'Shall I add both events?' });
  });

  afterEach(() => host.restore());

  /** A turn as the chat-logging middleware leaves it: the user's row saved and its place in the chat reserved. */
  function turn(agent: CalendarBotAgent, text: string): AgentContext {
    const chatHistoryId = fixture.ctx.conversationLogger.logUserMessage(USER_ID, text);
    const context: AgentContext = { ...fixture.ctx, messageText: text, chatHistoryId };
    reservations.set(context, agent.reserveChatTurn(USER_ID, chatHistoryId));
    return context;
  }

  /** What the middleware does around the handler: the run starts inside the update's reserved place. */
  function go(agent: CalendarBotAgent, context: AgentContext, source: AgentContext = context) {
    const reservation = reservations.get(source);
    return reservation ? withChatTurn(reservation, () => agent.run(context)) : agent.run(context);
  }

  test('without any ordering between the runs, the calendar’s own repeat check still leaves one set of events', async () => {
    // Two agents have two gates: nothing orders their runs, exactly as before the queue existed.
    const slowAgent = new CalendarBotAgent(fixture.config, fixture.sender, { streamImpl: host.model });
    const otherAgent = new CalendarBotAgent(fixture.config, fixture.sender, { streamImpl: host.model });

    const first = go(slowAgent, turn(slowAgent, 'Yes'));
    await host.reached;
    const second = go(otherAgent, turn(otherAgent, 'Yes'));
    await settle();
    expect(titlesInCalendar(fixture)).toEqual([STANDUP.title, REVIEW.title]); // the unordered run created them
    host.release();
    await Promise.all([first, second]);

    expect(titlesInCalendar(fixture)).toEqual([STANDUP.title, REVIEW.title]);
    // The run that came second in time was told, per event, that it already existed.
    const lateResults = host.requests
      .flatMap((request) => request.messages)
      .filter((message) => message.role === 'tool' && textOf(message).includes('already exists'));
    expect(lateResults).toHaveLength(2);
  });

  test('a hung run holds the chat only until its lease; the late run still creates nothing twice', async () => {
    const time = new ManualTime();
    const leaseMs = 120_000;
    const agent = new CalendarBotAgent(fixture.config, fixture.sender, {
      streamImpl: host.model,
      chatRunGate: new ChatRunGate({ leaseMs, now: time.now, schedule: time.schedule }),
    });

    const hung = go(agent, turn(agent, 'Yes'));
    await host.reached; // its model request is parked
    const queued = go(agent, turn(agent, 'Yes again'));
    await settle();
    expect(host.requests).toHaveLength(1); // the queued run has not reached the model: it is waiting

    time.advance(leaseMs);
    await queued; // the wait ended; the run completed while the first is still parked
    expect(titlesInCalendar(fixture)).toEqual([STANDUP.title, REVIEW.title]);

    host.release();
    await hung;
    // The late run's creates found the events already there.
    expect(titlesInCalendar(fixture)).toEqual([STANDUP.title, REVIEW.title]);
  });

  /** A model that changes the user's timezone during its first request (parked until released) and records each system prompt. */
  function timezoneChangingModel() {
    const prompts: string[] = [];
    const parked = Promise.withResolvers<void>();
    const reached = Promise.withResolvers<void>();
    let requests = 0;
    const streamImpl = async (opts: StreamRoundOptions): Promise<StreamRoundResult> => {
      const text = 'Noted.';
      const answer = {
        text,
        toolCalls: [],
        finishReason: 'stop',
        assistantMessage: { role: 'assistant' as const, content: text },
        providerUsed: 'mock',
        metrics: fakeMetrics('zai', 10, 2),
      };
      if (isValidatorCall(opts)) return { ...answer, text: 'APPROVE', metrics: fakeMetrics('hf', 10, 2) };
      prompts.push(textOf(opts.messages[0]));
      requests++;
      if (requests === 1) {
        // While this run works the user changes their timezone (a settings tool, a button, an admin).
        fixture.ctx.userRepo.update(USER_ID, { timezone: 'Pacific/Auckland' });
        reached.resolve();
        await parked.promise;
      }
      return answer;
    };
    return { prompts, streamImpl, reached: reached.promise, release: () => parked.resolve() };
  }

  test('a run that waited reads the user and schedule as the earlier run left them', async () => {
    const model = timezoneChangingModel();
    const agent = new CalendarBotAgent(fixture.config, fixture.sender, { streamImpl: model.streamImpl });

    const first = go(agent, turn(agent, 'first message'));
    await model.reached;
    const second = go(agent, turn(agent, 'second message')); // its context still holds the old user
    await settle();
    expect(model.prompts).toHaveLength(1);
    model.release();
    await Promise.all([first, second]);

    expect(model.prompts[0]).toContain('UTC');
    expect(model.prompts[0]).not.toContain('Pacific/Auckland');
    expect(model.prompts[1]).toContain('Pacific/Auckland');
  });

  test('a run whose earlier run finished just before it reached the gate reads the same fresh context', async () => {
    const model = timezoneChangingModel();
    const agent = new CalendarBotAgent(fixture.config, fixture.sender, { streamImpl: model.streamImpl });

    const first = go(agent, turn(agent, 'first message'));
    await model.reached;
    const secondContext = turn(agent, 'second message'); // saved while the first run works; its handler is slow
    model.release();
    await first;
    const second = go(agent, secondContext); // nothing is ahead any more: it never waits
    await second;

    expect(model.prompts[0]).not.toContain('Pacific/Auckland');
    expect(model.prompts[1]).toContain('Pacific/Auckland');
  });

  test('a queued message gets one answer of its own and its turn is saved once, after the earlier run', async () => {
    const agent = new CalendarBotAgent(fixture.config, fixture.sender, { streamImpl: host.model });

    const first = go(agent, turn(agent, 'Yes'));
    await host.reached;
    const second = go(agent, turn(agent, 'Yes, both'));
    await settle();
    host.release();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.responseText).toContain('Done: 2 results seen.');
    expect(secondResult.responseText).toContain('Both events already exist.');
    expect(secondResult.toolCalls).toEqual([]);

    const rows = fixture.ctx.chatHistory
      .getRecent(USER_ID, 50)
      .map((row) => (row.role === 'user' ? `user:${row.content}` : row.role));
    expect(rows.filter((row) => row === 'user:Yes')).toHaveLength(1);
    expect(rows.filter((row) => row === 'user:Yes, both')).toHaveLength(1);
    const at = rows.indexOf('user:Yes, both');
    expect(rows.slice(0, at)).toContain('tool'); // what the first run did comes before the second message
    expect(rows.slice(at + 1)).toEqual(['assistant']); // and only the second run's own answer comes after it
  });

  describe('what the user sees while a message waits', () => {
    function withTypingProbe() {
      const actions: string[] = [];
      fixture.sender.sendChatAction = async (chatId, action) => {
        actions.push(`${chatId}:${action}`);
      };
      return actions;
    }

    test('a waiting message shows the typing indicator at once', async () => {
      const actions = withTypingProbe();
      const agent = new CalendarBotAgent(fixture.config, fixture.sender, { streamImpl: host.model });

      const first = go(agent, turn(agent, 'Yes'));
      await host.reached;
      const beforeQueued = actions.length;
      const second = go(agent, turn(agent, 'Yes, both'));
      expect(actions.length).toBe(beforeQueued + 1);
      expect(actions.at(-1)).toBe(`${USER_ID}:typing`);

      host.release();
      await Promise.all([first, second]);
    });

    test('a supplement waits behind the main run like any run, silently: no typing, no text', async () => {
      const actions = withTypingProbe();
      const shown = recordDelivery(fixture.sender);
      const agent = new CalendarBotAgent(fixture.config, fixture.sender, { streamImpl: host.model });

      const main = go(agent, turn(agent, 'Yes'));
      await host.reached;
      const beforeQueued = actions.length;
      const supplementTurn = turn(agent, 'Yes, both');
      const supplement = go(
        agent,
        { ...supplementTurn, supplementMode: true, supplementAutoResponse: 'Done.' },
        supplementTurn,
      );
      await settle();
      expect(actions.length).toBe(beforeQueued); // no typing for a supplement
      expect(host.requests).toHaveLength(1); // and it has not started: it waits for the main run

      host.release();
      await Promise.all([main, supplement]);
      expect(shown.some((text) => text.includes('already exist'))).toBe(false); // its answer never reached the chat
    });

    test('when the run ahead outlives the lease the user is told, once, and the run goes on', async () => {
      const time = new ManualTime();
      const leaseMs = 90_000;
      const shown = recordDelivery(fixture.sender);
      const agent = new CalendarBotAgent(fixture.config, fixture.sender, {
        streamImpl: host.model,
        chatRunGate: new ChatRunGate({ leaseMs, now: time.now, schedule: time.schedule }),
      });

      const hung = go(agent, turn(agent, 'Yes'));
      await host.reached;
      const queued = go(agent, turn(agent, 'Yes, both'));
      await settle();
      expect(shown).not.toContain(t('en').agent_queue_lease_expired);

      time.advance(leaseMs);
      await queued;
      expect(shown.filter((text) => text === t('en').agent_queue_lease_expired)).toHaveLength(1);

      host.release();
      await hung;
      expect(shown.filter((text) => text === t('en').agent_queue_lease_expired)).toHaveLength(1);
    });

    test('a scheduled run (no message of the user behind it) is never told "handling your message"', async () => {
      const time = new ManualTime();
      const leaseMs = 90_000;
      const shown = recordDelivery(fixture.sender);
      const agent = new CalendarBotAgent(fixture.config, fixture.sender, {
        streamImpl: host.model,
        chatRunGate: new ChatRunGate({ leaseMs, now: time.now, schedule: time.schedule }),
      });
      const main = turn(agent, 'Yes');
      const hung = go(agent, main);
      await host.reached;
      // As the production context factory builds it: it borrows the user's latest row for the action log.
      const scheduled = agent.run({
        ...fixture.ctx,
        messageText: 'Scheduled check',
        chatHistoryId: main.chatHistoryId,
      });
      await settle();
      time.advance(leaseMs);
      await scheduled;
      expect(shown).not.toContain(t('en').agent_queue_lease_expired);
      host.release();
      await hung;
      // The borrowed row is still where it was saved: the earlier request is not made to look unanswered.
      const roles = fixture.ctx.chatHistory
        .getRecent(USER_ID, 50)
        .map((row) => `${row.role}:${row.content.slice(0, 3)}`);
      expect(roles.at(-1)).not.toBe('user:Yes');
    });

    test('a message that waited and then ran after the earlier run finished gets no lease notice', async () => {
      const shown = recordDelivery(fixture.sender);
      const agent = new CalendarBotAgent(fixture.config, fixture.sender, { streamImpl: host.model });
      const first = go(agent, turn(agent, 'Yes'));
      await host.reached;
      const second = go(agent, turn(agent, 'Yes, both'));
      await settle();
      host.release();
      await Promise.all([first, second]);
      expect(shown).not.toContain(t('en').agent_queue_lease_expired);
    });
  });

  test('log ids name the Telegram update and message of the run', () => {
    expect(turnIds({ updateId: 7, incomingMessageId: 8 })).toEqual({ updateId: 7, messageId: 8 });
    expect(turnIds({})).toEqual({});
  });
});

describe('CalendarBotAgent shutdown with a stalled lease notice', () => {
  test('a queued message whose notice never gets delivered is still drained and stored for retry', async () => {
    const fixture = createAgentRunFixture();
    const host = new SlowHost();
    try {
      const time = new ManualTime();
      const leaseMs = 90_000;
      const retried: string[] = [];
      fixture.ctx.retryEnqueue = async (message: string) => {
        retried.push(message);
        return true;
      };
      // The notice is the only message this sender cannot deliver; everything else goes through.
      const stalled = Promise.withResolvers<{ message_id: number }>();
      fixture.sender.sendMessage = async (_chatId, text) =>
        text === t('en').agent_queue_lease_expired ? stalled.promise : { message_id: 42 };
      const agent = new CalendarBotAgent(fixture.config, fixture.sender, {
        streamImpl: host.model,
        chatRunGate: new ChatRunGate({ leaseMs, now: time.now, schedule: time.schedule }),
      });
      const runFor = (text: string) => {
        const chatHistoryId = fixture.ctx.conversationLogger.logUserMessage(USER_ID, text);
        const reservation = agent.reserveChatTurn(USER_ID, chatHistoryId);
        return withChatTurn(reservation, () => agent.run({ ...fixture.ctx, messageText: text, chatHistoryId }));
      };

      const first = runFor('first request');
      await host.reached;
      const second = runFor('second request');
      await settle();
      time.advance(leaseMs); // the second run leaves the queue and tries to tell the user
      await settle();

      await agent.drain(2_000);
      await Promise.allSettled([first, second]);
      expect([...retried].sort()).toEqual(['first request', 'second request']);
    } finally {
      host.restore();
    }
  });
});
