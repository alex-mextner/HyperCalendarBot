import { describe, expect, test } from 'bun:test';
import { renderReminderForSpeech } from '../../../src/services/voice/tts-renderer';

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
