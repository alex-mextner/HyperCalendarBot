import { describe, expect, test } from 'bun:test';
import { resolveCallbackButtonLabel } from '../../src/bot/callback-label.ts';

describe('resolveCallbackButtonLabel', () => {
  test('stores the visible Telegram button text instead of an internal callback prefix', () => {
    const markup = {
      inline_keyboard: [
        [{ text: 'До даты', callback_data: 'are:until' }],
        [{ text: 'N повторений', callback_data: 'are:count' }],
      ],
    };

    expect(resolveCallbackButtonLabel(markup, 'are:until', 'are')).toBe('До даты');
  });

  test('falls back to the action code when reply markup is unavailable or stale', () => {
    expect(resolveCallbackButtonLabel(undefined, 'are:until', 'are')).toBe('are');
    expect(resolveCallbackButtonLabel({ inline_keyboard: [] }, 'are:until', 'are')).toBe('are');
  });
});
