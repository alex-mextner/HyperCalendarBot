import { describe, expect, test } from 'bun:test';
import { NotificationRenderer } from '../../../src/services/notification/renderer.ts';

describe('NotificationRenderer.renderEveHoliday', () => {
  const renderer = new NotificationRenderer();

  test('renders Russian message with holiday name front-loaded', () => {
    const result = renderer.renderEveHoliday('ru', 'День Конституции');
    expect(result.channel).toBe('telegram_text');
    // Holiday name leads the message so the first content word in a phone
    // preview is the specific name, not a generic "Завтра праздник" label.
    expect(result.text).toBe('🎉 День Конституции завтра');
  });

  test('renders English message with holiday name front-loaded', () => {
    const result = renderer.renderEveHoliday('en', 'Constitution Day');
    expect(result.channel).toBe('telegram_text');
    expect(result.text).toBe('🎉 Constitution Day tomorrow');
  });

  test('falls back to English for unknown language', () => {
    const result = renderer.renderEveHoliday('de', 'Tag der deutschen Einheit');
    expect(result.channel).toBe('telegram_text');
    expect(result.text).toContain('Tag der deutschen Einheit');
    expect(result.text).toContain('tomorrow');
  });
});
