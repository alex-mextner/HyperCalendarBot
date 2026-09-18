import { describe, expect, mock, test } from 'bun:test';
import { IntentExecutor } from '../../../src/services/intent/intent-executor.ts';
import { WorkflowSchema } from '../../../src/services/intent/workflow-schema.ts';
import { validateWorkflow } from '../../../src/services/intent/workflow-validator.ts';

const context = { timezone: 'UTC', language: 'en', userId: 1001 };
const settings = {
  tools: [
    {
      name: 'manage_settings',
      input: { action: 'update', category: 'general', updates: { default_event_duration_minutes: 45 } },
    },
  ],
};
const versioned = (workflow: Record<string, unknown>) => ({ version: 2, ...workflow });

describe('explicit versioned workflow inputs', () => {
  test('unversioned invalid legacy rule stays invalid; explicit version2 accepts the same safe typed input', () => {
    expect(WorkflowSchema.safeParse(settings).success).toBe(false);
    expect(WorkflowSchema.safeParse({ version: 1, ...settings }).success).toBe(false);
    expect(WorkflowSchema.safeParse(versioned(settings)).success).toBe(true);
  });
  test('unknown version is never silently stripped through legacy branch', () => {
    expect(WorkflowSchema.safeParse({ version: 3, tools: [{ name: 'get_contacts', input: {} }] }).success).toBe(false);
  });
  test('booleans, numbers, null and arrays survive parser without string coercion', () => {
    const input = {
      action: 'update',
      category: 'notifications',
      updates: { morning_agenda_enabled: true, quiet_hours_start: null, default_reminder_minutes: [30, 0] },
    };
    const parsed = WorkflowSchema.parse(versioned({ tools: [{ name: 'manage_settings', input }] }));
    expect('tools' in parsed && parsed.tools[0]?.input).toEqual(input);
  });
  test('version2 allows exactly one steps/tools branch, not silently choosing one', () => {
    expect(WorkflowSchema.safeParse({ version: 2, tools: [], steps: [{ respond: 'x' }] }).success).toBe(false);
  });
  for (const invalid of [NaN, Infinity, undefined, () => 1, 1n, new Date()])
    test(`reject non-JSON input ${typeof invalid}/${String(invalid)}`, () => {
      expect(
        WorkflowSchema.safeParse(
          versioned({ tools: [{ name: 'manage_settings', input: { updates: { value: invalid } } }] }),
        ).success,
      ).toBe(false);
    });
  test('reject prototype keys without polluting global objects', () => {
    const payload = JSON.parse(
      '{"version":2,"tools":[{"name":"manage_settings","input":{"updates":{"__proto__":{"polluted":true}}}}]}',
    );
    expect(WorkflowSchema.safeParse(payload).success).toBe(false);
    expect(Object.prototype).not.toHaveProperty('polluted');
  });
  test('reject cycles and excessive nesting without stack overflow', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const cyclic = versioned({ tools: [{ name: 'manage_settings', input: cycle }] });
    expect(() => WorkflowSchema.safeParse(cyclic)).not.toThrow();
    expect(WorkflowSchema.safeParse(cyclic).success).toBe(false);
    let nested: unknown = 'x';
    for (let i = 0; i < 50; i++) nested = { next: nested };
    expect(
      WorkflowSchema.safeParse(versioned({ tools: [{ name: 'manage_settings', input: { updates: nested } }] })).success,
    ).toBe(false);
  });
  test('reject oversized workflow and getters without invoking them', () => {
    const getter = mock(() => ({ x: 1 }));
    const input = {};
    Object.defineProperty(input, 'updates', { get: getter, enumerable: true });
    expect(WorkflowSchema.safeParse(versioned({ tools: [{ name: 'manage_settings', input }] })).success).toBe(false);
    expect(getter).not.toHaveBeenCalled();
    expect(
      WorkflowSchema.safeParse(versioned({ steps: Array.from({ length: 500 }, () => ({ respond: 'x' })) })).success,
    ).toBe(false);
  });
  test('static validator handles typed input recursively and detects an invalid real tool argument', () => {
    const good = WorkflowSchema.parse(versioned(settings));
    expect(validateWorkflow(good, null)).toEqual([]);
    const bad = WorkflowSchema.parse(versioned({ tools: [{ name: 'get_events', input: { limit: { wrong: true } } }] }));
    expect(validateWorkflow(bad, null).length).toBeGreaterThan(0);
  });
});

describe('typed workflow execution contract', () => {
  test('dispatch receives typed nested literals and original capture data', async () => {
    const fn = mock((_name: string, _input: unknown) => ({ success: true, output: 'ok' }));
    const flow = WorkflowSchema.parse(
      versioned({
        tools: [
          {
            name: 'manage_settings',
            input: {
              action: 'update',
              category: 'general',
              updates: { default_event_duration_minutes: 30, timezone: '{{$1}}' },
            },
          },
        ],
      }),
    );
    const result = await new IntentExecutor().run(flow, { $1: 'Europe/Belgrade' }, context, fn);
    expect(result.success).toBe(true);
    expect(fn).toHaveBeenCalledWith('manage_settings', {
      action: 'update',
      category: 'general',
      updates: { default_event_duration_minutes: 30, timezone: 'Europe/Belgrade' },
    });
  });
  test('required missing variable prevents dispatch rather than becoming a literal string', async () => {
    const fn = mock(() => ({ success: true, output: 'ok' }));
    const flow = WorkflowSchema.parse(versioned({ tools: [{ name: 'search_events', input: { query: '{{$1}}' } }] }));
    const result = await new IntentExecutor().run(flow, {}, context, fn);
    expect(result.success).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });
  test('user data resembling a template stays data and is not re-evaluated', async () => {
    const fn = mock(() => ({ success: true, output: 'ok' }));
    const flow = WorkflowSchema.parse(versioned({ tools: [{ name: 'search_events', input: { query: '{{$1}}' } }] }));
    const result = await new IntentExecutor().run(flow, { $1: 'literal {{user.id}}' }, context, fn);
    expect(result.success).toBe(true);
    expect(fn).toHaveBeenCalledWith('search_events', { query: 'literal {{user.id}}' });
  });
  test('unresolved nested reference and wrong resolved type cannot reach actual tool', async () => {
    const fn = mock(() => ({ success: true, output: 'ok' }));
    const flow = WorkflowSchema.parse(versioned({ tools: [{ name: 'get_events', input: { limit: '{{$1}}' } }] }));
    const result = await new IntentExecutor().run(flow, { $1: 'garbage' }, context, fn);
    expect(result.success).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });
  test('resolves ask options and suspends before any later mutation', async () => {
    const fn = mock(() => ({ success: true, output: 'ok' }));
    const flow = WorkflowSchema.parse(
      versioned({
        steps: [
          { call: 'ask_user', input: { question: '{{t.question}}', options: ['{{t.yes}}', '{{t.no}}'] }, as: 'answer' },
          {
            when: "ask.answer == 'Yes'",
            call: 'manage_settings',
            input: { action: 'update', category: 'general', updates: { default_event_duration_minutes: 30 } },
          },
        ],
        i18n: { en: { question: 'Change duration?', yes: 'Yes', no: 'No' } },
      }),
    );
    const result = await new IntentExecutor().run(flow, {}, context, fn);
    expect(result).toMatchObject({
      success: false,
      suspended: true,
      suspendedAt: 0,
      response: 'Change duration?',
      responseOptions: ['Yes', 'No'],
    });
    expect(fn).not.toHaveBeenCalled();
    const cancelled = await new IntentExecutor().run(flow, {}, context, fn, {
      stepIndex: 0,
      stepResults: result.stepResults!,
      userAnswer: 'No',
    });
    expect(cancelled.success).toBe(true);
    expect(fn).not.toHaveBeenCalled();
    const done = await new IntentExecutor().run(flow, {}, context, fn, {
      stepIndex: 0,
      stepResults: result.stepResults!,
      userAnswer: 'Yes',
    });
    expect(done.success).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
  });
  test('resume must point to an actual ask step', async () => {
    const fn = mock(() => ({ success: true, output: 'ok' }));
    const flow = WorkflowSchema.parse(
      versioned({
        steps: [
          {
            call: 'manage_settings',
            input: { action: 'update', category: 'general', updates: { default_event_duration_minutes: 30 } },
          },
        ],
      }),
    );
    const result = await new IntentExecutor().run(flow, {}, context, fn, {
      stepIndex: 0,
      stepResults: {},
      userAnswer: 'Yes',
    });
    expect(result.success).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });
});

test('unknown offered choice waits again and never advances to mutation', async () => {
  const fn = mock(() => ({ success: true, output: 'done' }));
  const flow = WorkflowSchema.parse({
    version: 2,
    steps: [
      { call: 'ask_user', input: { question: 'Confirm?', options: ['Yes', 'No'] }, as: 'answer' },
      {
        call: 'manage_settings',
        input: { action: 'update', category: 'general', updates: { default_event_duration_minutes: 45 } },
      },
    ],
  });
  const executor = new IntentExecutor();
  const first = await executor.run(flow, {}, context, fn);
  const next = await executor.run(flow, {}, context, fn, {
    stepIndex: 0,
    stepResults: first.stepResults!,
    userAnswer: 'something unrelated',
  });
  expect(next.suspended).toBe(true);
  expect(next.suspendedAt).toBe(0);
  expect(fn).not.toHaveBeenCalled();
});

test('recursive translation cannot recurse forever or reach tool execution', async () => {
  const fn = mock(() => ({ success: true, output: 'done' }));
  const flow = WorkflowSchema.parse({
    version: 2,
    tools: [{ name: 'search_events', input: { query: '{{t.a}}' } }],
    i18n: { en: { a: '{{t.b}}', b: '{{t.a}}' } },
  });
  const result = await new IntentExecutor().run(flow, {}, context, fn);
  expect(result.success).toBe(false);
  expect(result.errorCode).toBe('UNRESOLVED_TEMPLATE');
  expect(fn).not.toHaveBeenCalled();
});

test('optional literal default is not confused with missing required data', async () => {
  const fn = mock(() => ({ success: true, output: 'done' }));
  const flow = WorkflowSchema.parse({
    version: 2,
    tools: [{ name: 'search_events', input: { query: "{{$1|default('standup')}}" } }],
  });
  expect((await new IntentExecutor().run(flow, {}, context, fn)).success).toBe(true);
  expect(fn).toHaveBeenCalledWith('search_events', { query: 'standup' });
});

test('call:respond validates message type rather than casting an object into output', async () => {
  const fn = mock(() => ({ success: true, output: 'done' }));
  const flow = WorkflowSchema.parse({ version: 2, steps: [{ call: 'respond', input: { message: { not: 'text' } } }] });
  const result = await new IntentExecutor().run(flow, {}, context, fn);
  expect(result.success).toBe(false);
  expect(fn).not.toHaveBeenCalled();
});
test('template amplification is stopped before creating megabytes of output', async () => {
  const fn = mock(() => ({ success: true, output: 'done' }));
  const flow = WorkflowSchema.parse({
    version: 2,
    tools: [{ name: 'search_events', input: { query: Array(1000).fill('{{$1}}').join(' ') } }],
  });
  const observe = mock(() => 'a'.repeat(4000));
  const captures: Record<string, string> = {};
  Object.defineProperty(captures, '$1', { get: observe });
  const result = await new IntentExecutor().run(flow, captures, context, fn);
  expect(result.success).toBe(false);
  expect(fn).not.toHaveBeenCalled();
  expect(observe.mock.calls.length).toBeLessThan(20);
});
test('workflow-only pseudo-calls require steps, not Level1 tool dispatch', () => {
  for (const name of ['ask_user', 'respond'])
    expect(
      WorkflowSchema.safeParse({
        version: 2,
        tools: [{ name, input: { question: 'Q', message: 'M', options: ['Yes'] } }],
      }).success,
    ).toBe(false);
});

test('sparse and decorated arrays fail the JSON guard before recursive schema traversal', async () => {
  const { isBoundedJson, WORKFLOW_LIMITS } = await import('../../../src/services/intent/workflow-input.ts');
  expect(isBoundedJson(Array(WORKFLOW_LIMITS.nodes * 10))).toBe(false);
  expect(isBoundedJson(Array(2))).toBe(false);
  expect(isBoundedJson(Object.assign(['yes'], { extra: 'not JSON array data' }))).toBe(false);
  expect(isBoundedJson(Object.assign(Array(2), { 0: 'yes', extra: 'hides missing index' }))).toBe(false);
  expect(isBoundedJson([null, 'yes', { nested: [1, false] }])).toBe(true);
});

test('respond field also rejects object-valued entire-template results', async () => {
  const fn = mock(() => ({
    success: true,
    output: 'Resolved synthetic contact',
    data: { telegram_id: 1002, name: 'Synthetic contact' },
  }));
  const flow = WorkflowSchema.parse({
    version: 2,
    steps: [
      { call: 'find_user', input: { username: 'synthetic_person' }, as: 'person' },
      { respond: '{{tool_outputs.person}}' },
    ],
  });
  const result = await new IntentExecutor().run(flow, {}, context, fn);
  expect(result.success).toBe(false);
  expect(result.errorCode).toBe('INVALID_INPUT');
  expect(fn).toHaveBeenCalledTimes(1);
});
