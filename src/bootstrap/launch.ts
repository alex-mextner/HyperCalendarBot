// src/bootstrap/launch.ts
//
// The last startup step: start receiving Telegram updates, by webhook when PUBLIC_DOMAIN is set,
// by long polling otherwise.
//
// Ordering invariants:
//  - It runs LAST, after every queue, handler and shutdown hook exists: updates may arrive the
//    moment the bot starts.
//  - Webhook mode creates a fresh random secret per process and registers the web server's handler
//    on `webServerDeps` BEFORE bot.start() tells Telegram the URL, so the first delivery is served.
//  - Pending updates are kept, not dropped: a message sent while the bot restarted is answered now,
//    and createStaleUpdateGuard skips ones that waited too long.

import type { EnvConfig } from '../config/env.ts';
import { publicUrl, TELEGRAM_WEBHOOK_PATH } from '../config/public-url.ts';
import { botLogger } from '../utils/logger.ts';
import type { WebServerDeps } from '../web/server.ts';

export interface WebhookStartOptions {
  webhook: { url: string; secret_token: string };
}

export interface LaunchableBot {
  start(options?: WebhookStartOptions): unknown;
}

export interface LaunchCollaborators<TBot extends LaunchableBot> {
  createWebhookHandler: (bot: TBot, secretToken: string) => (req: Request) => Response;
  randomSecret: () => string;
}

/** gramio is imported lazily, as before: long-polling deployments never load the webhook adapter. */
export async function realLaunchCollaborators<TBot extends LaunchableBot>(): Promise<LaunchCollaborators<TBot>> {
  const { Bot, webhookHandler } = await import('gramio');
  return {
    createWebhookHandler: (bot, secretToken) => {
      if (!(bot instanceof Bot)) throw new TypeError('The webhook adapter needs a GramIO Bot');
      return webhookHandler(bot, 'Bun.serve', { secretToken }) as (req: Request) => Response;
    },
    randomSecret: () => crypto.randomUUID(),
  };
}

export async function launchBot<TBot extends LaunchableBot>(
  config: Pick<EnvConfig, 'PUBLIC_DOMAIN'>,
  webServerDeps: Pick<WebServerDeps, 'telegramWebhookHandler'>,
  bot: TBot,
  collaborators?: LaunchCollaborators<TBot>,
): Promise<void> {
  if (!config.PUBLIC_DOMAIN) {
    bot.start();
    return;
  }
  const { createWebhookHandler, randomSecret } = collaborators ?? (await realLaunchCollaborators<TBot>());
  const webhookSecret = randomSecret();
  const webhookUrl = publicUrl(config.PUBLIC_DOMAIN, TELEGRAM_WEBHOOK_PATH);

  webServerDeps.telegramWebhookHandler = createWebhookHandler(bot, webhookSecret);

  bot.start({
    webhook: {
      url: webhookUrl,
      secret_token: webhookSecret,
    },
  });
  botLogger.info({ webhookUrl }, 'Bot started (webhook mode)');
}
