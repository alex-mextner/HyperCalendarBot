import { describe, expect, test } from 'bun:test';
import type { Intent } from '../../../src/database/types.ts';
import { IntentMatcher } from '../../../src/services/intent/intent-matcher.ts';
import { type Bindings, evaluateBindings } from '../../../src/services/intent/workflow-bindings.ts';
import { WorkflowInputError } from '../../../src/services/intent/workflow-input.ts';
import { WorkflowSchema } from '../../../src/services/intent/workflow-schema.ts';
import { validateWorkflow, validateWorkflowBindings } from '../../../src/services/intent/workflow-validator.ts';

// Saturday 2026-09-19 10:00 in Belgrade (UTC+2); the clocks go back on 2026-10-25.
const NOW = new Date('2026-09-19T08:00:00Z');

function bind(bindings: Bindings, captures: { [key: string]: string }, timezone = 'Europe/Belgrade', now = NOW) {
  return evaluateBindings(bindings, captures, { timezone, language: 'ru' }, undefined, now);
}

const DAY_WORDS = {
  сегодня: 'today',
  завтра: 'tomorrow',
  послезавтра: 'day_after_tomorrow',
  вчера: 'yesterday',
} as const;

describe('date binding', () => {
  const day = (raw: string, future = false, now = NOW) =>
    bind({ d: { type: 'date', from: '{{$1}}', words: DAY_WORDS, future } }, { $1: raw }, 'Europe/Belgrade', now).d;

  test('relative words follow the user calendar day, not UTC', () => {
    expect(day('сегодня')).toBe('2026-09-19');
    expect(day('завтра')).toBe('2026-09-20');
    expect(day('послезавтра')).toBe('2026-09-21');
    expect(day('вчера')).toBe('2026-09-18');
    // 23:30 UTC is already the next day in Belgrade.
    expect(day('сегодня', false, new Date('2026-09-19T23:30:00Z'))).toBe('2026-09-20');
  });

  test('absolute forms are parsed and the raw ISO form is kept', () => {
    expect(day('2026-10-05')).toBe('2026-10-05');
    expect(day('05.10.2026')).toBe('2026-10-05');
    expect(day('5 октября')).toBe('2026-10-05');
    expect(day('5 октября 2027')).toBe('2027-10-05');
    expect(day('october 5th')).toBe('2026-10-05');
    expect(day('29 февраля 2028')).toBe('2028-02-29');
  });

  test('impossible dates are rejected instead of rolling into the next month', () => {
    for (const raw of ['31 февраля', '30.02.2026', '29.02.2027', '2026-13-01', '0.5', 'потом'])
      expect(() => day(raw)).toThrow(WorkflowInputError);
  });

  test('a date without a year rolls forward only when the future is required', () => {
    expect(day('10 сентября')).toBe('2026-09-10');
    expect(day('10 сентября', true)).toBe('2027-09-10');
    expect(day('19 сентября', true)).toBe('2026-09-19');
  });

  test('an optional date falls back to its default word', () => {
    const value = bind(
      { d: { type: 'date', from: '{{$1|default("")}}', words: DAY_WORDS, optional: true, default: 'today' } },
      {},
    );
    expect(value.d).toBe('2026-09-19');
  });
});

describe('time binding', () => {
  const time = (raw: string) => bind({ at: { type: 'time', from: '{{$1}}' } }, { $1: raw }).at;

  test('explicit 24-hour and suffixed forms', () => {
    expect(time('10:30')).toBe('10:30');
    expect(time('10.30')).toBe('10:30');
    expect(time('10 30')).toBe('10:30');
    expect(time('15')).toBe('15:00');
    expect(time('3pm')).toBe('15:00');
    expect(time('12 am')).toBe('00:00');
    expect(time('7 вечера')).toBe('19:00');
    expect(time('12 ночи')).toBe('00:00');
    expect(time('полдень')).toBe('12:00');
  });

  test('a bare hour from 1 to 12 is ambiguous and never guessed', () => {
    for (const raw of ['3', '10', '12']) expect(() => time(raw)).toThrow(WorkflowInputError);
  });

  test('out-of-range clock values are rejected', () => {
    for (const raw of ['25:00', '10:75', '13pm', '99', 'вечером']) expect(() => time(raw)).toThrow(WorkflowInputError);
  });
});

describe('period binding', () => {
  const values = {
    неделе: 'week',
    'на следующей неделе': 'next_week',
    месяце: 'month',
    'в следующем месяце': 'next_month',
    выходных: 'weekend',
  } as const;
  const period = (raw: string) => bind({ p: { type: 'period', from: '{{$1}}', values } }, { $1: raw }).p;

  test('calendar week runs Monday to Sunday and lists all seven days', () => {
    expect(period('неделе')).toMatchObject({
      kind: 'week',
      start: '2026-09-14',
      end: '2026-09-20',
      days: ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20'],
    });
    expect(period('на следующей неделе')).toMatchObject({ start: '2026-09-21', end: '2026-09-27' });
  });

  test('months and weekends', () => {
    expect(period('месяце')).toMatchObject({ kind: 'month', start: '2026-09-01', end: '2026-09-30', month: '2026-09' });
    expect(period('в следующем месяце')).toMatchObject({ start: '2026-10-01', end: '2026-10-31', month: '2026-10' });
    expect(period('выходных')).toMatchObject({ kind: 'weekend', start: '2026-09-19', end: '2026-09-20' });
  });

  test('a phrase outside the table is rejected', () => {
    expect(() => period('на прошлой неделе')).toThrow(WorkflowInputError);
  });
});

describe('datetime binding', () => {
  const instant = (
    date: string,
    at: string,
    timezone: string,
    extra: { future?: boolean; plus_minutes?: number } = {},
  ) =>
    bind(
      {
        d: { type: 'date', from: '{{$1}}', words: DAY_WORDS },
        at: { type: 'time', from: '{{$2}}' },
        start: { type: 'datetime', date: 'd', time: 'at', ...extra },
      },
      { $1: date, $2: at },
      timezone,
    ).start;

  test('builds an ISO instant with the offset in force on that date', () => {
    expect(instant('2026-10-05', '10:30', 'Europe/Belgrade')).toBe('2026-10-05T10:30:00+02:00');
    expect(instant('2026-10-26', '10:30', 'Europe/Belgrade')).toBe('2026-10-26T10:30:00+01:00');
    expect(instant('2026-10-05', '10:30', 'Asia/Tokyo')).toBe('2026-10-05T10:30:00+09:00');
    expect(instant('2026-10-05', '10:30', 'Europe/Belgrade', { plus_minutes: 60 })).toBe('2026-10-05T11:30:00+02:00');
  });

  test('a local time skipped by a clock change is rejected', () => {
    expect(() => instant('2026-03-29', '02:30', 'Europe/Belgrade')).toThrow(WorkflowInputError);
    expect(instant('2026-03-29', '03:30', 'Europe/Belgrade')).toBe('2026-03-29T03:30:00+02:00');
  });

  test('a local time repeated by a clock change is rejected, not resolved to one of its two instants', () => {
    expect(() => instant('2026-10-25', '02:30', 'Europe/Belgrade')).toThrow(WorkflowInputError);
    expect(() => instant('2026-11-01', '01:30', 'America/New_York')).toThrow(WorkflowInputError);
    expect(instant('2026-10-25', '03:30', 'Europe/Belgrade')).toBe('2026-10-25T03:30:00+01:00');
  });

  test('a past instant is rejected when the future is required', () => {
    expect(() => instant('вчера', '10:30', 'Europe/Belgrade', { future: true })).toThrow(WorkflowInputError);
    expect(instant('завтра', '10:30', 'Europe/Belgrade', { future: true })).toBe('2026-09-20T10:30:00+02:00');
  });
});

describe('remaining binding types', () => {
  test('duration multiplies by the unit and enforces bounds', () => {
    const units = { мин: 1, час: 60, hours: 60 };
    const dur = (amount: string, unit: string) =>
      bind(
        { n: { type: 'duration', from: '{{$1}}', unit: '{{$2}}', units, min: 1, max: 1440 } },
        { $1: amount, $2: unit },
      ).n;
    expect(dur('15', 'мин')).toBe(15);
    expect(dur('2', 'час')).toBe(120);
    expect(dur('1', 'hours')).toBe(60);
    for (const [amount, unit] of [
      ['0', 'мин'],
      ['25', 'час'],
      ['5', 'дней'],
      ['x', 'мин'],
    ] as const)
      expect(() => dur(amount, unit)).toThrow(WorkflowInputError);
  });

  test('timezone accepts exact IANA names only', () => {
    const zone = (raw: string) => bind({ tz: { type: 'timezone', from: '{{$1}}' } }, { $1: raw }).tz;
    expect(zone('Europe/Belgrade')).toBe('Europe/Belgrade');
    expect(zone('UTC')).toBe('UTC');
    for (const raw of ['Foo/Bar', 'Москва', '+03:00', 'GMT+3', ''] as const)
      expect(() => zone(raw)).toThrow(WorkflowInputError);
  });

  test('event reference is a number, or a title that is not a bulk word', () => {
    const ref = (raw: string) =>
      bind({ ref: { type: 'eventref', from: '{{$1}}', reject: ['все', 'all'] } }, { $1: raw }).ref;
    expect(ref('#12')).toEqual({ kind: 'id', id: 12 });
    expect(ref('№7')).toEqual({ kind: 'id', id: 7 });
    expect(ref('«Стендап»')).toEqual({ kind: 'name', query: 'Стендап' });
    expect(ref('встреча с Иваном')).toEqual({ kind: 'name', query: 'встреча с Иваном' });
    for (const raw of ['все', 'all my events', '#0', '']) expect(() => ref(raw)).toThrow(WorkflowInputError);
  });

  test('recipient is an exact @username or a numeric ID', () => {
    const who = (raw: string) => bind({ who: { type: 'recipient', from: '{{$1}}' } }, { $1: raw }).who;
    expect(who('@ivan_petrov')).toEqual({ kind: 'username', username: 'ivan_petrov', label: '@ivan_petrov' });
    expect(who('123456789')).toEqual({ kind: 'id', id: 123456789, label: '123456789' });
    for (const raw of ['ivan_petrov', '@ivan', '0', '12', '@'] as const)
      expect(() => who(raw)).toThrow(WorkflowInputError);
  });

  test('text is trimmed, unquoted, bounded and free of control characters', () => {
    const text = (raw: string, max = 20) => bind({ t: { type: 'text', from: '{{$1}}', max } }, { $1: raw }).t;
    expect(text('  «Стендап»  ')).toBe('Стендап');
    expect(text('a   b')).toBe('a b');
    expect(text('{{user.id}}')).toBe('{{user.id}}');
    expect(() => text('x'.repeat(21))).toThrow(WorkflowInputError);
    expect(() => text('ab')).toThrow(WorkflowInputError);
    expect(() => text('   ')).toThrow(WorkflowInputError);
  });

  test('integer bounds', () => {
    const n = (raw: string) => bind({ n: { type: 'integer', from: '{{$1}}', min: 1, max: 20 } }, { $1: raw }).n;
    expect(n('3')).toBe(3);
    for (const raw of ['0', '21', '-1', '2.5', 'три']) expect(() => n(raw)).toThrow(WorkflowInputError);
  });
});

describe('bindings inside workflow definitions', () => {
  const optionalWorkflow = (from: string) => ({
    version: 2,
    bindings: { n: { type: 'integer', from, min: 1, max: 9, optional: true, default: 5 } },
    steps: [{ call: 'get_upcoming', input: { limit: '{{bind.n}}' } }],
  });

  function matcherFor(workflow: object, pattern: string): IntentMatcher {
    const matcher = new IntentMatcher();
    matcher.load([
      {
        id: 1,
        canonical_name: 'synthetic',
        phrases: '[]',
        trigger_words: '["next"]',
        pattern,
        workflow: JSON.stringify(workflow),
        format: 'text',
        status: 'approved',
        source_message: null,
        created_at: '',
      } satisfies Intent,
    ]);
    return matcher;
  }

  test('an optional capture that did not take part still matches when read with default()', () => {
    const matcher = matcherFor(optionalWorkflow('{{$1|default("")}}'), String.raw`^next(?:\s+(\d))?$`);
    expect(matcher.explain('next').kind).toBe('matched');
    expect(matcher.explain('next 3')).toMatchObject({ kind: 'matched', result: { captures: { $1: '3' } } });
  });

  test('a bare capture reference makes the matcher require the group, so the validator rejects it for optional bindings', () => {
    const parsed = WorkflowSchema.parse(optionalWorkflow('{{$1}}'));
    expect(validateWorkflowBindings(parsed).join('\n')).toContain('default(');
    expect(matcherFor(optionalWorkflow('{{$1}}'), String.raw`^next(?:\s+(\d))?$`).explain('next').kind).toBe('abstain');
  });

  test('lookup tables must already be in normalized form or they can never match', () => {
    const parsed = WorkflowSchema.parse({
      version: 2,
      bindings: {
        d: { type: 'date', from: '{{$1}}', words: { Сегодня: 'today' } },
        n: { type: 'duration', from: '{{$1}}', unit: '{{$2}}', units: { Минут: 1 } },
        e: { type: 'enum', from: '{{$1}}', values: { 'Да!': true } },
      },
      steps: [{ call: 'get_upcoming', input: {} }],
    });
    const errors = validateWorkflowBindings(parsed);
    expect(errors.filter((message) => message.includes('normalized form'))).toHaveLength(3);
  });

  test('a datetime may only read earlier bindings of the right type', () => {
    const parsed = WorkflowSchema.parse({
      version: 2,
      bindings: {
        start: { type: 'datetime', date: 'later', time: 'at' },
        at: { type: 'time', from: '{{$1}}' },
        later: { type: 'date', from: '{{$2}}', words: {} },
      },
      steps: [{ call: 'get_upcoming', input: {} }],
    });
    expect(validateWorkflowBindings(parsed).length).toBeGreaterThan(0);
  });

  test('references to undeclared bindings are reported', () => {
    const parsed = WorkflowSchema.parse({
      version: 2,
      steps: [{ call: 'get_upcoming', input: { limit: '{{bind.missing}}' } }],
    });
    expect(validateWorkflow(parsed, null).join('\n')).toContain('bind.missing is not declared');
  });

  test('unknown binding fields and types fail the schema', () => {
    expect(
      WorkflowSchema.safeParse({
        version: 2,
        bindings: { n: { type: 'eval', from: '{{$1}}' } },
        steps: [{ respond: 'x' }],
      }).success,
    ).toBe(false);
    expect(
      WorkflowSchema.safeParse({
        version: 2,
        bindings: { n: { type: 'integer', from: '{{$1}}', code: 'process.exit()' } },
        steps: [{ respond: 'x' }],
      }).success,
    ).toBe(false);
  });
});
