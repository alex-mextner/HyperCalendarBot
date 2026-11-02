// A run that ends badly for the user raises one alert for the owner's auto-fix watcher, and nothing
// that identifies the user or the calendar ever goes into it (production, 2026-11-01).
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  AGENT_RUN_INCIDENT_SOURCE,
  INCIDENT_WINDOW_MS,
  type RunIncident,
  RunIncidentReporter,
  tallyTools,
} from '../../../src/services/ai/agent/run-incident.ts';
import { CalendarBotAgent } from '../../../src/services/ai/agent.ts';
import { AiDebugLogger } from '../../../src/services/ai/debug-logger.ts';
import type { StreamCallbacks, StreamRoundOptions } from '../../../src/services/ai/streaming.ts';
import type { AgentConfig, AgentContext, TelegramSender } from '../../../src/services/ai/types.ts';
import { createAgentRunFixture, isValidatorCall, makeStreamImpl, type ScriptedRound } from './agent-run-helpers.ts';

const TITLE_A = 'Synthetic standup';
const TITLE_B = 'Synthetic review';
const PRIVATE_MESSAGE = 'Synthetic private request text';
const CHAT_ID = 987_654_321;

const UNBACKED_PROSE = 'Both events are saved. You are free at 18:45.';
const INCIDENT_ROUNDS: ScriptedRound[] = [
  { kind: 'tool', callId: 'c1', name: 'create_event', input: { title: TITLE_A, start_at: '2035-03-05T09:00:00Z' } },
  { kind: 'tool', callId: 'c2', name: 'create_event', input: { title: TITLE_B, start_at: '2035-03-05T13:30:00Z' } },
  { kind: 'tool', callId: 'r1', name: 'get_events', input: { start_date: '2035-03-05', end_date: '2035-03-05' } },
  { kind: 'text', text: UNBACKED_PROSE },
];

function sampleIncident(overrides: Partial<RunIncident> = {}): RunIncident {
  return {
    incidentClass: 'unverified',
    requestId: '00000000-0000-4000-8000-000000000001',
    termination: 'unverified',
    elapsedMs: 91_234.6,
    deliveryOutcome: 'delivered',
    deliveredMessageIds: [4101],
    tools: [{ name: 'create_event', ok: 2, failed: 0 }],
    writeSucceeded: true,
    modelCalls: 5,
    modelAttempts: 6,
    providerFallbacks: 1,
    validator: 'unavailable(timeout)',
    errorName: null,
    ...overrides,
  };
}

describe('RunIncidentReporter', () => {
  let alerts: { text: string; source: string }[];
  let clock: number;
  let reporter: RunIncidentReporter;

  beforeEach(() => {
    alerts = [];
    clock = 1_000_000;
    reporter = new RunIncidentReporter(
      (text, source) => alerts.push({ text, source }),
      () => clock,
    );
  });

  test('pushes one alert on the agent-run-incident source with the run facts and where to look', () => {
    reporter.report(sampleIncident());

    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.source).toBe(AGENT_RUN_INCIDENT_SOURCE);
    const text = alerts[0]?.text ?? '';
    expect(text).toContain('Agent run incident (unverified)');
    expect(text).toContain('requestId: 00000000-0000-4000-8000-000000000001');
    expect(text).toContain('elapsedMs: 91235');
    expect(text).toContain('tools: create_event ok=2 fail=0');
    expect(text).toContain('writeSucceeded: yes');
    expect(text).toContain('validator: unavailable(timeout)');
    expect(text).toContain('docker logs hypercal-bot');
    expect(text).toContain('logs/chats');
    expect(text).not.toContain('suppressedSince');
  });

  test('holds back repeats of one class for ten minutes and counts them in the next alert', () => {
    reporter.report(sampleIncident({ requestId: 'first' }));
    clock += 60_000;
    reporter.report(sampleIncident({ requestId: 'second' }));
    clock += 60_000;
    reporter.report(sampleIncident({ requestId: 'third' }));
    expect(alerts).toHaveLength(1);

    clock += INCIDENT_WINDOW_MS;
    reporter.report(sampleIncident({ requestId: 'fourth' }));
    expect(alerts).toHaveLength(2);
    expect(alerts[1]?.text).toContain('requestId: fourth');
    expect(alerts[1]?.text).toContain('suppressedSince: 2 earlier incident(s)');

    clock += INCIDENT_WINDOW_MS;
    reporter.report(sampleIncident({ requestId: 'fifth' }));
    expect(alerts[2]?.text).not.toContain('suppressedSince');
  });

  test('each incident class has its own window', () => {
    reporter.report(sampleIncident({ incidentClass: 'unverified' }));
    reporter.report(sampleIncident({ incidentClass: 'error', termination: 'error' }));
    reporter.report(sampleIncident({ incidentClass: 'error', termination: 'error' }));
    expect(alerts.map((alert) => alert.text.split('\n')[0])).toEqual([
      'Agent run incident (unverified)',
      'Agent run incident (error)',
    ]);
  });

  test('an alert queue that throws never fails the run, and the next incident is still reported', () => {
    let failing = true;
    const flaky = new RunIncidentReporter(
      (text, source) => {
        if (failing) throw new Error('database is locked');
        alerts.push({ text, source });
      },
      () => clock,
    );
    expect(() => flaky.report(sampleIncident())).not.toThrow();
    failing = false;
    flaky.report(sampleIncident());
    expect(alerts).toHaveLength(1);
  });

  test('a tool name the bot does not define never reaches the alert text', () => {
    const forged = 'get_events\nsource: forged line with user text';
    const tools = tallyTools(
      [
        { name: forged, input: {} },
        { name: 'get_events', input: {} },
      ],
      [{ success: true }, { success: true }],
    );
    expect(tools.map((tool) => tool.name)).toEqual(['unknown_tool', 'get_events']);
  });
});

describe('agent run incidents', () => {
  let ctx: AgentContext;
  let config: AgentConfig;
  let sender: TelegramSender;
  let alerts: { text: string; source: string }[];

  beforeEach(() => {
    ({ ctx, config, sender } = createAgentRunFixture());
    ctx.messageText = PRIVATE_MESSAGE;
    ctx.chatId = CHAT_ID;
    alerts = [];
    config.runIncidents = new RunIncidentReporter((text, source) => alerts.push({ text, source }));
  });

  afterEach(() => setSystemTime());

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
    return { impl, stats };
  }

  function expectNothingPrivate(text: string) {
    expect(text).not.toContain(PRIVATE_MESSAGE);
    expect(text).not.toContain(TITLE_A);
    expect(text).not.toContain(TITLE_B);
    expect(text).not.toContain('18:45');
    expect(text).not.toContain(String(CHAT_ID));
    expect(text).not.toMatch(/\b456\b/);
  }

  test('a validator timeout after two successful writes: a readable receipt, one alert, no second write', async () => {
    const { impl } = runWithValidator(INCIDENT_ROUNDS, () =>
      Promise.reject(new DOMException('timed out', 'TimeoutError')),
    );
    const result = await new CalendarBotAgent(config, sender, { streamImpl: impl }).run(ctx);

    expect(result.toolCalls.filter((call) => call.name === 'create_event')).toHaveLength(2);
    expect(result.responseText).toContain(TITLE_A);
    expect(result.responseText).toContain(TITLE_B);
    expect(result.responseText).not.toMatch(/interrupted/i);

    expect(alerts).toHaveLength(1);
    const text = alerts[0]?.text ?? '';
    expect(alerts[0]?.source).toBe('agent-run-incident');
    expect(text).toContain(`requestId: ${result.metrics?.requestId}`);
    expect(text).toContain('termination: unverified');
    expect(text).toContain('create_event ok=2 fail=0');
    expect(text).toContain('get_events ok=1 fail=0');
    expect(text).toContain('writeSucceeded: yes');
    expect(text).toContain('validator: unavailable(timeout)');
    expect(text).toContain('delivery: edited messages=1 ids=42');
    expectNothingPrivate(text);
  });

  test('a request budget spent before the validator starts: same receipt, same single alert', async () => {
    const script = makeStreamImpl(INCIDENT_ROUNDS);
    let modelRounds = 0;
    const impl = async (opts: StreamRoundOptions, cbs?: StreamCallbacks) => {
      if (isValidatorCall(opts)) throw new Error('the validator must not start after the deadline');
      // The last round ends past the 90 s request deadline: the platform clock jumps, no real waiting.
      if (++modelRounds === INCIDENT_ROUNDS.length) setSystemTime(new Date(Date.now() + 100_000));
      return script.impl(opts, cbs);
    };
    const result = await new CalendarBotAgent(config, sender, { streamImpl: impl }).run(ctx);

    expect(result.responseText).toContain(TITLE_A);
    expect(result.responseText).toContain(TITLE_B);
    expect(result.toolCalls.filter((call) => call.name === 'create_event')).toHaveLength(2);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.text).toContain('validator: unavailable(budget_expired)');
    expectNothingPrivate(alerts[0]?.text ?? '');
  });

  test('a provider failure ends the run as an error incident carrying only the error class', async () => {
    const script = makeStreamImpl([{ kind: 'error', error: new TypeError(`boom ${PRIVATE_MESSAGE}`) }]);
    const result = await new CalendarBotAgent(config, sender, { streamImpl: script.impl }).run(ctx);

    expect(result.metrics?.termination).toBe('error');
    expect(alerts).toHaveLength(1);
    const text = alerts[0]?.text ?? '';
    expect(text).toContain('Agent run incident (error)');
    expect(text).toContain('error: TypeError');
    expectNothingPrivate(text);
  });

  test('the per-chat debug log carries the request id the alert names', async () => {
    const dir = mkdtempSync(`${tmpdir()}/incident-dbg-`);
    try {
      config.debugLogger = new AiDebugLogger(true, dir);
      const script = makeStreamImpl([{ kind: 'text', text: 'Hello there.' }]);
      const result = await new CalendarBotAgent(config, sender, { streamImpl: script.impl }).run(ctx);

      const [file] = readdirSync(`${dir}/chats/${CHAT_ID}`);
      const log = readFileSync(`${dir}/chats/${CHAT_ID}/${file}`, 'utf8');
      expect(log).toContain(`REQUEST ID: ${result.metrics?.requestId}`);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('a run that ends normally raises nothing', async () => {
    const script = makeStreamImpl([{ kind: 'text', text: 'Hello there.' }]);
    await new CalendarBotAgent(config, sender, { streamImpl: script.impl }).run(ctx);
    expect(alerts).toHaveLength(0);
  });

  test('a failed optional supplement turn raises nothing', async () => {
    ctx.supplementMode = true;
    const script = makeStreamImpl([{ kind: 'error', error: new Error('supplement provider failed') }]);
    await new CalendarBotAgent(config, sender, { streamImpl: script.impl }).run(ctx);
    expect(alerts).toHaveLength(0);
  });

  test('a run cut short by the process shutting down raises nothing', async () => {
    const agent = new CalendarBotAgent(config, sender, { streamImpl: makeStreamImpl([]).impl });
    await agent.drain(50);
    await agent.run(ctx);
    expect(alerts).toHaveLength(0);
  });

  test('two failing runs inside the window raise one alert', async () => {
    const failing = () => makeStreamImpl([{ kind: 'error', error: new Error('provider down') }]).impl;
    await new CalendarBotAgent(config, sender, { streamImpl: failing() }).run(ctx);
    await new CalendarBotAgent(config, sender, { streamImpl: failing() }).run(ctx);
    expect(alerts).toHaveLength(1);
  });
});
