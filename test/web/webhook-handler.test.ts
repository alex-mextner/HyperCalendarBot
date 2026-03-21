// test/web/webhook-handler.test.ts
import { describe, expect, mock, test } from 'bun:test';
import type { WebServerDeps } from '../../src/web/server.ts';
import { startWebServer } from '../../src/web/server.ts';

function makePort() {
  return 13311 + Math.floor(Math.random() * 1000);
}

function baseDeps(overrides: Partial<WebServerDeps> = {}): WebServerDeps {
  return {
    config: { OAUTH_SERVER_PORT: makePort() } as WebServerDeps['config'],
    userRepo: {} as WebServerDeps['userRepo'],
    ...overrides,
  };
}

describe('webhook handler', () => {
  test('returns 404 when calendarRepo not configured', async () => {
    const deps = baseDeps();
    const { stop } = startWebServer(deps);
    try {
      const res = await fetch(`http://localhost:${deps.config.OAUTH_SERVER_PORT}/webhooks/google-calendar`, {
        method: 'POST',
        headers: { 'x-goog-channel-id': 'ch-1', 'x-goog-resource-id': 'r-1' },
      });
      expect(res.status).toBe(404);
    } finally {
      stop();
    }
  });

  test('returns 400 without required headers', async () => {
    const deps = baseDeps({
      calendarRepo: { findChannelByIds: mock(() => null) } as unknown as WebServerDeps['calendarRepo'],
    });
    const { stop } = startWebServer(deps);
    try {
      const res = await fetch(`http://localhost:${deps.config.OAUTH_SERVER_PORT}/webhooks/google-calendar`, {
        method: 'POST',
      });
      expect(res.status).toBe(400);
    } finally {
      stop();
    }
  });

  test('returns 404 for unknown channel', async () => {
    const deps = baseDeps({
      calendarRepo: { findChannelByIds: mock(() => null) } as unknown as WebServerDeps['calendarRepo'],
    });
    const { stop } = startWebServer(deps);
    try {
      const res = await fetch(`http://localhost:${deps.config.OAUTH_SERVER_PORT}/webhooks/google-calendar`, {
        method: 'POST',
        headers: { 'x-goog-channel-id': 'ch-1', 'x-goog-resource-id': 'r-1', 'x-goog-resource-state': 'exists' },
      });
      expect(res.status).toBe(404);
    } finally {
      stop();
    }
  });

  test('returns 200 and triggers onWebhook for valid channel', async () => {
    const onWebhook = mock(() => Promise.resolve());
    const deps = baseDeps({
      calendarRepo: { findChannelByIds: mock(() => ({ id: 1 })) } as unknown as WebServerDeps['calendarRepo'],
      onWebhook,
    });
    const { stop } = startWebServer(deps);
    try {
      const res = await fetch(`http://localhost:${deps.config.OAUTH_SERVER_PORT}/webhooks/google-calendar`, {
        method: 'POST',
        headers: { 'x-goog-channel-id': 'ch-1', 'x-goog-resource-id': 'r-1', 'x-goog-resource-state': 'exists' },
      });
      expect(res.status).toBe(200);
      await Bun.sleep(10);
      expect(onWebhook).toHaveBeenCalledTimes(1);
    } finally {
      stop();
    }
  });
});
