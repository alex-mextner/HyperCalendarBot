// test/config/public-url.test.ts
// The bot's public URLs after the ingress moved from hypercal.invntrm.ru to hypercal.mextner.com (#828).
import { describe, expect, test } from 'bun:test';
import {
  GOOGLE_CALENDAR_WEBHOOK_PATH,
  GOOGLE_OAUTH_CALLBACK_PATH,
  publicUrl,
  TELEGRAM_WEBHOOK_PATH,
} from '../../src/config/public-url.ts';

const HOST = 'hypercal.mextner.com';

describe('publicUrl', () => {
  test('Telegram webhook address uses the configured host over https', () => {
    expect(publicUrl(HOST, TELEGRAM_WEBHOOK_PATH)).toBe('https://hypercal.mextner.com/webhook/telegram');
  });

  test('Google OAuth redirect address uses the configured host over https', () => {
    expect(publicUrl(HOST, GOOGLE_OAUTH_CALLBACK_PATH)).toBe('https://hypercal.mextner.com/oauth/google/callback');
  });

  test('Google Calendar push address uses the configured host over https', () => {
    expect(publicUrl(HOST, GOOGLE_CALENDAR_WEBHOOK_PATH)).toBe('https://hypercal.mextner.com/webhooks/google-calendar');
  });
});
