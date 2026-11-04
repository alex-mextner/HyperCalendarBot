// A response validator that cannot reach a verdict is an outage, not a rejection: a run that has
// already written to the calendar must not lose its outcome to it (production, 2026-11-01).
import { beforeEach, describe, expect, test } from 'bun:test';
import { CalendarBotAgent } from '../../../src/services/ai/agent.ts';
import type { StreamCallbacks, StreamRoundOptions } from '../../../src/services/ai/streaming.ts';
import type { AgentConfig, AgentContext, TelegramSender } from '../../../src/services/ai/types.ts';
import { createAgentRunFixture, isValidatorCall, makeStreamImpl, type ScriptedRound } from './agent-run-helpers.ts';

const TITLE_A = 'Synthetic standup';
const TITLE_B = 'Synthetic review';
/** A clock time no tool result contains: the prose is unbacked, so the validator model is asked. */
const UNBACKED_PROSE = 'Both events are saved. You are free at 18:45.';

function timeoutError(): DOMException {
  return new DOMException('The operation timed out.', 'TimeoutError');
}

/** The run of 2026-11-01 in miniature: two creates, a read, then prose the validator cannot check. */
function incidentRounds(): ScriptedRound[] {
  return [
    { kind: 'tool', callId: 'c1', name: 'create_event', input: { title: TITLE_A, start_at: '2035-03-05T09:00:00Z' } },
    { kind: 'tool', callId: 'c2', name: 'create_event', input: { title: TITLE_B, start_at: '2035-03-05T13:30:00Z' } },
    { kind: 'tool', callId: 'r1', name: 'get_events', input: { start_date: '2035-03-05', end_date: '2035-03-05' } },
    { kind: 'text', text: UNBACKED_PROSE },
  ];
}

describe('validator outage after writes', () => {
  let ctx: AgentContext;
  let config: AgentConfig;
  let sender: TelegramSender;

  beforeEach(() => {
    ({ ctx, config, sender } = createAgentRunFixture());
  });

  function runWithValidator(rounds: ScriptedRound[], validator: (opts: StreamRoundOptions) => Promise<never>) {
    const script = makeStreamImpl(rounds);
    const stats = { validatorCalls: 0 };
    const impl = (opts: StreamRoundOptions, cbs?: StreamCallbacks) => {
      if (isValidatorCall(opts)) {
        stats.validatorCalls++;
        return validator(opts);
      }
      return script.impl(opts, cbs);
    };
    return { impl, script, stats };
  }

  function eventRows() {
    return ctx.eventService.getEventsForDay(ctx.user.telegram_id, new Date('2035-03-05T12:00:00Z'), 'UTC');
  }

  test.each([
    ['en', 'March 5'] as const,
    ['ru', '5 марта'] as const,
  ])('delivers a receipt-only confirmation of what was created (%s)', async (language, dayWords) => {
    ctx.user.language = language;
    const { impl, script, stats } = runWithValidator(incidentRounds(), () => Promise.reject(timeoutError()));
    const result = await new CalendarBotAgent(config, sender, { streamImpl: impl }).run(ctx);

    expect(result.toolCalls.filter((call) => call.name === 'create_event')).toHaveLength(2);
    expect(eventRows()).toHaveLength(2);
    // No retry-with-tools pass: it could replay the writes. Four scripted rounds, not five.
    expect(script.calls).toHaveLength(4);
    expect(stats.validatorCalls).toBe(1);

    const text = result.responseText;
    expect(text).toContain(TITLE_A);
    expect(text).toContain('09:00');
    expect(text).toContain(TITLE_B);
    expect(text).toContain('13:30');
    expect(text).toContain(dayWords);
    // Unverified model prose never reaches the user, and nothing says the request was interrupted.
    expect(text).not.toContain('18:45');
    expect(text).not.toMatch(/interrupted|прерван/i);
    expect(result.metrics?.termination).toBe('unverified');
    expect(JSON.stringify(ctx.chatHistory.getRecent(ctx.user.telegram_id))).toContain(TITLE_B);
  });

  test('a failed or uncertain write keeps the guard notice and still runs no retry', async () => {
    const rounds: ScriptedRound[] = [
      { kind: 'tool', callId: 'c1', name: 'create_event', input: { title: TITLE_A, start_at: '2035-03-05T09:00:00Z' } },
      { kind: 'tool', callId: 'u1', name: 'update_event', input: { event_id: 999_999, title: 'Nope' } },
      { kind: 'tool', callId: 'r1', name: 'get_events', input: { start_date: '2035-03-05', end_date: '2035-03-05' } },
      { kind: 'text', text: UNBACKED_PROSE },
    ];
    const { impl, script } = runWithValidator(rounds, () => Promise.reject(timeoutError()));
    const result = await new CalendarBotAgent(config, sender, { streamImpl: impl }).run(ctx);

    expect(script.calls).toHaveLength(4);
    expect(result.responseText).toContain('Not updated');
    expect(result.responseText).toContain('Created: event');
    expect(result.metrics?.termination).toBe('unverified');
  });

  // Real delays on purpose: the request deadline is an AbortSignal.timeout on the platform clock,
  // and fake time cannot make it fire while the model round is still "running".
  test('a validator that starts with almost no request budget left still gets its own time', async () => {
    const script = makeStreamImpl([
      { kind: 'tool', callId: 'r1', name: 'get_events', input: { start_date: '2035-03-05', end_date: '2035-03-05' } },
      { kind: 'text', text: 'You have a meeting at 18:45.' },
    ]);
    let modelCalls = 0;
    const impl = async (opts: StreamRoundOptions, cbs?: StreamCallbacks) => {
      if (isValidatorCall(opts)) await Bun.sleep(150);
      else if (++modelCalls === 2) await Bun.sleep(330);
      return script.impl(opts, cbs);
    };
    const result = await new CalendarBotAgent(config, sender, { streamImpl: impl, requestTimeoutMs: 400 }).run(ctx);

    expect(result.responseText).toContain('You have a meeting at 18:45.');
    expect(result.metrics?.termination).toBe('normal');
  });
});
