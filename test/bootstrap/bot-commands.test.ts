import { describe, expect, test } from 'bun:test';
import { buildBotCommands, createOnStartHandler } from '../../src/bootstrap/bot-commands.ts';

const NO_FEATURES = { GOOGLE_CLIENT_ID: undefined, TELEGRAM_SESSION_MASTER_KEY: undefined };

describe('buildBotCommands', () => {
  test('the base menu has the same commands in both languages', () => {
    const menu = buildBotCommands(NO_FEATURES);
    expect(menu.en.map((c) => c.command)).toEqual(menu.ru.map((c) => c.command));
    expect(menu.en.map((c) => c.command)).toEqual([
      'today',
      'tomorrow',
      'week',
      'month',
      'add',
      'edit',
      'delete',
      'search',
      'free',
      'settings',
      'import',
      'holidays',
      'share',
      'invite',
      'invitations',
      'help',
    ]);
  });

  test('Google commands are appended with GOOGLE_CLIENT_ID', () => {
    const menu = buildBotCommands({ ...NO_FEATURES, GOOGLE_CLIENT_ID: 'id' });
    const google = ['connect_google', 'disconnect_google', 'google_status'];
    expect(menu.en.slice(-3).map((c) => c.command)).toEqual(google);
    expect(menu.ru.slice(-3).map((c) => c.command)).toEqual(google);
    expect(menu.ru.at(-1)?.description).toBe('Статус синхронизации Google Calendar');
  });

  test('Telegram connect commands follow the Google group when both are enabled', () => {
    const menu = buildBotCommands({ GOOGLE_CLIENT_ID: 'id', TELEGRAM_SESSION_MASTER_KEY: 'ab' });
    expect(menu.en.slice(-5).map((c) => c.command)).toEqual([
      'connect_google',
      'disconnect_google',
      'google_status',
      'connect_telegram',
      'disconnect_telegram',
    ]);
  });

  test('each call returns independent arrays', () => {
    const first = buildBotCommands(NO_FEATURES);
    first.en.push({ command: 'x', description: 'x' });
    expect(buildBotCommands(NO_FEATURES).en.some((c) => c.command === 'x')).toBe(false);
  });
});

describe('createOnStartHandler', () => {
  test('flags the bot started, then publishes the default and Russian menus', async () => {
    const events: string[] = [];
    const deps = { botStarted: false };
    const handler = createOnStartHandler(
      buildBotCommands(NO_FEATURES),
      {
        setMyCommands: async (params) => {
          events.push(`${params.language_code ?? 'default'}:${deps.botStarted}`);
        },
      },
      deps,
    );

    await handler({ info: { username: 'cal_bot' } });

    expect(deps.botStarted).toBe(true);
    expect(events).toEqual(['default:true', 'ru:true']);
  });

  test('botStarted is set even when publishing the menu fails', async () => {
    const deps = { botStarted: false };
    const handler = createOnStartHandler(
      { en: [], ru: [] },
      {
        setMyCommands: async () => {
          throw new Error('telegram down');
        },
      },
      deps,
    );
    await expect(handler({ info: {} })).rejects.toThrow('telegram down');
    expect(deps.botStarted).toBe(true);
  });
});
