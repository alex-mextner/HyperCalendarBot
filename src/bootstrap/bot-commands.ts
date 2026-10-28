// src/bootstrap/bot-commands.ts
//
// The Telegram command menu (English default + Russian) and the bot's onStart hook that publishes it.
//
// Ordering invariants:
//  - The menu is built from the final configuration, after createBot(): the Google and Telegram
//    connect commands appear only when GOOGLE_CLIENT_ID / TELEGRAM_SESSION_MASTER_KEY are set.
//  - The hook flips `webServerDeps.botStarted` FIRST (so /ready reports the bot as started even if
//    setMyCommands fails), then sets the default menu, then the Russian menu, then logs.

import type { EnvConfig } from '../config/env.ts';
import { botLogger } from '../utils/logger.ts';

export interface BotCommand {
  command: string;
  description: string;
}

export interface BotCommandMenu {
  en: BotCommand[];
  ru: BotCommand[];
}

export type MenuConfig = Pick<EnvConfig, 'GOOGLE_CLIENT_ID' | 'TELEGRAM_SESSION_MASTER_KEY'>;

const BASE_COMMANDS: BotCommandMenu = {
  en: [
    { command: 'today', description: "Today's events" },
    { command: 'tomorrow', description: "Tomorrow's events" },
    { command: 'week', description: '7-day overview' },
    { command: 'month', description: 'Monthly calendar' },
    { command: 'add', description: 'Create event' },
    { command: 'edit', description: 'Edit event' },
    { command: 'delete', description: 'Delete event' },
    { command: 'search', description: 'Search events' },
    { command: 'free', description: 'Find free slots' },
    { command: 'settings', description: 'Settings' },
    { command: 'import', description: 'Import .ics' },
    { command: 'holidays', description: 'Holidays calendar' },
    { command: 'share', description: 'Share agenda or event' },
    { command: 'invite', description: 'Invite user to event' },
    { command: 'invitations', description: 'View invitations' },
    { command: 'help', description: 'Help' },
  ],
  ru: [
    { command: 'today', description: 'События сегодня' },
    { command: 'tomorrow', description: 'События завтра' },
    { command: 'week', description: 'Обзор на 7 дней' },
    { command: 'month', description: 'Месячный календарь' },
    { command: 'add', description: 'Создать событие' },
    { command: 'edit', description: 'Редактировать событие' },
    { command: 'delete', description: 'Удалить событие' },
    { command: 'search', description: 'Поиск событий' },
    { command: 'free', description: 'Свободные слоты' },
    { command: 'settings', description: 'Настройки' },
    { command: 'import', description: 'Импорт .ics' },
    { command: 'holidays', description: 'Календарь праздников' },
    { command: 'share', description: 'Поделиться повесткой/событием' },
    { command: 'invite', description: 'Пригласить на событие' },
    { command: 'invitations', description: 'Просмотр приглашений' },
    { command: 'help', description: 'Справка' },
  ],
};

const GOOGLE_COMMANDS: BotCommandMenu = {
  en: [
    { command: 'connect_google', description: 'Connect Google Calendar' },
    { command: 'disconnect_google', description: 'Disconnect Google Calendar' },
    { command: 'google_status', description: 'Google Calendar sync status' },
  ],
  ru: [
    { command: 'connect_google', description: 'Подключить Google Calendar' },
    { command: 'disconnect_google', description: 'Отключить Google Calendar' },
    { command: 'google_status', description: 'Статус синхронизации Google Calendar' },
  ],
};

const TELEGRAM_CONNECT_COMMANDS: BotCommandMenu = {
  en: [
    { command: 'connect_telegram', description: 'Connect Telegram account for first-person invitations' },
    { command: 'disconnect_telegram', description: 'Disconnect Telegram account' },
  ],
  ru: [
    { command: 'connect_telegram', description: 'Подключить Telegram-аккаунт для приглашений от твоего имени' },
    { command: 'disconnect_telegram', description: 'Отключить подключенный Telegram-аккаунт' },
  ],
};

/** Base commands, then the Google group, then the Telegram-connect group, per language. */
export function buildBotCommands(config: MenuConfig): BotCommandMenu {
  const groups = [BASE_COMMANDS];
  if (config.GOOGLE_CLIENT_ID) groups.push(GOOGLE_COMMANDS);
  if (config.TELEGRAM_SESSION_MASTER_KEY) groups.push(TELEGRAM_CONNECT_COMMANDS);
  return {
    en: groups.flatMap((group) => group.en),
    ru: groups.flatMap((group) => group.ru),
  };
}

export interface MenuApi {
  setMyCommands(params: { commands: BotCommand[]; language_code?: string }): Promise<unknown>;
}

export function createOnStartHandler(
  menu: BotCommandMenu,
  api: MenuApi,
  webServerDeps: { botStarted?: boolean },
): (context: { info: { username?: string } }) => Promise<void> {
  return async ({ info }) => {
    webServerDeps.botStarted = true;
    await api.setMyCommands({ commands: menu.en });
    await api.setMyCommands({
      commands: menu.ru,
      language_code: 'ru',
    });
    botLogger.info({ username: info.username }, 'Bot started');
  };
}
