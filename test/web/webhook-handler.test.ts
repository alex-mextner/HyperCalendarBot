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

describe('health endpoint', () => {
  test('returns 200 when no healthCheck configured', async () => {
    const deps = baseDeps();
    const { stop } = startWebServer(deps);
    try {
      const res = await fetch(`http://localhost:${deps.config.OAUTH_SERVER_PORT}/health`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('ok');
    } finally {
      stop();
    }
  });

  test('returns 200 when healthCheck resolves', async () => {
    const deps = baseDeps({ healthCheck: mock(() => Promise.resolve()) });
    const { stop } = startWebServer(deps);
    try {
      const res = await fetch(`http://localhost:${deps.config.OAUTH_SERVER_PORT}/health`);
      expect(res.status).toBe(200);
    } finally {
      stop();
    }
  });

  test('returns 503 when healthCheck rejects', async () => {
    const deps = baseDeps({ healthCheck: mock(() => Promise.reject(new Error('redis down'))) });
    const { stop } = startWebServer(deps);
    try {
      const res = await fetch(`http://localhost:${deps.config.OAUTH_SERVER_PORT}/health`);
      expect(res.status).toBe(503);
      expect(await res.text()).toBe('error');
    } finally {
      stop();
    }
  });

  test('returns 503 when botStarted is false', async () => {
    const deps = baseDeps({ botStarted: false });
    const { stop } = startWebServer(deps);
    try {
      const res = await fetch(`http://localhost:${deps.config.OAUTH_SERVER_PORT}/health`);
      expect(res.status).toBe(503);
      expect(await res.text()).toBe('bot not started');
    } finally {
      stop();
    }
  });

  test('returns 200 when botStarted is true', async () => {
    const deps = baseDeps({ botStarted: true });
    const { stop } = startWebServer(deps);
    try {
      const res = await fetch(`http://localhost:${deps.config.OAUTH_SERVER_PORT}/health`);
      expect(res.status).toBe(200);
    } finally {
      stop();
    }
  });

  test('returns 200 when botStarted is undefined (legacy — no bot-started tracking)', async () => {
    const deps = baseDeps();
    const { stop } = startWebServer(deps);
    try {
      const res = await fetch(`http://localhost:${deps.config.OAUTH_SERVER_PORT}/health`);
      expect(res.status).toBe(200);
    } finally {
      stop();
    }
  });

  test('health check is re-evaluated on each request', async () => {
    let fail = true;
    const deps = baseDeps({
      healthCheck: mock(() => (fail ? Promise.reject(new Error('down')) : Promise.resolve())),
    });
    const { stop } = startWebServer(deps);
    try {
      const r1 = await fetch(`http://localhost:${deps.config.OAUTH_SERVER_PORT}/health`);
      expect(r1.status).toBe(503);
      fail = false;
      const r2 = await fetch(`http://localhost:${deps.config.OAUTH_SERVER_PORT}/health`);
      expect(r2.status).toBe(200);
    } finally {
      stop();
    }
  });
});

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
      calendarRepo: {
        findChannelByIds: mock(() => ({ id: 1, channel_token: null })),
      } as unknown as WebServerDeps['calendarRepo'],
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

  test('returns 403 when channel token does not match', async () => {
    const deps = baseDeps({
      calendarRepo: {
        findChannelByIds: mock(() => ({ id: 1, channel_token: 'secret-token' })),
      } as unknown as WebServerDeps['calendarRepo'],
    });
    const { stop } = startWebServer(deps);
    try {
      const res = await fetch(`http://localhost:${deps.config.OAUTH_SERVER_PORT}/webhooks/google-calendar`, {
        method: 'POST',
        headers: {
          'x-goog-channel-id': 'ch-1',
          'x-goog-resource-id': 'r-1',
          'x-goog-resource-state': 'exists',
          'x-goog-channel-token': 'wrong-token',
        },
      });
      expect(res.status).toBe(403);
    } finally {
      stop();
    }
  });

  test('returns 200 when channel token matches', async () => {
    const onWebhook = mock(() => Promise.resolve());
    const deps = baseDeps({
      calendarRepo: {
        findChannelByIds: mock(() => ({ id: 1, channel_token: 'secret-token' })),
      } as unknown as WebServerDeps['calendarRepo'],
      onWebhook,
    });
    const { stop } = startWebServer(deps);
    try {
      const res = await fetch(`http://localhost:${deps.config.OAUTH_SERVER_PORT}/webhooks/google-calendar`, {
        method: 'POST',
        headers: {
          'x-goog-channel-id': 'ch-1',
          'x-goog-resource-id': 'r-1',
          'x-goog-resource-state': 'exists',
          'x-goog-channel-token': 'secret-token',
        },
      });
      expect(res.status).toBe(200);
      await Bun.sleep(10);
      expect(onWebhook).toHaveBeenCalledTimes(1);
    } finally {
      stop();
    }
  });

  test('returns 403 when channel has token but request sends none', async () => {
    const deps = baseDeps({
      calendarRepo: {
        findChannelByIds: mock(() => ({ id: 1, channel_token: 'secret-token' })),
      } as unknown as WebServerDeps['calendarRepo'],
    });
    const { stop } = startWebServer(deps);
    try {
      const res = await fetch(`http://localhost:${deps.config.OAUTH_SERVER_PORT}/webhooks/google-calendar`, {
        method: 'POST',
        headers: { 'x-goog-channel-id': 'ch-1', 'x-goog-resource-id': 'r-1', 'x-goog-resource-state': 'exists' },
      });
      expect(res.status).toBe(403);
    } finally {
      stop();
    }
  });
});
