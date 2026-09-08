import { describe, expect, test } from 'bun:test';
import type { Workflow } from '../../../src/services/intent/workflow-schema.ts';
import {
  validateWorkflow,
  validateWorkflowSteps,
  validateWorkflowVariables,
} from '../../../src/services/intent/workflow-validator.ts';

describe('validateWorkflowVariables', () => {
  test('valid known variables pass', () => {
    const workflow = {
      tools: [{ name: 'get_events', input: { start_date: '{{dates.today}}', end_date: '{{dates.week_end}}' } }],
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
            a: '{{dates.today}}',
            b: '{{dates.tomorrow}}',
            c: '{{dates.week_start}}',
            d: '{{dates.week_end}}',
            e: '{{dates.month_start}}',
            f: '{{dates.month_end}}',
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
      steps: [{ call: 'fn', input: { msg: 'Hello {{user.unknown}} you asked about {{dates.today}}' } }],
    };
    const errors = validateWorkflowVariables(workflow, null);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('user.unknown');
  });

  test('unknown filter name is rejected', () => {
    const workflow = { tools: [{ name: 'fn', input: { x: '{{dates.today|bogus}}' } }] };
    const errors = validateWorkflowVariables(workflow, null);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('bogus');
  });

  test('invalid filter syntax is rejected', () => {
    const workflow = { tools: [{ name: 'fn', input: { x: '{{$1|pad(}}' } }] };
    const errors = validateWorkflowVariables(workflow, '^(.+)$');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('invalid filter syntax');
  });

  test('"as" field with valid filter is accepted', () => {
    const workflow: Workflow = {
      steps: [
        { call: 'ask_user', input: { question: 'дата или время?' }, as: 'choice|lower' },
        { when: 'choice == "время"', call: 'create_event', input: {} },
      ],
    };
    expect(validateWorkflowVariables(workflow, null)).toEqual([]);
  });

  test('"as" field with unknown filter is rejected', () => {
    const workflow = {
      steps: [{ call: 'ask_user', input: { question: '?' }, as: 'result|bogus_filter' }],
    };
    const errors = validateWorkflowVariables(workflow, null);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('bogus_filter');
    expect(errors[0]).toContain('as');
  });

  test('"as" field with invalid filter syntax is rejected', () => {
    const workflow = {
      steps: [{ call: 'create_event', input: {}, as: 'result|pad(' }],
    };
    const errors = validateWorkflowVariables(workflow, null);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('as');
  });

  test('"as" field without filter is accepted', () => {
    const workflow = {
      steps: [{ call: 'create_event', input: {}, as: 'result' }],
    };
    expect(validateWorkflowVariables(workflow, null)).toEqual([]);
  });

  test('{{t.key}} i18n namespace is accepted', () => {
    const workflow = {
      steps: [{ call: 'ask_user', input: { question: '{{t.q1}}' } }],
      i18n: { ru: { q1: 'Вопрос?' }, en: { q1: 'Question?' } },
    };
    expect(validateWorkflowVariables(workflow, null)).toEqual([]);
  });

  test('unknown variable inside i18n string is rejected', () => {
    const workflow = {
      steps: [{ call: 'ask_user', input: { question: '{{t.q}}' } }],
      i18n: { ru: { q: '{{user.unknown}} — дата или время?' }, en: { q: 'ok' } },
    };
    const errors = validateWorkflowVariables(workflow, null);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('user.unknown');
  });

  test('known variable inside i18n string is accepted', () => {
    const workflow = {
      steps: [{ call: 'ask_user', input: { question: '{{t.q}}' } }],
      i18n: { ru: { q: '{{dates.today}} — сегодня' }, en: { q: '{{dates.today}} today' } },
    };
    expect(validateWorkflowVariables(workflow, null)).toEqual([]);
  });

  test('$1 inside i18n string is accepted when pattern has 1 capture group', () => {
    const workflow = {
      steps: [{ call: 'ask_user', input: { question: '{{t.q}}' } }],
      i18n: { ru: { q: '«{{$1}}» — дата или время?' }, en: { q: 'Is «{{$1}}» a date?' } },
    };
    expect(validateWorkflowVariables(workflow, '^(.+)$')).toEqual([]);
  });

  test('$2 inside i18n string is rejected when pattern has only 1 capture group', () => {
    const workflow = {
      steps: [{ call: 'ask_user', input: { question: '{{t.q}}' } }],
      i18n: { ru: { q: '{{$2}} недопустимо' }, en: { q: 'ok' } },
    };
    const errors = validateWorkflowVariables(workflow, '^(.+)$');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('$2');
  });

  test('{{ask.choice}} is valid when ask_user step with matching as field exists', () => {
    const workflow: Workflow = {
      steps: [
        { call: 'ask_user', input: { question: 'choose?' }, as: 'choice' },
        { call: 'get_event', input: { id: '{{ask.choice}}' } },
      ],
    };
    expect(validateWorkflowVariables(workflow, null)).toEqual([]);
  });

  test('{{ask.choice}} is rejected when no ask_user step defines it', () => {
    const workflow = {
      steps: [{ call: 'get_event', input: { id: '{{ask.choice}}' } }],
    };
    const errors = validateWorkflowVariables(workflow, null);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('ask.choice');
  });

  test('{{ask.name}} with filter is valid when matching as field exists', () => {
    const workflow: Workflow = {
      steps: [
        { call: 'ask_user', input: { question: 'date?' }, as: 'date_or_time|lower' },
        { when: 'ask.date_or_time == "дата"', call: 'create_event', input: { title: '{{ask.date_or_time}}' } },
      ],
    };
    expect(validateWorkflowVariables(workflow, null)).toEqual([]);
  });

  test('dates.next_month_start is an allowed variable', () => {
    const workflow = {
      tools: [{ name: 'create_event', input: { start_at: '{{dates.next_month_start|date("yyyy-MM-")}}22T12:00:00' } }],
    };
    expect(validateWorkflowVariables(workflow, null)).toEqual([]);
  });

  test('user.utc_offset is an allowed variable', () => {
    const workflow = {
      tools: [{ name: 'create_event', input: { start_at: '{{dates.today}}T{{$1|pad(2)}}:00:00{{user.utc_offset}}' } }],
    };
    expect(validateWorkflowVariables(workflow, '^.+(\\d{1,2})$')).toEqual([]);
  });

  test('error includes path to the field with invalid variable', () => {
    const workflow = {
      steps: [{ call: 'manage_settings', input: { language: '{{user.phone}}' } }],
    };
    const errors = validateWorkflowVariables(workflow, null);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('steps[0].input.language');
    expect(errors[0]).toContain('user.phone');
  });

  test('error includes path for invalid variable inside i18n string', () => {
    const workflow = {
      steps: [{ call: 'ask_user', input: { question: 'ok' } }],
      i18n: { ru: { msg: '{{user.unknown}}' } },
    };
    const errors = validateWorkflowVariables(workflow, null);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('i18n.ru.msg');
    expect(errors[0]).toContain('user.unknown');
  });

  test('ternary expression is rejected with explanation', () => {
    const workflow = {
      steps: [
        {
          call: 'manage_settings',
          input: { language: "{{user.language == 'ru' ? 'en' : 'ru'}}" },
        },
      ],
    };
    const errors = validateWorkflowVariables(workflow, null);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('steps[0].input.language');
    expect(errors[0]).toContain('conditional expressions are not supported');
    expect(errors[0]).toContain('eq(');
    expect(errors[0]).toContain('ternary(');
    expect(errors[0]).toContain('user.language');
  });

  test('ternary with == in ask namespace is rejected with explanation', () => {
    const workflow = {
      steps: [
        {
          call: 'manage_settings',
          input: { language: "{{ask.current_language == 'ru' ? 'en' : 'ru'}}" },
        },
      ],
    };
    const errors = validateWorkflowVariables(workflow, null);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('conditional expressions are not supported');
    expect(errors[0]).toContain('eq(');
    expect(errors[0]).toContain('ternary(');
  });

  test('{{tool_outputs.found_user}} is valid when a step defines as: "found_user"', () => {
    const workflow: Workflow = {
      steps: [
        { call: 'find_user', input: { username: '{{$1}}' }, as: 'found_user' },
        { call: 'send_invitation', input: { invitee_id: '{{tool_outputs.found_user.telegram_id}}' } },
      ],
    };
    expect(validateWorkflowVariables(workflow, '^@(\\w+)$')).toEqual([]);
  });

  test('{{tool_outputs.event_time}} is valid when calculate step defines as: "event_time"', () => {
    const workflow: Workflow = {
      steps: [
        { call: 'calculate', input: { expression: '{{dates.now}}+{{$1}}min' }, as: 'event_time' },
        { call: 'create_event', input: { start_at: '{{tool_outputs.event_time}}' } },
      ],
    };
    expect(validateWorkflowVariables(workflow, '^через (\\d+) минут')).toEqual([]);
  });

  test('{{tool_outputs.missing}} is rejected when no step defines that name', () => {
    const workflow = {
      steps: [{ call: 'create_event', input: { invitee_id: '{{tool_outputs.missing.id}}' } }],
    };
    const errors = validateWorkflowVariables(workflow, null);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('tool_outputs.missing');
  });

  test('{{tool_outputs.confirm}} is valid when ask_user defines as: "confirm"', () => {
    const workflow: Workflow = {
      steps: [
        { call: 'ask_user', input: { question: 'Подтверди?' }, as: 'confirm' },
        { call: 'delete_event', input: { id: '{{tool_outputs.confirm}}' } },
      ],
    };
    expect(validateWorkflowVariables(workflow, null)).toEqual([]);
  });
});

describe('validateWorkflowSteps', () => {
  test('a workflow calling only real tools with complete input passes', () => {
    const workflow: Workflow = {
      steps: [
        { call: 'render_day_image', input: { date: '{{dates.today}}', scope: '{{env.scope}}' } },
        { call: 'get_events', input: { start_date: '{{dates.today}}', end_date: '{{dates.today}}' } },
      ],
    };
    expect(validateWorkflowSteps(workflow)).toEqual([]);
  });

  test('workflow-only steps are not treated as tools', () => {
    const workflow: Workflow = {
      steps: [
        { call: 'ask_user', input: { question: 'Когда?' }, as: 'when' },
        { call: 'respond', input: { message: 'Готово' } },
      ],
    };
    expect(validateWorkflowSteps(workflow)).toEqual([]);
  });

  test('ask_user without a question is rejected', () => {
    const workflow: Workflow = {
      steps: [{ call: 'ask_user', input: { quetion: 'When?' }, as: 'when' }],
    };
    const errors = validateWorkflowSteps(workflow);
    expect(errors.some((e) => e.includes('question'))).toBe(true);
  });

  test('call: respond without input.message is rejected', () => {
    const workflow: Workflow = {
      steps: [{ call: 'respond', input: {} }],
    };
    const errors = validateWorkflowSteps(workflow);
    expect(errors.some((e) => e.includes('message'))).toBe(true);
  });

  test('a literal value that does not match the field type is rejected', () => {
    const workflow: Workflow = {
      steps: [{ call: 'get_upcoming', input: { limit: '5' } }],
    };
    const errors = validateWorkflowSteps(workflow);
    expect(errors.some((e) => e.includes('limit'))).toBe(true);
  });

  test('a template value is exempt from the field type check', () => {
    const workflow: Workflow = {
      steps: [{ call: 'get_upcoming', input: { limit: '{{$1}}' } }],
    };
    expect(validateWorkflowSteps(workflow)).toEqual([]);
  });

  test('send_invitation with neither invitee_id nor invitee_username is rejected', () => {
    const workflow: Workflow = {
      steps: [{ call: 'send_invitation', input: { event_id: '{{tool_outputs.event.id}}' } }],
    };
    const errors = validateWorkflowSteps(workflow);
    expect(errors.some((e) => e.includes('invitee_id') && e.includes('invitee_username'))).toBe(true);
  });

  test('send_invitation with only invitee_username passes', () => {
    const workflow: Workflow = {
      steps: [
        {
          call: 'send_invitation',
          input: { event_id: '{{tool_outputs.event.id}}', invitee_username: '{{$1}}' },
        },
      ],
    };
    expect(validateWorkflowSteps(workflow)).toEqual([]);
  });

  test('a step calling a tool that does not exist is rejected', () => {
    const workflow: Workflow = {
      steps: [{ call: 'render_image', input: { period: 'month' } }],
    };
    const errors = validateWorkflowSteps(workflow);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('render_image');
  });

  test('inherited Object.prototype names are not mistaken for real tools', () => {
    for (const call of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
      const workflow: Workflow = { steps: [{ call, input: {} }] };
      const errors = validateWorkflowSteps(workflow);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('no such tool');
    }
  });

  test('a parameter named after an inherited Object.prototype member is rejected, not crashed on', () => {
    const workflow: Workflow = {
      steps: [{ call: 'get_events', input: { toString: 'x' } }],
    };
    const errors = validateWorkflowSteps(workflow);
    expect(errors.some((e) => e.includes('unknown parameter "toString"'))).toBe(true);
  });

  test('a missing required parameter is rejected', () => {
    const workflow: Workflow = {
      steps: [{ call: 'find_user', input: { query: '{{$1}}' } }],
    };
    const errors = validateWorkflowSteps(workflow);
    expect(errors.some((e) => e.includes('username'))).toBe(true);
  });

  test('a parameter the tool does not accept is rejected', () => {
    const workflow: Workflow = {
      steps: [{ call: 'send_invitation', input: { telegram_id: '{{$1}}', scope: 'personal' } }],
    };
    const errors = validateWorkflowSteps(workflow);
    expect(errors.some((e) => e.includes('telegram_id'))).toBe(true);
    expect(errors.some((e) => e.includes('event_id'))).toBe(true);
  });

  test('Level 1 workflows are validated the same way', () => {
    const workflow: Workflow = {
      tools: [{ name: 'get_day_of_week_date', input: { day_name: '{{$1}}' } }],
    };
    const errors = validateWorkflowSteps(workflow);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('get_day_of_week_date');
  });

  test('tools with free-form input schemas accept any parameters', () => {
    const workflow: Workflow = {
      steps: [{ call: 'bash_execute', input: { anything: 'goes' } }],
    };
    expect(validateWorkflowSteps(workflow)).toEqual([]);
  });
});

describe('validateWorkflow', () => {
  test('accepts a workflow that is sound in both variables and tool calls', () => {
    const workflow: Workflow = {
      steps: [{ call: 'get_events', input: { start_date: '{{dates.today}}', end_date: '{{dates.today}}' } }],
    };
    expect(validateWorkflow(workflow, null)).toEqual([]);
  });

  test('reports variable errors and tool errors together', () => {
    const workflow: Workflow = {
      steps: [{ call: 'render_image', input: { period: '{{user.phone}}' } }],
    };
    const errors = validateWorkflow(workflow, null);

    expect(errors.some((e) => e.includes('user.phone'))).toBe(true);
    expect(errors.some((e) => e.includes('render_image'))).toBe(true);
  });

  test('catches a bad capture reference alongside a bad parameter', () => {
    const workflow: Workflow = {
      steps: [{ call: 'find_user', input: { query: '{{$2}}' } }],
    };
    const errors = validateWorkflow(workflow, '^(.+)$');

    expect(errors.some((e) => e.includes('$2'))).toBe(true);
    expect(errors.some((e) => e.includes('username'))).toBe(true);
  });
});
