// src/config/public-url.ts

/**
 * The bot's own URLs on its public host (`PUBLIC_DOMAIN`): the Telegram webhook, the Google
 * OAuth redirect and the Google Calendar push address. One place builds them and the web
 * server routes on the same path constants, so the address registered with Telegram/Google
 * cannot drift from the route that answers it when the host changes (ingress moved from
 * hypercal.invntrm.ru to hypercal.mextner.com, #828).
 */

export const TELEGRAM_WEBHOOK_PATH = '/webhook/telegram';
export const GOOGLE_CALENDAR_WEBHOOK_PATH = '/webhooks/google-calendar';
export const GOOGLE_OAUTH_CALLBACK_PATH = '/oauth/google/callback';

/** `domain` is a bare host (`hypercal.mextner.com`), never a URL: the scheme is always https. */
export function publicUrl(domain: string, path: string): string {
  return `https://${domain}${path}`;
}
