// src/web/server.ts

import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
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
  // Required, unlike most of this interface: /ready exists to be strictly
  // stronger than /health, and a caller that forgets to wire these would
  // silently reproduce the blind spot the endpoint was added to close. The
  // compiler is a better guard than a runtime warning.
  /**
   * True while the whole AI provider chain is failing. Read by /ready, never by
   * /health: a live process that cannot answer anyone is a real failure, but it
   * is not one a restart fixes, and container orchestrators restart on a failing
   * liveness probe. Putting it on /health would turn a provider outage into a
   * restart loop during the very incident this is meant to surface.
   */
  aiChainDown: () => boolean;
  /**
   * True once some provider has answered in this process. A restarted process
   * has an empty outage record, which is not proof that the chain works, so
   * readiness says "ok (unverified)" until a provider has actually answered and
   * the watchdog knows not to call that a recovery.
   */
  aiChainVerified: () => boolean;
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
    this.hits.set(ip, timestamps);
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

/**
 * The exact strings /ready answers with. scripts/healthcheck-alert.sh matches
 * them character for character to decide whether a recovery is real, so they
 * are a contract across two languages: exported here so the tests on both sides
 * assert against one definition instead of two hand-copied ones.
 */
export const READINESS_BODY = {
  /** A provider has answered in this process — the bot demonstrably works. */
  ready: 'ok',
  /** Alive, but has served nobody since it started, so it can vouch for nothing. */
  unverified: 'ok (unverified)',
  /** Every provider on the serving chain is failing. */
  chainDown: 'ai chain down',
} as const;

/**
 * The checks both /health and /ready share: the process finished starting and
 * its own datastore answers. Returns the failing response, or undefined when
 * the process is live.
 */
async function livenessFailure(deps: WebServerDeps): Promise<Response | undefined> {
  if (deps.botStarted === false) {
    return new Response('bot not started', { status: 503 });
  }
  if (!deps.healthCheck) return undefined;
  try {
    await deps.healthCheck();
    return undefined;
  } catch (err) {
    webLogger.warn({ err }, 'Health check failed');
    return new Response('error', { status: 503 });
  }
}

async function handleRequest(
  req: Request,
  url: URL,
  server: { requestIP(req: Request): { address: string } | null },
  deps: WebServerDeps,
  oauthRateLimiter: IpRateLimiter,
): Promise<Response> {
  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/ready')) {
    const notLive = await livenessFailure(deps);
    if (notLive) return notLive;
    if (url.pathname === '/health') return new Response(READINESS_BODY.ready);
    // A running process with a dead provider chain answers nobody. Reporting it
    // healthy is what let the 2026-09-01 outage run for hours unnoticed: the
    // two-minute cron watchdog saw "ok" the whole time. This lives on /ready
    // rather than /health because a restart cannot fix an outage at the
    // provider — see the comment on aiChainDown in WebServerDeps.
    if (deps.aiChainDown()) {
      webLogger.error('AI provider chain is down — reporting not ready');
      return new Response(READINESS_BODY.chainDown, { status: 503 });
    }
    if (!deps.aiChainVerified()) return new Response(READINESS_BODY.unverified);
    return new Response(READINESS_BODY.ready);
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

export function startWebServer(deps: WebServerDeps): { port: number; stop: () => void } {
  const port = deps.config.OAUTH_SERVER_PORT ?? 3311;
  const oauthRateLimiter = new IpRateLimiter();

  function errorResponse(err: unknown): Response {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    if (!isAbort) {
      webLogger.error({ err }, 'Unexpected error in fetch handler');
    }
    return new Response(isAbort ? 'Client disconnected' : 'Internal Server Error', {
      status: isAbort ? 499 : 500,
    });
  }

  async function handleFetch(this: Bun.Server<undefined>, req: Request, server: Bun.Server<undefined>) {
    try {
      const url = new URL(req.url);
      const res = await handleRequest(req, url, server, deps, oauthRateLimiter);
      return withSecurityHeaders(res);
    } catch (err) {
      return errorResponse(err);
    }
  }

  const server = Bun.serve({ port, fetch: handleFetch });
  const cleanupTimer = setInterval(() => oauthRateLimiter.cleanup(), OAUTH_RATE_LIMIT.windowMs);

  webLogger.info({ port }, 'Web server started');

  return {
    port: server.port ?? port,
    stop: () => {
      clearInterval(cleanupTimer);
      server.stop();
      webLogger.info('Web server stopped');
    },
  };
}
