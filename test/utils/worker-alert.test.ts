// test/utils/worker-alert.test.ts
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { UnrecoverableError } from '../../src/utils/unrecoverable-error.ts';
import { makeWorkerFailureHandler } from '../../src/utils/worker-alert.ts';

describe('makeWorkerFailureHandler', () => {
  let fetchMock: ReturnType<typeof mock>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchMock = mock(() => Promise.resolve(new Response('ok')));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const deps = {
    botToken: 'test-token',
    adminId: 12345,
  };

  test('sends Telegram message with worker name and job id', () => {
    const handler = makeWorkerFailureHandler('image-render', deps);
    const err = new Error('Playwright crashed');
    handler({ id: 'job-42' }, err);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('test-token');
    expect(url).toContain('sendMessage');
    const body = JSON.parse(opts.body as string) as { chat_id: number; text: string; parse_mode: string };
    expect(body.chat_id).toBe(12345);
    expect(body.text).toContain('image-render');
    expect(body.text).toContain('job-42');
    expect(body.text).toContain('Playwright crashed');
    expect(body.parse_mode).toBe('HTML');
  });

  test('sends Telegram message when job is undefined', () => {
    const handler = makeWorkerFailureHandler('bot-tasks', deps);
    handler(undefined, new Error('oops'));
    const [, opts] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as { text: string };
    expect(body.text).toContain('bot-tasks');
  });

  test('calls pushAlert with full stack and worker source', () => {
    const pushAlert = mock((_msg: string, _source: string) => {});
    const handler = makeWorkerFailureHandler('ai-messages', { ...deps, pushAlert });
    const err = new Error('timeout');
    err.stack = 'Error: timeout\n    at Worker.process';
    handler({ id: 'job-7' }, err);

    expect(pushAlert).toHaveBeenCalledTimes(1);
    const [msg, source] = pushAlert.mock.calls[0] as unknown as [string, string];
    expect(msg).toContain('ai-messages');
    expect(msg).toContain('job-7');
    expect(msg).toContain('Error: timeout\n    at Worker.process');
    expect(source).toBe('worker');
  });

  test('does not call pushAlert when it is not provided', () => {
    const handler = makeWorkerFailureHandler('call-queue', deps);
    // Should not throw
    expect(() => handler({ id: 'j1' }, new Error('x'))).not.toThrow();
  });

  test('escapes HTML special chars in error message for Telegram', () => {
    const handler = makeWorkerFailureHandler('bot-tasks', deps);
    handler({ id: 'j1' }, new Error('<script>alert(1)</script>'));
    const [, opts] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as { text: string };
    expect(body.text).not.toContain('<script>');
    expect(body.text).toContain('&lt;script&gt;');
  });

  test('skips alert for UnrecoverableError (permanent failures)', () => {
    const pushAlert = mock((_msg: string, _source: string) => {});
    const handler = makeWorkerFailureHandler('broadcast-notification', { ...deps, pushAlert });
    handler({ id: 'job-99' }, new UnrecoverableError("bot can't initiate conversation with a user"));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(pushAlert).not.toHaveBeenCalled();
  });

  test('does not throw when fetch rejects', async () => {
    fetchMock = mock(() => Promise.reject(new Error('network error')));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const handler = makeWorkerFailureHandler('image-render', deps);
    // Should not throw synchronously
    expect(() => handler({ id: 'j1' }, new Error('fail'))).not.toThrow();
    // Give the rejected promise a chance to be handled
    await Bun.sleep(10);
  });
});
