import { describe, expect, test } from 'bun:test';
import type { Workflow } from '../../../src/services/intent/workflow-schema.ts';
import {
  validateWorkflowBindings,
  validateWorkflowVariables,
} from '../../../src/services/intent/workflow-validator.ts';

const respond = (text: string, extra: object = {}) =>
  ({ version: 2, steps: [{ respond: text }], ...extra }) as Workflow;

describe('validateWorkflowVariables: variable names', () => {
  test('event context and i18n keys are always valid', () => {
    expect(
      validateWorkflowVariables(respond('{{last_added_event.title}} {{last_mentioned_event.id}} {{t.any}}'), null),
    ).toEqual([]);
  });

  test('conditional expressions point at eq and ternary', () => {
    const errors = validateWorkflowVariables(respond('{{ a == b }}'), null);
    expect(errors).toEqual([
      'steps[0].respond: {{ a == b }} — conditional expressions are not supported; ' +
        'for equality: {{a|eq("match","if_match","if_no_match")}}, ' +
        'for truthy/falsy: {{a|ternary("if_true","if_false")}}',
    ]);
  });

  test('ask.* must name an ask_user step', () => {
    const workflow = {
      version: 2,
      steps: [
        { call: 'ask_user', input: { question: 'q' }, as: 'choice|lower' },
        { respond: '{{ask.choice}} {{ask.nope}}' },
      ],
    } as Workflow;
    expect(validateWorkflowVariables(workflow, null)).toEqual([
      'steps[1].respond: {{ask.nope}} — ask.nope is not defined, no ask_user step with as: "nope" found',
    ]);
  });

  test('capture groups are checked against the pattern, with singular and plural wording', () => {
    const w = respond('{{$1}} {{$2}} {{$0}}');
    expect(validateWorkflowVariables(w, '^(.+)$')).toEqual([
      'steps[0].respond: {{$2}} — capture group $2 does not exist in pattern (pattern has 1 capturing group)',
      'steps[0].respond: {{$0}} — capture group $0 does not exist in pattern (pattern has 1 capturing group)',
    ]);
    expect(validateWorkflowVariables(respond('{{$1}}'), null)).toEqual([
      'steps[0].respond: {{$1}} — capture group $1 does not exist in pattern (pattern has 0 capturing groups)',
    ]);
    expect(validateWorkflowVariables(respond('{{$2}}'), '^(a) (b)$')).toEqual([]);
  });

  test('bind.* must be declared, ignoring path and index suffixes', () => {
    const w = respond('{{bind.d}} {{bind.d[0]}} {{bind.zz.x}}', {
      bindings: { d: { type: 'date', from: '{{$1}}' } },
    });
    expect(validateWorkflowVariables(w, '^(.+)$')).toEqual([
      'steps[0].respond: {{bind.zz.x}} — bind.zz is not declared in bindings',
    ]);
  });

  test('tool_outputs.* must name a step or ask output, _text companions resolve to their base', () => {
    const workflow = {
      version: 2,
      steps: [
        { call: 'get_events', input: {}, as: 'ev|upper' },
        { respond: '{{tool_outputs.ev.title}} {{tool_outputs.ev_text}} {{tool_outputs.zz}} {{tool_outputs.zz_text}}' },
      ],
    } as Workflow;
    expect(validateWorkflowVariables(workflow, null)).toEqual([
      'steps[1].respond: {{tool_outputs.zz}} — tool_outputs.zz is not defined; no step with as: "zz" found',
      'steps[1].respond: {{tool_outputs.zz_text}} — tool_outputs.zz_text is not defined; no step with as: "zz_text" found',
    ]);
  });

  test('unknown variables list the allowed ones', () => {
    const [error] = validateWorkflowVariables(respond('{{nope}}'), null);
    expect(error).toStartWith('steps[0].respond: {{nope}} — unknown variable "nope"; allowed: dates.today, ');
    expect(error).toEndWith(
      ', or $1..$N from pattern capture groups, or tool_outputs.<name> for step outputs (as: "name" on any step)',
    );
  });

  test('the step path prefixes the message', () => {
    const [error] = validateWorkflowVariables(
      { version: 2, steps: [{ call: 'get_events', input: { start_date: '{{nope}}' } }] } as Workflow,
      null,
    );
    expect(error).toContain('{{nope}} — unknown variable "nope"');
    expect(error).not.toStartWith('{{nope}}');
  });
});

describe('validateWorkflowVariables: filter chains', () => {
  test('expression filters: syntax errors and unknown names', () => {
    const [syntax] = validateWorkflowVariables(respond('{{dates.today|pad(}}'), null);
    expect(syntax).toStartWith('steps[0].respond: {{dates.today|pad(}} — invalid filter syntax — ');
    expect(validateWorkflowVariables(respond('{{dates.today|upper|nope|bad}}'), null)).toEqual([
      expect.stringMatching(
        /^steps\[0\]\.respond: \{\{dates\.today\|upper\|nope\|bad\}\} — unknown filter "nope" — known filters: pad, upper, /,
      ),
      expect.stringMatching(/unknown filter "bad" — known filters: pad, upper, /),
    ]);
  });

  test('a variable error and a filter error are both reported, variable first', () => {
    const errors = validateWorkflowVariables(respond('{{nope|bad}}'), null);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('unknown variable "nope"');
    expect(errors[1]).toContain('unknown filter "bad"');
  });

  test('as-field filters: syntax errors and unknown names', () => {
    const w = {
      version: 2,
      steps: [
        { call: 'ask_user', input: { question: 'q' }, as: 'x|bogus' },
        { call: 'ask_user', input: { question: 'q' }, as: 'y|pad(' },
      ],
    } as Workflow;
    const errors = validateWorkflowVariables(w, null);
    expect(errors[0]).toMatch(/^as "x\|bogus": unknown filter "bogus" — known filters: pad, upper, /);
    expect(errors[1]).toStartWith('as "y|pad(": invalid filter syntax — ');
    expect(
      validateWorkflowVariables(
        { version: 2, steps: [{ call: 'ask_user', input: { question: 'q' }, as: 'z|lower' }] } as Workflow,
        null,
      ),
    ).toEqual([]);
  });
});

describe('validateWorkflowBindings', () => {
  const bindings = (value: object) => ({ version: 2, steps: [{ respond: 'x' }], bindings: value }) as Workflow;

  test('datetime must reference earlier date and time bindings', () => {
    expect(
      validateWorkflowBindings(
        bindings({ dt: { type: 'datetime', date: 'd', time: 't' }, d: { type: 'date', from: '{{$1}}' } }),
      ),
    ).toEqual([
      'binding "dt": date must reference an earlier date binding',
      'binding "dt": time must reference an earlier time binding',
    ]);
    expect(
      validateWorkflowBindings(
        bindings({
          d: { type: 'date', from: '{{$1}}' },
          t: { type: 'time', from: '{{$2}}' },
          dt: { type: 'datetime', date: 'd', time: 't' },
        }),
      ),
    ).toEqual([]);
    expect(
      validateWorkflowBindings(
        bindings({
          d: { type: 'date', from: '{{$1}}' },
          t: { type: 'time', from: '{{$2}}' },
          dt: { type: 'datetime', date: 't', time: 'd' },
        }),
      ),
    ).toEqual([
      'binding "dt": date must reference an earlier date binding',
      'binding "dt": time must reference an earlier time binding',
    ]);
  });

  test('optional bindings need a default and a defaulted capture', () => {
    expect(validateWorkflowBindings(bindings({ o: { type: 'integer', from: '{{$1}}', optional: true } }))).toEqual([
      'binding "o": an optional binding needs a default',
      'binding "o": an optional binding must read its capture with default(...)',
    ]);
    expect(
      validateWorkflowBindings(
        bindings({ o: { type: 'time', from: '{{$1|default("9:00")}}', optional: true, default: '09:00' } }),
      ),
    ).toEqual([]);
  });

  test('table keys must be in normalized form', () => {
    expect(
      validateWorkflowBindings(
        bindings({
          e: { type: 'enum', from: '{{$1}}', values: { Bad: 1, ok: 2 } },
          a: { type: 'date', from: '{{$1}}', words: { Сегодня: 'today' } },
          du: { type: 'duration', from: '{{$1}}', unit: '{{$2}}', units: { Мин: 1 } },
        }),
      ),
    ).toEqual([
      'binding "e": key "Bad" is not in normalized form',
      'binding "a": key "Сегодня" is not in normalized form',
      'binding "du": key "Мин" is not in normalized form',
    ]);
  });

  test('only one date binding may be marked after_midnight', () => {
    expect(
      validateWorkflowBindings(
        bindings({
          a: { type: 'date', from: '{{$1}}', after_midnight: 'both' },
          b: { type: 'date', from: '{{$1}}', after_midnight: 'both' },
        }),
      ),
    ).toEqual(['bindings a, b: only one date binding may set after_midnight']);
  });

  test('a workflow without bindings has nothing to report', () => {
    expect(validateWorkflowBindings({ steps: [{ respond: 'x' }] } as Workflow)).toEqual([]);
  });
});
