import { describe, expect, test } from 'bun:test';
import { formatResponse } from '../../../src/services/intent/response-formatter.ts';

describe('formatResponse', () => {
  test('text format returns as-is', () => {
    expect(formatResponse('text', 'hello world', 'UTC', 'en')).toBe('hello world');
  });

  test('events_list formats events with time', () => {
    const events = JSON.stringify([
      { title: 'Meeting', start_at: '2026-03-17T10:00:00Z' },
      { title: 'Lunch', start_at: '2026-03-17T12:00:00Z' },
    ]);
    const result = formatResponse('events_list', events, 'UTC', 'en');
    expect(result).toContain('Meeting');
    expect(result).toContain('Lunch');
    expect(result).toContain('10:00');
    expect(result).toContain('12:00');
  });

  test('events_list with timezone offset', () => {
    const events = JSON.stringify([{ title: 'Meeting', start_at: '2026-03-17T10:00:00Z' }]);
    const result = formatResponse('events_list', events, 'Europe/Moscow', 'en');
    expect(result).toContain('13:00'); // UTC+3
    expect(result).toContain('Meeting');
  });

  test('events_list empty', () => {
    const result = formatResponse('events_list', '[]', 'UTC', 'en');
    expect(result).toContain('No events');
  });

  test('events_list empty in Russian', () => {
    const result = formatResponse('events_list', '[]', 'UTC', 'ru');
    expect(result).toContain('Нет событий');
  });

  test('search_results formats numbered list', () => {
    const events = JSON.stringify([
      { title: 'Doctor', start_at: '2026-03-20T09:00:00Z' },
      { title: 'Dentist', start_at: '2026-03-21T14:00:00Z' },
    ]);
    const result = formatResponse('search_results', events, 'UTC', 'en');
    expect(result).toContain('1.');
    expect(result).toContain('Doctor');
    expect(result).toContain('2.');
    expect(result).toContain('Dentist');
  });

  test('text format extracts output field from JSON object', () => {
    const json = JSON.stringify({ output: 'Event created: Call at 10:00', event_id: 5 });
    expect(formatResponse('text', json, 'UTC', 'en')).toBe('Event created: Call at 10:00');
  });

  test('text format extracts message field from JSON object', () => {
    const json = JSON.stringify({ message: 'Событие удалено', id: 3 });
    expect(formatResponse('text', json, 'UTC', 'ru')).toBe('Событие удалено');
  });

  test('text format returns non-JSON as-is', () => {
    expect(formatResponse('text', 'Готово!', 'UTC', 'ru')).toBe('Готово!');
  });

  test('text format returns JSON array as-is (no extractable field)', () => {
    const json = JSON.stringify([{ id: 1 }, { id: 2 }]);
    expect(formatResponse('text', json, 'UTC', 'en')).toBe(json);
  });

  test('unknown format falls back to text', () => {
    expect(formatResponse('nonexistent', 'raw data', 'UTC', 'en')).toBe('raw data');
  });

  test('free_slots formats time ranges', () => {
    const slots = JSON.stringify([
      { start: '2026-03-17T09:00:00Z', end: '2026-03-17T12:00:00Z' },
      { start: '2026-03-17T14:00:00Z', end: '2026-03-17T17:00:00Z' },
    ]);
    const result = formatResponse('free_slots', slots, 'UTC', 'en');
    expect(result).toContain('09:00');
    expect(result).toContain('12:00');
    expect(result).toContain('14:00');
    expect(result).toContain('17:00');
  });

  test('holidays formats list', () => {
    const holidays = JSON.stringify([
      { name: 'Christmas', date: '2026-12-25' },
      { name: 'New Year', date: '2027-01-01' },
    ]);
    const result = formatResponse('holidays', holidays, 'UTC', 'en');
    expect(result).toContain('Christmas');
    expect(result).toContain('New Year');
  });

  test('events_list with invalid JSON falls back to text', () => {
    const result = formatResponse('events_list', 'not valid json', 'UTC', 'en');
    expect(result).toBe('not valid json');
  });

  test('search_results empty returns empty string', () => {
    expect(formatResponse('search_results', '[]', 'UTC', 'en')).toBe('');
  });

  test('search_results with invalid JSON falls back to text', () => {
    const result = formatResponse('search_results', 'invalid', 'UTC', 'en');
    expect(result).toBe('invalid');
  });

  test('free_slots empty returns empty string', () => {
    expect(formatResponse('free_slots', '[]', 'UTC', 'en')).toBe('');
  });

  test('free_slots with invalid JSON falls back to text', () => {
    const result = formatResponse('free_slots', 'broken', 'UTC', 'en');
    expect(result).toBe('broken');
  });

  test('holidays empty returns empty string', () => {
    expect(formatResponse('holidays', '[]', 'UTC', 'en')).toBe('');
  });

  test('holidays with invalid JSON falls back to text', () => {
    const result = formatResponse('holidays', 'bad json', 'UTC', 'en');
    expect(result).toBe('bad json');
  });

  test('settings with null value returns empty string', () => {
    expect(formatResponse('settings', 'null', 'UTC', 'en')).toBe('');
  });

  test('settings formats key-value pairs', () => {
    const settings = JSON.stringify({
      timezone: 'Europe/Kyiv',
      language: 'uk',
      notifications: true,
    });
    const result = formatResponse('settings', settings, 'UTC', 'en');
    expect(result).toContain('timezone');
    expect(result).toContain('Europe/Kyiv');
    expect(result).toContain('language');
    expect(result).toContain('uk');
    expect(result).toContain('notifications');
    expect(result).toContain('true');
  });

  test('events_list with end_at formats time range', () => {
    const events = JSON.stringify([
      { title: 'Meeting', start_at: '2026-03-17T10:00:00Z', end_at: '2026-03-17T11:30:00Z' },
    ]);
    const result = formatResponse('events_list', events, 'UTC', 'en');
    expect(result).toContain('Meeting');
    expect(result).toContain('10:00');
    expect(result).toContain('11:30');
  });

  test('search_results with date in title', () => {
    const events = JSON.stringify([{ title: 'Conference', start_at: '2026-04-15T14:00:00Z' }]);
    const result = formatResponse('search_results', events, 'UTC', 'en');
    expect(result).toContain('1.');
    expect(result).toContain('Conference');
    expect(result).toContain('14:00');
  });
});
