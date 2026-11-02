// Shared fixtures for the suites that replay the 2026-11-01 overlap: a slow host (a clock the test
// moves and one parked model request) and a model that is a function of what it is shown. Only the
// model is scripted; agents, tools, the 5 s repeated-call throttle and the database are real.
import { spyOn } from 'bun:test';
import type OpenAI from 'openai';
import type { StreamCallbacks, StreamRoundOptions, StreamRoundResult } from '../../src/services/ai/streaming.ts';
import type { TelegramSender } from '../../src/services/ai/types.ts';
import { type AgentRunFixture, fakeMetrics, isValidatorCall, USER_ID } from '../services/ai/agent-run-helpers.ts';

export const STANDUP = { title: 'Synthetic Standup', start_at: '2030-03-05T10:00:00Z', end_at: '2030-03-05T10:30:00Z' };
export const REVIEW = { title: 'Synthetic Review', start_at: '2030-03-05T11:00:00Z', end_at: '2030-03-05T12:00:00Z' };
/** How long a held model request is held: longer than the 5 s identical-call throttle, as on the slow host. */
export const HOST_DELAY_MS = 10_000;

export interface ModelRequest {
  messages: OpenAI.ChatCompletionMessageParam[];
}

export function textOf(message: OpenAI.ChatCompletionMessageParam | undefined): string {
  const content = message?.content;
  return typeof content === 'string' ? content : JSON.stringify(content ?? '');
}

/** A user turn as the model is shown it, without the timestamp the history builder prefixes. */
export function userTurn(message: OpenAI.ChatCompletionMessageParam | undefined): string {
  return textOf(message).replace(/^\[[^\]]*\] /, '');
}

function textRound(text: string): StreamRoundResult {
  return {
    text,
    toolCalls: [],
    finishReason: 'stop',
    assistantMessage: { role: 'assistant', content: text },
    providerUsed: 'mock',
    metrics: fakeMetrics('zai', 100, 20),
  };
}

function createBothRound(turn: number, allowDuplicate: boolean): StreamRoundResult {
  const calls = [STANDUP, REVIEW].map((event, index) => ({
    id: `create-${turn}-${index}`,
    name: 'create_event',
    arguments: JSON.stringify(allowDuplicate ? { ...event, allow_duplicate: true } : event),
  }));
  return {
    text: '',
    toolCalls: calls,
    finishReason: 'tool_calls',
    assistantMessage: {
      role: 'assistant',
      content: null,
      tool_calls: calls.map((call) => ({
        id: call.id,
        type: 'function' as const,
        function: { name: call.name, arguments: call.arguments },
      })),
    },
    providerUsed: 'mock',
  };
}

/** The host: a clock the test moves and one model request it can park, the way a loaded odroid does. */
export class SlowHost {
  readonly requests: ModelRequest[] = [];
  /**
   * `allowDuplicates`: the model asks for every copy deliberately, so the calendar's own repeat check
   * cannot hide a run that created again; only what the run was shown can keep it from doing so.
   */
  constructor(private readonly options: { allowDuplicates?: boolean } = {}) {}

  private clockMs = Date.parse('2030-01-01T00:00:00Z');
  private readonly released = Promise.withResolvers<void>();
  private readonly reachedFirst = Promise.withResolvers<void>();
  private firstRequestSeen = false;
  private readonly clock = spyOn(Date, 'now').mockImplementation(() => this.clockMs);

  /** Settles once the first model request is waiting. */
  get reached(): Promise<void> {
    return this.reachedFirst.promise;
  }

  /** The parked request returns HOST_DELAY_MS later. */
  release(): void {
    this.clockMs += HOST_DELAY_MS;
    this.released.resolve();
  }

  restore(): void {
    this.clock.mockRestore();
  }

  /**
   * A model that behaves like a sensible one: asked to confirm, it creates both events; once the
   * history it is shown already holds the created events, it only says so; after its own tool
   * results it reports them.
   */
  model = async (opts: StreamRoundOptions, callbacks: StreamCallbacks = {}): Promise<StreamRoundResult> => {
    if (isValidatorCall(opts)) return { ...textRound('APPROVE'), metrics: fakeMetrics('hf', 10, 2) };
    this.requests.push({ messages: opts.messages });
    const turn = this.requests.length;
    if (!this.firstRequestSeen) {
      this.firstRequestSeen = true;
      this.reachedFirst.resolve();
      await this.released.promise;
    }
    const messages = opts.messages;
    const lastUser = messages.map((m) => m.role).lastIndexOf('user');
    const thisTurn = messages.slice(lastUser + 1);
    const before = messages.slice(0, lastUser);
    let round: StreamRoundResult;
    if (thisTurn.some((m) => m.role === 'tool')) {
      round = textRound(`Done: ${thisTurn.filter((m) => m.role === 'tool').length} results seen.`);
    } else if (before.some((m) => m.role === 'tool' && /Event created/.test(textOf(m)))) {
      round = textRound('Both events already exist.');
    } else {
      round = createBothRound(turn, this.options.allowDuplicates === true);
    }
    callbacks.onTextDelta?.(round.text);
    return round;
  };
}

/** Lets every run that can make progress without a held request do so: two turns of the event loop. */
export async function settle(): Promise<void> {
  for (let turn = 0; turn < 2; turn++) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
  }
}

export function titlesInCalendar(fixture: AgentRunFixture): string[] {
  return (
    fixture.db.prepare('SELECT title FROM events WHERE user_id = ? AND is_deleted = 0 ORDER BY id').all(USER_ID) as {
      title: string;
    }[]
  ).map((row) => row.title);
}

/** What the chat showed, in order: sends and edits of every run. */
export function recordDelivery(sender: TelegramSender): string[] {
  const shown: string[] = [];
  sender.sendMessage = async (_chatId, text) => {
    shown.push(text);
    return { message_id: 42 };
  };
  sender.editMessageText = async (_chatId, _messageId, text) => {
    shown.push(text);
  };
  return shown;
}
