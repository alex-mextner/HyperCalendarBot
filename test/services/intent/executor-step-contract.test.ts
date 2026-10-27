import { describe, expect, test } from 'bun:test';
import { IntentExecutor } from '../../../src/services/intent/intent-executor.ts';
import type { Workflow } from '../../../src/services/intent/workflow-schema.ts';

const ctx = { timezone: 'UTC', language: 'en', userId: 1 };
const event = { id: 5, title: 'Standup', date: '2026-03-05', time: '10:00', all_day: false };

type Result = { success: boolean; output?: string; error?: string; data?: unknown; [key: string]: unknown };
const run = (workflow: unknown, tool: (name: string, input: unknown) => Result, captures = {}, resume?: unknown) =>
  new IntentExecutor().run(workflow as Workflow, captures, ctx, tool as never, resume as never);

describe('Level 2 step contract (legacy)', () => {
  test('an event in a tool result becomes last_mentioned_event and is reported for persistence', async () => {
    const result = await run(
      {
        steps: [{ call: 'one_event', input: {} }, { respond: '{{last_mentioned_event.title}}' }],
      },
      () => ({ success: true, output: 'one', data: event }),
    );
    expect(result).toMatchObject({ success: true, response: 'Standup', mentionedEventId: 5 });
  });

  test('only the first row of a list is promoted, and an empty list promotes nothing', async () => {
    const first = await run({ steps: [{ call: 'list', input: {} }] }, () => ({
      success: true,
      output: 'x',
      data: [event, { ...event, id: 6 }],
    }));
    expect(first.mentionedEventId).toBe(5);
    const empty = await run({ steps: [{ call: 'list', input: {} }] }, () => ({ success: true, output: 'x', data: [] }));
    expect(empty.mentionedEventId).toBeUndefined();
  });

  test('call: respond without a message ends the workflow with no response', async () => {
    const result = await run({ steps: [{ call: 'respond', input: {} }, { respond: 'never' }] }, () => ({
      success: true,
    }));
    expect(result).toMatchObject({ success: true, response: undefined });
  });

  test('a false when-condition skips only that step', async () => {
    const result = await run(
      { steps: [{ when: '$1 == 5', respond: 'five' }, { respond: 'other' }] },
      () => ({ success: true }),
      { $1: '6' },
    );
    expect(result.response).toBe('other');
  });

  test('a step with neither call nor respond is skipped', async () => {
    const calls: string[] = [];
    const result = await run({ steps: [{ as: 'x' }, { call: 'plain', input: {} }] }, (name) => {
      calls.push(name);
      return { success: true, output: 'done' };
    });
    expect(calls).toEqual(['plain']);
    expect(result.response).toBe('done');
  });

  test('as stores flat, under tool_outputs and parses JSON text output', async () => {
    const result = await run(
      {
        steps: [
          { call: 'list_text', input: {}, as: 'l' },
          { call: 'num_text', input: {}, as: 'num' },
          { respond: '{{l[1].a}} {{num}} {{tool_outputs.l[0].a}}' },
        ],
      },
      (name) => ({ success: true, output: name === 'list_text' ? '[{"a":"b"},{"a":"c"}]' : '42' }),
    );
    expect(result.response).toBe('c 42 b');
  });

  test('suspending records mutation evidence and returns a copy of the step results', async () => {
    const result = await run(
      {
        steps: [
          { call: 'delete_event', input: {} },
          { call: 'ask_user', input: { question: 'Sure?' } },
        ],
      },
      () => ({ success: true, output: 'deleted', mutationState: 'confirmed' }),
    );
    expect(result).toMatchObject({
      success: false,
      suspended: true,
      suspendedAt: 1,
      response: 'Sure?',
      mutationEvidence: 'applied',
    });
    expect(result.stepResults?.__mutationEvidence).toBe('applied');
  });

  test('resuming stores the answer, accumulates choices and continues after the suspended step', async () => {
    const workflow = {
      steps: [
        { call: 'ask_user', input: { question: 'q' }, as: 'pick|lower' },
        { respond: '{{ask.pick}} {{tool_outputs.pick}} {{choices[0]}} {{choices[1]}}' },
      ],
    };
    const result = await run(
      workflow,
      () => ({ success: true }),
      {},
      { stepIndex: 0, stepResults: { choices: ['earlier'], tool_outputs: {} }, userAnswer: 'YES' },
    );
    expect(result.response).toBe('yes yes earlier yes');
  });

  test('a prior mutation carried by the resume state is kept', async () => {
    const result = await run(
      { steps: [{ call: 'ask_user', input: { question: 'q' } }, { respond: 'done' }] },
      () => ({ success: true }),
      {},
      { stepIndex: 0, stepResults: { __mutationEvidence: 'applied' }, userAnswer: 'a' },
    );
    expect(result).toMatchObject({ success: true, response: 'done', mutationEvidence: 'applied' });
  });

  test('a throwing tool after a confirmed write is reported as TOOL_ERROR evidence, not rethrown', async () => {
    const result = await run(
      {
        steps: [
          { call: 'delete_event', input: {} },
          { call: 'explode', input: {} },
        ],
      },
      (name) => {
        if (name === 'explode') throw new Error('boom');
        return { success: true, mutationState: 'confirmed' };
      },
    );
    expect(result).toEqual({ success: false, errorCode: 'TOOL_ERROR', mutationEvidence: 'applied' });
  });
});

describe('Level 2 step contract (typed, version 2)', () => {
  const typed = (steps: unknown[]) => ({ version: 2, steps });

  test('a typed workflow never promotes an event from a deleted-event result or a list', async () => {
    const deleted = await run(typed([{ call: 'search_events', input: { query: 'x' } }]), () => ({
      success: true,
      output: 'gone',
      data: event,
      effect: { kind: 'event_deleted' },
    }));
    expect(deleted.mentionedEventId).toBeUndefined();
    const list = await run(typed([{ call: 'search_events', input: { query: 'x' } }]), () => ({
      success: true,
      output: 'rows',
      data: [event],
    }));
    expect(list.mentionedEventId).toBeUndefined();
    const single = await run(typed([{ call: 'search_events', input: { query: 'x' } }]), () => ({
      success: true,
      output: 'row',
      data: event,
    }));
    expect(single.mentionedEventId).toBe(5);
  });

  test('typed workflows keep the tool text next to the structured value, capped', async () => {
    const long = 'x'.repeat(2000);
    const result = await run(
      typed([
        { call: 'search_events', input: { query: 'x' }, as: 'found' },
        { respond: '{{tool_outputs.found_text}}' },
      ]),
      () => ({ success: true, output: long, data: event }),
    );
    expect(result.response).toBe('x'.repeat(1500));
  });

  test('a resume answer that is not an offered option re-asks the same question', async () => {
    const workflow = typed([
      { call: 'ask_user', input: { question: 'Which?', options: ['Yes', 'No'] }, as: 'c' },
      { respond: '{{ask.c}}' },
    ]);
    const state = (userAnswer: string) => ({
      stepIndex: 0,
      stepResults: { choices: [], tool_outputs: {} },
      userAnswer,
    });
    const again = await run(workflow, () => ({ success: true }), {}, state('maybe'));
    expect(again).toMatchObject({
      success: false,
      suspended: true,
      suspendedAt: 0,
      response: 'Which?',
      responseOptions: ['Yes', 'No'],
    });
    const matched = await run(workflow, () => ({ success: true }), {}, state(' no '));
    expect(matched).toMatchObject({ success: true, response: 'No' });
  });

  test('a resume that does not point at an ask_user step is refused', async () => {
    for (const stepIndex of [-1, 1, 1.5, 99]) {
      const result = await run(
        typed([{ call: 'ask_user', input: { question: 'q' } }, { respond: 'x' }]),
        () => ({ success: true }),
        {},
        { stepIndex, stepResults: { choices: [], tool_outputs: {} }, userAnswer: 'a' },
      );
      expect(result).toMatchObject({ success: false, errorCode: 'INVALID_RESUME' });
    }
  });
});
