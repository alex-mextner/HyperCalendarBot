// src/config/constants/messages/ru/holidays-notify.ts
// Holiday subscriptions, AI error fallbacks and notification-settings labels.

export const ruHolidaysNotify = {
  holidays_menu: '🌍 <b>Праздники</b>',
  holidays_no_subs: 'Нет подписок. Нажмите "+ Добавить" чтобы подписаться.',
  holidays_added: (country: string) => `✅ Подписка на ${country}`,
  holidays_removed: (country: string) => `Удалено: ${country}`,
  holidays_set_primary: (country: string) => `${country} — основная страна`,
  holidays_pick_region: 'Выберите регион:',
  holidays_pick_country: 'Выберите страну:',
  holidays_upcoming: '📅 <b>Ближайшие праздники</b>',
  holidays_none_upcoming: 'Нет ближайших праздников по вашим подпискам.',
  holidays_day_off: '🎉 Выходной!',
  holidays_manage_prompt: 'Выберите подписку для управления:',
  holidays_notify_on: (country: string) => `${country}: уведомления ВКЛ`,
  holidays_notify_off: (country: string) => `${country}: уведомления ВЫКЛ`,
  ai_error: 'ИИ временно недоступен. Используйте команды бота (/help).',
  ai_send_error: '⚠️ Произошла ошибка при отправке ответа. Попробуй ещё раз.',
  ai_clear_history: 'История чата очищена.',
  scene_help_btn: '🆘 Позвать на помощь',
  notify_menu: '⚙️ Настройки уведомлений',
  notify_morning: '🌅 Утренняя повестка',
  notify_morning_status: (enabled: boolean, time: string) => `Утренняя повестка: ${enabled ? `✅ ${time}` : '❌'}`,
  notify_evening: '🌙 Вечерний обзор',
  notify_evening_status: (enabled: boolean, time: string) => `Вечерний обзор: ${enabled ? `✅ ${time}` : '❌'}`,
  notify_reminders: '⏰ Напоминания по умолчанию',
  notify_quiet: '🔇 Тихие часы',
  notify_quiet_status: (enabled: boolean, start: string, end: string) =>
    `Тихие часы: ${enabled ? `✅ ${start} — ${end}` : '❌'}`,
  notify_pick_hour: 'Выберите час:',
  notify_pick_minute: 'Выберите минуту:',
  notify_updated: 'Настройки обновлены',
  notify_intervals_label: (intervals: number[]) =>
    `Напоминания: ${intervals.map((m) => (m === 0 ? 'в начале' : m >= 60 ? `${m / 60}ч` : `${m}мин`)).join(', ')}`,
} as const;
