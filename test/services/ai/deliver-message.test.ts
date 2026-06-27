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

  test('strips a deep link whose slash is HTML-escaped (scheme-less, host mangled) via start=', () => {
    // escapeHtml does not touch ':'/'/', but other escapers turn '/' into '&#x2F;'. With the host
    // mangled, neither the https:// nor the t.me/ regex matches — the surviving start= param still
    // carries the invite code and must be redacted.
    const out = redactUrls('forward t.me&#x2F;TestBot?start=i_SECRETCODE0 to them');
    expect(out).not.toContain('start=i_');
    expect(out).not.toContain('i_SECRETCODE0');
    expect(out).toContain('[link redacted]');
  });

  test('strips a bare deep-link code with no URL or scheme around it', () => {
    const out = redactUrls('invite code i_AbC1dEf2gH3 could not be created');
    expect(out).not.toContain('i_AbC1dEf2gH3');
    expect(out).toContain('[link redacted]');
  });

  test('strips bare s_ and g_ deep-link codes too', () => {
    expect(redactUrls('shared link s_ZbCdEf12-_3 failed')).not.toContain('s_ZbCdEf12-_3');
    expect(redactUrls('group link g_QwErTy78901 failed')).not.toContain('g_QwErTy78901');
  });

  test('does not over-redact ordinary text or short identifiers', () => {
    expect(redactUrls('event id 12345 was not found')).toBe('event id 12345 was not found');
    expect(redactUrls('chat not found')).toBe('chat not found');
    // Short `i_`/`s_` fragments in prose are not deep-link codes and must survive.
    expect(redactUrls('this is_ok and i_am fine')).toBe('this is_ok and i_am fine');
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

  test('TelegramError with a deep link in message/params → stack redacted, params/body never copied', () => {
    const secretLink = 'https://t.me/TestBot?start=i_STACKLEAK01';
    const err = new TelegramError(
      { ok: false, error_code: 400, description: `Bad Request: ${secretLink}` },
      'sendMessage',
      { chat_id: 12345, text: `forward ${secretLink}` },
    );
    const out = describeDeliveryError(err);
    // The stack is kept for debuggability, but V8 prepends `name: message` to its first line, so
    // the deep link embedded in the description must be redacted out of the stack too.
    expect(typeof out.stack).toBe('string');
    expect(out.stack).not.toContain('start=i_');
    expect(out.stack).not.toContain('t.me/TestBot');
    expect(out.stack).toContain('[link redacted]');
    // TelegramError attaches the request body (params/payload) as enumerable own props; the
    // described object must read only safe scalar fields and never copy them.
    expect(Object.keys(out)).not.toContain('params');
    expect(Object.keys(out)).not.toContain('payload');
    expect(Object.keys(out)).not.toContain('body');
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('chat_id');
    expect(serialized).not.toContain('start=i_');
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
