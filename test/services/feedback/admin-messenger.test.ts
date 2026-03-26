import { describe, expect, mock, test } from 'bun:test';
import { sendAdminReplyToUser } from '../../../src/services/feedback/admin-messenger.ts';

describe('sendAdminReplyToUser', () => {
  test('sends formatted message to user', async () => {
    const sendMessage = mock(() => Promise.resolve());

    await sendAdminReplyToUser(sendMessage, 123, 'We fixed it!', 'Something broken');

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text] = sendMessage.mock.calls[0]! as unknown as [number, string];
    expect(chatId).toBe(123);
    expect(text).toContain('Ответ разработчика');
    expect(text).toContain('Something broken');
    expect(text).toContain('We fixed it!');
  });

  test('includes thread subject in message', async () => {
    const sendMessage = mock(() => Promise.resolve());

    await sendAdminReplyToUser(sendMessage, 456, 'Thanks for reporting', 'Login bug');

    const [, text] = sendMessage.mock.calls[0]! as unknown as [number, string];
    expect(text).toContain('Login bug');
  });
});
