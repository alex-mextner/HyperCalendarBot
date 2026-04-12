import { describe, expect, test } from 'bun:test';
import { localizeInterval, NotificationRenderer } from '../../../src/services/notification/renderer.ts';
import type { DayWeather, EventForecast } from '../../../src/services/weather/types.ts';

describe('NotificationRenderer', () => {
  const renderer = new NotificationRenderer();

  describe('renderMorningAgenda', () => {
    test('renders agenda with events', () => {
      const result = renderer.renderMorningAgenda('en', 'Tuesday, March 15', [
        { title: 'Standup', startTime: '09:00', endTime: '09:30', location: 'Zoom', duration: '30min' },
        { title: 'Lunch', startTime: '13:00', endTime: '14:00', location: null, duration: '1hr' },
      ]);
      expect(result.channel).toBe('telegram_text');
      expect(result.text).toContain('Standup');
      expect(result.text).toContain('09:00');
      expect(result.text).toContain('Zoom');
    });
  });

  describe('renderEventReminder', () => {
    test('renders reminder with interval', () => {
      const result = renderer.renderEventReminder('en', {
        title: 'Meeting',
        startTime: '14:00',
        endTime: '15:00',
        location: 'Room B',
        intervalLabel: '15 minutes',
      });
      expect(result.channel).toBe('telegram_text');
      expect(result.text).toContain('Meeting');
      expect(result.text).toContain('15 minutes');
      expect(result.text).toContain('Room B');
      expect(result.text).toContain('14:00 — 15:00');
    });

    test('renders without location', () => {
      const result = renderer.renderEventReminder('en', {
        title: 'Call',
        startTime: '10:00',
        endTime: '10:30',
        location: null,
        intervalLabel: '5 minutes',
      });
      expect(result.text).toContain('Call');
      expect(result.text).not.toContain('📍');
    });

    test('renders "at start" without "in" prefix (EN)', () => {
      const result = renderer.renderEventReminder('en', {
        title: 'Standup',
        startTime: '10:00',
        location: null,
        intervalLabel: 'at start',
      });
      expect(result.text).toContain('Standup — starting now!');
      expect(result.text).not.toContain('Reminder:');
    });

    test('renders "at start" in Russian', () => {
      const result = renderer.renderEventReminder('ru', {
        title: 'Стендап',
        startTime: '10:00',
        location: null,
        intervalLabel: 'at start',
      });
      expect(result.text).toContain('Стендап — начинается!');
    });

    test('renders Russian interval', () => {
      const result = renderer.renderEventReminder('ru', {
        title: 'Звонок',
        startTime: '14:00',
        location: null,
        intervalLabel: '30 minutes',
      });
      expect(result.text).toContain('через 30 минут');
    });

    test('shows only startTime when endTime is missing', () => {
      const result = renderer.renderEventReminder('en', {
        title: 'Call',
        startTime: '10:00',
        location: null,
        intervalLabel: '15 minutes',
      });
      expect(result.text).toContain('🕐 10:00');
      expect(result.text).not.toContain('10:00 —');
    });

    test('shows only startTime when endTime equals startTime', () => {
      const result = renderer.renderEventReminder('en', {
        title: 'Call',
        startTime: '10:00',
        endTime: '10:00',
        location: null,
        intervalLabel: '15 minutes',
      });
      expect(result.text).toContain('🕐 10:00');
      expect(result.text).not.toContain('10:00 —');
    });

    test('renders all-day "day before" reminder in Russian without time', () => {
      const result = renderer.renderEventReminder('ru', {
        title: 'Зарплата как CTO',
        startTime: '03:00',
        location: null,
        intervalLabel: 'day before',
        isAllDay: true,
      });
      expect(result.text).toContain('Напоминание: Зарплата как CTO — завтра');
      expect(result.text).toContain('📅 Весь день');
      expect(result.text).not.toContain('🕐');
      expect(result.text).not.toContain('через');
      expect(result.text).not.toContain('03:00');
    });

    test('renders all-day "day of" reminder in Russian without time', () => {
      const result = renderer.renderEventReminder('ru', {
        title: 'Праздник',
        startTime: '03:00',
        location: null,
        intervalLabel: 'day of',
        isAllDay: true,
      });
      expect(result.text).toContain('Напоминание: Праздник — сегодня');
      expect(result.text).toContain('📅 Весь день');
      expect(result.text).not.toContain('🕐');
      expect(result.text).not.toContain('через');
    });

    test('renders all-day "day before" reminder in English without time', () => {
      const result = renderer.renderEventReminder('en', {
        title: 'Salary',
        startTime: '00:00',
        location: null,
        intervalLabel: 'day before',
        isAllDay: true,
      });
      expect(result.text).toContain('Reminder: Salary — day before');
      expect(result.text).toContain('📅 All day');
      expect(result.text).not.toContain('🕐');
      expect(result.text).not.toContain(' in ');
    });

    test('renders all-day reminder with location', () => {
      const result = renderer.renderEventReminder('ru', {
        title: 'Конференция',
        startTime: '03:00',
        location: 'Офис',
        intervalLabel: 'day before',
        isAllDay: true,
      });
      expect(result.text).toContain('📅 Весь день');
      expect(result.text).toContain('📍 <a href=');
      expect(result.text).toContain('>Офис</a>');
      expect(result.text).not.toContain('🕐');
    });

    test('appends hourly forecast to event reminder at the exact event time', () => {
      const forecast: EventForecast = {
        kind: 'hour',
        hour: {
          dt: 1_700_000_000,
          temp: 14,
          conditionCode: 500,
          description: 'light rain',
          windSpeed: 3,
        },
      };
      const result = renderer.renderEventReminder('en', {
        title: 'Run',
        startTime: '18:00',
        endTime: '18:30',
        location: null,
        intervalLabel: '15 minutes',
        forecast,
      });
      expect(result.text).toContain('🌧');
      expect(result.text).toContain('14°C');
      expect(result.text).toContain('light rain');
      // Hourly must not show a daily range
      expect(result.text).not.toContain('..');
    });

    test('appends daily fallback forecast when hourly is not available', () => {
      const forecast: EventForecast = {
        kind: 'day',
        day: {
          date: '2026-04-15',
          tempMin: 5,
          tempMax: 12,
          conditionCode: 801,
          description: 'few clouds',
          windSpeed: 4,
        },
      };
      const result = renderer.renderEventReminder('en', {
        title: 'Lunch',
        startTime: '13:00',
        endTime: '14:00',
        location: null,
        intervalLabel: '1 hour',
        forecast,
      });
      expect(result.text).toContain('⛅');
      expect(result.text).toContain('5..12°C');
    });

    test('omits weather line when forecast is null', () => {
      const result = renderer.renderEventReminder('en', {
        title: 'Meeting',
        startTime: '14:00',
        endTime: '15:00',
        location: null,
        intervalLabel: '15 minutes',
        forecast: null,
      });
      expect(result.text).not.toContain('°C');
    });
  });

  describe('renderBatchReminder', () => {
    test('renders batch with multiple items', () => {
      const result = renderer.renderBatchReminder('en', [
        { title: 'Standup', startTime: '10:00', location: null, intervalLabel: '30 minutes' },
        { title: 'Call', startTime: '10:00', location: 'Zoom', intervalLabel: '30 minutes' },
      ]);
      expect(result.text).toContain('Reminders:');
      expect(result.text).toContain('• Standup — 10:00 (in 30 minutes)');
      expect(result.text).toContain('• Call — 10:00 (in 30 minutes)');
      expect(result.text).toContain('📍 <a href=');
      expect(result.text).toContain('>Zoom</a>');
    });

    test('renders batch in Russian', () => {
      const result = renderer.renderBatchReminder('ru', [
        { title: 'Стендап', startTime: '10:00', location: null, intervalLabel: '30 minutes' },
        { title: 'Звонок', startTime: '10:00', location: null, intervalLabel: 'at start' },
      ]);
      expect(result.text).toContain('Напоминания:');
      expect(result.text).toContain('через 30 минут');
      expect(result.text).toContain('начинается!');
    });

    test('renders batch with all-day item in Russian', () => {
      const result = renderer.renderBatchReminder('ru', [
        { title: 'Стендап', startTime: '10:00', location: null, intervalLabel: '30 minutes' },
        { title: 'Праздник', startTime: '03:00', location: null, intervalLabel: 'day of', isAllDay: true },
      ]);
      expect(result.text).toContain('• Стендап — 10:00 (через 30 минут)');
      expect(result.text).toContain('• Праздник — Весь день (сегодня)');
      expect(result.text).not.toContain('03:00');
    });

    test('shows shared weather once at the top when all items have the same forecast', () => {
      const forecast: EventForecast = {
        kind: 'hour',
        hour: { dt: 1_700_000_000, temp: 12, conditionCode: 800, description: 'clear sky', windSpeed: 3 },
      };
      const result = renderer.renderBatchReminder('en', [
        { title: 'Standup', startTime: '10:00', location: null, intervalLabel: '30 minutes', forecast },
        { title: 'Call', startTime: '10:00', location: null, intervalLabel: '30 minutes', forecast },
      ]);
      // Weather line appears once — right after the header, not per item
      const weatherLine = '☀️ 12°C, clear sky';
      const firstIdx = result.text.indexOf(weatherLine);
      expect(firstIdx).toBeGreaterThan(-1);
      expect(result.text.indexOf(weatherLine, firstIdx + 1)).toBe(-1);
      // The weather line is between the header and the first bullet
      expect(result.text.indexOf('Reminders:')).toBeLessThan(firstIdx);
      expect(firstIdx).toBeLessThan(result.text.indexOf('• Standup'));
    });

    test('shows per-item weather when forecasts differ', () => {
      const sunny: EventForecast = {
        kind: 'hour',
        hour: { dt: 1_700_000_000, temp: 20, conditionCode: 800, description: 'clear sky', windSpeed: 2 },
      };
      const rainy: EventForecast = {
        kind: 'hour',
        hour: { dt: 1_700_003_600, temp: 14, conditionCode: 500, description: 'light rain', windSpeed: 5 },
      };
      const result = renderer.renderBatchReminder('en', [
        { title: 'Walk', startTime: '10:00', location: null, intervalLabel: '30 minutes', forecast: sunny },
        { title: 'Gym', startTime: '11:00', location: null, intervalLabel: '30 minutes', forecast: rainy },
      ]);
      // Both weather lines present, each indented under its item
      expect(result.text).toContain('  ☀️ 20°C, clear sky');
      expect(result.text).toContain('  🌧 14°C, light rain');
    });

    test('shows per-item weather when only some items have forecast', () => {
      const forecast: EventForecast = {
        kind: 'hour',
        hour: { dt: 1_700_000_000, temp: 15, conditionCode: 800, description: 'clear sky', windSpeed: 1 },
      };
      const result = renderer.renderBatchReminder('en', [
        { title: 'Walk', startTime: '10:00', location: null, intervalLabel: '30 minutes', forecast },
        { title: 'Call', startTime: '10:00', location: null, intervalLabel: '30 minutes' },
      ]);
      // One has forecast, one doesn't → can't deduplicate → per-item
      expect(result.text).toContain('  ☀️ 15°C, clear sky');
      // Weather line appears only once (only the first item has it)
      const line = '☀️ 15°C, clear sky';
      const idx = result.text.indexOf(line);
      expect(result.text.indexOf(line, idx + 1)).toBe(-1);
    });
  });

  describe('localizeInterval', () => {
    test('returns English labels unchanged', () => {
      expect(localizeInterval('en', '15 minutes')).toBe('15 minutes');
      expect(localizeInterval('en', 'at start')).toBe('at start');
    });

    test('translates known labels to Russian', () => {
      expect(localizeInterval('ru', 'at start')).toBe('сейчас');
      expect(localizeInterval('ru', '30 minutes')).toBe('30 минут');
      expect(localizeInterval('ru', '1 hour')).toBe('1 час');
      expect(localizeInterval('ru', '2 hours')).toBe('2 часа');
      expect(localizeInterval('ru', '1 day')).toBe('1 день');
      expect(localizeInterval('ru', 'day before')).toBe('завтра');
      expect(localizeInterval('ru', 'day of')).toBe('сегодня');
    });

    test('handles snooze labels (N min)', () => {
      expect(localizeInterval('ru', '5 min')).toBe('5 мин');
      expect(localizeInterval('ru', '10 min')).toBe('10 мин');
    });

    test('handles snooze labels (Nh)', () => {
      expect(localizeInterval('ru', '1h')).toBe('1 ч');
    });

    test('returns unknown labels as-is', () => {
      expect(localizeInterval('ru', 'custom label')).toBe('custom label');
    });
  });

  describe('renderMorningAgenda – all-day events', () => {
    test('renders all-day event without time in Russian', () => {
      const result = renderer.renderMorningAgenda('ru', 'среда, апреля 1', [
        {
          title: 'Зарплата как CTO',
          startTime: '02:00',
          endTime: '02:00',
          location: null,
          duration: '24ч',
          isAllDay: true,
        },
        { title: 'English', startTime: '13:30', endTime: '14:30', location: null, duration: '1ч' },
      ]);
      expect(result.text).toContain('📅 Зарплата как CTO (Весь день)');
      expect(result.text).not.toContain('02:00');
      expect(result.text).toContain('13:30 — English (1ч)');
    });

    test('renders all-day event without time in English', () => {
      const result = renderer.renderMorningAgenda('en', 'Wednesday, April 1', [
        { title: 'Payday', startTime: '00:00', endTime: '00:00', location: null, duration: '24h', isAllDay: true },
      ]);
      expect(result.text).toContain('📅 Payday (All day)');
      expect(result.text).not.toContain('00:00');
    });

    test('renders all-day event with location', () => {
      const result = renderer.renderMorningAgenda('ru', 'среда, апреля 1', [
        {
          title: 'Конференция',
          startTime: '00:00',
          endTime: '00:00',
          location: 'Офис',
          duration: '24ч',
          isAllDay: true,
        },
      ]);
      expect(result.text).toContain('📅 Конференция (Весь день)');
      expect(result.text).toContain('📍 <a href=');
      expect(result.text).toContain('>Офис</a>');
    });
  });

  describe('renderEveningReview – all-day events', () => {
    test('renders all-day event without time in Russian', () => {
      const result = renderer.renderEveningReview('ru', 'четверг, 2 апреля', [
        { title: 'Праздник', startTime: '00:00', endTime: '00:00', location: null, duration: '24ч', isAllDay: true },
      ]);
      expect(result.text).toContain('📅 Праздник (Весь день)');
      expect(result.text).not.toContain('00:00');
    });

    test('renders all-day event without time in English', () => {
      const result = renderer.renderEveningReview('en', 'Thursday, April 2', [
        { title: 'Holiday', startTime: '00:00', endTime: '00:00', location: null, duration: '24h', isAllDay: true },
        { title: 'Meeting', startTime: '14:00', endTime: '15:00', location: null, duration: '1h' },
      ]);
      expect(result.text).toContain('📅 Holiday (All day)');
      expect(result.text).toContain('14:00 — Meeting (1h)');
    });

    test('footer uses localized "tomorrow" in Russian', () => {
      const result = renderer.renderEveningReview('ru', 'четверг, 2 апреля', [
        { title: 'Встреча', startTime: '14:00', endTime: '15:00', location: null, duration: '1ч' },
      ]);
      expect(result.text).toContain('1 событие завтра.');
      expect(result.text).not.toContain('tomorrow');
    });

    test('footer uses "tomorrow" in English', () => {
      const result = renderer.renderEveningReview('en', 'Thursday, April 2', [
        { title: 'Meeting', startTime: '14:00', endTime: '15:00', location: null, duration: '1h' },
      ]);
      expect(result.text).toContain('1 event tomorrow.');
    });
  });

  describe('renderMorningAgenda – free day', () => {
    test('renders free-day message in English', () => {
      const result = renderer.renderMorningAgenda('en', 'Sunday, March 15', []);
      expect(result.text).toContain('No events today');
      expect(result.text).toContain('Just describe it in a message');
      expect(result.text).toContain('/add');
      expect(result.text).not.toContain('Have a productive day');
    });

    test('renders free-day message in Russian', () => {
      const result = renderer.renderMorningAgenda('ru', 'воскресенье, 15 марта', []);
      expect(result.text).toContain('Сегодня нет событий');
      expect(result.text).toContain('Просто напиши сообщение');
      expect(result.text).toContain('/add');
    });
  });

  describe('renderEveningReview', () => {
    test('renders tomorrow schedule', () => {
      const result = renderer.renderEveningReview('en', 'Wednesday, March 16', [
        { title: 'Review', startTime: '16:00', endTime: '17:00', location: null, duration: '1hr' },
      ]);
      expect(result.channel).toBe('telegram_text');
      expect(result.text).toContain('Review');
      expect(result.text).toContain('Wednesday');
    });

    test('renders free-day message when no events tomorrow', () => {
      const result = renderer.renderEveningReview('en', 'Thursday, March 17', []);
      expect(result.text).toContain('No events tomorrow');
      expect(result.text).toContain('Just describe it in a message');
      expect(result.text).toContain('/add');
      expect(result.text).not.toContain('Good night');
    });

    test('renders free-day message in Russian', () => {
      const result = renderer.renderEveningReview('ru', 'четверг, 17 марта', []);
      expect(result.text).toContain('Завтра нет событий');
      expect(result.text).toContain('Просто напиши сообщение');
    });
  });

  describe('weather in agendas', () => {
    const clearWeather: DayWeather = {
      tempMin: 5,
      tempMax: 15,
      tempCurrent: 10,
      conditionCode: 800,
      description: 'clear sky',
      windSpeed: 3,
    };

    test('morning agenda includes weather line', () => {
      const result = renderer.renderMorningAgenda(
        'en',
        'Monday, April 3',
        [{ title: 'Meeting', startTime: '10:00', endTime: '11:00', location: null, duration: '1h' }],
        { weather: clearWeather },
      );
      expect(result.text).toContain('☀️ 10°C (5..15°C), clear sky');
      expect(result.text).toContain('Meeting');
    });

    test('morning agenda shows weather on free day', () => {
      const result = renderer.renderMorningAgenda('ru', 'понедельник, 3 апреля', [], {
        weather: clearWeather,
      });
      expect(result.text).toContain('☀️ 10°C (5..15°C), clear sky');
      expect(result.text).toContain('Сегодня нет событий');
    });

    test('morning agenda shows bot tip on free day', () => {
      const result = renderer.renderMorningAgenda('en', 'Monday, April 3', [], {
        botTip: '💡 Tip: send a voice message to quickly create an event!',
      });
      expect(result.text).toContain('💡 Tip: send a voice message');
    });

    test('morning agenda does not show bot tip with events', () => {
      const result = renderer.renderMorningAgenda(
        'en',
        'Monday, April 3',
        [{ title: 'Meeting', startTime: '10:00', endTime: '11:00', location: null, duration: '1h' }],
        { botTip: '💡 Some tip' },
      );
      // botTip is ignored when events exist (scheduler passes null, but renderer also won't show it)
      // In renderAgenda, botTip is only shown in the empty-events branch
      expect(result.text).not.toContain('💡 Some tip');
    });

    test('evening review includes weather for tomorrow', () => {
      const tomorrowWeather: DayWeather = {
        tempMin: -3,
        tempMax: 2,
        conditionCode: 600,
        description: 'snow',
        windSpeed: 8,
      };
      const result = renderer.renderEveningReview('ru', 'вторник, 4 апреля', [], {
        weather: tomorrowWeather,
      });
      expect(result.text).toContain('🌨 -3..2°C, snow');
    });

    test('weekly digest includes weather per day', () => {
      const days = [
        { date: '2026-04-06', dayLabel: 'Mon 6', events: [{ title: 'Meeting', startTime: '10:00' }] },
        { date: '2026-04-07', dayLabel: 'Tue 7', events: [] },
      ];
      const weatherByDate = {
        '2026-04-06': { tempMin: 10, tempMax: 18, conditionCode: 800, description: 'clear', windSpeed: 3 },
        '2026-04-07': { tempMin: 5, tempMax: 12, conditionCode: 500, description: 'rain', windSpeed: 6 },
      };
      const result = renderer.renderWeeklyDigest('en', '6–12 Apr', days, { weatherByDate });
      expect(result.text).toContain('Mon 6: 10:00 Meeting ☀️ 10..18°');
      expect(result.text).toContain('Tue 7: (no events) 🌧 5..12°');
    });

    test('weekly digest works without weather', () => {
      const days = [{ date: '2026-04-06', dayLabel: 'Mon 6', events: [{ title: 'Meeting', startTime: '10:00' }] }];
      const result = renderer.renderWeeklyDigest('en', '6–12 Apr', days);
      expect(result.text).toContain('Mon 6: 10:00 Meeting');
      expect(result.text).not.toContain('°');
    });
  });
});
