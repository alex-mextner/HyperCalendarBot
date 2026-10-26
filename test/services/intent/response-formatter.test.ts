import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { handleGetBotInfo } from '../../../src/services/ai/tool-handlers/meta.ts';
import type { ToolResultData } from '../../../src/services/ai/types.ts';
import { quotableText, type ToolAnswer } from '../../../src/services/intent/answer-renderers.ts';
import {
  formatDayAnswers,
  formatEventSummaries,
  renderAnswer,
} from '../../../src/services/intent/response-formatter.ts';
import type { EventSummary } from '../../../src/services/intent/variable-resolver.ts';

// Tuesday 2026-10-06, 10:00 in Belgrade (UTC+2); "tomorrow" is Wednesday 2026-10-07.
const NOW = new Date('2026-10-06T08:00:00Z');
const ZONE = 'Europe/Belgrade';
const ru = { now: NOW, timezone: ZONE, language: 'ru' };
const en = { now: NOW, timezone: ZONE, language: 'en' };

/** The local calendar day `offset` days from the frozen clock's day, as YYYY-MM-DD. */
const day = (offset: number): string => new Date(Date.UTC(2026, 9, 6 + offset)).toISOString().slice(0, 10);
/** A Belgrade wall clock on day `offset` as a UTC instant (UTC+2 on every day used here). */
const at = (offset: number, clock: string): string => new Date(`${day(offset)}T${clock}:00+02:00`).toISOString();

const event = (
  id: number,
  title: string,
  offset: number,
  time: string,
  minutes = 30,
  rest: Partial<EventSummary> = {},
) =>
  ({
    id,
    title,
    date: day(offset),
    time,
    all_day: false,
    end_at: new Date(Date.parse(at(offset, time)) + minutes * 60_000).toISOString(),
    ...rest,
  }) satisfies EventSummary;

const answer = (tool: string, input: ToolAnswer['input'], output: string, data?: ToolResultData): ToolAnswer => ({
  tool,
  input,
  output,
  ...(data !== undefined ? { data } : {}),
});

const render = (a: ToolAnswer, context = ru) => renderAnswer('text', a.output, a, context);

beforeEach(() => setSystemTime(NOW));
afterEach(() => setSystemTime());

describe('agenda of a read', () => {
  test('heads the day relative to today and lists start–end times, never ISO dates', () => {
    const events = [event(1, 'Стендап', 1, '10:00'), event(2, 'Созвон', 1, '15:30', 60)];
    const { text, complete } = render(answer('get_events', { scope: 'personal' }, 'id: 1, title: Стендап', events));
    expect(text).toBe('Завтра, ср 7 октября:\n10:00–10:30  Стендап\n15:30–16:30  Созвон');
    expect(complete).toBe(true);
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  test('speaks English to an English chat', () => {
    const { text } = render(answer('get_events', {}, 'raw', [event(1, 'Standup', 0, '10:00')]), en);
    expect(text).toBe('Today, Tue Oct 6:\n10:00–10:30  Standup');
  });

  test('groups a several-day answer by day, each under its own heading', () => {
    const events = [
      event(1, 'Йога', 0, '19:00', 60),
      event(2, 'Ретро', 3, '16:00', 60),
      event(3, 'Планёрка', 3, '17:30'),
    ];
    const { text } = render(answer('get_events', {}, 'raw', events));
    expect(text).toBe(
      'Сегодня, вт 6 октября:\n19:00–20:00  Йога\n\nПт 9 октября:\n16:00–17:00  Ретро\n17:30–18:00  Планёрка',
    );
  });

  test('adds the year only for a day outside the current one', () => {
    const far = { id: 9, title: 'Конференция', date: '2027-01-12', time: '09:00', all_day: false };
    expect(render(answer('get_upcoming', {}, 'raw', [far])).text).toBe('Вт 12 января 2027:\n09:00  Конференция');
  });

  test('an all-day event carries no clock and an overnight one names the day it runs into', () => {
    const allDay: EventSummary = { id: 3, title: 'Отпуск', date: day(1), all_day: true };
    const overnight = event(4, 'Поезд', 1, '22:00', 8 * 60);
    const { text } = render(answer('get_events', {}, 'raw', [allDay, overnight]));
    expect(text).toBe('Завтра, ср 7 октября:\nвесь день  Отпуск\n22:00–06:00 (до чт 8 октября)  Поезд');
  });

  test('an event ending at midnight stays on its own day', () => {
    const { text } = render(answer('get_events', {}, 'raw', [event(4, 'Кино', 1, '22:30', 90)]));
    expect(text).toContain('22:30–00:00  Кино');
    expect(text).not.toContain('до');
  });

  test('shows the place of an event and names a calendar that is not the user’s own', () => {
    const withPlace = event(5, 'Обед', 0, '13:00', 60, { location: 'Кафе на углу' });
    expect(render(answer('get_events', { scope: 'group' }, 'raw', [withPlace])).text).toBe(
      'Календарь группы:\nСегодня, вт 6 октября:\n13:00–14:00  Обед — Кафе на углу',
    );
    expect(render(answer('get_events', { owner_id: 5 }, 'raw', [withPlace]), en).text.split('\n')[0]).toBe(
      'Selected calendar:',
    );
  });

  test('an empty read keeps the tool’s sentence that names the checked day and calendar', () => {
    const sentence = 'На завтра, 7 октября, в твоём календаре пока нет событий, которые начинаются в этот день.';
    const rendered = render(answer('get_events', {}, sentence, []));
    expect(rendered).toEqual({ text: sentence, complete: true });
  });

  test('a single event is a card with its day, time, place and notes', () => {
    const card = event(7, 'Стоматолог', 2, '09:15', 45, { location: 'ул. Мира, 3', description: 'Взять полис' });
    expect(render(answer('get_event', {}, 'raw', card)).text).toBe(
      'Стоматолог\nПослезавтра, чт 8 октября, 09:15–10:00\nМесто: ул. Мира, 3\nОписание: Взять полис',
    );
    const weekly = event(8, 'Йога', 2, '19:00', 60, { recurrence_rule: 'FREQ=WEEKLY' });
    expect(render(answer('get_event', {}, 'raw', weekly), en).text).toContain('Repeats: every week');
  });

  test('a DST-change day keeps wall-clock times (Belgrade clocks go back on 2026-10-25)', () => {
    setSystemTime(new Date('2026-10-24T20:00:00Z'));
    const start = '2026-10-25T00:30:00Z'; // 02:30 CEST
    const end = '2026-10-25T02:15:00Z'; // 03:15 CET, after the clocks went back
    const dst: EventSummary = {
      id: 1,
      title: 'Ночной релиз',
      date: '2026-10-25',
      time: '02:30',
      all_day: false,
      end_at: end,
    };
    expect(start < end).toBe(true);
    const { text } = renderAnswer('text', 'raw', answer('get_events', {}, 'raw', [dst]), {
      now: new Date(),
      timezone: ZONE,
      language: 'ru',
    });
    expect(text).toBe('Завтра, вс 25 октября:\n02:30–03:15  Ночной релиз');
  });
});

describe('a write is confirmed, never listed as a read result', () => {
  const deleted = event(10, 'Ревью дизайна', 3, '14:00', 60);

  test('delete names the exact event, day and time in words', () => {
    const rendered = render({
      ...answer('delete_event', { event_id: 10 }, 'Событие «Ревью дизайна» (id: 10) удалено.', deleted),
      effect: { kind: 'event_deleted' },
    });
    expect(rendered.text).toBe('Событие удалено: «Ревью дизайна» — пт 9 октября, 14:00–15:00.');
    expect(rendered.complete).toBe(false);
  });

  test('create and update confirm in the user’s language', () => {
    const made = event(11, 'Deep work', 1, '13:00', 150);
    expect(render(answer('create_event', {}, 'raw', made), en).text).toBe(
      'Event created: “Deep work” — tomorrow, Wed Oct 7, 13:00–15:30.',
    );
    expect(render(answer('update_event', {}, 'raw', made)).text).toBe(
      'Событие обновлено: «Deep work» — завтра, ср 7 октября, 13:00–15:30.',
    );
  });

  test('a write without event data shows the tool’s own sentence', () => {
    const declined = answer('delete_event', {}, 'Ты отказался от события. Оно убрано из твоего календаря.');
    expect(render(declined).text).toBe('Ты отказался от события. Оно убрано из твоего календаря.');
  });
});

describe('free windows', () => {
  const window = (from: string, to: string) => ({
    start: at(1, from),
    end: at(1, to),
    durationMinutes: 0,
  });

  test('lists the windows of the asked day', () => {
    const data = { slots: [window('10:30', '12:00'), window('14:00', '16:00')] };
    const rendered = render(answer('get_free_slots', { date: day(1) }, 'raw', data));
    expect(rendered).toEqual({ text: 'Свободно завтра, ср 7 октября: 10:30–12:00, 14:00–16:00.', complete: true });
    expect(render(answer('get_free_slots', { date: day(1) }, 'raw', data), en).text).toBe(
      'Free tomorrow, Wed Oct 7: 10:30–12:00, 14:00–16:00.',
    );
  });

  test('a day with nothing in it is free all day; a fully booked day names day and calendar', () => {
    const wholeDay = { slots: [{ start: at(1, '00:00'), end: at(1, '23:59'), durationMinutes: 1439 }] };
    expect(render(answer('get_free_slots', { date: day(1) }, 'raw', wholeDay)).text).toBe(
      'Свободно завтра, ср 7 октября: весь день.',
    );
    expect(render(answer('get_free_slots', { date: day(1), scope: 'group' }, 'raw', { slots: [] })).text).toBe(
      'На завтра, ср 7 октября, в календаре группы нет свободных окон: день занят целиком.',
    );
  });

  test('windows are wall clocks of the user’s zone on a 25-hour day', () => {
    setSystemTime(new Date('2026-10-24T20:00:00Z'));
    const data = { slots: [{ start: '2026-10-24T22:00:00Z', end: '2026-10-25T22:59:00Z', durationMinutes: 1499 }] };
    const { text } = renderAnswer('text', 'raw', answer('get_free_slots', { date: '2026-10-25' }, 'raw', data), {
      now: new Date(),
      timezone: ZONE,
      language: 'en',
    });
    expect(text).toBe('Free tomorrow, Sun Oct 25: all day.');
  });

  test('quoted inside another sentence the windows come bare', () => {
    const data = { slots: [window('10:30', '12:00')] };
    expect(quotableText(answer('get_free_slots', { date: day(1) }, 'raw', data), ru)).toBe('10:30–12:00');
    expect(quotableText(answer('get_free_slots', { date: day(1) }, 'raw', { slots: [] }), ru)).toBe(
      'свободных окон нет',
    );
  });
});

describe('quoting a read in a rule sentence', () => {
  test('events come with ids and human days so a person can pick one by number', () => {
    const list = [event(12, 'Стендап', 1, '10:00'), event(13, 'Стендап', 4, '10:00')];
    expect(quotableText(answer('search_events', {}, 'raw', list), ru)).toBe(
      '#12  Стендап — завтра, ср 7 октября, 10:00–10:30\n#13  Стендап — сб 10 октября, 10:00–10:30',
    );
  });
});

describe('time', () => {
  const zoneJson = (timezone: string, offset: string, local: string) =>
    JSON.stringify({ timezone, utc_offset: offset, utc_offset_minutes: 0, dst_active: false, local_time: local });

  test('the user’s own time names the zone', () => {
    const output = zoneJson(ZONE, '+02:00', '2026-10-06T10:00:00+02:00');
    expect(render(answer('get_timezone_info', { timezone: ZONE }, output)).text).toBe(
      `Сейчас 10:00, вт 6 октября (${ZONE}, UTC+2).`,
    );
  });

  test('a city is named as the user wrote it', () => {
    const output = zoneJson('Asia/Tokyo', '+09:00', '2026-10-06T17:00:00+09:00');
    expect(render(answer('get_timezone_info', { timezone: 'Токио' }, output))).toEqual({
      text: 'Сейчас в Токио 17:00, вт 6 октября (UTC+9).',
      complete: true,
    });
    expect(render(answer('get_timezone_info', { timezone: 'tokyo' }, output), en).text).toBe(
      "Right now in Tokyo it's 17:00, Tue Oct 6 (UTC+9).",
    );
  });

  test('a half-hour offset and a zone id', () => {
    const output = zoneJson('Asia/Kolkata', '+05:30', '2026-10-06T13:30:00+05:30');
    expect(render(answer('get_timezone_info', { timezone: 'Asia/Kolkata' }, output), en).text).toBe(
      "Right now in Asia/Kolkata it's 13:30, Tue Oct 6 (UTC+5:30).",
    );
  });

  test('two zones are listed with the gap between them', () => {
    const zones = {
      timezones: [
        { timezone: 'America/New_York', utc_offset: '-04:00', local_time: '2026-10-06T04:00:00-04:00' },
        { timezone: 'Europe/Belgrade', utc_offset: '+02:00', local_time: '2026-10-06T10:00:00+02:00' },
      ],
      difference_hours: 6,
    };
    const rendered = render(answer('get_timezone_info', { timezone: ['x', 'y'] }, JSON.stringify(zones)), en);
    expect(rendered.text).toBe(
      [
        "Right now in America/New_York it's 04:00, Tue Oct 6 (UTC-4).",
        "Right now in Europe/Belgrade it's 10:00, Tue Oct 6 (UTC+2).",
        'The zones are 6 hours apart.',
      ].join('\n'),
    );
  });

  test('a converted instant reads as a clock in the target zone', () => {
    const output = JSON.stringify({
      timezone: 'Asia/Tokyo',
      local_datetime: '2026-10-06T17:00:00+09:00',
      utc_offset: '+09:00',
    });
    expect(render(answer('convert_to_timezone', {}, output)).text).toBe(
      'В поясе Asia/Tokyo 17:00, вт 6 октября (UTC+9).',
    );
  });

  test('no JSON ever reaches the user, even for a shape nobody rendered', () => {
    const rendered = render(answer('get_timezone_info', { timezone: 'x' }, '{"zone":"x","t":1}'));
    expect(rendered.text).toBe('Данные получил, но показать их в читаемом виде не смог.');
    expect(rendered.complete).toBe(false);
    expect(render(answer('some_tool', {}, '[1,2]'), en).text).toBe(
      'I got the data but could not show it in a readable form.',
    );
  });
});

describe('settings', () => {
  const all = JSON.stringify({
    general: {
      timezone: ZONE,
      language: 'ru',
      username: 'ann_test',
      first_name: 'Ann',
      country_code: 'not set',
      default_event_duration_minutes: 90,
    },
    notifications: {
      morning_agenda_enabled: 1,
      morning_agenda_time: '08:00:00',
      evening_review_enabled: 0,
      quiet_hours_enabled: 1,
      quiet_hours_start: '22:00',
      quiet_hours_end: '07:00',
      default_reminder_intervals: '[15,60]',
    },
    privacy: { default_visibility: 'private', inline_mode_enabled: 1, allow_invitations: 0 },
    voice: { voice_response_enabled: null },
  });

  test('a short labelled list in the user’s language', () => {
    const rendered = render(answer('manage_settings', { action: 'get' }, all));
    expect(rendered.complete).toBe(true);
    expect(rendered.text).toBe(
      [
        'Твои настройки:',
        '',
        'Общие:',
        '• Часовой пояс: Europe/Belgrade',
        '• Язык: русский',
        '• Длительность события по умолчанию: 1 ч 30 мин',
        '',
        'Уведомления:',
        '• Утренняя сводка: в 08:00',
        '• Вечерний обзор: нет',
        '• Тихие часы: с 22:00 до 07:00',
        '• Напоминания по умолчанию: за 15 мин, за 1 ч',
        '',
        'Приватность:',
        '• Видимость событий по умолчанию: приватные',
        '• Инлайн-режим: да',
        '• Приглашения от других: нет',
        '',
        'Голос:',
        '• Голосовые ответы: не задано',
      ].join('\n'),
    );
    expect(render(answer('manage_settings', { action: 'get' }, all), en).text).toContain(
      '• Quiet hours: from 22:00 to 07:00',
    );
  });

  test('one category comes flat and says which', () => {
    const output = JSON.stringify({ default_visibility: 'full', inline_mode_enabled: 0 });
    expect(render(answer('manage_settings', { action: 'get', category: 'privacy' }, output), en).text).toBe(
      'Your settings (privacy):\n• Default event visibility: fully visible\n• Inline mode: no',
    );
  });

  test('an unknown shape is said to be unknown, an update is not a whole-read answer', () => {
    expect(render(answer('manage_settings', { action: 'get' }, '{"x":{"y":1}}')).complete).toBe(false);
    const update = render(answer('manage_settings', { action: 'update' }, 'Часовой пояс обновлён.'));
    expect(update).toEqual({ text: 'Часовой пояс обновлён.', complete: false });
  });
});

describe('contacts, holidays, bot info, access', () => {
  test('the contact list is names and @usernames, without internal fields', () => {
    const output = [
      'Контакты:',
      'Анна — contact_id:2 — created_at_utc:2026-10-25 21:21:04 — @anna_smith — telegram_id:987654321',
      'Лена — contact_id:4 — created_at_utc:2026-10-25 21:21:04 — telegram_id:none',
      'Ваня — contact_id:5 — created_at_utc:2026-10-25 21:21:04 — display:Иван — @ivan_petrov — telegram_id:1',
    ].join('\n');
    expect(render(answer('get_contacts', {}, output))).toEqual({
      text: 'Контакты (3):\nАнна — @anna_smith\nЛена\nВаня (Иван) — @ivan_petrov',
      complete: true,
    });
    expect(render(answer('get_contacts', {}, 'Адресная книга пуста.'))).toEqual({
      text: 'Адресная книга пуста.',
      complete: true,
    });
  });

  test('find_contact answers one exact match, but an approximate or several matches stay open', () => {
    const match = (id: number, name: string, username: string | null, confidence: number) => ({
      id,
      name,
      preferred_name: null,
      username,
      telegram_id: null,
      confidence,
    });
    expect(render(answer('find_contact', {}, 'raw', { matches: [match(1, 'Иван', 'ivan_petrov', 1)] }))).toEqual({
      text: 'Нашёл контакт: Иван — @ivan_petrov',
      complete: true,
    });
    expect(render(answer('find_contact', {}, 'raw', { matches: [match(1, 'Иван', null, 0.8)] })).complete).toBe(false);
    const several = render(
      answer('find_contact', {}, 'raw', { matches: [match(1, 'Иван', 'a_b', 1), match(2, 'Ивана', null, 1)] }),
      en,
    );
    expect(several).toEqual({ text: 'Found several contacts:\nИван — @a_b\nИвана', complete: false });
  });

  test('holiday dates become days', () => {
    const output = `Ближайшие праздники:\n${day(2)}: День народного единства (Россия)`;
    expect(render(answer('get_holidays', {}, output)).text).toBe(
      'Ближайшие праздники:\nпослезавтра, чт 8 октября — День народного единства (Россия)',
    );
  });

  test('bot info is localised and keeps the developer handle the tool gives', () => {
    const tool = handleGetBotInfo().output ?? '';
    const bullets = (text: string) => text.split('\n').filter((line) => line.startsWith('•'));
    const ruText = render(answer('get_bot_info', {}, tool)).text;
    // One bullet per capability of the tool; a new capability in the tool fails here until the wording has it.
    expect(bullets(ruText)).toHaveLength(tool.split('\n').filter((line) => line.startsWith('- ')).length);
    expect(ruText).toContain('Разработчик: @mxtnr');
    expect(render(answer('get_bot_info', {}, tool), en).text).toContain('Developer: @mxtnr');
  });

  test('calendar access is a list of people and what they may do', () => {
    const person = { permission: 'read', status: 'active', username: 'anna', display_name: 'Анна' };
    const output = JSON.stringify({ own: {}, my_secretaries: [person], secretary_for: [] });
    expect(render(answer('list_calendar_access', {}, output)).text).toBe(
      'Твои секретари:\n• Анна (@anna) — просмотр, доступ открыт',
    );
    expect(
      render(answer('manage_secretaries', {}, '{"status":"awaiting_confirmation","secretary_access_id":3}')).text,
    ).toBe('Отправил приглашение. Доступ появится, когда человек его примет.');
  });
});

describe('plain text and legacy formats', () => {
  test('a rule’s own sentence and a tool’s plain text pass through', () => {
    expect(renderAnswer('text', 'hello world', undefined, en)).toEqual({ text: 'hello world', complete: false });
    expect(render(answer('calculate', {}, '63'))).toEqual({ text: '63', complete: true });
  });

  test('a JSON object with a text field gives that field', () => {
    expect(renderAnswer('text', '{"output":"Event created: Call"}', undefined, en).text).toBe('Event created: Call');
    expect(renderAnswer('text', '{"message":"Событие удалено"}', undefined, ru).text).toBe('Событие удалено');
    expect(renderAnswer('text', '{"ok":true}', undefined, ru).text).toBe('Готово.');
  });

  test('JSON without a text field is never dumped', () => {
    expect(renderAnswer('text', '[{"a":1}]', undefined, ru).text).toBe(
      'Данные получил, но показать их в читаемом виде не смог.',
    );
    expect(renderAnswer('nonexistent', 'raw data', undefined, en).text).toBe('raw data');
  });

  test('events_list renders a headed agenda in the user’s zone', () => {
    const output = JSON.stringify([{ title: 'Call', start_at: at(1, '10:00'), end_at: at(1, '11:00') }]);
    expect(renderAnswer('events_list', output, undefined, en).text).toBe('Tomorrow, Wed Oct 7:\n10:00–11:00  Call');
    expect(renderAnswer('events_list', '[]', undefined, ru).text).toBe('Подходящих событий в календаре нет.');
    expect(renderAnswer('events_list', 'not valid json', undefined, en).text).toBe('not valid json');
  });

  test('search_results are numbered with human days', () => {
    const output = JSON.stringify([{ title: 'Dentist', start_at: at(2, '09:15') }]);
    expect(renderAnswer('search_results', output, undefined, en).text).toBe(
      '1. day after tomorrow, Thu Oct 8, 09:15  Dentist',
    );
  });

  test('free_slots, holidays and settings legacy formats', () => {
    const slots = JSON.stringify([{ start: at(1, '10:00'), end: at(1, '11:30') }]);
    expect(renderAnswer('free_slots', slots, undefined, ru).text).toBe('Свободно завтра, ср 7 октября: 10:00–11:30.');
    expect(renderAnswer('free_slots', '[]', undefined, en).text).toBe('No free windows.');
    const holidays = JSON.stringify([{ name: 'Labour Day', date: day(5) }]);
    expect(renderAnswer('holidays', holidays, undefined, en).text).toBe('Sun Oct 11 — Labour Day');
    expect(renderAnswer('holidays', '[]', undefined, en).text).toBe('Nothing found.');
    expect(renderAnswer('settings', '{"general":{"timezone":"UTC"}}', undefined, en).text).toContain(
      '• Time zone: UTC',
    );
    expect(renderAnswer('settings', '{"x":1}', undefined, en).text).toBe(
      'I got the data but could not show it in a readable form.',
    );
  });
});

describe('answers for two possible days (just after midnight)', () => {
  test('each day gets a heading and the answer is whole only when every day’s is', () => {
    const first = answer('get_events', {}, 'raw', [event(1, 'Стендап', 0, '10:00')]);
    const empty = answer('get_events', {}, 'На завтра, 7 октября, в твоём календаре пока нет событий.', []);
    const rendered = formatDayAnswers(
      [
        { day: day(0), answer: first },
        { day: day(1), answer: empty },
      ],
      ru,
    );
    expect(rendered.text).toBe(
      'Сегодня, вт 6 октября:\n10:00–10:30  Стендап\n\nЗавтра, ср 7 октября:\nНа завтра, 7 октября, в твоём календаре пока нет событий.',
    );
    expect(rendered.complete).toBe(true);
    expect(formatDayAnswers([{ day: day(0), response: 'Готово' }], ru).complete).toBe(false);
  });
});

describe('formatEventSummaries (compact evidence the reply guard quotes)', () => {
  test('omits the date when every event is today in the user’s zone', () => {
    expect(formatEventSummaries([event(1, 'Обед', 0, '13:00')], ZONE)).toBe('13:00  Обед');
  });

  test('dates every line once the list has an event on another day, all-day ones without a clock', () => {
    const lines = formatEventSummaries(
      [
        event(1, 'Поездка', -1, '19:00'),
        event(2, 'Урок', 0, '12:30'),
        { id: 3, title: 'Отпуск', date: day(0), all_day: true },
      ],
      ZONE,
    ).split('\n');
    expect(lines).toEqual([`${day(-1)} 19:00  Поездка`, `${day(0)} 12:30  Урок`, `${day(0)}  Отпуск`]);
  });
});
