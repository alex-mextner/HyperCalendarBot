// #972: the retry classifier reads two things this repository does not own, the `code` strings of Bun's
// fetch errors and the shape of gramio's TelegramError. These tests run the REAL gramio Bot through the
// real launchBot against a local socket that resets, answers an HTML gateway page, floods or rejects, so a
// Bun or gramio upgrade that changes either shape fails here instead of reviving the boot loop.
import { afterEach, describe, expect, test } from 'bun:test';
import net from 'node:net';
import { Bot } from 'gramio';
import { launchBot } from '../../src/bootstrap/launch.ts';
import { createLogger } from '../../src/utils/logger.ts';
import { FAKE_TELEGRAM_TOKEN, SECRET_FRAGMENTS } from '../helpers/fake-secrets.ts';

type Step = 'reset' | 'html502' | 'flood429' | 'unauthorized401' | 'ok';

const BODIES: Record<Exclude<Step, 'reset' | 'ok'>, { status: string; type: string; body: string }> = {
  html502: { status: '502 Bad Gateway', type: 'text/html', body: '<html><body>502 Bad Gateway</body></html>' },
  flood429: {
    status: '429 Too Many Requests',
    type: 'application/json',
    body: '{"ok":false,"error_code":429,"description":"Too Many Requests: retry after 2","parameters":{"retry_after":2}}',
  },
  unauthorized401: {
    status: '401 Unauthorized',
    type: 'application/json',
    body: '{"ok":false,"error_code":401,"description":"Unauthorized"}',
  },
};

const OK_BY_METHOD: Record<string, string> = {
  getMe: '{"ok":true,"result":{"id":424242,"is_bot":true,"first_name":"Test","username":"test_bot"}}',
  setWebhook: '{"ok":true,"result":true}',
};

/** A tiny HTTP server that answers each request from a script and counts the Telegram methods it saw. */
async function scriptedTelegram(steps: Step[]) {
  const methods: string[] = [];
  const paths: string[] = [];
  const server = net.createServer((socket) => {
    socket.on('error', () => undefined);
    let received = '';
    socket.on('data', (chunk) => {
      received += chunk.toString('latin1');
      const head = received.split('\r\n\r\n')[0] ?? '';
      const requestLine = head.split('\r\n')[0] ?? '';
      const requestPath = requestLine.split(' ')[1] ?? '';
      if (!received.includes('\r\n\r\n')) return;
      const method = requestPath.split('/').at(-1) ?? '';
      methods.push(method);
      paths.push(requestPath);
      const isGetMe = method === 'getMe';
      const step: Step = isGetMe ? (steps.shift() ?? 'ok') : 'ok';
      received = '';
      if (step === 'reset') {
        socket.resetAndDestroy();
        return;
      }
      const reply =
        step === 'ok'
          ? { status: '200 OK', type: 'application/json', body: OK_BY_METHOD[method] ?? '{"ok":true,"result":true}' }
          : BODIES[step];
      socket.end(
        `HTTP/1.1 ${reply.status}\r\nContent-Type: ${reply.type}\r\nContent-Length: ${Buffer.byteLength(reply.body)}\r\nConnection: close\r\n\r\n${reply.body}`,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as net.AddressInfo;
  return { port, methods, paths, close: () => server.close() };
}

const open: Array<() => void> = [];
afterEach(() => {
  for (const close of open.splice(0)) close();
});

async function launchAgainst(steps: Step[]) {
  const telegram = await scriptedTelegram(steps);
  open.push(telegram.close);
  const bot = new Bot(FAKE_TELEGRAM_TOKEN, { api: { baseURL: `http://127.0.0.1:${telegram.port}/bot` } });
  const sleeps: number[] = [];
  const lines: string[] = [];
  const logger = createLogger({ level: 'debug', destination: { write: (line: string) => void lines.push(line) } });
  const outcome = await launchBot({ PUBLIC_DOMAIN: 'bot.example.com' }, {}, bot, undefined, {
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    logger,
  }).then(
    () => ({ failed: false as const }),
    (error: unknown) => ({ failed: true as const, error }),
  );
  return { telegram, sleeps, lines, outcome };
}

function expectNoSecretIn(lines: string[]): void {
  const text = lines.join('');
  expect(text).not.toContain(FAKE_TELEGRAM_TOKEN);
  for (const fragment of SECRET_FRAGMENTS) expect(text).not.toContain(fragment);
}

describe('launchBot against the real gramio Bot', () => {
  test('two connection resets on getMe are retried and the webhook is then set', async () => {
    const { telegram, sleeps, lines, outcome } = await launchAgainst(['reset', 'reset']);

    expect(outcome.failed).toBe(false);
    expect(telegram.methods).toEqual(['getMe', 'getMe', 'getMe', 'setWebhook']);
    expect(sleeps).toHaveLength(2);
    expect(lines.filter((line) => JSON.parse(line).level === 40)).toHaveLength(2);
    expectNoSecretIn(lines);
  });

  test('eight real resets end in a level-60 line whose real fetch error keeps code and path but not the bot token', async () => {
    const { telegram, lines, outcome } = await launchAgainst(Array.from({ length: 8 }, () => 'reset' as const));

    expect(outcome.failed).toBe(true);
    // The request path the server saw holds the token, which is what Bun's error puts in `err.path`.
    expect(telegram.paths[0]).toContain(FAKE_TELEGRAM_TOKEN);
    const fatal = lines.map((line) => JSON.parse(line)).filter((record) => record.level === 60);
    expect(fatal).toHaveLength(1);
    expect(fatal[0].err.code).toBe('ECONNRESET');
    expect(fatal[0].err.path).toContain('/getMe');
    expect(fatal[0].err.path).not.toContain(FAKE_TELEGRAM_TOKEN);
    expectNoSecretIn(lines);
  });

  test('an HTML 502 gateway page from Telegram is retried', async () => {
    const { telegram, outcome } = await launchAgainst(['html502']);

    expect(outcome.failed).toBe(false);
    expect(telegram.methods.filter((m) => m === 'getMe')).toHaveLength(2);
  });

  test('a 429 flood wait is waited out for the time Telegram asked', async () => {
    const { sleeps, outcome } = await launchAgainst(['flood429']);

    expect(outcome.failed).toBe(false);
    expect(sleeps).toEqual([2_000]);
  });

  test('a 401 is permanent: one request, no pause, one fatal line without the token', async () => {
    const { telegram, sleeps, lines, outcome } = await launchAgainst(['unauthorized401']);

    expect(outcome.failed).toBe(true);
    expect(telegram.methods).toEqual(['getMe']);
    expect(sleeps).toEqual([]);
    expect(lines.filter((line) => JSON.parse(line).level === 60)).toHaveLength(1);
    expectNoSecretIn(lines);
  });
});
