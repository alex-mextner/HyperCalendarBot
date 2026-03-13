// test/web/webhook-handler.test.ts
import { describe, expect, mock, test } from 'bun:test';
import { startWebServer } from '../../src/web/server.ts';

function createMinimalDeps(overrides: Record<string, unknown> = {}) {
  return {
    config: { OAUTH_SERVER_PORT: 13311 + Math.floor(Math.random() * 1000) },
    oauthService: {},
    userRepo: {},
    syncRepo: {},
    calendarRepo: { findChannelByIds: mock(() => null) },
    stateLookup: { get: mock(() => Promise.resolve(null)), del: mock(() => Promise.resolve()) },
    ...overrides,
  };
}

describe('webhook handler', () => {
  test('returns 400 without required headers', async () => {
    const deps = createMinimalDeps();
    const { stop } = startWebServer(deps as never);
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
    const deps = createMinimalDeps({
      calendarRepo: { findChannelByIds: mock(() => null) },
    });
    const { stop } = startWebServer(deps as never);
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
    const deps = createMinimalDeps({
      calendarRepo: { findChannelByIds: mock(() => ({ id: 1 })) },
      onWebhook,
    });
    const { stop } = startWebServer(deps as never);
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
