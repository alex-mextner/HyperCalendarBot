// src/config/constants/messages/ru/onboarding.ts
// Onboarding, timezone detection, country/agenda prompts and basic event result messages.

export const ruOnboarding = {
  welcome: '🌍 Choose your language / Выберите язык:',
  tz_prompt: 'Установим часовой пояс. Самый точный способ — поделиться геолокацией.',
  tz_detected: (tz: string, offset: string) => `Ваш часовой пояс: ${tz} (${offset}).\nВсё верно?`,
  tz_confirm_yes: 'Да ✓',
  tz_confirm_no: 'Нет, выбрать вручную',
  geo_tz_confirm_prompt: (currentTz: string, newTz: string, offset: string) =>
    `📍 Твой текущий часовой пояс — <b>${currentTz}</b>.\nПо геолокации похоже, что ты в <b>${newTz}</b> (${offset}).\n\nОбновление часового пояса нужно, чтобы напоминания, сводка дня и время событий отображались правильно.\n\nОбновить часовой пояс?`,
  geo_tz_confirm_btn: 'Да, обновить ✓',
  geo_tz_dismiss_btn: 'Нет, оставить',
  event_map_btn: '🗺 На карте',
  geo_tz_updated: (tz: string, offset: string) => `✅ Часовой пояс обновлён: ${tz} (${offset}).`,
  geo_tz_dismissed: 'ОК, часовой пояс не изменён.',
  tz_same_from_location: (tz: string, offset: string) =>
    `📍 Твой часовой пояс уже ${tz} (${offset}) — менять ничего не нужно.`,
  share_location: '📍 Отправить геолокацию',
  choose_manually: '⌨️ Выбрать вручную',
  country_prompt: 'Показывать государственные праздники в календаре?',
  country_skip: 'Пропустить',
  agenda_prompt: 'Могу отправлять утреннюю сводку событий на день.\n\nВыберите время для утренней сводки:',
  onboard_done:
    '✅ Всё готово!\n\n/add — создать событие\n/today — расписание на сегодня\n\nПросто напишите или отправьте голосовое — я понимаю естественный язык и могу создавать, редактировать, искать события за вас.',
  no_events_today: (date: string) =>
    `📅 ${date}\n\nНет событий. Хочешь что-то запланировать? Просто напиши сообщение, или используй /add.`,
  no_events: 'Нет событий за этот период.',
  event_created: (title: string) => `✅ Создано: "${title}"`,
  event_deleted: (title: string) => `🗑 Удалено: "${title}"`,
  event_updated: (title: string) => `✏️ Обновлено: "${title}"`,
  confirm_delete: (title: string) => `Удалить "${title}"?`,
  search_no_results: 'Ничего не найдено.',
  something_wrong: 'Что-то пошло не так. Попробуй ещё раз или /help.',
} as const;
