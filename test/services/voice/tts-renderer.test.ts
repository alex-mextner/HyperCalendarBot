import { describe, expect, test } from 'bun:test';
import {
  renderBatchReminderForSpeech,
  renderEveningReviewForSpeech,
  renderMorningAgendaForSpeech,
  renderReminderForSpeech,
  renderWeeklyDigestForSpeech,
} from '../../../src/services/voice/tts-renderer';

describe('renderReminderForSpeech', () => {
  test('renders basic event reminder in English', () => {
    const text = renderReminderForSpeech({
      title: 'Team standup',
      startAt: '2026-03-16T10:00:00Z',
      timezone: 'Europe/Kyiv',
      language: 'en',
    });
    expect(text).toContain('Team standup');
    expect(text).toContain('12'); // UTC+2 in March
  });

  test('renders event with location', () => {
    const text = renderReminderForSpeech({
      title: 'Doctor appointment',
      startAt: '2026-03-16T14:30:00Z',
      timezone: 'UTC',
      location: 'City Hospital, Room 205',
      language: 'en',
    });
    expect(text).toContain('Doctor appointment');
    expect(text).toContain('City Hospital');
  });

  test('renders in Russian', () => {
    const text = renderReminderForSpeech({
      title: 'Встреча с командой',
      startAt: '2026-03-16T10:00:00Z',
      timezone: 'Europe/Kyiv',
      language: 'ru',
    });
    expect(text).toContain('Встреча с командой');
    expect(text).toContain('напоминание');
  });

  test('handles missing optional fields', () => {
    const text = renderReminderForSpeech({
      title: 'Quick call',
      startAt: '2026-03-16T15:00:00Z',
      timezone: 'UTC',
      language: 'en',
    });
    expect(text).toContain('Quick call');
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('null');
  });

  test('text is speech-friendly — no HTML, no special chars', () => {
    const text = renderReminderForSpeech({
      title: 'Meeting <b>important</b> & urgent',
      startAt: '2026-03-16T10:00:00Z',
      timezone: 'UTC',
      language: 'en',
    });
    expect(text).not.toContain('<b>');
    expect(text).not.toContain('&amp;');
    expect(text).toContain('&');
  });
});

describe('renderMorningAgendaForSpeech', () => {
  const events = [
    { title: 'Team standup', startTime: '09:00', duration: '30m' },
    { title: 'Lunch meeting', startTime: '13:00', duration: '1h' },
  ];

  test('renders morning agenda in English', () => {
    const text = renderMorningAgendaForSpeech({ lang: 'en', dateLabel: 'Thursday, March 19', events });
    expect(text).toContain('Good morning');
    expect(text).toContain('Thursday, March 19');
    expect(text).toContain('Team standup');
    expect(text).toContain('09:00');
    expect(text).toContain('Lunch meeting');
    expect(text).toContain('13:00');
    expect(text).toContain('productive day');
  });

  test('renders morning agenda in Russian', () => {
    const text = renderMorningAgendaForSpeech({ lang: 'ru', dateLabel: 'четверг, 19 марта', events });
    expect(text).toContain('Доброе утро');
    expect(text).toContain('четверг, 19 марта');
    expect(text).toContain('Team standup');
    expect(text).toContain('09:00');
    expect(text).toContain('Продуктивного дня');
  });

  test('output has no emoji or markdown', () => {
    const text = renderMorningAgendaForSpeech({ lang: 'en', dateLabel: 'Friday, March 20', events });
    expect(text).not.toMatch(/[\u{1F300}-\u{1FFFF}]/u);
    expect(text).not.toContain('**');
    expect(text).not.toContain('__');
    expect(text).not.toContain('#');
  });

  test('renders all-day event without time in Russian', () => {
    const allDayEvents = [
      { title: 'Зарплата', startTime: '02:00', duration: '24ч', isAllDay: true },
      { title: 'English', startTime: '13:30', duration: '1ч' },
    ];
    const text = renderMorningAgendaForSpeech({ lang: 'ru', dateLabel: 'среда, 1 апреля', events: allDayEvents });
    expect(text).toContain('Зарплата, весь день.');
    expect(text).not.toContain('02:00');
    expect(text).toContain('13:30 — English, 1ч.');
  });

  test('renders all-day event without time in English', () => {
    const allDayEvents = [{ title: 'Payday', startTime: '00:00', duration: '24h', isAllDay: true }];
    const text = renderMorningAgendaForSpeech({ lang: 'en', dateLabel: 'Wednesday, April 1', events: allDayEvents });
    expect(text).toContain('Payday, all day.');
    expect(text).not.toContain('00:00');
  });
});

describe('renderEveningReviewForSpeech', () => {
  const events = [{ title: 'Dentist', startTime: '10:00', duration: '1h' }];

  test('renders evening review in English', () => {
    const text = renderEveningReviewForSpeech({ lang: 'en', dateLabel: 'Friday, March 20', events });
    expect(text).toContain('Good evening');
    expect(text).toContain('Friday, March 20');
    expect(text).toContain('Dentist');
    expect(text).toContain('10:00');
    expect(text).toContain('Good night');
  });

  test('renders evening review in Russian', () => {
    const text = renderEveningReviewForSpeech({ lang: 'ru', dateLabel: 'пятница, 20 марта', events });
    expect(text).toContain('Добрый вечер');
    expect(text).toContain('пятница, 20 марта');
    expect(text).toContain('Dentist');
    expect(text).toContain('10:00');
    expect(text).toContain('Спокойной ночи');
  });

  test('output has no emoji or markdown', () => {
    const text = renderEveningReviewForSpeech({ lang: 'en', dateLabel: 'Friday, March 20', events });
    expect(text).not.toMatch(/[\u{1F300}-\u{1FFFF}]/u);
    expect(text).not.toContain('**');
  });

  test('renders all-day event without time in English', () => {
    const allDayEvents = [
      { title: 'Holiday', startTime: '00:00', duration: '24h', isAllDay: true },
      { title: 'Meeting', startTime: '14:00', duration: '1h' },
    ];
    const text = renderEveningReviewForSpeech({ lang: 'en', dateLabel: 'Friday, March 20', events: allDayEvents });
    expect(text).toContain('Holiday, all day.');
    expect(text).not.toContain('00:00');
    expect(text).toContain('14:00 — Meeting, 1h.');
  });
});

describe('renderWeeklyDigestForSpeech', () => {
  const days = [
    { dayLabel: 'Mon', events: [{ title: 'Standup', startTime: '09:00' }] },
    { dayLabel: 'Tue', events: [] },
    { dayLabel: 'Wed', events: [{ title: 'Review', startTime: '14:00' }] },
  ];

  test('renders weekly digest in English', () => {
    const text = renderWeeklyDigestForSpeech({ lang: 'en', weekRange: 'Mar 20-26', days });
    expect(text).toContain('Weekly digest');
    expect(text).toContain('Mar 20-26');
    expect(text).toContain('Mon');
    expect(text).toContain('Standup');
    expect(text).toContain('09:00');
    expect(text).toContain('Tue');
    expect(text).toContain('no events');
    expect(text).toContain('Review');
    expect(text).toContain('14:00');
  });

  test('renders weekly digest in Russian', () => {
    const text = renderWeeklyDigestForSpeech({ lang: 'ru', weekRange: '20-26 мар', days });
    expect(text).toContain('дайджест');
    expect(text).toContain('20-26 мар');
    expect(text).toContain('нет событий');
    expect(text).toContain('Standup');
  });

  test('output has no emoji or markdown', () => {
    const text = renderWeeklyDigestForSpeech({ lang: 'en', weekRange: 'Mar 20-26', days });
    expect(text).not.toMatch(/[\u{1F300}-\u{1FFFF}]/u);
    expect(text).not.toContain('**');
  });

  test('renders all-day event without time in weekly digest', () => {
    const daysWithAllDay = [
      { dayLabel: 'Mon', events: [{ title: 'Holiday', startTime: '00:00', isAllDay: true }] },
      { dayLabel: 'Tue', events: [{ title: 'Standup', startTime: '09:00' }] },
    ];
    const text = renderWeeklyDigestForSpeech({ lang: 'en', weekRange: 'Mar 20-26', days: daysWithAllDay });
    expect(text).toContain('Holiday, all day');
    expect(text).not.toContain('at 00:00');
    expect(text).toContain('Standup at 09:00');
  });

  test('renders all-day event without time in Russian weekly digest', () => {
    const daysWithAllDay = [{ dayLabel: 'Пн', events: [{ title: 'Праздник', startTime: '00:00', isAllDay: true }] }];
    const text = renderWeeklyDigestForSpeech({ lang: 'ru', weekRange: '20-26 мар', days: daysWithAllDay });
    expect(text).toContain('Праздник, весь день');
    expect(text).not.toContain('в 00:00');
  });
});

describe('renderBatchReminderForSpeech', () => {
  const items = [
    { event_title: 'Meeting with John', event_start_at: '2026-03-19T09:00:00Z', timezone: 'UTC' },
    { event_title: 'Team sync', event_start_at: '2026-03-19T14:00:00Z', timezone: 'UTC' },
    { event_title: 'Dentist', event_start_at: '2026-03-19T15:00:00Z', timezone: 'UTC' },
  ];

  test('renders batch reminder in English', () => {
    const text = renderBatchReminderForSpeech({ lang: 'en', items });
    expect(text).toContain('Calendar reminder');
    expect(text).toContain('3 events');
    expect(text).toContain('Meeting with John');
    expect(text).toContain('09:00');
    expect(text).toContain('Team sync');
    expect(text).toContain('14:00');
    expect(text).toContain('Dentist');
    expect(text).toContain('15:00');
  });

  test('renders batch reminder in Russian', () => {
    const text = renderBatchReminderForSpeech({ lang: 'ru', items });
    expect(text).toContain('напоминание');
    expect(text).toContain('Meeting with John');
    expect(text).toContain('09:00');
  });

  test('uses correct Russian plural for 1 event', () => {
    const text = renderBatchReminderForSpeech({
      lang: 'ru',
      items: [{ event_title: 'Solo event', event_start_at: '2026-03-19T10:00:00Z', timezone: 'UTC' }],
    });
    expect(text).toContain('событие');
  });

  test('uses correct Russian plural for 2 events', () => {
    const text = renderBatchReminderForSpeech({
      lang: 'ru',
      items: [
        { event_title: 'Event A', event_start_at: '2026-03-19T10:00:00Z', timezone: 'UTC' },
        { event_title: 'Event B', event_start_at: '2026-03-19T11:00:00Z', timezone: 'UTC' },
      ],
    });
    expect(text).toContain('события');
  });

  test('uses correct English singular for 1 event', () => {
    const text = renderBatchReminderForSpeech({
      lang: 'en',
      items: [{ event_title: 'Solo event', event_start_at: '2026-03-19T10:00:00Z', timezone: 'UTC' }],
    });
    expect(text).toContain('1 event starting');
    expect(text).not.toContain('1 events');
  });

  test('output has no emoji or markdown', () => {
    const text = renderBatchReminderForSpeech({ lang: 'en', items });
    expect(text).not.toMatch(/[\u{1F300}-\u{1FFFF}]/u);
    expect(text).not.toContain('**');
  });
});
