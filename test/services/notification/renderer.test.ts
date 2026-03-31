import { describe, expect, test } from 'bun:test';
import { localizeInterval, NotificationRenderer } from '../../../src/services/notification/renderer.ts';

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
      expect(result.text).toContain('📍 Офис');
      expect(result.text).not.toContain('🕐');
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
      expect(result.text).toContain('📍 Zoom');
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
});
