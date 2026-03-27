// src/web/server.ts

import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { AgentDispatcher } from '../agent/dispatcher.ts';
import type { AgentRegistry } from '../agent/registry.ts';
import { createAgentWsHandler, upgradeAgentWs } from '../agent/ws-server.ts';
import type { EnvConfig } from '../config/env.ts';
import type { AlertRepository } from '../database/repositories/alert.repository.ts';
import type { GoogleCalendarRepository } from '../database/repositories/google-calendar.repository.ts';
import type { GoogleSyncRepository } from '../database/repositories/google-sync.repository.ts';
import type { UserRepository } from '../database/repositories/user.repository.ts';
import type { GoogleOAuthService } from '../services/google/oauth.ts';
import { webLogger } from '../utils/logger.ts';
import { handleOAuthCallback } from './oauth-callback.ts';

interface OAuthStateLookup {
  get(stateId: string): Promise<string | null>;
  del(stateId: string): Promise<void>;
}

export interface WebServerDeps {
  config: EnvConfig;
  userRepo: UserRepository;
  agentRegistry?: AgentRegistry;
  agentDispatcher?: AgentDispatcher;
  // Google Calendar — only populated when GOOGLE_CLIENT_ID is configured
  oauthService?: GoogleOAuthService;
  syncRepo?: GoogleSyncRepository;
  calendarRepo?: GoogleCalendarRepository;
  stateLookup?: OAuthStateLookup;
  onConnected?: (userId: number) => Promise<void>;
  onWebhook?: (channelId: string, resourceId: string) => Promise<void>;
  // Telegram bot webhook — set when PUBLIC_DOMAIN is configured
  telegramWebhookHandler?: (req: Request) => Response | Promise<Response>;
  // Optional deep health check — throws if a critical dependency is unreachable
  healthCheck?: () => Promise<void>;
  // Set to false during init, true once bot.onStart fires — health endpoint returns 503 until ready
  botStarted?: boolean;
  // Admin alert queue — POST /admin/alerts to push, GET /admin/alerts/next to pop
  alertRepo?: AlertRepository;
  adminAlertToken?: string;
}

const OAUTH_RATE_LIMIT = { windowMs: 60_000, maxRequests: 10 } as const;

class IpRateLimiter {
  private readonly hits = new Map<string, number[]>();

  isAllowed(ip: string): boolean {
    const now = Date.now();
    const windowStart = now - OAUTH_RATE_LIMIT.windowMs;
    const timestamps = (this.hits.get(ip) ?? []).filter((t) => t > windowStart);
    timestamps.push(now);
    if (timestamps.length > 0) {
      this.hits.set(ip, timestamps);
    } else {
      this.hits.delete(ip);
    }
    return timestamps.length <= OAUTH_RATE_LIMIT.maxRequests;
  }

  /** Remove IPs with no activity in the last window. Call periodically to bound memory. */
  cleanup(): void {
    const windowStart = Date.now() - OAUTH_RATE_LIMIT.windowMs;
    for (const [ip, timestamps] of this.hits) {
      if (timestamps.every((t) => t <= windowStart)) {
        this.hits.delete(ip);
      }
    }
  }
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
} as const;

function isValidAlertToken(received: string | null, expected: string): boolean {
  if (!received) return false;
  const a = Buffer.from(received);
  const b = Buffer.from(`Bearer ${expected}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

function withSecurityHeaders(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

async function handleRequest(
  req: Request,
  url: URL,
  server: {
    upgrade(req: Request, opts: { data: object }): boolean;
    requestIP(req: Request): { address: string } | null;
  },
  deps: WebServerDeps,
  agentWs: ReturnType<typeof createAgentWsHandler> | undefined,
  oauthRateLimiter: IpRateLimiter,
): Promise<Response | undefined> {
  if (url.pathname === '/ws/agent' && agentWs) {
    if (!upgradeAgentWs(req, server)) {
      return new Response('WebSocket upgrade failed', { status: 400 });
    }
    return undefined;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    if (deps.botStarted === false) {
      return new Response('bot not started', { status: 503 });
    }
    if (deps.healthCheck) {
      try {
        await deps.healthCheck();
      } catch (err) {
        webLogger.warn({ err }, 'Health check failed');
        return new Response('error', { status: 503 });
      }
    }
    return new Response('ok');
  }

  if (req.method === 'GET' && url.pathname === '/oauth/google/callback') {
    const clientIp = server.requestIP(req)?.address ?? 'unknown';
    if (!oauthRateLimiter.isAllowed(clientIp)) {
      webLogger.warn({ clientIp }, 'OAuth callback rate limit exceeded');
      return new Response('Too Many Requests', { status: 429 });
    }
    if (!deps.oauthService || !deps.syncRepo || !deps.calendarRepo || !deps.stateLookup) {
      return new Response('Not Found', { status: 404 });
    }
    return handleOAuthCallback(req, {
      config: deps.config,
      oauthService: deps.oauthService,
      userRepo: deps.userRepo,
      syncRepo: deps.syncRepo,
      calendarRepo: deps.calendarRepo,
      stateLookup: deps.stateLookup,
      onConnected: deps.onConnected,
    });
  }

  if (req.method === 'POST' && url.pathname === '/webhook/telegram') {
    if (!deps.telegramWebhookHandler) {
      return new Response('Not Found', { status: 404 });
    }
    return deps.telegramWebhookHandler(req);
  }

  if (req.method === 'POST' && url.pathname === '/webhooks/google-calendar') {
    if (!deps.calendarRepo) {
      return new Response('Not Found', { status: 404 });
    }

    const channelId = req.headers.get('x-goog-channel-id');
    const resourceId = req.headers.get('x-goog-resource-id');
    const resourceState = req.headers.get('x-goog-resource-state');

    if (!channelId || !resourceId) {
      return new Response('Missing headers', { status: 400 });
    }

    const channel = deps.calendarRepo.findChannelByIds(channelId, resourceId);
    if (!channel) {
      webLogger.warn({ channelId, resourceId }, 'Unknown webhook channel');
      return new Response('Unknown channel', { status: 404 });
    }

    const channelToken = req.headers.get('x-goog-channel-token');
    if (channel.channel_token && channelToken !== channel.channel_token) {
      webLogger.warn({ channelId, channelToken }, 'Webhook token mismatch');
      return new Response('Forbidden', { status: 403 });
    }

    if ((resourceState === 'exists' || resourceState === 'sync') && deps.onWebhook) {
      deps.onWebhook(channelId, resourceId).catch((err) => {
        webLogger.error({ err: err, channelId }, 'Webhook processing error');
      });
    }

    return new Response('OK', { status: 200 });
  }

  if (url.pathname === '/admin/alerts') {
    if (!deps.alertRepo || !deps.adminAlertToken) return new Response('Not Found', { status: 404 });
    if (!isValidAlertToken(req.headers.get('Authorization'), deps.adminAlertToken)) {
      return new Response('Unauthorized', { status: 401 });
    }

    if (req.method === 'POST') {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        // invalid JSON from external caller — expected input error
        return new Response('Bad Request', { status: 400 });
      }
      const parsed = z
        .object({ text: z.string().min(1).max(65535), source: z.string().min(1).max(64).default('bot') })
        .safeParse(body);
      if (!parsed.success) {
        return new Response('Bad Request', { status: 400 });
      }
      deps.alertRepo.push(parsed.data.text, parsed.data.source);
      return new Response('OK', { status: 200 });
    }

    return new Response('Method Not Allowed', { status: 405 });
  }

  if (req.method === 'GET' && url.pathname === '/admin/alerts/next') {
    if (!deps.alertRepo || !deps.adminAlertToken) return new Response('Not Found', { status: 404 });
    if (!isValidAlertToken(req.headers.get('Authorization'), deps.adminAlertToken)) {
      return new Response('Unauthorized', { status: 401 });
    }

    const alert = deps.alertRepo.pop();
    if (!alert) {
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify(alert), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response('Not Found', { status: 404 });
}

export function startWebServer(deps: WebServerDeps): { stop: () => void } {
  const port = deps.config.OAUTH_SERVER_PORT ?? 3311;
  const oauthRateLimiter = new IpRateLimiter();

  const agentWs =
    deps.agentRegistry && deps.agentDispatcher
      ? createAgentWsHandler(deps.agentRegistry, deps.agentDispatcher)
      : undefined;

  const serveOptions = {
    port,
    ...(agentWs ? { websocket: { ...agentWs, idleTimeout: 30 } } : {}),
    async fetch(
      req: Request,
      server: {
        upgrade(req: Request, opts: { data: object }): boolean;
        requestIP(req: Request): { address: string } | null;
      },
    ) {
      const url = new URL(req.url);
      const res = await handleRequest(req, url, server, deps, agentWs, oauthRateLimiter);
      if (!res) return res;
      return withSecurityHeaders(res);
    },
  };

  // Bun.serve requires a discriminated union: either websocket is present or absent.
  // We conditionally include it via spread, so cast at the framework boundary.
  const server = Bun.serve(serveOptions as unknown as Parameters<typeof Bun.serve>[0]);
  const cleanupTimer = setInterval(() => oauthRateLimiter.cleanup(), OAUTH_RATE_LIMIT.windowMs);

  webLogger.info({ port }, 'Web server started');

  return {
    stop: () => {
      clearInterval(cleanupTimer);
      server.stop();
      webLogger.info('Web server stopped');
    },
  };
}
