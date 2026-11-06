import { afterEach, describe, expect, test } from 'bun:test';
import {
  installConsoleRedaction,
  redactSecrets,
  registerSecretValues,
  resetRegisteredSecrets,
} from '../../src/utils/redact-secrets.ts';
import {
  FAKE_ADMIN_ALERT_TOKEN,
  FAKE_ANTHROPIC_API_KEY,
  FAKE_ANTHROPIC_OAUTH_TOKEN,
  FAKE_GETME_URL,
  FAKE_TELEGRAM_BOT_ID,
  FAKE_TELEGRAM_SECRET,
  FAKE_TELEGRAM_TOKEN,
  SECRET_FRAGMENTS,
} from '../helpers/fake-secrets.ts';

afterEach(() => {
  resetRegisteredSecrets();
});

function expectNoSecret(text: string): void {
  for (const fragment of SECRET_FRAGMENTS) expect(text).not.toContain(fragment);
}

describe('redactSecrets: Telegram bot tokens', () => {
  test('the token inside a request URL path is removed and the rest of the URL stays readable', () => {
    const out = redactSecrets(`fetch failed: ${FAKE_GETME_URL}`);
    expectNoSecret(out);
    expect(out).toContain('https://api.telegram.org/bot');
    expect(out).toContain('/getMe');
  });

  test('a token in an error message, a stack line and a JSON params blob is removed', () => {
    const err = new Error(`request to ${FAKE_GETME_URL} failed`);
    const json = JSON.stringify({ err: { message: err.message, stack: err.stack, path: FAKE_GETME_URL } });
    expectNoSecret(redactSecrets(json));
    expectNoSecret(redactSecrets(`at fetch (${FAKE_GETME_URL}:1:1)`));
  });

  test('a URL-encoded colon does not hide the token', () => {
    expectNoSecret(
      redactSecrets(`https://api.telegram.org/bot${FAKE_TELEGRAM_BOT_ID}%3A${FAKE_TELEGRAM_SECRET}/getMe`),
    );
  });

  test('a bare token outside a URL is removed too', () => {
    expectNoSecret(redactSecrets(`token=${FAKE_TELEGRAM_TOKEN}`));
  });

  test('the same token twice in one string is removed both times', () => {
    const out = redactSecrets(`${FAKE_GETME_URL} then ${FAKE_GETME_URL}`);
    expectNoSecret(out);
  });

  test('times, durations and short ratios are not mistaken for a token', () => {
    const text = 'started 15:16:52 boot 1:2 ratio 12345:6 slot 123456:abc';
    expect(redactSecrets(text)).toBe(text);
  });
});

describe('redactSecrets: other known secret shapes', () => {
  test('an Anthropic API key and an Anthropic OAuth access token are removed', () => {
    const out = redactSecrets(`invalid x-api-key ${FAKE_ANTHROPIC_API_KEY}; oauth ${FAKE_ANTHROPIC_OAUTH_TOKEN}`);
    expectNoSecret(out);
    expect(out).toContain('invalid x-api-key');
  });

  test('an Authorization bearer value is removed whatever its shape', () => {
    const out = redactSecrets(`headers: {"authorization":"Bearer ${FAKE_ADMIN_ALERT_TOKEN}"}`);
    expectNoSecret(out);
    expect(out).toContain('Bearer');
  });

  test('a registered secret value is removed wherever it appears, with no recognisable prefix', () => {
    registerSecretValues([FAKE_ADMIN_ALERT_TOKEN]);
    const out = redactSecrets(`POST /admin/alerts?t=${FAKE_ADMIN_ALERT_TOKEN} failed`);
    expectNoSecret(out);
    expect(out).toContain('POST /admin/alerts');
  });

  test('an unregistered opaque value is left alone, a short or empty registration changes nothing', () => {
    registerSecretValues([undefined, '', 'short']);
    const text = `value ${FAKE_ADMIN_ALERT_TOKEN} and short and more`;
    expect(redactSecrets(text)).toBe(text);
  });
});

describe('redactSecrets: registered values beat the shape patterns', () => {
  const ODD_SECRET = 'Xk2Lm9Pq4Rt7Wb3N#tail-after-a-hash-9z8y7x';

  test('a registered value with characters outside the bearer alphabet is removed whole, not cut at the first odd character', () => {
    registerSecretValues([ODD_SECRET]);

    const out = redactSecrets(`authorization: Bearer ${ODD_SECRET}`);

    expect(out).not.toContain('tail-after-a-hash');
    expect(out).not.toContain('Xk2Lm9Pq4Rt7Wb3N');
  });

  test('a registered value that pino writes JSON-escaped (a quote or backslash inside) is removed from the line', () => {
    const quoted = 'pass"word\\with-quote-and-backslash-4411';
    registerSecretValues([quoted]);

    const line = JSON.stringify({ msg: `failed with ${quoted}` });

    expect(line).not.toContain(quoted);
    expect(redactSecrets(line)).not.toContain('with-quote-and-backslash');
  });

  test('when one registered value is a prefix of another the longer one is removed whole', () => {
    registerSecretValues(['shared-prefix-0123456789', 'shared-prefix-0123456789-and-a-long-tail']);

    expect(redactSecrets('x shared-prefix-0123456789-and-a-long-tail y')).not.toContain('long-tail');
  });
});

describe('redactSecrets: behaviour', () => {
  test('text without a secret is returned unchanged', () => {
    const text = 'Image delivery outcome {"outcome":"sent","turnMs":1234}';
    expect(redactSecrets(text)).toBe(text);
  });

  test('redaction is idempotent', () => {
    const once = redactSecrets(`${FAKE_GETME_URL} ${FAKE_ANTHROPIC_API_KEY}`);
    expect(redactSecrets(once)).toBe(once);
  });
});

describe('installConsoleRedaction', () => {
  function recordingConsole(): { target: Console; lines: string[] } {
    const lines: string[] = [];
    const record = (...args: unknown[]): void => {
      lines.push(args.map((a) => (typeof a === 'string' ? a : Bun.inspect(a))).join(' '));
    };
    const target = { log: record, info: record, warn: record, error: record, debug: record } as unknown as Console;
    return { target, lines };
  }

  test('a string, an error carrying the token in its path, and a plain object are all redacted', () => {
    const { target, lines } = recordingConsole();
    installConsoleRedaction(target);
    const fetchError = Object.assign(new TypeError('ECONNRESET: The socket connection was closed unexpectedly'), {
      code: 'ECONNRESET',
      path: FAKE_GETME_URL,
    });

    target.error('Error received when fetching updates', fetchError);
    target.warn(`poll ${FAKE_GETME_URL}`);
    target.log({ url: FAKE_GETME_URL });

    expect(lines).toHaveLength(3);
    for (const line of lines) expectNoSecret(line);
    expect(lines[0]).toContain('ECONNRESET');
  });

  test('installing twice does not wrap twice', () => {
    const { target, lines } = recordingConsole();
    installConsoleRedaction(target);
    const once = target.error;
    installConsoleRedaction(target);
    expect(target.error).toBe(once);
    target.error('plain');
    expect(lines).toEqual(['plain']);
  });

  test('an argument without a secret is passed through as the very same value', () => {
    const seen: unknown[] = [];
    const target = { log: (...args: unknown[]) => seen.push(...args) } as unknown as Console;
    installConsoleRedaction(target);
    const payload = { turnMs: 12 };
    target.log(payload);
    expect(seen[0]).toBe(payload);
  });
});
