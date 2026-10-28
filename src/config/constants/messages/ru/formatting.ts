// src/config/constants/messages/ru/formatting.ts
// Notification, weather and event-card formatting fragments.

import { ruPlural } from '../../../../services/event/formatters.ts';
import { formatTempCurrent, formatTempRange } from '../../../../services/weather/format.ts';

export const ruFormatting = {
  notifications: {
    morning: 'Доброе утро! Твой день:',
    morningFree: 'Доброе утро!',
    evening: 'Расписание на завтра:',
    eveningFree: 'Добрый вечер!',
    inLabel: 'через',
    startingNow: 'начинается!',
    eventsCount: (n: number) => `${n} ${ruPlural(n, 'событие', 'события', 'событий')}`,
    goodNight: 'Спокойной ночи!',
    tomorrow: 'завтра',
    haveADay: 'Продуктивного дня!',
    eveHoliday: (name: string) => `🎉 ${name} завтра`,
    weeklyDigest: (range: string) => `📅 Неделя ${range}:`,
    noEvents: 'нет событий',
    allDay: 'Весь день',
    freeDayMorning:
      'Сегодня нет событий — день свободен!\nХочешь что-то запланировать? Просто напиши сообщение, или используй /add.',
    freeDayEvening:
      'Завтра нет событий — день свободен!\nХочешь запланировать что-то заранее? Просто напиши сообщение, или используй /add.',
    durationHours: (h: number) => `${h} ${ruPlural(h, 'час', 'часа', 'часов')}`,
    durationMinutes: (m: number) => `${m} ${ruPlural(m, 'минуту', 'минуты', 'минут')}`,
    batchHeader: (firstTitle: string, restCount: number) => `${firstTitle} + ещё ${restCount}`,
    clockChangeForward: (duration: string) => `🕐 Часы переведены на +${duration}`,
    clockChangeBack: (duration: string) => `🕐 Часы переведены на -${duration}`,
  },
  weather: {
    tempCurrent: formatTempCurrent,
    tempRange: formatTempRange,
    wind: (ms: number) => `${ms} м/с`,
    weekForecast: '🌤 Погода на неделю:',
    eventForecast: (weather: string) => `Погода: ${weather}`,
  },
  eventCard: {
    allDayInline: 'весь день',
    birthdayAgeSuffix: (age: number) => ` — ${age} ${ruPlural(age, 'год', 'года', 'лет')}`,
    dayAgendaEmpty: 'Нет событий. /add для создания.',
    weekAgendaDayEmpty: '— нет событий',
    weekHeader: 'Неделя',
    eventsWord: (n: number) => ruPlural(n, 'событие', 'события', 'событий'),
    recurrenceEvery: (interval: number, unit: string) => `Каждые ${interval} ${unit}`,
    recurrenceCountSuffix: (count: string) => `, ${count} раз`,
    recurrenceMonthShort: ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'],
    recurrenceUntilSuffix: (day: number, monthShort: string) => ` до ${day} ${monthShort}`,
    recurrenceUnitDays: (n: number) => ruPlural(n, 'день', 'дня', 'дней'),
    recurrenceUnitWeeks: (n: number) => ruPlural(n, 'неделю', 'недели', 'недель'),
    recurrenceUnitMonths: (n: number) => ruPlural(n, 'месяц', 'месяца', 'месяцев'),
    recurrenceUnitYears: (n: number) => ruPlural(n, 'год', 'года', 'лет'),
    recurrenceFreqDaily: 'Ежедневно',
    recurrenceFreqWeekly: 'Еженедельно',
    recurrenceFreqMonthly: 'Ежемесячно',
    recurrenceFreqYearly: 'Ежегодно',
  },
} as const;
