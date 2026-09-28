// The per-run rule guard every intent run dispatches its tools through, and the one mapping from
// a run's write evidence to the message the user gets when the run stops.
import { beforeEach, describe, expect, test } from 'bun:test';
import { t } from '../../../src/config/constants.ts';
import type { ToolResult } from '../../../src/services/ai/types.ts';
import { evidenceMessage, guardRuleTools } from '../../../src/services/intent/rule-run-guard.ts';

function identitySource(initial: string | null) {
  let current = initial;
  return {
    currentRuleFingerprint: () => current,
    change(next: string | null) {
      current = next;
    },
  };
}

describe('guardRuleTools', () => {
  let dispatched: string[];
  const tools = (name: string): ToolResult => {
    dispatched.push(name);
    return { success: true, output: name, mutationState: 'confirmed' };
  };
  beforeEach(() => {
    dispatched = [];
  });

  test('passes calls through while the rule is unchanged', async () => {
    const guard = guardRuleTools(identitySource('a'), 1, 'a', tools);
    expect(await guard.run('get_events', {})).toMatchObject({ success: true, output: 'get_events' });
    expect(guard.changed()).toBe(false);
    expect(dispatched).toEqual(['get_events']);
  });

  test('refuses unapplied from the first call after the change and stays refused', async () => {
    const source = identitySource('a');
    const guard = guardRuleTools(source, 1, 'a', tools);
    await guard.run('get_events', {});
    source.change('b');
    expect(await guard.run('create_event', {})).toMatchObject({ success: false, mutationState: 'not_applied' });
    source.change('a');
    expect(await guard.run('create_event', {})).toMatchObject({ success: false, mutationState: 'not_applied' });
    expect(guard.changed()).toBe(true);
    expect(dispatched).toEqual(['get_events']);
  });

  test('a rule that is no longer runnable counts as changed', async () => {
    const guard = guardRuleTools(identitySource(null), 1, 'a', tools);
    expect(await guard.run('create_event', {})).toMatchObject({ mutationState: 'not_applied' });
    expect(dispatched).toEqual([]);
  });
});

describe('evidenceMessage', () => {
  const messages = t('en').intentWorkflow;
  test.each([
    ['applied', messages.appliedIncomplete],
    ['unknown', messages.outcomeUnknown],
    ['none', messages.failedUnchanged],
    [undefined, messages.failedUnchanged],
  ] as const)('evidence %p gets its message', (evidence, expected) => {
    expect(evidenceMessage('en', evidence)).toBe(expected);
  });
});
