// src/config/constants/messages/ru/speech-sync-stats.ts
// Speech (TTS/STT), calendar-sync reminder and AI-stats report text.

import { ruPlural } from '../../../../services/event/formatters.ts';

export const ruSpeechSyncStats = {
  speech: {
    allDay: 'весь день',
    noEvents: 'нет событий',
    at: 'в',
    morningIntro: (dateLabel: string) => `Доброе утро. Сегодня, ${dateLabel}.`,
    morningOutro: 'Продуктивного дня!',
    eveningIntro: (dateLabel: string) => `Добрый вечер. Завтра, ${dateLabel}.`,
    eveningOutro: 'Спокойной ночи!',
    weeklyDigestIntro: (weekRange: string) => `Еженедельный дайджест на неделю ${weekRange}.`,
    reminderIntro: (cleanTitle: string, timeStr: string) => `Календарное напоминание. ${cleanTitle} в ${timeStr}.`,
    location: (loc: string) => `Место: ${loc}.`,
    batchIntro: (count: number) =>
      `Календарное напоминание. ${count} ${ruPlural(count, 'событие', 'события', 'событий')} начинаются скоро:`,
    eventAt: (title: string, timeStr: string) => `${title} в ${timeStr}.`,
  },
  sync: {
    eventChanged: (title: string, changes: string) => `📅 «${title}» изменён:\n${changes}`,
    eventCancelled: (title: string) => `❌ «${title}» — отменено организатором`,
    changeProposed: (participantName: string, title: string, changes: string) =>
      `📝 ${participantName} → «${title}»:\n${changes}`,
    acceptBtn: 'Принять ✅',
    rejectBtn: 'Отклонить ❌',
    proposalAccepted: (title: string, changes: string) => `✅ «${title}» принято:\n${changes}`,
    proposalRejected: (title: string, changes: string) => `❌ «${title}» отклонено:\n${changes}`,
    proposalExpired: (title: string) => `⏰ «${title}» — нет ответа, изменения отменены`,
    proposalExpiredOrganizer: (title: string) => `⏰ «${title}» — предложение истекло`,
    participantDeclinedViaGoogle: (participantName: string, title: string) =>
      `👋 ${participantName} отклонил «${title}»`,
    changeTime: (oldTime: string, newTime: string) => `• ${oldTime} → ${newTime}`,
    changeTitle: (oldTitle: string, newTitle: string) => `• ${oldTitle} → ${newTitle}`,
    changeLocation: (oldLoc: string, newLoc: string) => `• ${oldLoc} → ${newLoc}`,
    changeDescription: '• Описание обновлено',
    changeAllDay: (isAllDay: boolean) => (isAllDay ? '• Теперь на весь день' : '• Больше не на весь день'),
    changeRecurrence: '• Повторения изменены',
  },
  aiStats: {
    adminOnly: 'Только для админа.',
    usage: 'Формат: /ai_stats [дни, 1–180]',
    title: (days: number, attempts: number) => `ИИ за ${days} дн. · запросов: ${attempts}`,
    sectionProviders: 'Провайдеры',
    sectionRoles: 'Роли',
    sectionModels: 'Модели',
    noTraffic: 'за период запросов нет',
    skippedOnly: (skipped: number) => `не вызывался, пропусков: ${skipped}`,
    healthy: (ok: number, sent: number, rate: string) => `работает, ${ok}/${sent} успешно (${rate})`,
    degraded: (ok: number, sent: number, rate: string) => `сбоит, ${ok}/${sent} успешно (${rate})`,
    failing: (errors: number) => `не отвечает, ошибок: ${errors}`,
    lastOk: (when: string) => `последний успех ${when}`,
    lastError: (errorClass: string, status: string, when: string) => `последняя ошибка ${errorClass}${status} ${when}`,
    counts: (ok: number, errors: number, skipped: number, rate: string) =>
      `${ok} ок · ${errors} ошибок · ${skipped} пропущено · ${rate}`,
    skippedBy: (list: string) => `пропуски: ${list}`,
    errorsBy: (list: string) => `ошибки: ${list}`,
    tokens: (prompt: string, completion: string) => `токены: вход ${prompt} · выход ${completion}`,
    tokensExtra: (reasoning: string, cached: string) => `рассуждение ${reasoning} · из кэша ${cached}`,
    tokensUnknown: (answers: number) => `без данных о токенах, ответов: ${answers}`,
    cost: (total: string) => `стоимость: ${total}`,
    costUnknown: (answers: number) => `без известной стоимости, ответов: ${answers}`,
    latency: (p50: number, p95: number) => `p50 ${p50} мс · p95 ${p95} мс`,
    okRange: (first: string, last: string) => `первый успех ${first} · последний ${last}`,
    unknown: '—',
  },
} as const;
