import { expect, mock, test } from 'bun:test';
import { deliverMessage } from '../../../src/services/ai/deliver-message.ts';

test('deliverMessage: delivers via bot API on success', async () => {
  const fakeSend = mock(async () => ({ message_id: 42 }));
  const result = await deliverMessage({
    targetId: 100,
    text: 'hello',
    fallbackRecipientId: 999,
    fallbackText: 'fallback',
    botSend: fakeSend,
  });
  expect(fakeSend).toHaveBeenCalledWith(100, 'hello', undefined);
  expect(result).toEqual({ delivered: true, messageId: 42 });
});

test('deliverMessage: falls back to MTProto if bot API fails', async () => {
  const fakeSend = mock(async () => {
    throw new Error('403');
  });
  const fakeMtproto = mock(async () => true);
  const result = await deliverMessage({
    targetId: 100,
    targetUsername: 'johndoe',
    text: 'hello',
    fallbackRecipientId: 999,
    fallbackText: 'fallback',
    botSend: fakeSend,
    mtprotoSend: fakeMtproto,
  });
  expect(fakeMtproto).toHaveBeenCalledWith(100, 'hello', 'johndoe');
  expect(result).toEqual({ delivered: true });
});

test('deliverMessage: sends deeplink to fallback recipient if all fail', async () => {
  const fakeSend = mock(async (id: number) => {
    if (id === 100) throw new Error('403');
    return { message_id: 1 };
  });
  const result = await deliverMessage({
    targetId: 100,
    text: 'hello',
    fallbackRecipientId: 999,
    fallbackText: 'They have not started the bot.',
    botSend: fakeSend,
  });
  expect(fakeSend).toHaveBeenCalledWith(999, 'They have not started the bot.');
  expect(result).toEqual({ delivered: false });
});
