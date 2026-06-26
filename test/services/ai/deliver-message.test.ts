import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { TelegramError } from 'gramio';
import { deliverMessage } from '../../../src/services/ai/deliver-message.ts';
import { botLogger } from '../../../src/utils/logger.ts';

afterEach(() => {
  mock.restore();
});

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

test('deliverMessage: deep-link fallback delivered → fallbackSent true', async () => {
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
  expect(result).toEqual({ delivered: false, fallbackSent: true });
});

test('deliverMessage: deep-link fallback throws → fallbackSent false, error logged (not silent)', async () => {
  const warnSpy = spyOn(botLogger, 'warn').mockImplementation(() => {});
  const fakeSend = mock(async () => {
    throw new Error('403 everywhere');
  });
  const result = await deliverMessage({
    targetId: 100,
    text: 'hello',
    fallbackRecipientId: 999,
    fallbackText: 'fallback',
    botSend: fakeSend,
  });
  expect(result).toEqual({ delivered: false, fallbackSent: false });
  expect(warnSpy).toHaveBeenCalled();
  const [logArg] = warnSpy.mock.calls[0] ?? [];
  expect(logArg !== null && typeof logArg === 'object' && 'err' in logArg).toBe(true);
});

test('deliverMessage: TelegramError fallback failure never logs the request params (deep link)', async () => {
  const warnSpy = spyOn(botLogger, 'warn').mockImplementation(() => {});
  const secretLink = 'https://t.me/TestBot?start=i_SECRETCODE';
  const tgError = new TelegramError(
    { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' },
    'sendMessage',
    { chat_id: 999, text: `Forward this: ${secretLink}` },
  );
  const fakeSend = mock(async () => {
    throw tgError;
  });
  const result = await deliverMessage({
    targetId: 100,
    text: 'hello',
    fallbackRecipientId: 999,
    fallbackText: `Forward this: ${secretLink}`,
    botSend: fakeSend,
  });
  expect(result).toEqual({ delivered: false, fallbackSent: false });
  expect(warnSpy).toHaveBeenCalled();
  // The whole logged payload must not contain the deep link / request params.
  const logged = JSON.stringify(warnSpy.mock.calls[0] ?? []);
  expect(logged).not.toContain(secretLink);
  expect(logged).not.toContain('start=i_');
  // Useful diagnostic fields are still present.
  expect(logged).toContain('403');
  expect(logged).toContain('sendMessage');
});

test('deliverMessage: non-TelegramError carrying request params never leaks the deep link', async () => {
  const warnSpy = spyOn(botLogger, 'warn').mockImplementation(() => {});
  const secretLink = 'https://t.me/TestBot?start=i_LEAKME';
  // A wrapped / cross-package error that attaches the request body as enumerable props
  // but is NOT an instanceof TelegramError.
  class WrappedApiError extends Error {
    params = { chat_id: 999, text: `Forward: ${secretLink}` };
    body = `Forward: ${secretLink}`;
  }
  const fakeSend = mock(async () => {
    throw new WrappedApiError('upstream send failed');
  });
  const result = await deliverMessage({
    targetId: 100,
    text: 'hi',
    fallbackRecipientId: 999,
    fallbackText: `Forward: ${secretLink}`,
    botSend: fakeSend,
  });
  expect(result).toEqual({ delivered: false, fallbackSent: false });
  const logged = JSON.stringify(warnSpy.mock.calls[0] ?? []);
  expect(logged).not.toContain(secretLink);
  expect(logged).not.toContain('start=i_');
  expect(logged).toContain('upstream send failed');
});

test('deliverMessage: a deep link embedded in the error message itself is redacted from logs', async () => {
  const warnSpy = spyOn(botLogger, 'warn').mockImplementation(() => {});
  const secretLink = 'https://t.me/TestBot?start=i_INMESSAGE';
  const fakeSend = mock(async () => {
    throw new Error(`failed to deliver ${secretLink} to inviter`);
  });
  const result = await deliverMessage({
    targetId: 100,
    text: 'hi',
    fallbackRecipientId: 999,
    fallbackText: secretLink,
    botSend: fakeSend,
  });
  expect(result).toEqual({ delivered: false, fallbackSent: false });
  const logged = JSON.stringify(warnSpy.mock.calls[0] ?? []);
  expect(logged).not.toContain(secretLink);
  expect(logged).not.toContain('start=i_');
  expect(logged).toContain('[link redacted]');
});
