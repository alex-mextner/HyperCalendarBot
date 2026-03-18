import { expect, mock, test } from 'bun:test';
import { handleConnectGoogle } from '../../../src/bot/commands/connect-google.ts';

test('handleConnectGoogle in group sends private-chat-only message in Russian', async () => {
  let sentText = '';
  const ctx = {
    chat: { type: 'group', id: -100 },
    dbUser: { telegram_id: 1, language: 'ru', timezone: 'UTC' },
    send: mock((text: string) => {
      sentText = text;
      return Promise.resolve();
    }),
  };
  await handleConnectGoogle(ctx as never, {} as never);
  expect(sentText).toContain('личном чате');
});

test('handleConnectGoogle in supergroup sends private-chat-only message in English', async () => {
  let sentText = '';
  const ctx = {
    chat: { type: 'supergroup', id: -100 },
    dbUser: { telegram_id: 1, language: 'en', timezone: 'UTC' },
    send: mock((text: string) => {
      sentText = text;
      return Promise.resolve();
    }),
  };
  await handleConnectGoogle(ctx as never, {} as never);
  expect(sentText).toContain('private chat');
});

test('handleConnectGoogle in private chat does not send group-guard message', async () => {
  const sent: string[] = [];
  const ctx = {
    chat: { type: 'private', id: 1 },
    dbUser: { telegram_id: 1, language: 'ru', timezone: 'UTC' },
    send: mock((text: string) => {
      sent.push(text);
      return Promise.resolve();
    }),
  };
  try {
    await handleConnectGoogle(ctx as never, {} as never);
  } catch {
    /* ignore missing deps */
  }
  expect(sent.every((t) => !t.includes('личном чате'))).toBe(true);
});
