// src/config/constants/messages/ru/sharing-voice.ts
// Event sharing, voice-response prompts, group event notices and the feature tour.

export const ruSharingVoice = {
  privacy_current: (level: string) => `🔒 Текущая видимость: <b>${level}</b>`,
  share_preview: '📤 Превью — вот что будет отправлено:',
  share_sent: '✅ Отправлено',
  share_cancelled: '❌ Отправка отменена',
  no_events_to_share: 'Нет событий для этого периода',
  voice_response_enabled: '🎤 Голосовые ответы включены!',
  voice_response_disabled: '🎤 Ок, только текстом.',
  voice_demo_failed: '🎤 Голосовые ответы включены! Демо не воспроизвелось — голос появится со следующего ответа.',
  cancelled: 'Отменено.',
  voice_prompt: '🎤 Хочешь получать голосовые ответы?\nУдобно за рулём, на кухне или на ходу.',
  voice_prompt_yes: 'Да, хочу',
  voice_prompt_no: 'Нет, только текстом',
  voice_stt_error: 'Не удалось распознать речь.',
  voice_error: 'Не удалось обработать голосовое сообщение.',
  group_event_created: (groupRef: string, organizerLink: string) =>
    `📅 Новое событие в ${groupRef}\n👤 Организатор: ${organizerLink}`,
  group_event_updated: (groupRef: string, organizerLink: string) =>
    `✏️ Событие обновлено в ${groupRef}\n👤 Изменил: ${organizerLink}`,
  feature_tour_btn: '📖 Все функции',
  feature_tour: [
    '<b>🤖 AI-ассистент</b>\nПросто напишите или отправьте голосовое: "запланируй встречу завтра в 15:00", "что у меня на неделе?", "перенеси стендап на 11:00". Все функции бота доступны через чат — я понимаю контекст и выполняю команды.',
    '<b>📅 Управление календарём</b>\n/add — пошаговое создание\n/today, /week, /month — разные виды\n/edit, /delete — редактирование\n/free — свободные слоты\nПовторяющиеся события с гибкими правилами.',
    '<b>🔔 Умные напоминания</b>\n/settings — утренняя сводка, вечерний обзор, тихие часы, голосовые звонки, приватность\nНесколько напоминаний на событие (15 мин, 1 ч и т.д.)',
    '<b>🌍 Праздники</b>\n/holidays — подписка на праздники 100+ стран\nПраздники отображаются в ежедневной повестке.',
    '<b>📤 Шаринг и приглашения</b>\n/share today — поделиться расписанием\n/invite @username — пригласить на событие\nВидимость событий: /settings → Приватность\nInline-режим: наберите @HyperCalendarBot в любом чате.',
    '<b>🖼 Визуальное расписание</b>\nКрасивые изображения календаря автоматически отправляются с командами /today и /week.',
  ],
} as const;
