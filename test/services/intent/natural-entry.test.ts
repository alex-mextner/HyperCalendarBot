import { describe, expect, test } from 'bun:test';
import { recognizeCancelTarget, recognizeEventEntry } from '../../../src/services/intent/natural-entry.ts';
import { evaluateBindings } from '../../../src/services/intent/workflow-bindings.ts';
import { WorkflowInputError } from '../../../src/services/intent/workflow-input.ts';

// Saturday 2026-09-19 10:00 in Belgrade (UTC+2).
const NOW = new Date('2026-09-19T08:00:00Z');
const BELGRADE = { timezone: 'Europe/Belgrade', language: 'ru' };

function entry(text: string) {
  const scan = recognizeEventEntry(text);
  if (scan.kind !== 'entry') throw new Error(`abstained (${scan.reason}): ${text}`);
  return scan.parts;
}

const reason = (text: string) => {
  const scan = recognizeEventEntry(text);
  return scan.kind === 'abstain' ? scan.reason : 'entry';
};

function bound(text: string, now = NOW, ctx = BELGRADE) {
  return evaluateBindings({ entry: { type: 'event_request', from: '{{$1}}' } }, { $1: text }, ctx, undefined, now)
    .entry;
}

describe('terse entries in any order are recognized with the title as written', () => {
  const cases: [string, string, string, number, number | null][] = [
    ['Завтра 13:15 стрижка', 'стрижка', 'offset', 13, 15],
    ['12 октября 13:45 Стоматолог', 'Стоматолог', 'absolute', 13, 45],
    ['Стоматолог 12 октября в 13:45', 'Стоматолог', 'absolute', 13, 45],
    ['В четверг в 14 урок гитары', 'урок гитары', 'weekday', 14, null],
    ['Среда вокал 12:30', 'вокал', 'weekday', 12, 30],
    ['10 октября, ремонт велосипеда в 16.00', 'ремонт велосипеда', 'absolute', 16, 0],
    ['Сегодня 14 починить кран', 'починить кран', 'offset', 14, null],
    ['Пятница. Урок с Олегом в 11 утра.', 'Урок с Олегом', 'weekday', 11, null],
    ['Завтра бассейн в 12', 'бассейн', 'offset', 12, null],
    ['Добавь на завтра на 8.15 съездить в МФЦ с Петром.', 'съездить в МФЦ с Петром', 'offset', 8, 15],
    ['Tomorrow 9:15 dentist', 'dentist', 'offset', 9, 15],
    ['dentist tomorrow at 17:30', 'dentist', 'offset', 17, 30],
    ['Kapetan Street 6a market tomorrow 18:00', 'Kapetan Street 6a market', 'offset', 18, 0],
  ];
  for (const [text, title, kind, hour, minute] of cases)
    test(text, () => {
      const parts = entry(text);
      expect(parts.title).toBe(title);
      expect(String(parts.day.kind)).toBe(kind);
      expect(parts.start.hour).toBe(hour);
      expect(parts.start.minute).toBe(minute);
    });

  test('a day-part suffix, a range and an explicit zone are kept', () => {
    expect(entry('Пятница урок в 11 утра').start).toEqual({ hour: 11, minute: null, suffix: 'утра' });
    expect(entry('Среда с 13 до 15, обед в кафе')).toMatchObject({
      title: 'обед в кафе',
      start: { hour: 13, minute: null },
      end: { hour: 15, minute: null },
    });
    expect(entry('Понедельник 16:00-23:00 покраска стен').end).toEqual({ hour: 23, minute: 0, suffix: null });
    expect(entry('Суббота 13.00 по Москве. Занятие с Олегом')).toMatchObject({
      title: 'Занятие с Олегом',
      zone: 'Europe/Moscow',
    });
    expect(entry('Завтра в 12:30 по Белграду созвон по проекту').zone).toBe('Europe/Belgrade');
  });

  test('d.mm is a date next to a time, a time next to a date, otherwise abstains', () => {
    expect(entry('15.10 12:30 вокал').day).toEqual({ kind: 'absolute', y: null, m: 10, d: 15 });
    expect(entry('Завтра 12.10 вокал').start).toEqual({ hour: 12, minute: 10, suffix: null });
    expect(reason('15.10 вокал')).toBe('ambiguous_date');
  });

  test('a trailing question mark is tolerated only after an explicit create verb', () => {
    expect(entry('Добавь на завтра на 10:30 йогу?').title).toBe('йогу');
    expect(reason('Йога завтра в 10:30?')).toBe('question');
  });
});

describe('anything but one clear entry abstains with a reason', () => {
  const cases: [string, string][] = [
    ['Завтра йога', 'no_time'],
    ['Йога в 10:30', 'no_date'],
    ['Завтра в 10:30', 'no_title'],
    ['не ставь йогу завтра в 10:30', 'negation'],
    ['Завтра в 10:30 йога. Пригласи Анну', 'other_verb'],
    ['Суббота 18:00 ярмарка добавь Олега', 'compound'],
    ['Завтра в 10:30 йога https://example.com', 'compound'],
    ['Завтра в 10:30 созвон с @someone', 'compound'],
    ['Завтра 10:30 йога\nЗавтра 12:00 бассейн', 'multiline'],
    ['Каждый вторник в 10:30 йога', 'bulk'],
    ['По вторникам в 10:30 йога', 'recurring'],
    ['Вторник 15.00 урок, регулярно', 'recurring'],
    ['Через 2 часа прогулка', 'relative'],
    ['Завтра после работы в 19 зал', 'relative'],
    ['Йога в следующий вторник в 10:30', 'vague_date'],
    ['Завтра в два часа встреча', 'word_time'],
    ['Завтра утром в 10 зал', 'word_time'],
    ['в 16:00 GMT+4 завтра созвон', 'unsupported_zone'],
    ['Завтра в среду урок в 15.30', 'two_dates'],
    ['Среда 18.00 ветеринар, приём в 7.00', 'two_times'],
    ['Суббота 12.00 праздник. Гости с 12.00 до 18.00', 'two_times'],
    ['Вторник Олег в 13 английский', 'split_title'],
    ['Сегодня в 20.30 созвон. Позже решим', 'multi_sentence'],
    ['Завтра 12-15 обед', 'ambiguous_time'],
    ['Когда йога завтра в 10:30', 'question'],
    ['удали йогу завтра в 10:30', 'other_verb'],
  ];
  for (const [text, expected] of cases) test(text, () => expect(reason(text)).toBe(expected));

  test('size and token bounds abstain quickly', () => {
    const started = performance.now();
    expect(reason(`Завтра в 10:30 ${'а'.repeat(800)}`)).toBe('too_long');
    expect(reason(`Завтра в 10:30 ${'а '.repeat(70)}`)).toBe('too_long');
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe('the typed binding resolves the entry against the current day and zone', () => {
  test('an exact time becomes one future instant with a one-hour check window', () => {
    expect(bound('Завтра 13:15 стрижка')).toEqual({
      title: 'стрижка',
      date: '2026-09-20',
      timezone: 'Europe/Belgrade',
      zone_explicit: false,
      mode: 'exact',
      time: '13:15',
      start: '2026-09-20T13:15:00+02:00',
      until: '2026-09-20T14:15:00+02:00',
      end: null,
      time_options: [],
      start_options: [],
    });
  });

  test('a weekday is the nearest one from today; today counts when its time is still ahead', () => {
    expect(bound('Среда вокал 12:30')).toMatchObject({ date: '2026-09-23', start: '2026-09-23T12:30:00+02:00' });
    expect(bound('Суббота 18:00 ярмарка')).toMatchObject({ date: '2026-09-19' });
    expect(() => bound('Суббота 09:00 ярмарка')).toThrow(WorkflowInputError);
  });

  test('a passed day of the year without a year moves to next year', () => {
    expect(bound('3 июля ветеринар в 13:00')).toMatchObject({ date: '2027-07-03' });
  });

  test('a bare hour offers both readings, dropping one that already passed', () => {
    expect(bound('Завтра в 3 пробежка')).toMatchObject({
      mode: 'choose',
      time: null,
      time_options: ['03:00', '15:00'],
      start_options: ['2026-09-20T03:00:00+02:00', '2026-09-20T15:00:00+02:00'],
    });
    expect(bound('Сегодня в 6 ужин')).toMatchObject({ time_options: ['18:00'] });
    expect(() => bound('Сегодня в 6 ужин', new Date('2026-09-19T17:00:00Z'))).toThrow(WorkflowInputError);
  });

  test('12 is confirmed as noon, 13 and later are plain 24-hour times', () => {
    expect(bound('Завтра бассейн в 12')).toMatchObject({ mode: 'noon', time: '12:00' });
    expect(bound('Завтра 20 кино')).toMatchObject({ mode: 'exact', time: '20:00' });
    expect(bound('Завтра в 7 вечера кино')).toMatchObject({ mode: 'exact', time: '19:00' });
  });

  test('an explicit zone places this event in that zone only', () => {
    expect(bound('Завтра в 15:00 по Москве созвон')).toMatchObject({
      timezone: 'Europe/Moscow',
      zone_explicit: true,
      start: '2026-09-20T15:00:00+03:00',
    });
  });

  test('a range keeps its end; a reversed or ambiguous range is rejected', () => {
    expect(bound('Послезавтра 13:00-14:30 воркшоп')).toMatchObject({
      end: '2026-09-21T14:30:00+02:00',
      until: '2026-09-21T14:30:00+02:00',
    });
    expect(() => bound('Послезавтра 15:00-14:00 воркшоп')).toThrow(WorkflowInputError);
    expect(() => bound('Послезавтра с 1 до 3 воркшоп')).toThrow(WorkflowInputError);
  });

  test('invalid calendar days, past times and clock-change gaps are rejected, never guessed', () => {
    for (const text of ['Йога 31 февраля в 10:30', 'Йога вчера в 10:30', 'Йога 28 марта 2027 в 02:30'])
      expect(() => bound(text, NOW, { timezone: 'Europe/Belgrade', language: 'ru' }), text).toThrow(WorkflowInputError);
  });
});

describe('cancel by title', () => {
  const target = (text: string) => recognizeCancelTarget(text);
  test('verb first or last, title kept as written', () => {
    expect(target('Отмени пробежку')).toEqual({ kind: 'target', query: 'пробежку' });
    expect(target('Бассейн убери')).toEqual({ kind: 'target', query: 'Бассейн' });
    expect(target('Удали Кофе с Олегом.')).toEqual({ kind: 'target', query: 'Кофе с Олегом' });
  });

  test('pronouns, dates, bulk, several targets and questions abstain', () => {
    for (const [text, why] of [
      ['Удали его', 'reference'],
      ['Удали эту встречу', 'reference'],
      ['Отмени всё', 'bulk'],
      ['Удали бассейн и йогу', 'reference'],
      ['Удали йогу завтра', 'dated'],
      ['Йогу в 14 удали', 'dated'],
      ['Удали сегодняшнюю встречу', 'dated'],
      ['Не отменяй пробежку', 'no_verb'],
      ['Отмена', 'shape'],
      ['Удали пробежку и отмени бассейн', 'reference'],
      ['Бассейн удалить?', 'no_verb'],
      ['Бассейн убери?', 'question'],
    ] as const)
      expect(target(text), text).toMatchObject({ kind: 'abstain', reason: why });
  });

  test('the binding yields an eventref-shaped name query', () => {
    expect(
      evaluateBindings(
        { ref: { type: 'cancel_target', from: '{{$1}}' } },
        { $1: 'Отмени пробежку' },
        BELGRADE,
        undefined,
      ).ref,
    ).toEqual({ kind: 'name', query: 'пробежку' });
  });
});

describe('duration word amounts', () => {
  const delay = (amount: string, unit: string) =>
    evaluateBindings(
      {
        d: {
          type: 'duration',
          from: '{{$1}}',
          unit: '{{$2}}',
          units: { час: 60, часа: 60, 'полтора часа': 90, полчаса: 30 },
          amounts: { два: 2 },
          default_amount: 1,
          max: 10080,
        },
      },
      { $1: amount, $2: unit },
      BELGRADE,
      undefined,
    ).d;
  test('number words, halves and the default amount', () => {
    expect(delay('два', 'часа')).toBe(120);
    expect(delay('', 'полтора часа')).toBe(90);
    expect(delay('', 'полчаса')).toBe(30);
    expect(delay('', 'час')).toBe(60);
    expect(() => delay('сто', 'часа')).toThrow(WorkflowInputError);
  });
});
