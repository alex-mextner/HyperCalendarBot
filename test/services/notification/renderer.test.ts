import { describe, expect, test } from 'bun:test';
import { NotificationRenderer } from '../../../src/services/notification/renderer.ts';

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
  });
});
