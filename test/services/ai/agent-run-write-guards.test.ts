import { beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { CalendarBotAgent } from '../../../src/services/ai/agent.ts';
import { approveDeletes } from '../../../src/services/ai/delete-confirmation.ts';
import type { StreamCallbacks, StreamRoundOptions, StreamRoundResult } from '../../../src/services/ai/streaming.ts';
import { executeTool } from '../../../src/services/ai/tool-executor.ts';
import type { AgentConfig, AgentContext, TelegramSender } from '../../../src/services/ai/types.ts';
import {
  createAgentRunFixture,
  createOwnedEvent,
  fakeMetrics,
  isValidatorCall,
  makeStreamImpl,
  type ScriptedRound,
  USER_ID,
} from './agent-run-helpers.ts';

describe('CalendarBotAgent.run()', () => {
  let ctx: AgentContext;
  let config: AgentConfig;
  let sender: TelegramSender;

  beforeEach(() => {
    ({ ctx, config, sender } = createAgentRunFixture());
  });

  test.each([false, true])('live call speaks actual ask_user question, validation retry=%s', async (retry) => {
    ctx.inputMode = 'live_call';
    const question = 'Which afternoon works?';
    const script = makeStreamImpl([
      ...(retry ? [{ kind: 'text' as const, text: 'Unverified completion' }] : []),
      {
        kind: 'tool',
        callId: 'ask',
        name: 'ask_user',
        input: { question, options: ['Monday', 'Tuesday'] },
        text: 'Provisional prose',
      },
    ]);
    const impl = async (opts: StreamRoundOptions, callbacks?: StreamCallbacks): Promise<StreamRoundResult> => {
      if (retry && isValidatorCall(opts))
        return {
          text: 'REJECT: use tools',
          toolCalls: [],
          finishReason: 'stop',
          assistantMessage: { role: 'assistant', content: 'REJECT: use tools' },
          providerUsed: 'mock',
          metrics: fakeMetrics('zai', 100, 20),
        };
      return script.impl(opts, callbacks);
    };
    const result = await new CalendarBotAgent(config, sender, { streamImpl: impl }).run(ctx);
    expect(result.responseText).toContain(question);
    expect(result.responseText).toContain('Monday');
    expect(result.responseText).not.toContain('Provisional prose');
  });

  test('title correction does not clear failed all_day and timezone metadata', async () => {
    const event = createOwnedEvent(ctx);
    const script = makeStreamImpl([
      {
        kind: 'tool',
        callId: 'bad',
        name: 'update_event',
        input: { event_id: event.id, title: 123, all_day: true, timezone: 'Europe/Belgrade', category: 'work' },
      },
      { kind: 'tool', callId: 'fix', name: 'update_event', input: { event_id: event.id, title: 'Fixed' } },
      { kind: 'text', text: 'All updated.' },
    ]);
    const result = await new CalendarBotAgent(config, sender, { streamImpl: script.impl }).run(ctx);
    expect(ctx.eventService.getEvent(event.id, USER_ID)?.all_day).toBe(0);
    expect(ctx.eventService.getEvent(event.id, USER_ID)?.title).toBe('Fixed');
    expect(result.responseText).toContain('all day');
    expect(result.responseText).toContain('timezone');
    expect(result.responseText).toContain('category');
  });

  test('confirmed write survives provider interruption without whole-request retry', async () => {
    const event = createOwnedEvent(ctx);
    approveDeletes(USER_ID, ctx.chatId, [event.id]);
    const enqueue = mock(async () => true);
    ctx.retryEnqueue = enqueue;
    const script = makeStreamImpl([
      { kind: 'tool', callId: 'delete', name: 'delete_event', input: { event_id: event.id } },
      { kind: 'error', error: new Error('private provider details') },
    ]);
    const result = await new CalendarBotAgent(config, sender, { streamImpl: script.impl }).run(ctx);
    expect(ctx.eventService.getEvent(event.id, USER_ID)).toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
    expect(result.responseText).toContain('Completed: Delete event');
    expect(result.responseText).toContain('interrupted');
    expect(result.responseText).not.toContain('private provider');
  });

  test('receipts persist before next provider request without provisional success prose', async () => {
    const event = createOwnedEvent(ctx);
    const script = makeStreamImpl([
      {
        kind: 'tool',
        callId: 'delete',
        name: 'delete_event',
        input: { event_id: event.id },
        text: 'Everything completed provisionally',
      },
      { kind: 'text', text: 'Done.' },
    ]);
    let receipts = '';
    const impl = async (opts: StreamRoundOptions, callbacks?: StreamCallbacks) => {
      if (!isValidatorCall(opts) && script.calls.length === 1)
        receipts = JSON.stringify(ctx.chatHistory.getRecent(USER_ID));
      return script.impl(opts, callbacks);
    };
    await new CalendarBotAgent(config, sender, { streamImpl: impl }).run(ctx);
    expect(receipts).toContain('delete');
    expect(receipts).toContain('tool_call_id');
    expect(receipts).not.toContain('Everything completed provisionally');
  });

  test('failed write cannot be narrated as success', async () => {
    const { impl } = makeStreamImpl([
      { kind: 'tool', callId: 'failed-delete', name: 'delete_event', input: { event_id: '999999' } },
      { kind: 'text', text: 'Successfully deleted everything.' },
    ]);
    const result = await new CalendarBotAgent(config, sender, { streamImpl: impl }).run(ctx);
    expect(result.responseText).toContain('Not completed: Delete event');
    expect(result.responseText).not.toContain('Successfully deleted everything.');
    const history = ctx.chatHistory.getRecent(USER_ID);
    expect(JSON.stringify(history)).not.toContain('Successfully deleted everything.');
  });

  test('later success for the same operation and target clears the failure', async () => {
    const event = ctx.eventService.createEvent({
      user_id: USER_ID,
      title: 'Synthetic',
      start_at: '2030-01-01T10:00:00Z',
      timezone: 'UTC',
    });
    const { impl } = makeStreamImpl([
      { kind: 'tool', callId: 'bad-update', name: 'update_event', input: { event_id: String(event.id), title: 123 } },
      { kind: 'tool', callId: 'good-update', name: 'update_event', input: { event_id: event.id, title: 'Corrected' } },
      { kind: 'text', text: 'Updated.' },
    ]);
    const result = await new CalendarBotAgent(config, sender, { streamImpl: impl }).run(ctx);
    expect(result.responseText).not.toContain('Not completed:');
    expect(ctx.eventService.getEvent(event.id, USER_ID)?.title).toBe('Corrected');
  });

  test('retry loop guards failed writes without replaying a successful write', async () => {
    const event = ctx.eventService.createEvent({
      user_id: USER_ID,
      title: 'Synthetic',
      start_at: '2030-01-01T10:00:00Z',
      timezone: 'UTC',
    });
    approveDeletes(USER_ID, ctx.chatId, [event.id]);
    const script = makeStreamImpl([
      { kind: 'text', text: 'Unverified answer' },
      { kind: 'tool', callId: 'retry-delete', name: 'delete_event', input: { event_id: String(event.id) } },
      { kind: 'tool', callId: 'retry-duplicate', name: 'delete_event', input: { event_id: String(event.id) } },
      { kind: 'tool', callId: 'retry-failed', name: 'delete_event', input: { event_id: '999999' } },
      { kind: 'text', text: 'Everything succeeded.' },
    ]);
    const impl = async (opts: StreamRoundOptions, callbacks?: StreamCallbacks): Promise<StreamRoundResult> => {
      if (isValidatorCall(opts))
        return {
          text: 'REJECT: missing evidence',
          toolCalls: [],
          finishReason: 'stop',
          assistantMessage: { role: 'assistant', content: 'REJECT: missing evidence' },
          providerUsed: 'synthetic',
        };
      return script.impl(opts, callbacks);
    };
    const result = await new CalendarBotAgent(config, sender, { streamImpl: impl }).run(ctx);
    expect(script.calls).toHaveLength(5);
    expect(result.toolResults.map((entry) => entry.success)).toEqual([true, true, false]);
    expect(result.responseText).toContain('Completed: Delete event');
    expect(result.responseText).toContain('Not completed: Delete event');
    expect(result.responseText).not.toContain('Everything succeeded.');
    expect(JSON.stringify(ctx.chatHistory.getRecent(USER_ID))).not.toContain('Everything succeeded.');
    expect(ctx.eventService.getEvent(event.id, USER_ID)).toBeNull();
  });

  test.each(['ask_user', 'pick_users', 'supplement_skip'])('failed write preserves %s stop behavior', async (name) => {
    const script = makeStreamImpl([
      { kind: 'tool', callId: 'failure', name: 'delete_event', input: { event_id: '999999' } },
      {
        kind: 'tool',
        callId: 'stop',
        name,
        input: { question: 'Which event?', options: ['A', 'B'], event_id: 999999, prompt: 'Who?' },
      },
    ]);
    if (name === 'pick_users') sender.sendUserPicker = mock(() => Promise.resolve({ message_id: 43 }));
    if (name === 'ask_user') sender.sendButtons = mock(() => Promise.resolve({ message_id: 43 }));
    if (name === 'supplement_skip') ctx.supplementMode = true;
    const result = await new CalendarBotAgent(config, sender, { streamImpl: script.impl }).run(ctx);
    expect(script.calls).toHaveLength(2);
    expect(result.responseText).not.toContain('Not completed:');
    if (name === 'ask_user') expect(sender.sendButtons).toHaveBeenCalledTimes(1);
    if (name === 'pick_users') expect(sender.sendUserPicker).toHaveBeenCalledTimes(1);
    if (name === 'supplement_skip') expect(sender.editMessageText).not.toHaveBeenCalled();
  });

  test.each([
    'end',
    'rounds',
    'throw',
    'quiet-retry',
    'timeout',
  ])('final evidence survives %s termination', async (ending) => {
    const failure: ScriptedRound = {
      kind: 'tool',
      callId: 'failure',
      name: 'delete_event',
      input: { event_id: 999999 },
    };
    const tail: ScriptedRound[] =
      ending === 'end'
        ? [
            {
              kind: 'tool',
              callId: 'stop',
              name: 'end_conversation',
              input: {},
              text: 'Successfully deleted everything.',
            },
          ]
        : ending === 'rounds'
          ? Array.from({ length: 14 }, (_, i) => ({ ...failure, callId: `failure-${i}` }))
          : [{ kind: 'error', text: 'Successfully deleted everything.', error: new Error('provider secret') }];
    if (ending === 'quiet-retry') ctx.retryAttempt = 1;
    const enqueue = mock(async () => true);
    ctx.retryEnqueue = enqueue;
    let delivered = '';
    sender.editMessageText = async (_chatId, _messageId, text) => {
      delivered = text;
    };
    const script = makeStreamImpl([failure, ...tail]);
    const now = Date.now();
    const date = spyOn(Date, 'now').mockImplementation(() =>
      ending === 'timeout' && script.calls.length >= 1 ? now + 300001 : now,
    );
    let result: Awaited<ReturnType<CalendarBotAgent['run']>>;
    try {
      result = await new CalendarBotAgent(config, sender, { streamImpl: script.impl }).run(ctx);
    } finally {
      date.mockRestore();
    }
    if (ending === 'quiet-retry') expect(enqueue).toHaveBeenCalledTimes(1);
    expect(result.responseText).toContain('Not completed:');
    expect(result.responseText).not.toContain('Successfully deleted');
    const history = JSON.stringify(ctx.chatHistory.getRecent(USER_ID));
    expect(history).toContain('Not completed:');
    expect(history).not.toContain('Successfully deleted');
    expect(delivered).toContain('Not completed:');
    expect(delivered).not.toContain('Successfully deleted');
  });

  test('a cross-run throttle cannot invent a new completed write', async () => {
    const event = ctx.eventService.createEvent({
      user_id: USER_ID,
      title: 'Before',
      start_at: '2030-01-01T10:00:00Z',
      timezone: 'UTC',
    });
    const input = { event_id: event.id, title: 'After' };
    expect((await executeTool(ctx, 'update_event', input)).success).toBe(true);
    const update = spyOn(ctx.eventService, 'updateEvent');
    let delivered = '';
    sender.editMessageText = async (_chatId, _messageId, text) => {
      delivered = text;
    };
    const { impl } = makeStreamImpl([
      { kind: 'tool', callId: 'skipped', name: 'update_event', input },
      { kind: 'text', text: 'Updated successfully again.' },
    ]);
    try {
      const result = await new CalendarBotAgent(config, sender, { streamImpl: impl }).run(ctx);
      expect(update).not.toHaveBeenCalled();
      expect(ctx.eventService.getEvent(event.id, USER_ID)?.title).toBe('After');
      expect(result.responseText).toContain('skipped');
      expect(result.responseText).not.toContain('Updated successfully');
      expect(delivered).not.toContain('Updated successfully');
      expect(JSON.stringify(ctx.chatHistory.getRecent(USER_ID))).not.toContain('Updated successfully');
    } finally {
      update.mockRestore();
    }
  });

  test.each(['end', 'rounds', 'throw', 'timeout'])('validation retry shares final guard on %s', async (ending) => {
    const failure: ScriptedRound = {
      kind: 'tool',
      callId: 'failure',
      name: 'delete_event',
      input: { event_id: 999999 },
    };
    const tail: ScriptedRound[] =
      ending === 'end'
        ? [{ kind: 'tool', callId: 'stop', name: 'end_conversation', input: {}, text: 'Deleted successfully.' }]
        : ending === 'rounds'
          ? Array.from({ length: 14 }, (_, i) => ({ ...failure, callId: `f-${i}` }))
          : [{ kind: 'error', text: 'Deleted successfully.', error: new Error('provider secret') }];
    const script = makeStreamImpl([{ kind: 'text', text: 'Unverified answer' }, failure, ...tail]);
    const now = Date.now();
    const date = spyOn(Date, 'now').mockImplementation(() =>
      ending === 'timeout' && script.calls.length >= 2 ? now + 300001 : now,
    );
    let delivered = '';
    sender.editMessageText = async (_chatId, _messageId, text) => {
      delivered = text;
    };
    const impl = async (opts: StreamRoundOptions, callbacks?: StreamCallbacks): Promise<StreamRoundResult> => {
      if (isValidatorCall(opts))
        return {
          text: 'REJECT',
          toolCalls: [],
          finishReason: 'stop',
          assistantMessage: { role: 'assistant', content: 'REJECT' },
          providerUsed: 'synthetic',
        };
      return script.impl(opts, callbacks);
    };
    try {
      const result = await new CalendarBotAgent(config, sender, { streamImpl: impl }).run(ctx);
      expect(result.responseText).toContain('Not completed:');
      expect(delivered).toContain('Not completed:');
      expect(delivered).not.toContain('Deleted successfully');
      const history = JSON.stringify(ctx.chatHistory.getRecent(USER_ID));
      expect(history).toContain('Not completed:');
      expect(history).not.toContain('Deleted successfully');
      expect(history).not.toContain('Unverified answer');
    } finally {
      date.mockRestore();
    }
  });

  test('successful location update retains failed title and time intent in real SQLite', async () => {
    const event = ctx.eventService.createEvent({
      user_id: USER_ID,
      title: 'Before',
      start_at: '2030-01-01T10:00:00Z',
      timezone: 'UTC',
    });
    const { impl } = makeStreamImpl([
      { kind: 'tool', callId: 'bad', name: 'update_event', input: { event_id: event.id, title: 123, start_at: 123 } },
      { kind: 'tool', callId: 'good', name: 'update_event', input: { event_id: event.id, location: 'Office' } },
      { kind: 'text', text: 'Everything updated.' },
    ]);
    let delivered = '';
    sender.editMessageText = async (_chatId, _messageId, text) => {
      delivered = text;
    };
    const result = await new CalendarBotAgent(config, sender, { streamImpl: impl }).run(ctx);
    expect(result.responseText).toContain('title');
    expect(result.responseText).toContain('start time');
    expect(delivered).toContain('Not completed:');
    const saved = ctx.eventService.getEvent(event.id, USER_ID);
    expect(saved?.title).toBe('Before');
    expect(saved?.location).toBe('Office');
    expect(JSON.stringify(ctx.chatHistory.getRecent(USER_ID))).not.toContain('Everything updated.');
  });

  test('implicit failure stays silent and persists authoritative evidence', async () => {
    ctx.wasExplicitInvocation = false;
    sender.deleteMessage = mock(async () => {});
    const enqueue = mock(async () => true);
    ctx.retryEnqueue = enqueue;
    const { impl } = makeStreamImpl([
      { kind: 'tool', callId: 'failed', name: 'delete_event', input: { event_id: 999999 } },
      { kind: 'error', text: 'Deleted successfully.', error: new Error('provider secret') },
    ]);
    const result = await new CalendarBotAgent(config, sender, { streamImpl: impl }).run(ctx);
    expect(result.responseText).toBe('');
    expect(sender.deleteMessage).toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    const history = JSON.stringify(ctx.chatHistory.getRecent(USER_ID));
    expect(history).toContain('Not completed:');
    expect(history).not.toContain('Deleted successfully');
  });

  test('failed create is also guarded by structured write evidence', async () => {
    const { impl } = makeStreamImpl([
      { kind: 'tool', callId: 'bad-create', name: 'create_event', input: { title: 'Synthetic' } },
      { kind: 'text', text: 'Created successfully.' },
    ]);
    const result = await new CalendarBotAgent(config, sender, { streamImpl: impl }).run(ctx);
    expect(result.responseText).toContain('Not completed: Create event');
    expect(result.responseText).not.toContain('Created successfully.');
    expect(JSON.stringify(ctx.chatHistory.getRecent(USER_ID))).not.toContain('Created successfully.');
  });
});
