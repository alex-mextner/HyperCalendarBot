import { describe, expect, test } from 'bun:test';
import { NotificationRenderer } from '../../../src/services/notification/renderer.ts';

describe('NotificationRenderer.renderEveHoliday', () => {
  const renderer = new NotificationRenderer();

  test('renders Russian message with holiday name', () => {
    const result = renderer.renderEveHoliday('ru', 'День Конституции');
    expect(result.channel).toBe('telegram_text');
    expect(result.text).toContain('Завтра праздник');
    expect(result.text).toContain('День Конституции');
  });

  test('renders English message with holiday name', () => {
    const result = renderer.renderEveHoliday('en', 'Constitution Day');
    expect(result.channel).toBe('telegram_text');
    expect(result.text).toContain('Constitution Day');
    expect(result.text).toContain('Tomorrow');
  });

  test('falls back to English for unknown language', () => {
    const result = renderer.renderEveHoliday('de', 'Tag der deutschen Einheit');
    expect(result.channel).toBe('telegram_text');
    expect(result.text).toContain('Tag der deutschen Einheit');
  });
});
