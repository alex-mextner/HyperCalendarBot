import { describe, expect, mock, test } from 'bun:test';
import { formatAdminReply, sendAdminReplyToUser } from '../../../src/services/feedback/admin-messenger.ts';

describe('sendAdminReplyToUser', () => {
  test('sends formatted message to user in Russian', async () => {
    const sendMessage = mock(() => Promise.resolve());

    await sendAdminReplyToUser(sendMessage, 123, 'We fixed it!', 'Something broken', 'ru');

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text] = sendMessage.mock.calls[0]! as unknown as [number, string];
    expect(chatId).toBe(123);
    expect(text).toContain('Ответ разработчика');
    expect(text).toContain('Something broken');
    expect(text).toContain('We fixed it!');
  });

  test('sends formatted message to user in English', async () => {
    const sendMessage = mock(() => Promise.resolve());

    await sendAdminReplyToUser(sendMessage, 123, 'We fixed it!', 'Something broken', 'en');

    const [, text] = sendMessage.mock.calls[0]! as unknown as [number, string];
    expect(text).toContain('Developer reply');
    expect(text).toContain('Something broken');
    expect(text).toContain('We fixed it!');
  });

  test('includes thread subject in message', async () => {
    const sendMessage = mock(() => Promise.resolve());

    await sendAdminReplyToUser(sendMessage, 456, 'Thanks for reporting', 'Login bug', 'en');

    const [, text] = sendMessage.mock.calls[0]! as unknown as [number, string];
    expect(text).toContain('Login bug');
  });
});

describe('formatAdminReply', () => {
  test('uses Russian header for ru', () => {
    const text = formatAdminReply('Fixed!', 'Bug report', 'ru');
    expect(text).toContain('Ответ разработчика');
    expect(text).toContain('Bug report');
    expect(text).toContain('Fixed!');
  });

  test('uses English header for en', () => {
    const text = formatAdminReply('Fixed!', 'Bug report', 'en');
    expect(text).toContain('Developer reply');
    expect(text).toContain('Bug report');
    expect(text).toContain('Fixed!');
  });
});
