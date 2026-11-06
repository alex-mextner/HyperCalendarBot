// Every pino line passes through the secret redaction before it reaches the container log. The
// 2026-11-05 incident (#972) printed the bot token in `err.path` of a level-60 record; these tests
// log that exact error shape, and a real production-mode logger in a child process.
import { afterEach, describe, expect, test } from 'bun:test';
import { createLogger } from '../../src/utils/logger.ts';
import { registerSecretValues, resetRegisteredSecrets } from '../../src/utils/redact-secrets.ts';
import {
  FAKE_ADMIN_ALERT_TOKEN,
  FAKE_ANTHROPIC_API_KEY,
  FAKE_ANTHROPIC_OAUTH_TOKEN,
  FAKE_GETME_URL,
  FAKE_TELEGRAM_TOKEN,
  SECRET_FRAGMENTS,
} from '../helpers/fake-secrets.ts';

afterEach(() => {
  resetRegisteredSecrets();
});

function capture() {
  const lines: string[] = [];
  const log = createLogger({ level: 'debug', destination: { write: (line: string) => void lines.push(line) } });
  return { log, lines };
}

function expectNoSecret(text: string): void {
  expect(text).not.toContain(FAKE_TELEGRAM_TOKEN);
  for (const fragment of SECRET_FRAGMENTS) expect(text).not.toContain(fragment);
}

/** What Bun's fetch throws when Telegram resets the connection: the URL, token included, lands in `path`. */
function resetError(): Error {
  return Object.assign(
    new TypeError(
      'ECONNRESET: The socket connection was closed unexpectedly. For more information, pass `verbose: true`',
    ),
    { code: 'ECONNRESET', path: FAKE_GETME_URL, errno: 0 },
  );
}

describe('createLogger redaction', () => {
  test('a fetch reset logged as { err } keeps its code and URL but not the bot token in path', () => {
    const { log, lines } = capture();

    log.fatal({ err: resetError() }, 'Unhandled promise rejection');

    const record = JSON.parse(lines.join(''));
    expectNoSecret(lines.join(''));
    expect(record.err.code).toBe('ECONNRESET');
    expect(record.err.path).toContain('https://api.telegram.org/bot');
    expect(record.err.path).toContain('/getMe');
    expect(record.msg).toBe('Unhandled promise rejection');
  });

  test('a token in err.message, err.stack, a plain field, the message text and a child binding is redacted', () => {
    const { log, lines } = capture();
    const failing = new Error(`request to ${FAKE_GETME_URL} failed`);

    log
      .child({ module: 'bot', url: FAKE_GETME_URL })
      .error({ err: failing, params: { value: FAKE_TELEGRAM_TOKEN } }, `boom ${FAKE_GETME_URL}`);

    expect(lines).toHaveLength(1);
    expectNoSecret(lines.join(''));
    expect(JSON.parse(lines.join('')).module).toBe('bot');
  });

  test('Anthropic keys, an OAuth bearer and a registered ADMIN_ALERT_TOKEN never reach the line', () => {
    registerSecretValues([FAKE_ADMIN_ALERT_TOKEN]);
    const { log, lines } = capture();
    const header = `Bearer ${FAKE_ANTHROPIC_OAUTH_TOKEN}`;

    log.error(
      {
        err: new Error(`401 invalid x-api-key ${FAKE_ANTHROPIC_API_KEY}`),
        headers: { authorization: header, 'x-admin': FAKE_ADMIN_ALERT_TOKEN },
      },
      'provider rejected the request',
    );

    expectNoSecret(lines.join(''));
  });

  test('a line with no secret keeps every field', () => {
    const { log, lines } = capture();

    log.info({ outcome: 'sent', turnMs: 1234 }, 'Image delivery outcome');

    const record = JSON.parse(lines.join(''));
    expect(record).toMatchObject({ outcome: 'sent', turnMs: 1234, msg: 'Image delivery outcome' });
  });
});

describe('the production logger', () => {
  test('a module-level logger in production mode prints the reset error without the token', async () => {
    const script = `
      import { botLogger } from './src/utils/logger.ts';
      const err = Object.assign(new TypeError('ECONNRESET: closed'), { code: 'ECONNRESET', path: process.env.FAKE_URL });
      botLogger.fatal({ err }, 'Unhandled promise rejection');
    `;
    const proc = Bun.spawn(['bun', '--no-env-file', '-e', script], {
      cwd: `${import.meta.dir}/../..`,
      env: { PATH: process.env.PATH ?? '', NODE_ENV: 'production', FAKE_URL: FAKE_GETME_URL },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;

    expectNoSecret(stdout + stderr);
    const record = JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}');
    expect(record.level).toBe(60);
    expect(record.err.code).toBe('ECONNRESET');
    expect(record.err.path).toContain('/getMe');
  });
});
