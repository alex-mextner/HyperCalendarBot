// test/services/ai/response-grounding.test.ts
import { describe, expect, test } from 'bun:test';
import {
  checkGrounding,
  claimsCompletedWrite,
  type ToolEvidence,
  verifiedScheduleEvents,
} from '../../../src/services/ai/response-grounding.ts';

const TZ = 'Europe/Belgrade';
/** Sunday 2026-09-27, 23:00 in Belgrade. */
const NOW = new Date('2026-09-27T21:00:00Z');

/** A week read that returned one Tuesday lesson (10:30Z = 12:30 local). */
const WEEK_READ: ToolEvidence = {
  name: 'get_events',
  input: { start_date: '2026-09-27T00:00:00.000Z', end_date: '2026-10-04T23:59:59.999Z', scope: 'personal' },
  success: true,
  output:
    'id: 41, title: Английский с Томом, start: 2026-09-29T10:30:00Z, end: 2026-09-29T11:30:00Z, description: Учебник, стр. 12',
  data: [
    {
      id: 41,
      title: 'Английский с Томом',
      date: '2026-09-29',
      time: '12:30',
      all_day: false,
      end_at: '2026-09-29T11:30:00Z',
      description: 'Учебник, стр. 12',
    },
  ],
};

function ungrounded(response: string, tools: ToolEvidence[] = [WEEK_READ], userMessage = ''): string[] {
  return checkGrounding(response, tools, TZ, userMessage, NOW).ungrounded;
}

describe('checkGrounding — clock times', () => {
  test('local start and end times of a returned event are grounded', () => {
    expect(ungrounded('Урок во вторник с 12:30 до 13:30.')).toEqual([]);
  });

  test('the stored UTC clock presented as local time is not grounded', () => {
    expect(ungrounded('Урок во вторник в 10:30.')).toEqual(['10:30']);
  });

  test('a UTC clock is grounded when the prose labels it, including a labelled range', () => {
    expect(ungrounded('Урок: 10:30 – 11:30 (UTC), то есть 12:30 – 13:30 у тебя.')).toEqual([]);
    expect(ungrounded('Lesson at 10:30 UTC.')).toEqual([]);
  });

  test('12-hour clock times are compared as 24-hour local times', () => {
    expect(ungrounded('The lesson is on September 29 at 12:30 PM and ends at 1:30 pm.')).toEqual([]);
    expect(ungrounded('The lesson starts at 10:30 AM.')).toEqual(['10:30']);
  });

  test('a dotted time is read as a time when it cannot be a date', () => {
    expect(ungrounded('Урок в 12.30.')).toEqual([]);
    expect(ungrounded('Урок в 15.30.')).toEqual(['15.30']);
  });

  test('a time from a failed tool is no evidence', () => {
    const failed: ToolEvidence = { ...WEEK_READ, success: false };
    expect(ungrounded('Урок в 12:30.', [failed])).toEqual(['12:30']);
  });

  test('a computed conversion is not calendar evidence for the UTC clock shown as local', () => {
    const conversion: ToolEvidence = {
      name: 'calculate',
      input: { expression: '2026-09-29 10:30 Europe/Belgrade to UTC' },
      success: true,
      output: '2026-09-29T08:30:00.000Z',
    };
    expect(ungrounded('Урок во вторник в 10:30.', [WEEK_READ, conversion])).toEqual(['10:30']);
  });
});

describe('checkGrounding — calendar days', () => {
  test('ru and en month-name dates of returned events are grounded', () => {
    expect(ungrounded('Вторник, 29 сентября; Tuesday, September 29; 29th Sept.')).toEqual([]);
  });

  test('an empty day inside the read range is grounded; a day outside every read is not', () => {
    expect(ungrounded('30 сентября и 04.10 свободны.')).toEqual([]);
    expect(ungrounded('22 сентября свободен весь день.')).toEqual(['22 сентября']);
    expect(ungrounded('Встреча 12.10.2026.')).toEqual(['12.10.2026']);
  });

  test('a date-only get_events range covers each of its local days', () => {
    const read: ToolEvidence = {
      name: 'get_events',
      input: { start_date: '2026-10-10', end_date: '2026-10-11' },
      success: true,
    };
    expect(ungrounded('11 октября ничего нет.', [read])).toEqual([]);
    expect(ungrounded('12 октября ничего нет.', [read])).toEqual(['12 октября']);
  });

  test('today and tomorrow need no read, but only a read that covered them makes them calendar evidence', () => {
    const days = (tools: ToolEvidence[]) =>
      checkGrounding('Сегодня 27 сентября, завтра 28 сентября.', tools, TZ, '', NOW);
    expect(days([])).toMatchObject({ ungrounded: [], contextOnly: ['27 сентября', '28 сентября'] });
    expect(days([WEEK_READ])).toMatchObject({ ungrounded: [], contextOnly: [] });
  });
});

describe('checkGrounding — quotes and ids', () => {
  test('a quoted title or detail must appear in a result or in the user message', () => {
    expect(ungrounded('Это «английский с томом», в описании "Учебник, стр. 12".')).toEqual([]);
    expect(ungrounded('Ты спросил про «перенос на пятницу».', [WEEK_READ], 'Перенос на пятницу возможен?')).toEqual([]);
    expect(ungrounded('Это «Французский».')).toEqual(['«Французский»']);
  });

  test('a quote found only in the user message or a tool argument is context, not calendar data', () => {
    const search: ToolEvidence = { name: 'search_events', input: { query: 'Совет директоров' }, success: true };
    const report = checkGrounding(
      '«Совет директоров» и «перенос на пятницу».',
      [search],
      TZ,
      'Перенос на пятницу?',
      NOW,
    );
    expect(report).toMatchObject({ ungrounded: [], contextOnly: ['«Совет директоров»', '«перенос на пятницу»'] });
  });

  test('ё and е are the same letter for quote matching', () => {
    const read: ToolEvidence = { ...WEEK_READ, output: 'id: 5, title: Ёлка', data: undefined };
    expect(ungrounded('Событие «Елка».', [read])).toEqual([]);
  });

  test('an event id must be one of the returned events', () => {
    expect(ungrounded('Событие id 41 во вторник.')).toEqual([]);
    expect(ungrounded('Событие id 99 во вторник.')).toEqual(['id 99']);
  });

  test('counts every concrete fact it checked', () => {
    expect(checkGrounding('«Английский с Томом» 29 сентября в 12:30.', [WEEK_READ], TZ, '', NOW).checked).toBe(3);
    expect(checkGrounding('Да, ты участвуешь.', [WEEK_READ], TZ, '', NOW).checked).toBe(0);
  });
});

describe('claimsCompletedWrite', () => {
  test.each([
    'Удалил урок во вторник.',
    'Встреча перенесена на 15:00.',
    'Готово, перенёс на среду.',
    'Событие создано.',
    'Отменила занятие.',
    'I deleted the lesson.',
    'The meeting was rescheduled.',
    'Готово! Встреча в 15:00.',
    'Done, see you at 3.',
    '✅ Встреча в 15:00',
  ])('%s claims a completed change', (text) => {
    expect(claimsCompletedWrite(text)).toBe(true);
  });

  test.each([
    'Если хочешь, я создам или перенесу событие.',
    'Могу перенести урок на завтра.',
    'Как создатель встречи ты уже её участник.',
    'Следующее занятие запланировано на вторник.',
    'I can move the lesson if you want.',
  ])('%s does not', (text) => {
    expect(claimsCompletedWrite(text)).toBe(false);
  });
});

describe('verifiedScheduleEvents', () => {
  test('merges events from successful schedule reads only, deduplicated and in order', () => {
    const tools: ToolEvidence[] = [
      {
        name: 'search_events',
        input: {},
        success: true,
        data: [
          { id: 2, title: 'B', date: '2026-09-29', time: '12:30', all_day: false },
          { id: 1, title: 'A', date: '2026-09-28', time: '20:30', all_day: false },
        ],
      },
      WEEK_READ,
      { name: 'get_event', input: {}, success: true, data: { id: 3, title: 'C', date: '2026-09-29', all_day: true } },
      {
        name: 'create_event',
        input: {},
        success: true,
        data: { id: 4, title: 'D', date: '2026-09-27', all_day: true },
      },
      {
        name: 'get_upcoming',
        input: {},
        success: false,
        data: [{ id: 5, title: 'E', date: '2026-09-27', all_day: true }],
      },
      { name: 'get_free_slots', input: {}, success: true, data: { slots: [] } },
    ];
    expect(verifiedScheduleEvents(tools).map((event) => event.id)).toEqual([1, 3, 2, 41]);
  });
});

describe('checkGrounding — fact extraction without evidence', () => {
  const factsOf = (text: string) => checkGrounding(text, [], TZ, '', NOW);

  test('reads ISO instants, month-name days, 12-hour clocks, dotted dates, quotes and ids in pattern order', () => {
    const report = factsOf(
      'Встреча 2026-10-12T09:00:00+0200, потом 5 ноября, March 7th, в 3:15 pm UTC, 12.11, 12.11.2026, 31.02.26 «Тема.», id: 77.',
    );
    expect(report).toEqual({
      checked: 9,
      ungrounded: [
        '2026-10-12T09:00:00+0200',
        '5 ноября',
        'March 7th',
        '3:15',
        '12.11',
        '12.11.2026',
        '31.02.26',
        '«Тема.»',
        'id: 77',
      ],
      ungroundedTitlesAndIds: ['«Тема.»', 'id: 77'],
      contextOnly: [],
      contextOnlyDays: [],
    });
  });

  test('keeps impossible ISO dates as day facts and skips unparseable instants', () => {
    expect(factsOf('2026-13-45 и 2026-02-30T10:00:00Z и 2026-11-03 и 2026-11-03 14:20 и 2026-09-28T08:00:00Z')).toEqual(
      {
        checked: 5,
        ungrounded: ['2026-13-45', '2026-02-30T10:00:00Z', '2026-11-03', '2026-11-03 14:20', '2026-09-28T08:00:00Z'],
        ungroundedTitlesAndIds: [],
        contextOnly: [],
        contextOnlyDays: [],
      },
    );
  });

  test('drops out-of-range month-name days and non-time dotted numbers, keeps en month-day and 24-hour clocks', () => {
    expect(
      factsOf('Oct. 9, 3rd Aug, 1 июля, 32 мая, 31.13, 99.99, 25.61, 5.5.2026, 20:15 UTC, 7pm, 1:05 a.m., 13:00 pm')
        .ungrounded,
    ).toEqual(['1 июля', '3rd Aug', 'Oct. 9', '20:15', '1:05', '13:00']);
  });

  test('quotes of every bracket style and ids of every spelling are facts; empty quotes are not', () => {
    expect(factsOf('„Хей, мир!“ и “Quote—” и "  .x " и «   » и id #12 и ID № 5')).toEqual({
      checked: 5,
      ungrounded: ['„Хей, мир!“', '“Quote—”', '"  .x "', 'id #12', 'ID № 5'],
      ungroundedTitlesAndIds: ['„Хей, мир!“', '“Quote—”', '"  .x "', 'id #12', 'ID № 5'],
      contextOnly: [],
      contextOnlyDays: [],
    });
  });

  test('a bare ISO date of today or tomorrow is context only', () => {
    expect(factsOf('2026-09-28').contextOnly).toEqual(['2026-09-28']);
    expect(factsOf('2026-09-28').contextOnlyDays).toEqual(['2026-09-28']);
  });
});

describe('checkGrounding — evidence indexing', () => {
  test('ISO instants are grounded by their UTC or local clock together with a covered day', () => {
    expect(
      ungrounded('2026-09-29T10:30:00Z; 2026-09-29T12:30:00+02:00; 2026-09-29 12:30; 2026-09-29T12:30:00+0200'),
    ).toEqual([]);
    expect(ungrounded('2026-09-29 10:30')).toEqual(['2026-09-29 10:30']);
    expect(ungrounded('2026-10-20T10:30:00Z')).toEqual(['2026-10-20T10:30:00Z']);
  });

  test('a lone event object backs its id, day, title, description and location but not a time it lacks', () => {
    const event: ToolEvidence = {
      name: 'get_event',
      input: {},
      success: true,
      data: { id: 8, title: 'Отпуск', date: '2026-10-20', all_day: true, location: 'Белград', description: 'Море' },
    };
    expect(ungrounded('«Отпуск» «Белград» «Море» 20 октября, id 8.', [event])).toEqual([]);
    expect(ungrounded('20 октября в 12:30.', [event])).toEqual(['12:30']);
  });

  test('a get_free_slots date backs exactly that day', () => {
    const slots: ToolEvidence = { name: 'get_free_slots', input: { date: '2026-11-05' }, success: true };
    expect(ungrounded('5 ноября свободно, 6 ноября нет.', [slots])).toEqual(['6 ноября']);
  });

  test('a get_events range is indexed for at most 62 days', () => {
    const year: ToolEvidence = {
      name: 'get_events',
      input: { start_date: '2026-01-01', end_date: '2026-12-31' },
      success: true,
    };
    expect(ungrounded('3 марта и 4 марта и 1 декабря.', [year])).toEqual(['4 марта', '1 декабря']);
  });

  test('an inverted, open-ended or unparseable get_events range backs the days it can', () => {
    const read = (input: ToolEvidence['input']): ToolEvidence => ({ name: 'get_events', input, success: true });
    expect(ungrounded('10 октября.', [read({ start_date: '2026-10-10', end_date: '2026-10-05' })])).toEqual([
      '10 октября',
    ]);
    expect(ungrounded('10 октября и 11 октября.', [read({ start_date: '2026-10-10' })])).toEqual(['11 октября']);
    expect(ungrounded('10 октября.', [read({ start_date: 'not-a-date', end_date: 'nope' })])).toEqual(['10 октября']);
    expect(ungrounded('10 октября.', [read({ start_date: 10, end_date: 11 })])).toEqual(['10 октября']);
  });

  test('the output of a non-schedule tool backs quotes but contributes no days or times', () => {
    const note: ToolEvidence = {
      name: 'calculate',
      input: {},
      success: true,
      output: 'метка: Альфа, 2026-10-20 15:45',
    };
    expect(ungrounded('«Альфа» 20 октября в 15:45.', [note])).toEqual(['20 октября', '15:45']);
  });

  test('the text output of a schedule read backs its clocks, dotted dates, month-name days and UTC clocks', () => {
    const read: ToolEvidence = {
      name: 'search_events',
      input: {},
      success: true,
      output: 'Старт 09:15, финиш 14:05 UTC, дата 20.10, ещё 7.45 и 21 октября',
    };
    expect(ungrounded('09:15, 14:05 UTC, 20 октября, 21 октября, 07:45.', [read])).toEqual([]);
    expect(ungrounded('14:05.', [read])).toEqual(['14:05']);
  });
});
