import { describe, expect, test } from 'bun:test';
import { formatActivityEvent } from '../../../src/services/ai/activity-event.ts';

describe('formatActivityEvent', () => {
  test('button without detail', () => {
    expect(formatActivityEvent({ kind: 'button', label: 'accept' })).toBe('[Button: "accept"]');
  });

  test('button with detail', () => {
    expect(formatActivityEvent({ kind: 'button', label: 'accept', detail: 'id:42' })).toBe(
      '[Button: "accept"] (id:42)',
    );
  });

  test('command', () => {
    expect(formatActivityEvent({ kind: 'command', name: '/start' })).toBe('[Command: /start]');
  });

  test('bot', () => {
    expect(formatActivityEvent({ kind: 'bot', text: 'Hello!' })).toBe('[Bot: Hello!]');
  });

  test('edited', () => {
    expect(formatActivityEvent({ kind: 'edited', text: 'new text' })).toBe('[Edited: new text]');
  });
});
