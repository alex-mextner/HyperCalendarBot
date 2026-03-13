// src/web/server.ts
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

interface WebServerDeps {
  config: EnvConfig;
  oauthService: GoogleOAuthService;
  userRepo: UserRepository;
  syncRepo: GoogleSyncRepository;
  calendarRepo: GoogleCalendarRepository;
  stateLookup: OAuthStateLookup;
  onConnected?: (userId: number) => Promise<void>;
  onWebhook?: (channelId: string, resourceId: string) => Promise<void>;
}

export function startWebServer(deps: WebServerDeps): { stop: () => void } {
  const port = deps.config.OAUTH_SERVER_PORT ?? 3311;

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      if (req.method === 'GET' && url.pathname === '/health') {
        return new Response('ok');
      }

      if (req.method === 'GET' && url.pathname === '/oauth/google/callback') {
        return handleOAuthCallback(req, deps);
      }

      if (req.method === 'POST' && url.pathname === '/webhooks/google-calendar') {
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
            webLogger.error({ error: String(err), channelId }, 'Webhook processing error');
          });
        }

        return new Response('OK', { status: 200 });
      }

      return new Response('Not Found', { status: 404 });
    },
  });

  webLogger.info({ port }, 'Web server started');

  return {
    stop: () => {
      server.stop();
      webLogger.info('Web server stopped');
    },
  };
}
