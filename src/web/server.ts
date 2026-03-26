// src/web/server.ts

import type { AgentDispatcher } from '../agent/dispatcher.ts';
import type { AgentRegistry } from '../agent/registry.ts';
import { createAgentWsHandler, upgradeAgentWs } from '../agent/ws-server.ts';
import type { EnvConfig } from '../config/env.ts';
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
}

export function startWebServer(deps: WebServerDeps): { stop: () => void } {
  const port = deps.config.OAUTH_SERVER_PORT ?? 3311;

  const agentWs =
    deps.agentRegistry && deps.agentDispatcher
      ? createAgentWsHandler(deps.agentRegistry, deps.agentDispatcher)
      : undefined;

  const serveOptions = {
    port,
    ...(agentWs ? { websocket: agentWs } : {}),
    async fetch(req: Request, server: { upgrade(req: Request, opts: { data: unknown }): boolean }) {
      const url = new URL(req.url);

      if (url.pathname === '/ws/agent' && agentWs) {
        if (!upgradeAgentWs(req, server)) {
          return new Response('WebSocket upgrade failed', { status: 400 });
        }
        return;
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

        if ((resourceState === 'exists' || resourceState === 'sync') && deps.onWebhook) {
          deps.onWebhook(channelId, resourceId).catch((err) => {
            webLogger.error({ err: err, channelId }, 'Webhook processing error');
          });
        }

        return new Response('OK', { status: 200 });
      }

      return new Response('Not Found', { status: 404 });
    },
  };

  // Bun.serve requires a discriminated union: either websocket is present or absent.
  // We conditionally include it via spread, so cast at the framework boundary.
  const server = Bun.serve(serveOptions as Parameters<typeof Bun.serve>[0]);

  webLogger.info({ port }, 'Web server started');

  return {
    stop: () => {
      server.stop();
      webLogger.info('Web server stopped');
    },
  };
}
