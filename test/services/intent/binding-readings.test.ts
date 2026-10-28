import { describe, expect, test } from 'bun:test';
import { type Bindings, evaluateBindings } from '../../../src/services/intent/workflow-bindings.ts';
import { WorkflowInputError } from '../../../src/services/intent/workflow-input.ts';

const NOW = new Date('2026-03-04T09:00:00Z');
const user = { timezone: 'Europe/Moscow', language: 'ru' };

const read = (bindings: Bindings, captures: Record<string, string>) =>
  evaluateBindings(bindings, captures, user, undefined, NOW);

const time = (raw: string, extra: object = {}) =>
  read({ t: { type: 'time', from: '{{$1}}', ...extra } } as Bindings, { $1: raw }).t;

describe('time binding: hour with am/pm or day-part suffix', () => {
  test.each([
    ['9am', '09:00'],
    ['9 am', '09:00'],
    ['12 am', '00:00'],
    ['12 pm', '12:00'],
    ['1 p m', '13:00'],
    ['11 a m', '11:00'],
    ['9pm', '21:00'],
    ['9:30 pm', '21:30'],
    ['12:30 am', '00:30'],
    ['4 утра', '04:00'],
    ['11 утра', '11:00'],
    ['12 дня', '12:00'],
    ['1 дня', '13:00'],
    ['6 дня', '18:00'],
    ['4 вечера', '16:00'],
    ['11 вечера', '23:00'],
    ['12 ночи', '00:00'],
    ['1 ночи', '01:00'],
    ['5 ночи', '05:00'],
    ['9 ночи', '21:00'],
    ['11 ночи', '23:00'],
    ['10 ночи', '22:00'],
  ])('%s reads as %s', (raw, expected) => {
    expect(time(raw)).toBe(expected);
  });

  test.each([
    '0 am',
    '13 pm',
    '3 утра',
    '12 утра',
    '7 дня',
    '3 вечера',
    '12 вечера',
    '6 ночи',
    '8 ночи',
    '7 constructor',
  ])('%s is impossible and rejected', (raw) => {
    expect(() => time(raw)).toThrow(WorkflowInputError);
  });

  test('a bare 12-hour value is ambiguous, a 24-hour one is not', () => {
    expect(() => time('9')).toThrow(WorkflowInputError);
    expect(time('13')).toBe('13:00');
    expect(time('9:30')).toBe('09:30');
    expect(time('0')).toBe('00:00');
    expect(time('1:05')).toBe('01:05');
    expect(() => time('24:00')).toThrow(WorkflowInputError);
    expect(() => time('09:61')).toThrow(WorkflowInputError);
  });

  test('words for noon and midnight', () => {
    expect(time('полдень')).toBe('12:00');
    expect(time('noon')).toBe('12:00');
    expect(time('полночь')).toBe('00:00');
    expect(time('midnight')).toBe('00:00');
  });
});

describe('optional bindings take their default only for blank input', () => {
  test('time', () => {
    expect(time('', { optional: true, default: '07:45' })).toBe('07:45');
    expect(time('  ', { optional: true, default: '07:45' })).toBe('07:45');
    expect(time('08:00', { optional: true, default: '07:45' })).toBe('08:00');
    expect(() => time('', { optional: true })).toThrow(WorkflowInputError);
    expect(() => time('')).toThrow(WorkflowInputError);
  });

  test('integer, enum and text', () => {
    const run = (binding: object, raw: string) =>
      read({ v: { from: '{{$1}}', ...binding } } as unknown as Bindings, { $1: raw }).v;
    expect(run({ type: 'integer', optional: true, default: 3 }, '')).toBe(3);
    expect(run({ type: 'integer', optional: true, default: 3 }, '8')).toBe(8);
    expect(() => run({ type: 'integer', optional: true }, '')).toThrow(WorkflowInputError);
    expect(run({ type: 'enum', values: { a: 1 }, optional: true, default: 'x' }, '')).toBe('x');
    expect(run({ type: 'enum', values: { a: 1 } }, 'a')).toBe(1);
    expect(() => run({ type: 'enum', values: { a: 1 } }, 'constructor')).toThrow(WorkflowInputError);
    expect(run({ type: 'text', optional: true, default: 'dflt' }, '')).toBe('dflt');
    expect(run({ type: 'text' }, '  «quoted»  ')).toBe('quoted');
  });

  test('date uses the default day word, period uses the default period key', () => {
    const words = { today: 'today', завтра: 'tomorrow' };
    const date = read({ d: { type: 'date', from: '{{$1}}', words, optional: true, default: 'tomorrow' } } as Bindings, {
      $1: '',
    }).d;
    expect(date).toBe('2026-03-05');
    const period = read(
      {
        p: { type: 'period', from: '{{$1}}', values: { week: 'week' }, optional: true, default: 'month' },
      } as Bindings,
      { $1: '' },
    ).p;
    expect(period).toMatchObject({ key: 'month', kind: 'month', start: '2026-03-01', end: '2026-03-31' });
    expect(() => read({ d: { type: 'date', from: '{{$1}}', words, optional: true } } as Bindings, { $1: '' })).toThrow(
      WorkflowInputError,
    );
  });
});

describe('derived bindings', () => {
  test('datetime combines an earlier date and time in the user zone', () => {
    const bindings = {
      d: { type: 'date', from: '{{$1}}', words: { завтра: 'tomorrow' } },
      t: { type: 'time', from: '{{$2}}' },
      dt: { type: 'datetime', date: 'd', time: 't', future: true, plus_minutes: 30 },
    } as Bindings;
    expect(read(bindings, { $1: 'завтра', $2: '09:30' }).dt).toBe('2026-03-05T10:00:00+03:00');
  });

  test('relative_instant adds a bounded duration to now, as a local instant on a whole minute', () => {
    const bindings = {
      n: { type: 'integer', from: '{{$1}}', min: -5, max: 99999 },
      r: { type: 'relative_instant', duration: 'n' },
    } as Bindings;
    expect(read(bindings, { $1: '5' }).r).toBe('2026-03-04T12:05:00+03:00');
    for (const raw of ['0', '-1', '10081']) expect(() => read(bindings, { $1: raw })).toThrow(WorkflowInputError);
    expect(read(bindings, { $1: '10080' }).r).toBe('2026-03-11T12:00:00+03:00');
  });

  test('duration, timezone, event reference and recipient', () => {
    const run = (binding: object, captures: Record<string, string>) =>
      read({ v: { from: '{{$1}}', ...binding } } as unknown as Bindings, captures).v;
    const duration = { type: 'duration', unit: '{{$2}}', units: { мин: 1, ч: 60 }, default_amount: 30 };
    expect(run(duration, { $1: '2', $2: 'ч' })).toBe(120);
    expect(run(duration, { $1: '', $2: 'мин' })).toBe(30);
    expect(() => run(duration, { $1: '5', $2: 'constructor' })).toThrow(WorkflowInputError);
    expect(run({ type: 'timezone' }, { $1: 'Europe/Berlin' })).toBe('Europe/Berlin');
    expect(() => run({ type: 'timezone' }, { $1: 'Nope/Zone' })).toThrow(WorkflowInputError);
    expect(run({ type: 'eventref' }, { $1: '#5' })).toEqual({ kind: 'id', id: 5 });
    expect(run({ type: 'eventref', reject: ['next'] }, { $1: 'встреча' })).toEqual({
      kind: 'name',
      query: 'встреча',
      label: 'встреча',
    });
    expect(() => run({ type: 'eventref', reject: ['next'] }, { $1: 'next meeting' })).toThrow(WorkflowInputError);
    expect(run({ type: 'recipient' }, { $1: '@abcde' })).toEqual({
      kind: 'username',
      username: 'abcde',
      label: '@abcde',
    });
    expect(run({ type: 'recipient' }, { $1: '12345' })).toEqual({ kind: 'id', id: 12345, label: '12345' });
    expect(() => run({ type: 'recipient' }, { $1: '1234' })).toThrow(WorkflowInputError);
  });
});
