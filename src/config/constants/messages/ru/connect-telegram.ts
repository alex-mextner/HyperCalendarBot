// src/config/constants/messages/ru/connect-telegram.ts
// Telegram-account connection flow (invitation delivery setup) messages.

import { ruPlural } from '../../../../services/event/formatters.ts';

export const ruConnectTelegram = {
  connectTelegram: {
    consent: [
      '🔐 Подключение Telegram-аккаунта',
      '',
      'Это позволит боту отправлять приглашения на встречи от твоего имени',
      'людям, которые ещё не пользуются ботом.',
      '',
      '🔒 Безопасность:',
      '• Данные сессии зашифрованы AES-256-GCM',
      '• Ключ шифрования живёт только в памяти процесса бота — на диске рядом с данными его нет',
      '• Бот хранит только техническую сессию — без паролей и сообщений',
      '',
      'Бот НЕ будет:',
      '• Читать твои сообщения',
      '• Отправлять сообщения без твоей команды',
      '• Получать доступ к твоим контактам',
      '',
      'Бот БУДЕТ:',
      '• Отправлять приглашения на встречи от твоего имени',
      '',
      'Отключить можно в любой момент в /settings.',
    ].join('\n'),
    btnConnect: 'Подключить',
    btnCancel: 'Отмена',
    btnSharePhone: '📱 Поделиться номером',
    enterPhone: 'Введи номер телефона в международном формате:\nНапример: +79001234567',
    invalidPhone: 'Неверный формат. Используй международный формат: +79001234567',
    sendingCode: '⏳ Отправляю код подтверждения…',
    codeSent:
      'Код подтверждения отправлен в Telegram.\nВведи код через пробелы или дефисы (напр. 1 2 3 4 5 или 123-45):',
    invalidCode: 'Неверный код. Введи 5 цифр через пробелы или дефисы (напр. 1 2 3 4 5 или 123-45).',
    btnCancelAuth: 'Отменить авторизацию',
    authCancelled: 'Авторизация отменена.',
    codeExpired: 'Код истёк. Начни заново: /connect_telegram',
    wizardExpired:
      'Время на подключение Telegram вышло. Сообщение удалено — вдруг там был код или пароль. Начни заново: /connect_telegram',
    tooManyAttempts: 'Слишком много попыток. Начни заново: /connect_telegram',
    enter2fa: 'У тебя включена двухфакторная аутентификация.\nВведи пароль (он не будет сохранён):',
    invalid2fa: 'Неверный пароль. Попробуй ещё раз.',
    success: (masked: string) =>
      `✅ Telegram-аккаунт подключён (${masked})\n\nТеперь приглашения на встречи будут отправляться от твоего имени.\nОтключить: /settings`,
    cancelled: 'Подключение отменено.',
    featureUnavailable: 'Функция временно недоступна.',
    phoneAlreadyUsed: 'Этот номер телефона уже подключён к другому аккаунту.',
    floodWait: (minutes: number) => `Telegram ограничил запросы. Попробуй через ${minutes} мин.`,
    alreadyConnected: (masked: string) => `✅ Telegram-аккаунт уже подключён (${masked})\nПереподключить?`,
    btnReconnect: 'Переподключить',
    cooldown: (seconds: number) => `Подожди ${seconds}с перед повтором.`,
    successWithPending: (masked: string, eventTitle: string, dateLine: string, inviteeList: string) =>
      `✅ Telegram-аккаунт подключён (${masked})\n\nУ тебя есть встреча «${eventTitle}» (${dateLine})\n\nЕщё не приглашены:\n${inviteeList}`,
    sendPendingBtn: (count: number) =>
      `Отправить ${count} ${ruPlural(count, 'приглашение', 'приглашения', 'приглашений')}`,
    skipPendingBtn: 'Не сейчас',
    pendingSent: (count: number) =>
      `✅ ${count} ${ruPlural(count, 'приглашение отправлено', 'приглашения отправлены', 'приглашений отправлено')}.`,
    tzDetected: (region: string, iana: string) => `Похоже, ты сейчас в ${region}.\nОбновить таймзону на ${iana}?`,
    tzUpdated: (iana: string) => `✅ Таймзона обновлена: ${iana}`,
    tzSkipped: 'Таймзона не изменена.',
    tzConsentPrompt:
      '🌍 Бот может определять таймзону по твоему Telegram-подключению, чтобы события показывались в правильное время.\nРазрешить? (читается только страна и регион, не сообщения)',
    tzConsentYes: 'Разрешить',
    tzConsentNo: 'Нет',
    accountUnavailable:
      'Telegram сообщает, что подключённый аккаунт отключён или недоступен. Сначала проверь этот аккаунт в Telegram; переподключай его здесь после восстановления доступа.',
    revocationConfirmed:
      'Telegram сообщил, что доступ этой сессии отозван. Точное время отзыва и кто это сделал — неизвестно.',
    connectionUnavailable:
      'Подключение к твоему Telegram больше недоступно. Переподключи его, чтобы снова отправлять приглашения от твоего имени.',
    lossObservedAt: (at: string) => `Обнаружено ${at} (UTC). Это время обнаружения, а не точное время отзыва.`,
    sessionExpired:
      'Без подключения не смогу отправлять приглашения от твоего имени. Календарь и сообщения от бота остаются доступны; отдельным получателям понадобится переслать ссылку вручную. Восстановить отправку от твоего имени: /connect_telegram.',
    privateOnly: 'Эта команда работает только в личных сообщениях. Отправь /connect_telegram мне в личку.',
  },
} as const;
