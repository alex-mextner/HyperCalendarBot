// src/config/constants/messages/ru/gcal.ts
// Google Calendar connect, calendar picker and sync status messages.

export const ruGcal = {
  gcal_onboarding:
    'Хотите синхронизировать с Google Calendar?\n\nСобытия останутся в боте в любом случае. Синхронизация даёт:\n- Просмотр событий бота в Google Calendar\n- Изменения в Google Calendar авто-синхронизируются\n- Двусторонняя синхронизация',
  gcal_onboarding_maybe_later: 'Позже',
  gcal_not_configured: 'Синхронизация с Google Calendar не настроена. Обратитесь к администратору.',
  gcal_already_connected: 'Google Calendar уже подключён. Используйте /disconnect_google чтобы переподключить.',
  gcal_connect_prompt: '🔗 Подключите Google Calendar для двусторонней синхронизации событий.',
  gcal_connect_button: 'Подключить Google Calendar',
  gcal_connected: '✅ Google Calendar подключён! Выберите календари для синхронизации.',
  gcal_disconnected: '✅ Google Calendar отключён. Локальные события сохранены.',
  gcal_disconnect_confirm: 'Отключить Google Calendar? События останутся в боте.',
  gcal_disconnect_yes: 'Да, отключить',
  gcal_disconnect_no: 'Отмена',
  gcal_calendar_picker: 'Выберите календари для синхронизации (нажмите для переключения):',
  gcal_calendar_done: 'Готово ✓',
  gcal_calendar_readonly: '(только чтение)',
  gcal_calendars_saved: '✅ Выбор сохранён. Начинается синхронизация...',
  gcal_sync_complete: '✅ Синхронизация завершена. Ваши события из Google теперь в боте.',
  gcal_revoked: '⚠️ Связь с Google Calendar потеряна. Используйте /connect_google чтобы переподключить.',
  gcal_conflict: (title: string, winner: string) =>
    `⚠️ Конфликт синхронизации "${title}"\n\n${winner === 'google' ? 'Google Calendar' : 'Локальная'} версия применена (более новая).`,
  gcal_status_connected: 'Подключён ✅',
  gcal_status_not_connected: 'Google Calendar не подключён. Используй /connect_google чтобы начать синхронизацию.',
  gcal_status_sync_btn: '🔄 Синхронизировать',
  gcal_status_calendars_btn: '⚙️ Календари',
  gcal_status_sync_started: '⏳ Синхронизация запущена',
} as const;
