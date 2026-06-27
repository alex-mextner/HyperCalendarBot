import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { TelegramError } from 'gramio';
import { deliverMessage, describeDeliveryError, redactUrls } from '../../../src/services/ai/deliver-message.ts';
import { botLogger } from '../../../src/utils/logger.ts';

afterEach(() => {
  mock.restore();
});

describe('redactUrls', () => {
  test('strips an https URL', () => {
    expect(redactUrls('see https://t.me/TestBot?start=i_SECRET now')).toBe('see [link redacted] now');
  });

  test('strips a scheme-less t.me deep link', () => {
    const out = redactUrls('forward t.me/TestBot?start=i_SECRET to them');
    expect(out).not.toContain('t.me/TestBot');
    expect(out).not.toContain('start=i_');
    expect(out).toContain('[link redacted]');
  });

  test('leaves URL-free text untouched', () => {
    expect(redactUrls('bot was blocked by the user')).toBe('bot was blocked by the user');
  });
});

describe('describeDeliveryError', () => {
  test('TelegramError → method as name, code populated, message redacted', () => {
    const err = new TelegramError(
      { ok: false, error_code: 403, description: 'Forbidden: bot blocked' },
      'sendMessage',
      { chat_id: 1, text: 'forward https://t.me/TestBot?start=i_SECRET' },
    );
    const out = describeDeliveryError(err);
    expect(out.name).toBe('sendMessage');
    expect(out.code).toBe(403);
    expect(out.message).not.toContain('start=i_');
  });

  test('plain Error → name and message, no code', () => {
    const out = describeDeliveryError(new TypeError('Bot API delivery failed'));
    expect(out.name).toBe('TypeError');
    expect(out.message).toBe('Bot API delivery failed');
    expect(out.code).toBeUndefined();
  });

  test('plain Error message has any URL redacted', () => {
    const out = describeDeliveryError(new Error('could not reach https://t.me/TestBot?start=i_X'));
    expect(out.message).not.toContain('start=i_');
    expect(out.message).toContain('[link redacted]');
  });

  test('non-error value → NonError sentinel (no stack)', () => {
    expect(describeDeliveryError('a bare string')).toEqual({ name: 'NonError', message: 'unknown delivery error' });
    expect(describeDeliveryError(undefined)).toEqual({ name: 'NonError', message: 'unknown delivery error' });
  });

  test('real Error → stack trace included for debuggability, any URL in it redacted', () => {
    const out = describeDeliveryError(new Error('could not reach https://t.me/TestBot?start=i_SECRET'));
    // The stack carries call frames (function names + file:line) so delivery failures stay debuggable.
    expect(typeof out.stack).toBe('string');
    expect(out.stack).toContain('at ');
    // V8 prepends the message to the stack's first line, so the deep link must still be redacted.
    expect(out.stack).not.toContain('start=i_');
    expect(out.stack).not.toContain('t.me/TestBot');
    expect(out.stack).toContain('[link redacted]');
  });

  test('Error carrying request-body props → stack present but params/body never copied', () => {
    class WrappedApiError extends Error {
      params = { chat_id: 999, text: 'forward https://t.me/TestBot?start=i_SECRET' };
      body = 'forward https://t.me/TestBot?start=i_SECRET';
    }
    const out = describeDeliveryError(new WrappedApiError('upstream send failed'));
    expect(out.message).toBe('upstream send failed');
    expect(out.stack).toBeDefined();
    // The whole described object must not leak the request body / deep link via any field.
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('start=i_');
    expect(serialized).not.toContain('chat_id');
  });
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

test('deliverMessage: a Bot API failure is logged (not silently swallowed) before fallback', async () => {
  const warnSpy = spyOn(botLogger, 'warn').mockImplementation(() => {});
  const fakeSend = mock(async () => {
    throw new Error('bot API down');
  });
  const fakeMtproto = mock(async () => true);
  const result = await deliverMessage({
    targetId: 100,
    text: 'hello',
    fallbackRecipientId: 999,
    fallbackText: 'fallback',
    botSend: fakeSend,
    mtprotoSend: fakeMtproto,
  });
  expect(result).toEqual({ delivered: true });
  expect(warnSpy).toHaveBeenCalled();
  expect(JSON.stringify(warnSpy.mock.calls)).toContain('bot API down');
});

test('deliverMessage: an MTProto failure is logged (not silently swallowed) before fallback', async () => {
  const warnSpy = spyOn(botLogger, 'warn').mockImplementation(() => {});
  const fakeSend = mock(async (id: number) => {
    if (id === 100) throw new Error('bot API down');
    return { message_id: 1 };
  });
  const fakeMtproto = mock(async () => {
    throw new Error('mtproto session corrupt');
  });
  const result = await deliverMessage({
    targetId: 100,
    text: 'hello',
    fallbackRecipientId: 999,
    fallbackText: 'fallback',
    botSend: fakeSend,
    mtprotoSend: fakeMtproto,
  });
  expect(result).toEqual({ delivered: false, fallbackSent: true });
  expect(JSON.stringify(warnSpy.mock.calls)).toContain('mtproto session corrupt');
});

test('deliverMessage: suppressFallback skips the deep-link fallback entirely', async () => {
  const fakeSend = mock(async (id: number) => {
    if (id === 100) throw new Error('403');
    return { message_id: 1 };
  });
  const result = await deliverMessage({
    targetId: 100,
    text: 'hello',
    fallbackRecipientId: 999,
    fallbackText: 'fallback',
    botSend: fakeSend,
    suppressFallback: true,
  });
  expect(result).toEqual({ delivered: false, fallbackSent: false });
  // Only the target was attempted — no fallback send to the initiator (999).
  expect(fakeSend).toHaveBeenCalledTimes(1);
  expect(fakeSend).toHaveBeenCalledWith(100, 'hello', undefined);
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
