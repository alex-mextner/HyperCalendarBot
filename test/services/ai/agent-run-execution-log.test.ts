import { beforeEach, describe, expect, test } from 'bun:test';
import type OpenAI from 'openai';
import { CalendarBotAgent } from '../../../src/services/ai/agent.ts';
import { approveDeletes } from '../../../src/services/ai/delete-confirmation.ts';
import type { StreamCallbacks, StreamRoundOptions, StreamRoundResult } from '../../../src/services/ai/streaming.ts';
import type { AgentConfig, AgentContext, TelegramSender } from '../../../src/services/ai/types.ts';
import { createAgentRunFixture, isValidatorCall, makeStreamImpl, USER_ID } from './agent-run-helpers.ts';

describe('CalendarBotAgent.run()', () => {
  let ctx: AgentContext;
  let config: AgentConfig;
  let sender: TelegramSender;

  beforeEach(() => {
    ({ ctx, config, sender } = createAgentRunFixture());
  });

  test('a successful tool call during validator-retry still appears in the execution log even though the final answer is guarded (#346)', async () => {
    // Covers the retry loop's stopLoop early-return: a round that SUCCEEDS
    // (writes a real ✅ toolLine, no failure) followed by a stopLoop round
    // must still have that success reach finalize()'s execution log, even
    // though the request-wide validator guard replaces the model's own
    // final answer with a generic notice.
    const script = makeStreamImpl([
      { kind: 'text', text: 'Unverified answer' },
      {
        kind: 'tool',
        callId: 'ok',
        name: 'get_events',
        input: { start_date: '2030-01-01T00:00:00Z', end_date: '2030-01-02T00:00:00Z' },
      },
      { kind: 'tool', callId: 'stop', name: 'end_conversation', input: {}, text: 'All done.' },
    ]);
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
    await new CalendarBotAgent(config, sender, { streamImpl: impl }).run(ctx);
    expect(delivered).toContain('<blockquote expandable>');
    expect(delivered).toContain('✅');
    // The model's own unvalidated final claim must never surface as the answer.
    expect(delivered).not.toContain('All done.');
    expect(delivered).not.toContain('Unverified answer');
  });

  test('provider failover mid-stream preserves the already-committed execution log (#346)', async () => {
    // onProviderSwitch fires when a provider fails over mid-round — it must
    // discard only that round's in-flight draft, never a PRIOR round's
    // already-committed tool history.
    const script = makeStreamImpl([
      {
        kind: 'tool',
        callId: 'ok',
        name: 'get_events',
        input: { start_date: '2030-01-01T00:00:00Z', end_date: '2030-01-02T00:00:00Z' },
      },
      { kind: 'text', text: 'Here are your events.' },
    ]);
    let delivered = '';
    sender.editMessageText = async (_chatId, _messageId, text) => {
      delivered = text;
    };
    let round = 0;
    const impl: typeof script.impl = async (opts, cbs) => {
      if (!isValidatorCall(opts)) {
        round += 1;
        if (round === 2) cbs?.onProviderSwitch?.();
      }
      return script.impl(opts, cbs);
    };
    await new CalendarBotAgent(config, sender, { streamImpl: impl }).run(ctx);
    expect(delivered).toContain('<blockquote expandable>');
    expect(delivered).toContain('✅');
    expect(delivered).toContain('Here are your events.');
  });

  test('a false success claim narrated alongside a failing tool call never reaches the execution log (#346)', async () => {
    // Real risk flagged in review: if the model narrates a premature
    // completion claim in the SAME round as a tool call that then fails,
    // that prose must never survive into the trusted execution log once the
    // request-wide guard fires — even though it was committed in an EARLIER
    // round, before the guard had a reason to fire. AGENTS.md: never report
    // a deletion/creation as done when it wasn't.
    const script = makeStreamImpl([
      {
        kind: 'tool',
        callId: 'bad',
        name: 'delete_event',
        input: { event_id: 999999 },
        text: 'Готово! Событие удалено ✅',
      },
      { kind: 'text', text: 'Final response text.' },
    ]);
    let delivered = '';
    sender.editMessageText = async (_chatId, _messageId, text) => {
      delivered = text;
    };
    await new CalendarBotAgent(config, sender, { streamImpl: script.impl }).run(ctx);
    expect(delivered).toContain('Not completed:');
    expect(delivered).not.toContain('Готово! Событие удалено');
  });

  test('provider failover mid-stream in the validator-retry loop preserves the execution log (#346)', async () => {
    // The retry loop (runRetryAfterRejection) wires its own onProviderSwitch
    // callback separately from the main loop — nothing else pins that it
    // actually reaches writer.resetDraft() without wiping prior tool history.
    const script = makeStreamImpl([
      { kind: 'text', text: 'Unverified answer' },
      {
        kind: 'tool',
        callId: 'ok',
        name: 'get_events',
        input: { start_date: '2030-01-01T00:00:00Z', end_date: '2030-01-02T00:00:00Z' },
      },
      { kind: 'tool', callId: 'stop', name: 'end_conversation', input: {}, text: 'All done.' },
    ]);
    let delivered = '';
    sender.editMessageText = async (_chatId, _messageId, text) => {
      delivered = text;
    };
    let retryRound = 0;
    const impl = async (opts: StreamRoundOptions, callbacks?: StreamCallbacks): Promise<StreamRoundResult> => {
      if (isValidatorCall(opts))
        return {
          text: 'REJECT',
          toolCalls: [],
          finishReason: 'stop',
          assistantMessage: { role: 'assistant', content: 'REJECT' },
          providerUsed: 'synthetic',
        };
      retryRound += 1;
      // round 1 is the original rejected text; rounds 2+ are the retry loop.
      if (retryRound === 3) callbacks?.onProviderSwitch?.();
      return script.impl(opts, callbacks);
    };
    await new CalendarBotAgent(config, sender, { streamImpl: impl }).run(ctx);
    expect(delivered).toContain('<blockquote expandable>');
    expect(delivered).toContain('✅');
    expect(delivered).not.toContain('All done.');
    expect(delivered).not.toContain('Unverified answer');
  });

  test('committed reasoning narration survives finalize when the request stays fully trusted (#346)', async () => {
    // The inverse of resetForGuard's narration-stripping: on a clean, non-guarded run
    // (no write failure, no validator rejection, no waiting/error), the
    // model's own interim reasoning is legitimate context and must still
    // reach the execution log — this change must not turn into "narration
    // is always dropped".
    const script = makeStreamImpl([
      {
        kind: 'tool',
        callId: 'ok',
        name: 'get_events',
        input: { start_date: '2030-01-01T00:00:00Z', end_date: '2030-01-02T00:00:00Z' },
        text: 'Ищу события...',
      },
      { kind: 'text', text: 'Вот ваши события.' },
    ]);
    let delivered = '';
    sender.editMessageText = async (_chatId, _messageId, text) => {
      delivered = text;
    };
    await new CalendarBotAgent(config, sender, { streamImpl: script.impl }).run(ctx);
    expect(delivered).toContain('<blockquote expandable>');
    expect(delivered).toContain('Ищу события');
    expect(delivered).toContain('Вот ваши события.');
  });

  test('earlier-round committed reasoning survives a rejected-then-approved retry (#346)', async () => {
    // Round 0 (main loop): tool call, reasoning committed via commitIntermediate().
    // Round 1 (main loop): a "nothing scheduled" claim after a non-schedule-read tool —
    // shouldValidateResponse fires and validateResponse's local prefilter rejects it
    // deterministically (no LLM call needed for this half).
    // Round 2 (retry loop): a corrected claim that does NOT match the completeness
    // prefilter, so re-validation actually calls the LLM validator, which approves.
    // guarded stays false, so resetForGuard() never fires and round 0's committed
    // reasoning must survive finalize.
    const event = ctx.eventService.createEvent({
      user_id: USER_ID,
      title: 'To delete',
      start_at: '2030-01-01T10:00:00Z',
      timezone: 'UTC',
    });
    approveDeletes(USER_ID, ctx.chatId, [event.id]);
    const script = makeStreamImpl([
      {
        kind: 'tool',
        callId: 'ok',
        name: 'delete_event',
        input: { event_id: event.id },
        text: 'Удаляю событие...',
      },
      { kind: 'text', text: 'Ничего больше не запланировано.' },
      { kind: 'text', text: 'Событие удалено.' },
    ]);
    const impl = async (opts: StreamRoundOptions, cbs?: StreamCallbacks): Promise<StreamRoundResult> => {
      if (isValidatorCall(opts)) {
        const msg: OpenAI.ChatCompletionMessageParam = { role: 'assistant', content: 'APPROVE' };
        return {
          text: 'APPROVE',
          toolCalls: [],
          finishReason: 'stop',
          assistantMessage: msg,
          providerUsed: 'mock-validator',
        };
      }
      return script.impl(opts, cbs);
    };
    let delivered = '';
    sender.editMessageText = async (_chatId, _messageId, text) => {
      delivered = text;
    };
    ctx.retryEnqueue = async () => true;
    await new CalendarBotAgent(config, sender, { streamImpl: impl }).run(ctx);
    expect(delivered).toContain('<blockquote expandable>');
    expect(delivered).toContain('Удаляю событие');
    expect(delivered).toContain('Событие удалено.');
  });
});
