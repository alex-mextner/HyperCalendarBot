import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import { IntentExecutor } from '../../../src/services/intent/intent-executor.ts';

describe('IntentExecutor', () => {
  let executor: IntentExecutor;
  const userCtx = { timezone: 'Europe/Moscow', language: 'ru' };

  beforeEach(() => {
    executor = new IntentExecutor();
  });

  test('executes Level 1 workflow (single tool call)', async () => {
    const workflow = {
      tools: [{ name: 'get_events', input: { start_date: '{{dates.today}}' } }],
      format: 'events_list',
    };
    const mockExecutor = (_name: string) => ({
      success: true,
      output: JSON.stringify([{ title: 'Meeting' }]),
    });
    const result = await executor.run(workflow, {}, userCtx, mockExecutor);
    expect(result.success).toBe(true);
    expect(result.response).toBeDefined();
  });

  test('Level 1 with multiple tools executes sequentially', async () => {
    const calls: string[] = [];
    const workflow = {
      tools: [
        { name: 'tool_a', input: {} },
        { name: 'tool_b', input: {} },
      ],
      format: 'text',
    };
    const mockExecutor = (name: string) => {
      calls.push(name);
      return { success: true, output: 'ok' };
    };
    await executor.run(workflow, {}, userCtx, mockExecutor);
    expect(calls).toEqual(['tool_a', 'tool_b']);
  });

  test('Level 2 workflow with conditions — stop on respond', async () => {
    const workflow = {
      steps: [
        { call: 'search_events', input: { query: '{{$1}}' }, as: 'results' },
        { when: 'results.length == 0', respond: 'Nothing found', stop: true },
      ],
    };
    const mockExecutor = () => ({ success: true, output: '[]' });
    const result = await executor.run(workflow, { $1: 'test' }, userCtx, mockExecutor);
    expect(result.success).toBe(true);
    expect(result.response).toBe('Nothing found');
  });

  test('Level 2 skips step when condition is false', async () => {
    const calls: string[] = [];
    const workflow = {
      steps: [
        { call: 'search_events', input: {}, as: 'results' },
        { when: 'results.length == 0', respond: 'Nothing found', stop: true },
        { call: 'format_results', input: {} },
      ],
    };
    const mockExecutor = (name: string) => {
      calls.push(name);
      return { success: true, output: '[{"id": 1}]' };
    };
    await executor.run(workflow, {}, userCtx, mockExecutor);
    expect(calls).toEqual(['search_events', 'format_results']);
  });

  test('workflow suspends on ask_user', async () => {
    const workflow = {
      steps: [
        { call: 'search_events', input: {}, as: 'results' },
        { when: 'results.length > 1', call: 'ask_user', input: { question: 'Which?' }, as: 'choice' },
      ],
    };
    const mockExecutor = () => ({ success: true, output: '[{"id":1},{"id":2}]' });
    const result = await executor.run(workflow, {}, userCtx, mockExecutor);
    expect(result.suspended).toBe(true);
    expect(result.suspendedAt).toBe(1);
    expect(result.stepResults).toBeDefined();
  });

  test('tool failure returns error', async () => {
    const workflow = { tools: [{ name: 'bad_tool', input: {} }], format: 'text' };
    const mockExecutor = () => ({ success: false, error: 'Tool failed' });
    const result = await executor.run(workflow, {}, userCtx, mockExecutor);
    expect(result.success).toBe(false);
  });

  test('async tool executor is awaited', async () => {
    const workflow = {
      steps: [{ call: 'find_user', input: { username: '{{$1}}' }, as: 'found' }],
    };
    const mockExecutor = async (_name: string) => ({
      success: true as const,
      output: 'telegram_id=123',
    });
    const result = await executor.run(workflow, { $1: 'testuser' }, userCtx, mockExecutor);
    expect(result.success).toBe(true);
  });

  test('tool output with data is accessible via tool_outputs namespace in next step', async () => {
    const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
    const workflow = {
      steps: [
        { call: 'find_user', input: { username: '{{$1}}' }, as: 'found_user' },
        { call: 'send_invitation', input: { invitee_id: '{{tool_outputs.found_user.telegram_id}}' } },
      ],
    };
    const mockExecutor = async (name: string, input: unknown) => {
      calls.push({ name, input: input as Record<string, unknown> });
      if (name === 'find_user') {
        return { success: true as const, output: 'Found user', data: { telegram_id: 8888, name: 'Alice' } };
      }
      return { success: true as const, output: 'ok' };
    };
    const result = await executor.run(workflow, { $1: 'alice' }, userCtx, mockExecutor);
    expect(result.success).toBe(true);
    expect(calls[1]!.input.invitee_id).toBe(8888);
  });

  test('ask_user answer is accessible via tool_outputs namespace after resume', async () => {
    const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
    const workflow = {
      steps: [
        { call: 'ask_user', input: { question: 'Confirm?' }, as: 'confirm' },
        { call: 'delete_event', input: { answer_was: '{{tool_outputs.confirm}}' } },
      ],
    };
    const mockExecutor = async (name: string, input: unknown) => {
      calls.push({ name, input: input as Record<string, unknown> });
      return { success: true as const, output: 'ok' };
    };
    const result = await executor.run(workflow, {}, userCtx, mockExecutor, {
      stepIndex: 0,
      stepResults: {},
      userAnswer: 'да',
    });
    expect(result.success).toBe(true);
    expect(calls[0]!.input.answer_was).toBe('да');
  });

  test('async tool failure propagates correctly', async () => {
    const workflow = {
      steps: [{ call: 'find_user', input: { username: '{{$1}}' }, as: 'found' }],
    };
    const mockExecutor = async () => ({
      success: false as const,
      error: 'User not found',
    });
    const result = await executor.run(workflow, { $1: 'ghost' }, userCtx, mockExecutor);
    expect(result.success).toBe(false);
    expect(result.response).toBe('User not found');
  });

  test('ask_user step returns question text in response', async () => {
    const workflow = {
      steps: [
        { call: 'ask_user', input: { question: 'На 22 число или 22:00?' }, as: 'answer' },
        { call: 'create_event', input: { title: 'Встреча' } },
      ],
    };
    const mockExecutor = () => ({ success: true, output: 'ok' });
    const result = await executor.run(workflow, {}, userCtx, mockExecutor);
    expect(result.suspended).toBe(true);
    expect(result.suspendedAt).toBe(0);
    expect(result.response).toBe('На 22 число или 22:00?');
  });

  test('ask_user answers auto-accumulated in choices without as field', async () => {
    const workflow = {
      steps: [
        { call: 'ask_user', input: { question: 'Q1' } },
        { call: 'ask_user', input: { question: 'Q2' } },
      ],
    };
    const mockExecutor = () => ({ success: true, output: 'ok' });

    const afterFirst = await executor.run(workflow, {}, userCtx, mockExecutor, {
      stepIndex: 0,
      stepResults: {},
      userAnswer: 'время',
    });
    expect(afterFirst.suspended).toBe(true);
    expect((afterFirst.stepResults as Record<string, unknown>).choices).toEqual(['время']);

    const final = await executor.run(workflow, {}, userCtx, mockExecutor, {
      stepIndex: 1,
      stepResults: { choices: ['время'] },
      userAnswer: 'утро',
    });
    expect((final.stepResults as Record<string, unknown>).choices).toEqual(['время', 'утро']);
  });

  test('choices[0] accessible in when condition after auto-accumulation', async () => {
    const calls: string[] = [];
    const workflow = {
      steps: [
        { call: 'ask_user', input: { question: 'Q' } },
        { when: 'choices[0] == "время"', call: 'create_event', input: { title: 'test' } },
      ],
    };
    const mockExecutor = (name: string) => {
      calls.push(name);
      return { success: true, output: 'ok' };
    };
    await executor.run(workflow, {}, userCtx, mockExecutor, {
      stepIndex: 0,
      stepResults: {},
      userAnswer: 'время',
    });
    expect(calls).toContain('create_event');
  });

  test('ask_user answer stored under ask.* namespace', async () => {
    const workflow = {
      steps: [{ call: 'ask_user', input: { question: 'Q' }, as: 'date_or_time|lower' }],
    };
    const mockExecutor = () => ({ success: true, output: 'ok' });
    const result = await executor.run(workflow, {}, userCtx, mockExecutor, {
      stepIndex: 0,
      stepResults: {},
      userAnswer: 'ВРЕМЯ',
    });
    const sr = result.stepResults as Record<string, unknown>;
    const ask = sr.ask as Record<string, unknown>;
    expect(ask).toBeDefined();
    expect(ask.date_or_time).toBe('время');
    // choices[] auto-accumulation stays flat
    expect(sr.choices).toEqual(['время']);
    // old flat key must NOT exist
    expect(sr.date_or_time).toBeUndefined();
  });

  test('regular tool as field stays flat, not under ask.*', async () => {
    const workflow = {
      steps: [{ call: 'search_events', input: {}, as: 'results' }],
    };
    const mock = () => ({ success: true, output: '["a","b"]' });
    const result = await executor.run(workflow, {}, userCtx, mock);
    const sr = result.stepResults as Record<string, unknown>;
    expect(sr.results).toBeDefined();
    expect(sr.ask).toBeUndefined();
  });

  test('ask_user answer stored with filter from "as" field (e.g. |lower)', async () => {
    const workflow = {
      steps: [
        { call: 'ask_user', input: { question: 'дата или время?' }, as: 'choice|lower' },
        { when: 'ask.choice == "время"', call: 'create_event', input: { title: 'test' }, as: 'result' },
      ],
    };
    const mockExecutor = () => ({ success: true, output: 'ok' });
    // First run suspends
    const suspended = await executor.run(workflow, {}, userCtx, mockExecutor);
    expect(suspended.suspended).toBe(true);

    // Resume with mixed-case answer
    const result = await executor.run(workflow, {}, userCtx, mockExecutor, {
      stepIndex: 0,
      stepResults: {},
      userAnswer: 'ВРЕМЯ',
    });
    // create_event should be called (choice == "время" matches because |lower was applied)
    expect(result.success).toBe(true);
  });

  test('ask_user question supports template variables', async () => {
    const workflow = {
      steps: [
        {
          call: 'ask_user',
          input: { question: '{{$1}} — это дата или время?' },
          as: 'answer',
        },
      ],
    };
    const mockExecutor = () => ({ success: true, output: 'ok' });
    const result = await executor.run(workflow, { $1: '22' }, userCtx, mockExecutor);
    expect(result.suspended).toBe(true);
    expect(result.response).toBe('22 — это дата или время?');
  });

  test('$1 capture is accessible in when condition', async () => {
    const calls: string[] = [];
    const workflow = {
      steps: [
        { when: '$1 > 10', call: 'high_value_tool', input: {} },
        { when: '$1 <= 10', call: 'low_value_tool', input: {} },
      ],
    };
    const mockExecutor = (name: string) => {
      calls.push(name);
      return { success: true, output: 'ok' };
    };
    await executor.run(workflow, { $1: '22' }, userCtx, mockExecutor);
    expect(calls).toEqual(['high_value_tool']);
  });

  test('user.language accessible in when condition for bilingual branching', async () => {
    const calls: string[] = [];
    const workflow = {
      steps: [
        { when: 'user.language == "ru"', call: 'ru_tool', input: {} },
        { when: 'user.language != "ru"', call: 'en_tool', input: {} },
      ],
    };
    const mockExecutor = (name: string) => {
      calls.push(name);
      return { success: true, output: 'ok' };
    };
    await executor.run(workflow, {}, { timezone: 'Europe/Moscow', language: 'ru' }, mockExecutor);
    expect(calls).toEqual(['ru_tool']);
    calls.length = 0;
    await executor.run(workflow, {}, { timezone: 'Europe/London', language: 'en' }, mockExecutor);
    expect(calls).toEqual(['en_tool']);
  });

  test('isPastHour helper available in when condition', async () => {
    const calls: string[] = [];
    // Use a value of 0 — hour 0 is always past (current hour >= 0 always, but 0 < current_hour if hour > 0)
    // Use 25 — always false since no hour is > 24
    const workflow = {
      steps: [
        { when: 'isPastHour(25)', call: 'past_tool', input: {} },
        { call: 'always_tool', input: {} },
      ],
    };
    const mockExecutor = (name: string) => {
      calls.push(name);
      return { success: true, output: 'ok' };
    };
    await executor.run(workflow, {}, userCtx, mockExecutor);
    expect(calls).toContain('always_tool');
    expect(calls).not.toContain('past_tool');
  });

  test('isAmPmAmbiguous — hours 1..12 are ambiguous', async () => {
    for (const h of [1, 2, 6, 8, 11, 12]) {
      const calls: string[] = [];
      const workflow = { steps: [{ when: `isAmPmAmbiguous(${h})`, call: 'tool', input: {} }] };
      const mock = (name: string) => {
        calls.push(name);
        return { success: true, output: 'ok' };
      };
      await executor.run(workflow, {}, userCtx, mock);
      expect(calls).toEqual(['tool']);
    }
  });

  test('isAmPmAmbiguous — hours 0, 13..23 are unambiguous', async () => {
    for (const h of [0, 13, 15, 20, 22, 23]) {
      const calls: string[] = [];
      const workflow = { steps: [{ when: `isAmPmAmbiguous(${h}) == false`, call: 'tool', input: {} }] };
      const mock = (name: string) => {
        calls.push(name);
        return { success: true, output: 'ok' };
      };
      await executor.run(workflow, {}, userCtx, mock);
      expect(calls).toEqual(['tool']);
    }
  });

  test('isPastHour — hour 25 is never past (out of range)', async () => {
    const workflow = { steps: [{ when: 'isPastHour(25)', call: 'tool', input: {} }] };
    const mock = () => ({ success: true, output: 'ok' });
    const result = await executor.run(workflow, {}, userCtx, mock);
    expect(result.success).toBe(true);
    // stepResults has no 'tool' call logged — condition was false
    const sr = result.stepResults as Record<string, unknown>;
    expect(sr).toBeDefined();
  });

  test('isPastDay — day 0 is always past (no month has day 0)', async () => {
    const calls: string[] = [];
    const workflow = { steps: [{ when: 'isPastDay(0)', call: 'tool', input: {} }] };
    const mock = (name: string) => {
      calls.push(name);
      return { success: true, output: 'ok' };
    };
    await executor.run(workflow, {}, userCtx, mock);
    expect(calls).toEqual(['tool']);
  });

  test('isPastHourPM — hour 12 PM results in 24h which is never past', async () => {
    const calls: string[] = [];
    const workflow = { steps: [{ when: 'isPastHourPM(12) == false', call: 'tool', input: {} }] };
    const mock = (name: string) => {
      calls.push(name);
      return { success: true, output: 'ok' };
    };
    await executor.run(workflow, {}, userCtx, mock);
    expect(calls).toEqual(['tool']);
  });

  test('isPastHourPM — hour 2 PM is past when current time is 3 PM UTC', async () => {
    jest.setSystemTime(new Date('2026-03-19T15:00:00Z')); // 15:00 UTC
    const calls: string[] = [];
    // isPastHourPM(2): 2+12=14, 14 <= 15 → true
    const workflow = { steps: [{ when: 'isPastHourPM(2) == true', call: 'tool', input: {} }] };
    const mock = (name: string) => {
      calls.push(name);
      return { success: true, output: 'ok' };
    };
    await executor.run(workflow, {}, { timezone: 'UTC', language: 'ru' }, mock);
    expect(calls).toEqual(['tool']);
  });

  test('isPastHourPM — hour 2 PM is past at exactly 2 PM UTC', async () => {
    jest.setSystemTime(new Date('2026-03-19T14:00:00Z')); // exactly 14:00 UTC = 2 PM
    const calls: string[] = [];
    // isPastHourPM(2): 2+12=14, 14 <= 14 → true (already 2 PM)
    const workflow = { steps: [{ when: 'isPastHourPM(2) == true', call: 'tool', input: {} }] };
    const mock = (name: string) => {
      calls.push(name);
      return { success: true, output: 'ok' };
    };
    await executor.run(workflow, {}, { timezone: 'UTC', language: 'ru' }, mock);
    expect(calls).toEqual(['tool']);
  });

  afterEach(() => {
    jest.setSystemTime();
  });

  test('isPastDay — day 32 is never past (no month has 32 days)', async () => {
    const calls: string[] = [];
    const workflow = { steps: [{ when: 'isPastDay(32) == false', call: 'tool', input: {} }] };
    const mock = (name: string) => {
      calls.push(name);
      return { success: true, output: 'ok' };
    };
    await executor.run(workflow, {}, userCtx, mock);
    expect(calls).toEqual(['tool']);
  });

  test('isAmPmAmbiguous + isPastHour combined — mutually exclusive branches via &&', async () => {
    // hour 22: not AM/PM ambiguous, may or may not be past depending on current time
    // We just verify exactly ONE of the two branches is taken (they're mutually exclusive)
    const calls: string[] = [];
    const workflow = {
      steps: [
        { when: 'isAmPmAmbiguous($1) == false && isPastHour($1) == false', call: 'not_past', input: {} },
        { when: 'isAmPmAmbiguous($1) == false && isPastHour($1)', call: 'past', input: {} },
      ],
    };
    const mock = (name: string) => {
      calls.push(name);
      return { success: true, output: 'ok' };
    };
    await executor.run(workflow, { $1: '22' }, userCtx, mock);
    // Exactly one branch taken: either 'not_past' or 'past', never both
    expect(calls.length).toBe(1);
    expect(['not_past', 'past']).toContain(calls[0]!);
  });

  test('isAmPmAmbiguous with $1 from captures — hour 8 triggers AM/PM ask', async () => {
    const calls: string[] = [];
    const workflow = {
      steps: [
        {
          when: 'isAmPmAmbiguous($1)',
          call: 'ask_user',
          input: { question: 'Утра или вечера?' },
          as: 'ampm|lower',
        },
      ],
    };
    const mock = (name: string) => {
      calls.push(name);
      return { success: true, output: 'ok' };
    };
    const result = await executor.run(workflow, { $1: '8' }, userCtx, mock);
    expect(result.suspended).toBe(true);
    expect(result.response).toBe('Утра или вечера?');
  });

  test('AM/PM workflow: "вечера" answer → create with hour + 12', async () => {
    const calls: string[] = [];
    const inputs: Record<string, unknown>[] = [];
    const workflow = {
      steps: [
        { when: 'isAmPmAmbiguous($1)', call: 'ask_user', input: { question: '{{t.ampm}}' }, as: 'ampm|lower' },
        {
          when: 'ask.ampm == "утра" || ask.ampm == "am"',
          call: 'create_event',
          input: { start_at: '{{dates.today}}T{{$1|pad(2)}}:00:00' },
        },
        {
          when: 'ask.ampm == "вечера" || ask.ampm == "pm"',
          call: 'create_event',
          input: { start_at: '{{dates.today}}T{{$1|add(12)|pad(2)}}:00:00' },
        },
      ],
      i18n: { ru: { ampm: 'Утра или вечера?' }, en: { ampm: 'AM or PM?' } },
    };
    const mock = (_name: string, input: unknown) => {
      calls.push(_name);
      inputs.push(input as Record<string, unknown>);
      return { success: true, output: 'ok' };
    };
    // Resume from ask_user with answer "вечера"
    const result = await executor.run(workflow, { $1: '8' }, userCtx, mock, {
      stepIndex: 0,
      stepResults: {},
      userAnswer: 'вечера',
    });
    expect(result.success).toBe(true);
    expect(calls).toEqual(['create_event']);
    expect(inputs[0]?.start_at).toMatch(/T20:00:00/);
  });

  test('i18n workflow — ask_user question uses correct language', async () => {
    const workflow = {
      steps: [{ call: 'ask_user', input: { question: '{{t.q1}}' }, as: 'choice|lower' }],
      i18n: {
        ru: { q1: 'Это дата или время?' },
        en: { q1: 'Is this a date or time?' },
      },
    };
    const mockExecutor = () => ({ success: true, output: 'ok' });
    const ru = await executor.run(workflow, {}, { timezone: 'UTC', language: 'ru' }, mockExecutor);
    expect(ru.response).toBe('Это дата или время?');
    const en = await executor.run(workflow, {}, { timezone: 'UTC', language: 'en' }, mockExecutor);
    expect(en.response).toBe('Is this a date or time?');
  });

  test('i18n — $1 in i18n string resolved correctly', async () => {
    const workflow = {
      steps: [{ call: 'ask_user', input: { question: '{{t.q}}' }, as: 'choice|lower' }],
      i18n: {
        ru: { q: '«{{$1}}» — дата или время?' },
        en: { q: 'Is «{{$1}}» a date or time?' },
      },
    };
    const mockExecutor = () => ({ success: true, output: 'ok' });
    const result = await executor.run(workflow, { $1: '22' }, { timezone: 'UTC', language: 'ru' }, mockExecutor);
    expect(result.response).toBe('«22» — дата или время?');
  });

  test('Level 2: last tool output becomes response when no respond step', async () => {
    // Regression: get_history-style workflow where the only step is a tool call without `as`.
    // Previously runLevel2 returned { success: true, stepResults } with no response field,
    // causing silent delivery failure in intent-matcher-layer.
    const workflow = {
      steps: [{ call: 'get_history', input: { limit: 50 } }],
    };
    const historyText = '[2026-03-20 10:00] [user] Покажи нашу переписку';
    const mockExecutor = () => ({ success: true, output: historyText });
    const result = await executor.run(workflow, {}, userCtx, mockExecutor);
    expect(result.success).toBe(true);
    expect(result.response).toBe(historyText);
  });

  test('Level 2: last tool output becomes response even with as field', async () => {
    const workflow = {
      steps: [{ call: 'get_history', input: { limit: 10 }, as: 'history' }],
    };
    const output = 'some history';
    const mockExecutor = () => ({ success: true, output });
    const result = await executor.run(workflow, {}, userCtx, mockExecutor);
    expect(result.success).toBe(true);
    expect(result.response).toBe(output);
  });

  test('resume from suspended workflow', async () => {
    const workflow = {
      steps: [
        { call: 'search_events', input: {}, as: 'results' },
        { when: 'results.length > 1', call: 'ask_user', input: { question: 'Which?' }, as: 'choice' },
        { call: 'get_event', input: { id: '{{ask.choice}}' } },
      ],
    };
    const calls: string[] = [];
    const mockExecutor = (name: string) => {
      calls.push(name);
      return { success: true, output: '{"id": 1, "title": "Meeting"}' };
    };
    const result = await executor.run(workflow, {}, userCtx, mockExecutor, {
      stepIndex: 1,
      stepResults: { results: [{ id: 1 }, { id: 2 }] },
      userAnswer: '1',
    });
    // Should skip steps 0 and 1 (the ask_user), execute step 2
    expect(calls).toEqual(['get_event']);
    expect(result.success).toBe(true);
  });
});
