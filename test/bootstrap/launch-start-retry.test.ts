// #972: on 2026-11-05 a Telegram getMe reset during bot.start() was an unhandled rejection at level 60
// and the container exited. A transient network failure at start is retried with bounded backoff; a
// permanent one (the token is rejected) still fails fast with one honest fatal line.
import { describe, expect, test } from 'bun:test';
import {
  handleLaunchFailure,
  isTransientStartError,
  type LaunchableBot,
  launchBot,
  START_MAX_ATTEMPTS,
  TelegramStartError,
  type WebhookStartOptions,
} from '../../src/bootstrap/launch.ts';
import { createLogger } from '../../src/utils/logger.ts';
import { FAKE_GETME_URL, FAKE_TELEGRAM_TOKEN, SECRET_FRAGMENTS } from '../helpers/fake-secrets.ts';

/** What Bun's fetch throws on a reset: the failing URL, token included, is in `path`. */
function networkError(code: string): Error {
  return Object.assign(new TypeError(`${code}: The socket connection was closed unexpectedly`), {
    code,
    path: FAKE_GETME_URL,
    errno: 0,
  });
}

/** gramio's TelegramError: a numeric Bot API `code` and the failing `method`. */
function telegramError(code: number, description: string): Error {
  return Object.assign(new Error(description), { name: 'getMe', method: 'getMe', code, params: {} });
}

function harness(failures: Array<Error | undefined>) {
  const starts: Array<WebhookStartOptions | undefined> = [];
  const bot: LaunchableBot = {
    start: async (options) => {
      starts.push(options);
      const failure = failures[starts.length - 1];
      if (failure) throw failure;
      return undefined;
    },
  };
  const sleeps: number[] = [];
  const lines: string[] = [];
  const logger = createLogger({ level: 'debug', destination: { write: (line: string) => void lines.push(line) } });
  const records = (): Array<{ level: number; msg: string; [key: string]: unknown }> =>
    lines.map((line) => JSON.parse(line));
  const control = {
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    logger,
  };
  return { bot, starts, sleeps, lines, records, control };
}

const POLLING = { PUBLIC_DOMAIN: undefined };

describe('launchBot start retry', () => {
  test.each([
    'ECONNRESET',
    'ETIMEDOUT',
    'ECONNREFUSED',
    'EAI_AGAIN',
    'ConnectionClosed',
  ])('a getMe %s is retried and the bot starts without an exception', async (code) => {
    const { bot, starts, sleeps, records, control } = harness([networkError(code), networkError(code)]);

    await launchBot(POLLING, {}, bot, undefined, control);

    expect(starts).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
    const warnings = records().filter((r) => r.level === 40);
    expect(warnings).toHaveLength(2);
    expect(String(warnings[0]?.msg)).toContain('retry');
    expect(warnings[0]).toMatchObject({ attempt: 1, maxAttempts: START_MAX_ATTEMPTS, code });
    expect(records().some((r) => r.level >= 50)).toBe(false);
  });

  test('a Telegram 502 and a 429 are retried, an AbortError and a wrapped reset too', async () => {
    const abort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    const wrapped = new Error('start failed', { cause: networkError('ECONNRESET') });
    const { bot, starts, control } = harness([
      telegramError(502, 'Bad Gateway'),
      telegramError(429, 'Too Many Requests'),
      abort,
      wrapped,
    ]);

    await launchBot(POLLING, {}, bot, undefined, control);

    expect(starts).toHaveLength(5);
  });

  test('the wait between attempts grows, is capped and the number of attempts is bounded', async () => {
    const always = Array.from({ length: START_MAX_ATTEMPTS + 3 }, () => networkError('ECONNRESET'));
    const { bot, starts, sleeps, records, control } = harness(always);

    await expect(launchBot(POLLING, {}, bot, undefined, control)).rejects.toThrow(/Telegram start failed/);

    expect(starts).toHaveLength(START_MAX_ATTEMPTS);
    expect(sleeps).toHaveLength(START_MAX_ATTEMPTS - 1);
    expect(sleeps[0]).toBeGreaterThan(0);
    for (let i = 1; i < sleeps.length; i++) expect(sleeps[i]).toBeGreaterThanOrEqual(sleeps[i - 1] ?? 0);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(30_000);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(120_000);
    const fatals = records().filter((r) => r.level === 60);
    expect(fatals).toHaveLength(1);
    expect(String(fatals[0]?.msg)).toContain(`${START_MAX_ATTEMPTS} attempts`);
  });

  test('a rejected token (401) fails at once with one honest fatal line and no retry', async () => {
    const { bot, starts, sleeps, records, control } = harness([telegramError(401, 'Unauthorized')]);

    await expect(launchBot(POLLING, {}, bot, undefined, control)).rejects.toThrow(/Telegram start failed/);

    expect(starts).toHaveLength(1);
    expect(sleeps).toEqual([]);
    const fatals = records().filter((r) => r.level === 60);
    expect(fatals).toHaveLength(1);
    expect(String(fatals[0]?.msg)).toMatch(/not retried|permanent/i);
    expect(records().filter((r) => r.level === 40)).toHaveLength(0);
  });

  test('a getMe 404 and an error with no network code or Telegram status are permanent too', async () => {
    for (const failure of [
      telegramError(404, 'The bot token is incorrect. Check it in BotFather.'),
      new TypeError('x is not a function'),
    ]) {
      const { bot, starts, control } = harness([failure]);
      await expect(launchBot(POLLING, {}, bot, undefined, control)).rejects.toBeInstanceOf(Error);
      expect(starts).toHaveLength(1);
    }
  });

  test('neither the retry warnings nor the fatal line carry the bot token', async () => {
    const reset = harness([
      networkError('ECONNRESET'),
      networkError('ECONNRESET'),
      networkError('ECONNRESET'),
      networkError('ECONNRESET'),
      networkError('ECONNRESET'),
      networkError('ECONNRESET'),
      networkError('ECONNRESET'),
      networkError('ECONNRESET'),
    ]);
    await launchBot(POLLING, {}, reset.bot, undefined, reset.control).catch(() => undefined);
    const rejected = harness([
      Object.assign(telegramError(401, `Unauthorized ${FAKE_GETME_URL}`), { path: FAKE_GETME_URL }),
    ]);
    await launchBot(POLLING, {}, rejected.bot, undefined, rejected.control).catch(() => undefined);

    for (const text of [...reset.lines, ...rejected.lines]) {
      expect(text).not.toContain(FAKE_TELEGRAM_TOKEN);
      for (const fragment of SECRET_FRAGMENTS) expect(text).not.toContain(fragment);
    }
    expect(reset.lines.length).toBeGreaterThan(0);
    expect(reset.lines.join('')).toContain('ECONNRESET');
  });

  test('webhook mode registers the handler once, retries start, and logs "started" only after it succeeded', async () => {
    const { bot, starts, records, control } = harness([networkError('ECONNRESET')]);
    const registered: string[] = [];
    const deps: { telegramWebhookHandler?: (req: Request) => Response } = {};

    await launchBot(
      { PUBLIC_DOMAIN: 'bot.example.com' },
      deps,
      bot,
      {
        randomSecret: () => 'secret-1',
        createWebhookHandler: (_bot, secret) => {
          registered.push(secret);
          return () => new Response('ok');
        },
      },
      control,
    );

    expect(registered).toEqual(['secret-1']);
    expect(starts).toHaveLength(2);
    expect(starts[1]?.webhook.secret_token).toBe('secret-1');
    const messages = records().map((r) => r.msg);
    expect(messages.filter((m) => m === 'Bot started (webhook mode)')).toHaveLength(1);
    expect(messages.at(-1)).toBe('Bot started (webhook mode)');
  });

  test('a start that rejects asynchronously is awaited, not left as an unhandled rejection', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      const { bot, control } = harness([telegramError(401, 'Unauthorized')]);
      await launchBot(POLLING, {}, bot, undefined, control).catch(() => undefined);
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      process.off('unhandledRejection', onRejection);
    }
    expect(rejections).toEqual([]);
  });
});

describe('launchBot start retry: edge cases', () => {
  test('a 5xx answer whose body is not JSON (an HTML gateway page, an empty body) is retried', async () => {
    const htmlBody = new SyntaxError('JSON Parse error: Unrecognized token <');
    const { bot, starts, control } = harness([htmlBody, htmlBody]);

    await launchBot(POLLING, {}, bot, undefined, control);

    expect(starts).toHaveLength(3);
  });

  test('a flood wait longer than the backoff is waited out, not hammered', async () => {
    const flood = Object.assign(telegramError(429, 'Too Many Requests: retry after 40'), {
      payload: { retry_after: 40 },
    });
    const { bot, sleeps, control } = harness([flood]);

    await launchBot(POLLING, {}, bot, undefined, control);

    expect(sleeps).toEqual([40_000]);
  });

  test('a flood wait is capped so one answer cannot park the process for hours', async () => {
    const flood = Object.assign(telegramError(429, 'Too Many Requests'), { payload: { retry_after: 86_400 } });
    const { bot, sleeps, control } = harness([flood]);

    await launchBot(POLLING, {}, bot, undefined, control);

    expect(sleeps[0]).toBeLessThanOrEqual(120_000);
    expect(sleeps[0]).toBeGreaterThanOrEqual(15_000);
  });

  test('a shutdown that starts during the pause stops the launch: no further attempt, no error', async () => {
    const deps: { telegramUpdatesClosed?: boolean } = {};
    const { bot, starts, records, control } = harness([networkError('ECONNRESET')]);
    const sleepingControl = {
      ...control,
      sleep: async () => {
        deps.telegramUpdatesClosed = true;
      },
    };

    await launchBot(POLLING, deps, bot, undefined, sleepingControl);

    expect(starts).toHaveLength(1);
    expect(records().some((r) => r.level >= 50)).toBe(false);
    expect(records().some((r) => String(r.msg).includes('shutdown'))).toBe(true);
  });

  test('a start that succeeds after shutdown began is stopped again and not announced as started', async () => {
    const deps: { telegramUpdatesClosed?: boolean } = {};
    const { starts, records, control } = harness([]);
    let stops = 0;
    const bot: LaunchableBot = {
      start: async (options) => {
        starts.push(options);
        deps.telegramUpdatesClosed = true;
      },
      stop: async () => {
        stops++;
      },
    };

    await launchBot(
      { PUBLIC_DOMAIN: 'bot.example.com' },
      deps,
      bot,
      {
        randomSecret: () => 'secret-1',
        createWebhookHandler: () => () => new Response('ok'),
      },
      control,
    );

    expect(starts).toHaveLength(1);
    expect(stops).toBe(1);
    expect(records().map((r) => r.msg)).not.toContain('Bot started (webhook mode)');
  });

  test('a start that fails during shutdown is abandoned quietly, not raised as a crash', async () => {
    for (const failure of [telegramError(401, 'Unauthorized'), networkError('ECONNRESET')]) {
      const deps: { telegramUpdatesClosed?: boolean } = {};
      const { starts, records, control } = harness([]);
      const bot: LaunchableBot = {
        start: async (options) => {
          starts.push(options);
          deps.telegramUpdatesClosed = true;
          throw failure;
        },
      };

      await launchBot(POLLING, deps, bot, undefined, control);

      expect(starts).toHaveLength(1);
      expect(records().some((r) => r.level >= 50)).toBe(false);
    }
  });

  test('a shutdown that began before the first attempt starts nothing', async () => {
    const { bot, starts, control } = harness([]);

    await launchBot(POLLING, { telegramUpdatesClosed: true }, bot, undefined, control);

    expect(starts).toHaveLength(0);
  });

  test('the thrown error names the cause so the crash alert says why, without the URL', async () => {
    const permanent = harness([telegramError(401, 'Unauthorized')]);
    const error = await launchBot(POLLING, {}, permanent.bot, undefined, permanent.control).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TelegramStartError);
    expect((error as Error).message).toContain('401');
    expect((error as Error).cause).toBeInstanceOf(Error);

    const exhausted = harness(Array.from({ length: START_MAX_ATTEMPTS }, () => networkError('ECONNRESET')));
    const last = await launchBot(POLLING, {}, exhausted.bot, undefined, exhausted.control).catch((e: unknown) => e);
    expect((last as Error).message).toContain('ECONNRESET');
  });
});

describe('isTransientStartError', () => {
  test('classifies network failures and server-side Telegram codes as transient only', () => {
    expect(isTransientStartError(networkError('ECONNRESET'))).toBe(true);
    expect(isTransientStartError(telegramError(500, 'Internal'))).toBe(true);
    expect(isTransientStartError(telegramError(503, 'Unavailable'))).toBe(true);
    expect(isTransientStartError(telegramError(401, 'Unauthorized'))).toBe(false);
    expect(isTransientStartError(telegramError(400, 'Bad Request'))).toBe(false);
    expect(isTransientStartError(new Error('plain'))).toBe(false);
    expect(isTransientStartError(new SyntaxError('JSON Parse error'))).toBe(true);
    expect(isTransientStartError('ECONNRESET')).toBe(false);
  });
});

describe('handleLaunchFailure', () => {
  function failureHarness(options: { alertThrows?: boolean; shutdownThrows?: boolean } = {}) {
    const events: string[] = [];
    const lines: Array<{ level: string; msg: string }> = [];
    const deps = {
      logger: {
        fatal: (_fields: object, msg: string) => void lines.push({ level: 'fatal', msg }),
        warn: (_fields: object, msg: string) => void lines.push({ level: 'warn', msg }),
      },
      alertFatal: () => {
        events.push('alert');
        if (options.alertThrows) throw new Error('SQLITE_BUSY');
      },
      shutdown: async () => {
        events.push('shutdown');
        if (options.shutdownThrows) throw new Error('shutdown broke');
      },
      exit: (code: number) => void events.push(`exit ${code}`),
    };
    return { deps, events, lines };
  }

  test('alerts first, then runs the graceful shutdown, then exits 1', async () => {
    const { deps, events } = failureHarness();

    await handleLaunchFailure(
      new TelegramStartError('Telegram start failed permanently', { cause: new Error('x') }),
      deps,
    );

    expect(events).toEqual(['alert', 'shutdown', 'exit 1']);
  });

  test('a launch error that did not come from the retry loop is logged fatal, one from it is not logged twice', async () => {
    const stray = failureHarness();
    await handleLaunchFailure(new TypeError('The webhook adapter needs a GramIO Bot'), stray.deps);
    expect(stray.lines.filter((l) => l.level === 'fatal')).toHaveLength(1);

    const fromLoop = failureHarness();
    await handleLaunchFailure(new TelegramStartError('Telegram start failed after 8 attempts'), fromLoop.deps);
    expect(fromLoop.lines.filter((l) => l.level === 'fatal')).toHaveLength(0);
  });

  test('an alert that cannot be queued does not skip the shutdown or the exit', async () => {
    const { deps, events, lines } = failureHarness({ alertThrows: true });

    await handleLaunchFailure(new TelegramStartError('x'), deps);

    expect(events).toEqual(['alert', 'shutdown', 'exit 1']);
    expect(lines.some((l) => l.level === 'warn')).toBe(true);
  });

  test('a shutdown that throws still ends in exit 1', async () => {
    const { deps, events } = failureHarness({ shutdownThrows: true });

    await handleLaunchFailure(new TelegramStartError('x'), deps);

    expect(events.at(-1)).toBe('exit 1');
  });

  test('a non-Error rejection is wrapped, not lost', async () => {
    const { deps, events } = failureHarness();

    await handleLaunchFailure('plain string', deps);

    expect(events).toEqual(['alert', 'shutdown', 'exit 1']);
  });
});
