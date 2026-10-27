import { describe, expect, test } from 'bun:test';
import { Bot } from 'gramio';
import {
  type LaunchableBot,
  launchBot,
  realLaunchCollaborators,
  type WebhookStartOptions,
} from '../../src/bootstrap/launch.ts';

function fakeBot() {
  const starts: Array<WebhookStartOptions | undefined> = [];
  const bot: LaunchableBot = {
    start: (options) => {
      starts.push(options);
    },
  };
  return { bot, starts };
}

describe('launchBot', () => {
  test('without PUBLIC_DOMAIN it long-polls and registers no webhook handler', async () => {
    const { bot, starts } = fakeBot();
    const webServerDeps: { telegramWebhookHandler?: (req: Request) => Response } = {};

    await launchBot({ PUBLIC_DOMAIN: undefined }, webServerDeps, bot);

    expect(starts).toEqual([undefined]);
    expect(webServerDeps.telegramWebhookHandler).toBeUndefined();
  });

  test('with PUBLIC_DOMAIN the handler is registered before the bot starts, with a per-process secret', async () => {
    const { bot, starts } = fakeBot();
    const webServerDeps: { telegramWebhookHandler?: (req: Request) => Response } = {};
    const handler = (_req: Request) => new Response('ok');
    const seenSecrets: string[] = [];
    let handlerWasRegisteredAtStart = false;
    const originalStart = bot.start;
    bot.start = (options) => {
      handlerWasRegisteredAtStart = webServerDeps.telegramWebhookHandler === handler;
      return originalStart(options);
    };

    await launchBot({ PUBLIC_DOMAIN: 'bot.example.com' }, webServerDeps, bot, {
      randomSecret: () => 'secret-1',
      createWebhookHandler: (_bot, secret) => {
        seenSecrets.push(secret);
        return handler;
      },
    });

    expect(seenSecrets).toEqual(['secret-1']);
    expect(handlerWasRegisteredAtStart).toBe(true);
    expect(starts).toHaveLength(1);
    expect(starts[0]?.webhook.secret_token).toBe('secret-1');
    expect(starts[0]?.webhook.url).toStartWith('https://bot.example.com');
  });
});

describe('realLaunchCollaborators', () => {
  test('builds a webhook handler for a GramIO bot', async () => {
    const { createWebhookHandler } = await realLaunchCollaborators<Bot>();

    expect(createWebhookHandler(new Bot('123:test'), 'secret')).toBeInstanceOf(Function);
  });

  test('refuses a launchable that is not a GramIO bot instead of handing it to the webhook adapter', async () => {
    const { createWebhookHandler } = await realLaunchCollaborators<LaunchableBot>();

    expect(() => createWebhookHandler(fakeBot().bot, 'secret')).toThrow('The webhook adapter needs a GramIO Bot');
  });
});
