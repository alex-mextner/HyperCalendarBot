import { beforeEach, describe, expect, test } from 'bun:test';
import { IntentExecutor } from '../../../src/services/intent/intent-executor.ts';

describe('IntentExecutor', () => {
  let executor: IntentExecutor;
  const userCtx = { timezone: 'Europe/Moscow', language: 'ru' };

  beforeEach(() => {
    executor = new IntentExecutor();
  });

  test('executes Level 1 workflow (single tool call)', async () => {
    const workflow = {
      tools: [{ name: 'get_events', input: { start_date: '{{today}}' } }],
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

  test('resume from suspended workflow', async () => {
    const workflow = {
      steps: [
        { call: 'search_events', input: {}, as: 'results' },
        { when: 'results.length > 1', call: 'ask_user', input: { question: 'Which?' }, as: 'choice' },
        { call: 'get_event', input: { id: '{{choice}}' } },
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
