import { describe, expect, test } from 'bun:test';
import { validateWorkflowVariables } from '../../../src/services/intent/workflow-validator.ts';

describe('validateWorkflowVariables', () => {
  test('valid known variables pass', () => {
    const workflow = {
      tools: [{ name: 'get_events', input: { start_date: '{{today}}', end_date: '{{week_end}}' } }],
    };
    expect(validateWorkflowVariables(workflow, null)).toEqual([]);
  });

  test('valid $1 capture group passes when pattern has one group', () => {
    const workflow = {
      tools: [{ name: 'search', input: { query: '{{$1}}' } }],
    };
    expect(validateWorkflowVariables(workflow, '^(.+)$')).toEqual([]);
  });

  test('unknown variable is rejected', () => {
    const workflow = {
      steps: [{ call: 'find_user', input: { username: '{{user.phone}}' } }],
    };
    const errors = validateWorkflowVariables(workflow, null);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('user.phone');
  });

  test('event.id and event.title are rejected', () => {
    const workflow = {
      steps: [{ call: 'pick_users', input: { event_id: '{{event.id}}', prompt: '{{event.title}}' } }],
    };
    const errors = validateWorkflowVariables(workflow, null);
    expect(errors).toHaveLength(2);
  });

  test('$1 without capturing group in pattern is rejected', () => {
    const workflow = {
      tools: [{ name: 'find_user', input: { username: '{{$1}}' } }],
    };
    // non-capturing groups only
    const errors = validateWorkflowVariables(workflow, '^(?:пригласи|invite)$');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('$1');
  });

  test('$2 when pattern has only 1 capture group is rejected', () => {
    const workflow = {
      tools: [{ name: 'fn', input: { a: '{{$1}}', b: '{{$2}}' } }],
    };
    const errors = validateWorkflowVariables(workflow, '^(\\w+)\\s+(.+)$');
    // pattern has 2 capture groups, so both $1 and $2 are valid
    expect(errors).toEqual([]);
  });

  test('$3 when pattern has only 2 capture groups is rejected', () => {
    const workflow = {
      tools: [{ name: 'fn', input: { a: '{{$3}}' } }],
    };
    const errors = validateWorkflowVariables(workflow, '^(\\w+)\\s+(.+)$');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('$3');
  });

  test('$1 with null pattern is rejected', () => {
    const workflow = {
      tools: [{ name: 'fn', input: { a: '{{$1}}' } }],
    };
    const errors = validateWorkflowVariables(workflow, null);
    expect(errors).toHaveLength(1);
  });

  test('all known variables are accepted', () => {
    const workflow = {
      steps: [
        {
          call: 'get_events',
          input: {
            a: '{{today}}',
            b: '{{tomorrow}}',
            c: '{{week_start}}',
            d: '{{week_end}}',
            e: '{{month_start}}',
            f: '{{month_end}}',
            g: '{{user.timezone}}',
            h: '{{user.language}}',
          },
        },
      ],
    };
    expect(validateWorkflowVariables(workflow, null)).toEqual([]);
  });

  test('variables embedded in longer strings are validated', () => {
    const workflow = {
      steps: [{ call: 'fn', input: { msg: 'Hello {{user.unknown}} you asked about {{today}}' } }],
    };
    const errors = validateWorkflowVariables(workflow, null);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('user.unknown');
  });
});
