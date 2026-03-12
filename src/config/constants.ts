// src/config/constants.ts

// Rate limits
export const RATE_LIMIT = {
  MESSAGES_PER_MINUTE: 30,
  MESSAGES_PER_HOUR: 200,
  ADD_PER_HOUR: 20,
  EXPORT_PER_HOUR: 5,
  COOLDOWN_MS: 60_000,
} as const;

// Defaults
export const DEFAULTS = {
  LANGUAGE: 'en' as const,
  TIMEZONE: 'UTC',
  REMINDER_MINUTES: 15,
  WEEK_STARTS_ON: 1 as const, // Monday
} as const;

// Callback data prefixes
export const CB = {
  EVENT_VIEW: 'ev',
  EVENT_EDIT: 'ee',
  EVENT_DELETE: 'ed',
  EVENT_DELETE_CONFIRM: 'edc',
  EVENT_RECURRENCE: 'er',
  EVENT_REMINDER: 'erm',
  ONBOARD_LANG: 'ol',
  ONBOARD_TZ_REGION: 'otr',
  ONBOARD_TZ: 'ot',
  ONBOARD_COUNTRY: 'oc',
  ONBOARD_AGENDA: 'oa',
  MONTH_NAV: 'mn',
  SETTINGS: 'st',
  EDIT_FIELD: 'ef',
  ADD_STEP: 'as',
} as const;

// i18n messages
export const MSG = {
  en: {
    welcome: '🌍 Choose your language / Выберите язык:',
    tz_prompt: "Now let's set your timezone. The most accurate way is to share your location.",
    tz_detected: (tz: string, offset: string) => `Got it! Your timezone is ${tz} (${offset}).\nIs this correct?`,
    tz_confirm_yes: 'Yes ✓',
    tz_confirm_no: 'No, choose manually',
    share_location: '📍 Share Location',
    choose_manually: '⌨️ Choose Manually',
    country_prompt: 'Want to see public holidays in your calendar?',
    country_skip: 'Skip',
    agenda_prompt: "I can send you a morning summary of your day's events.\n\nChoose a time for the daily agenda:",
    onboard_done:
      "✅ All set! Here's what you can do:\n\n/add — create your first event\n/today — view today's schedule\n/help — see all commands",
    no_events_today: (date: string) => `📅 ${date}\n\nNo events today. Use /add to create one.`,
    no_events: 'No events in this range.',
    event_created: (title: string) => `✅ Created: "${title}"`,
    event_deleted: (title: string) => `🗑 Deleted: "${title}"`,
    event_updated: (title: string) => `✏️ Updated: "${title}"`,
    confirm_delete: (title: string) => `Delete "${title}"?`,
    search_no_results: 'No events found.',
    something_wrong: 'Something went wrong. Try again or use /help.',
    rate_limited: 'Slow down, too many messages.',
    add_title_prompt: "Let's create an event. What's the title?",
    add_time_prompt: 'When? (e.g., "tomorrow 18:00", "Mar 15 19:30")',
    add_duration_prompt: 'How long? (e.g., "1h", "30m", "2h30m") or skip for no end time.',
    add_description_prompt: 'Description? (send text or "skip")',
    add_location_prompt: 'Location? (send text or "skip")',
    edit_pick: 'Which event to edit? Pick from upcoming:',
    delete_pick: 'Which event to delete?',
    free_header: (date: string) => `📋 Free slots ${date}:`,
    pong: (ms: number) => `pong (${ms}ms)`,
    welcome_back: 'Welcome back! Use /help for commands.',
  },
  ru: {
    welcome: '🌍 Choose your language / Выберите язык:',
    tz_prompt: 'Установим часовой пояс. Самый точный способ — поделиться геолокацией.',
    tz_detected: (tz: string, offset: string) => `Ваш часовой пояс: ${tz} (${offset}).\nВсё верно?`,
    tz_confirm_yes: 'Да ✓',
    tz_confirm_no: 'Нет, выбрать вручную',
    share_location: '📍 Отправить геолокацию',
    choose_manually: '⌨️ Выбрать вручную',
    country_prompt: 'Показывать государственные праздники в календаре?',
    country_skip: 'Пропустить',
    agenda_prompt: 'Могу отправлять утреннюю сводку событий на день.\n\nВыберите время для утренней сводки:',
    onboard_done:
      '✅ Всё готово! Вот что можно сделать:\n\n/add — создать событие\n/today — расписание на сегодня\n/help — список команд',
    no_events_today: (date: string) => `📅 ${date}\n\nНет событий. Используйте /add для создания.`,
    no_events: 'Нет событий за этот период.',
    event_created: (title: string) => `✅ Создано: "${title}"`,
    event_deleted: (title: string) => `🗑 Удалено: "${title}"`,
    event_updated: (title: string) => `✏️ Обновлено: "${title}"`,
    confirm_delete: (title: string) => `Удалить "${title}"?`,
    search_no_results: 'Ничего не найдено.',
    something_wrong: 'Что-то пошло не так. Попробуйте ещё раз или /help.',
    rate_limited: 'Слишком много сообщений, подождите.',
    add_title_prompt: 'Создаём событие. Как назовём?',
    add_time_prompt: 'Когда? (например, "завтра 18:00", "15 мар 19:30")',
    add_duration_prompt: 'Сколько длится? (например, "1ч", "30м") или пропустите.',
    add_description_prompt: 'Описание? (текст или "пропустить")',
    add_location_prompt: 'Место? (текст или "пропустить")',
    edit_pick: 'Какое событие редактировать?',
    delete_pick: 'Какое событие удалить?',
    free_header: (date: string) => `📋 Свободные слоты ${date}:`,
    pong: (ms: number) => `понг (${ms}мс)`,
    welcome_back: 'С возвращением! /help для списка команд.',
  },
} as const;

export type Lang = keyof typeof MSG;
export type Messages = (typeof MSG)[Lang];

export function t(lang: Lang): Messages {
  return MSG[lang] || MSG.en;
}

// Popular timezone regions for manual selection
export const TZ_REGIONS: Record<string, string[]> = {
  Europe: [
    'Europe/London',
    'Europe/Paris',
    'Europe/Berlin',
    'Europe/Moscow',
    'Europe/Istanbul',
    'Europe/Kyiv',
    'Europe/Warsaw',
    'Europe/Rome',
    'Europe/Madrid',
    'Europe/Amsterdam',
    'Europe/Belgrade',
    'Europe/Helsinki',
  ],
  Asia: [
    'Asia/Dubai',
    'Asia/Kolkata',
    'Asia/Bangkok',
    'Asia/Singapore',
    'Asia/Tokyo',
    'Asia/Seoul',
    'Asia/Shanghai',
    'Asia/Hong_Kong',
    'Asia/Almaty',
    'Asia/Tbilisi',
    'Asia/Yerevan',
    'Asia/Tashkent',
  ],
  Americas: [
    'America/New_York',
    'America/Chicago',
    'America/Denver',
    'America/Los_Angeles',
    'America/Toronto',
    'America/Sao_Paulo',
    'America/Mexico_City',
    'America/Buenos_Aires',
  ],
  Africa: ['Africa/Cairo', 'Africa/Lagos', 'Africa/Johannesburg', 'Africa/Nairobi'],
  Oceania: ['Australia/Sydney', 'Australia/Melbourne', 'Pacific/Auckland'],
};
