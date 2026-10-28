import type { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { CalendarBotAgent } from '../../../src/services/ai/agent.ts';
import type { AgentConfig, AgentContext, TelegramSender } from '../../../src/services/ai/types.ts';
import { createAgentRunFixture, makeStreamImpl, USER_ID } from './agent-run-helpers.ts';

describe('CalendarBotAgent.run()', () => {
  let db: Database;
  let ctx: AgentContext;
  let config: AgentConfig;
  let sender: TelegramSender;

  beforeEach(() => {
    ({ db, ctx, config, sender } = createAgentRunFixture());
  });

  test('duplicate tool calls with identical args are deduped within a run (no real execution)', async () => {
    const { impl } = makeStreamImpl([
      {
        kind: 'tool',
        callId: 'call-1',
        name: 'get_events',
        input: { start_date: '2026-04-16', end_date: '2026-04-16' },
      },
      {
        kind: 'tool',
        callId: 'call-2',
        name: 'get_events',
        // Same args — should be deduped
        input: { start_date: '2026-04-16', end_date: '2026-04-16' },
      },
      {
        kind: 'tool',
        callId: 'call-3',
        name: 'get_events',
        // Key-order variant — must still be detected as duplicate
        input: { end_date: '2026-04-16', start_date: '2026-04-16' },
      },
      { kind: 'text', text: 'No events.' },
    ]);

    // Spy on eventService.getEventsForDay — the real backing call for get_events.
    // It should fire exactly once; the other two are deduped.
    const originalGetEvents = ctx.eventService.getEventsInRange.bind(ctx.eventService);
    let realCallCount = 0;
    ctx.eventService.getEventsInRange = ((userId: number, start: string, end: string) => {
      realCallCount++;
      return originalGetEvents(userId, start, end);
    }) as typeof ctx.eventService.getEventsInRange;

    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });
    ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);

    const result = await agent.run(ctx);

    // All three tool calls recorded in the run result…
    expect(result.toolCalls.length).toBe(3);
    // …but the real backing service was invoked once.
    expect(realCallCount).toBe(1);
    // Two of the three results are synthetic DUPLICATE markers.
    const duplicateResults = result.toolResults.filter((r) => (r.output ?? '').includes('DUPLICATE'));
    expect(duplicateResults.length).toBe(2);
  });

  test('dedup key normalizes argument key order', async () => {
    // Two calls with same semantic args but different key order must be deduped.
    const { impl } = makeStreamImpl([
      {
        kind: 'tool',
        callId: 'call-1',
        name: 'get_events',
        input: { start_date: '2026-04-16', end_date: '2026-04-16' },
      },
      {
        kind: 'tool',
        callId: 'call-2',
        name: 'get_events',
        input: { end_date: '2026-04-16', start_date: '2026-04-16' },
      },
      { kind: 'text', text: 'ok' },
    ]);

    let realCallCount = 0;
    const originalGetEvents = ctx.eventService.getEventsInRange.bind(ctx.eventService);
    ctx.eventService.getEventsInRange = ((userId: number, start: string, end: string) => {
      realCallCount++;
      return originalGetEvents(userId, start, end);
    }) as typeof ctx.eventService.getEventsInRange;

    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });
    ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);
    await agent.run(ctx);

    expect(realCallCount).toBe(1);
  });

  test('different args with same tool name are NOT deduped', async () => {
    const { impl } = makeStreamImpl([
      {
        kind: 'tool',
        callId: 'call-1',
        name: 'get_events',
        input: { start_date: '2026-04-16', end_date: '2026-04-16' },
      },
      {
        kind: 'tool',
        callId: 'call-2',
        name: 'get_events',
        // Different date — must execute for real
        input: { start_date: '2026-04-17', end_date: '2026-04-17' },
      },
      { kind: 'text', text: 'ok' },
    ]);

    let realCallCount = 0;
    const originalGetEvents = ctx.eventService.getEventsInRange.bind(ctx.eventService);
    ctx.eventService.getEventsInRange = ((userId: number, start: string, end: string) => {
      realCallCount++;
      return originalGetEvents(userId, start, end);
    }) as typeof ctx.eventService.getEventsInRange;

    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });
    ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);
    await agent.run(ctx);

    expect(realCallCount).toBe(2);
  });

  test('a call that explicitly clears a field is NOT deduped against an earlier call that omitted it', async () => {
    // Regression: update_event's nullable fields (location, end_at, description,
    // recurrence_rule) use `null` to mean "clear this field" — distinct from
    // omitting the key entirely. The dedup key must not collapse
    // {title:"New Title"} and {title:"New Title", location:null} into the same
    // key, or the second (clearing) call is silently swallowed as a duplicate
    // and the model is falsely told the clear already happened.
    const event = ctx.eventService.createEvent({
      user_id: USER_ID,
      title: 'Original title',
      location: 'Somewhere',
      start_at: new Date(Date.now() + 86400000).toISOString(),
      timezone: 'UTC',
    });
    const { impl } = makeStreamImpl([
      {
        kind: 'tool',
        callId: 'call-1',
        name: 'update_event',
        input: { event_id: event.id, title: 'New Title' },
      },
      {
        kind: 'tool',
        callId: 'call-2',
        name: 'update_event',
        // Same title, but explicitly clears location — must execute for real.
        input: { event_id: event.id, title: 'New Title', location: null },
      },
      { kind: 'text', text: 'ok' },
    ]);

    let realCallCount = 0;
    const originalUpdateEvent = ctx.eventService.updateEvent.bind(ctx.eventService);
    ctx.eventService.updateEvent = ((id: number, userId: number, data: Parameters<typeof originalUpdateEvent>[2]) => {
      realCallCount++;
      return originalUpdateEvent(id, userId, data);
    }) as typeof ctx.eventService.updateEvent;

    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });
    ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);
    const result = await agent.run(ctx);

    expect(realCallCount).toBe(2);
    const duplicateResults = result.toolResults.filter((r) => (r.output ?? '').includes('DUPLICATE'));
    expect(duplicateResults.length).toBe(0);
    const stored = db.query('SELECT location FROM events WHERE id=?').get(event.id) as { location: string | null };
    expect(stored.location).toBeNull();
  });

  test('duplicate tool result is passed back to the model in the next round', async () => {
    // Model sees the DUPLICATE marker in the tool result and should use it to
    // understand the call was skipped. Verify the model input on round 3
    // contains the synthetic tool result for call-2.
    const { impl, calls } = makeStreamImpl([
      {
        kind: 'tool',
        callId: 'call-1',
        name: 'get_events',
        input: { start_date: '2026-04-16', end_date: '2026-04-16' },
      },
      {
        kind: 'tool',
        callId: 'call-2',
        name: 'get_events',
        input: { start_date: '2026-04-16', end_date: '2026-04-16' },
      },
      { kind: 'text', text: 'final' },
    ]);

    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });
    ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);
    await agent.run(ctx);

    // The third model call (after 2 tool rounds) must see call-2's result,
    // and that result must contain DUPLICATE.
    const thirdCall = calls[2];
    expect(thirdCall).toBeDefined();
    const toolMessagesInThirdCall = thirdCall!.messages.filter((m) => m.role === 'tool');
    const call2Result = toolMessagesInThirdCall.find(
      (m) => 'tool_call_id' in m && (m as { tool_call_id: string }).tool_call_id === 'call-2',
    );
    expect(call2Result).toBeDefined();
    const content = (call2Result as { content: string }).content;
    expect(content).toContain('DUPLICATE');
  });

  // ── Regression: error delivery guarantee ────────────────────────────────

  test('a failed tool result carries its recovery hint into the next model round', async () => {
    const script = makeStreamImpl([
      { kind: 'tool', callId: 'lookup', name: 'find_user', input: { username: 'unconfirmed_person' } },
      { kind: 'text', text: 'Please send the exact @username.' },
    ]);
    await new CalendarBotAgent(config, sender, { streamImpl: script.impl }).run(ctx);

    const toolMessage = script.calls[1]?.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'lookup');
    expect(toolMessage?.content).toStartWith('Error: ');
    expect(toolMessage?.content).toContain('\n[AGENT: Use find_contact for a personal name.');
  });
});
