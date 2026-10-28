// src/config/constants/messages/en/formatting.ts
// Notification, weather and event-card formatting fragments.

import { formatTempCurrent, formatTempRange } from '../../../../services/weather/format.ts';

export const enFormatting = {
  notifications: {
    morning: "Good morning! Here's your day:",
    morningFree: 'Good morning!',
    evening: "Tomorrow's schedule:",
    eveningFree: 'Good evening!',
    inLabel: 'in',
    startingNow: 'starting now!',
    eventsCount: (n: number) => `${n} event${n === 1 ? '' : 's'}`,
    goodNight: 'Good night!',
    tomorrow: 'tomorrow',
    haveADay: 'Have a productive day!',
    eveHoliday: (name: string) => `🎉 ${name} tomorrow`,
    weeklyDigest: (range: string) => `📅 Week ${range}:`,
    noEvents: 'no events',
    allDay: 'All day',
    freeDayMorning:
      'No events today — your day is free!\nWant to plan something? Just describe it in a message, or use /add.',
    freeDayEvening:
      'No events tomorrow — the day is free!\nWant to plan ahead? Just describe it in a message, or use /add.',
    durationHours: (h: number) => `${h}h`,
    durationMinutes: (m: number) => `${m} min`,
    batchHeader: (firstTitle: string, restCount: number) => `${firstTitle} +${restCount} more`,
    clockChangeForward: (duration: string) => `🕐 Clocks shifted by +${duration}`,
    clockChangeBack: (duration: string) => `🕐 Clocks shifted by -${duration}`,
  },
  weather: {
    tempCurrent: formatTempCurrent,
    tempRange: formatTempRange,
    wind: (ms: number) => `${ms} m/s`,
    weekForecast: '🌤 Weather this week:',
    eventForecast: (weather: string) => `Weather: ${weather}`,
  },
  eventCard: {
    allDayInline: 'all day',
    birthdayAgeSuffix: (age: number) => ` — turns ${age}`,
    dayAgendaEmpty: 'No events. Use /add to create one.',
    weekAgendaDayEmpty: '— no events',
    weekHeader: 'Week',
    eventsWord: (n: number) => (n === 1 ? 'event' : 'events'),
    recurrenceEvery: (interval: number, unit: string) => `Every ${interval} ${unit}`,
    recurrenceCountSuffix: (count: string) => `, ${count} times`,
    recurrenceMonthShort: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    recurrenceUntilSuffix: (day: number, monthShort: string) => ` until ${monthShort} ${day}`,
    recurrenceUnitDays: (n: number) => (n === 1 ? 'day' : 'days'),
    recurrenceUnitWeeks: (n: number) => (n === 1 ? 'week' : 'weeks'),
    recurrenceUnitMonths: (n: number) => (n === 1 ? 'month' : 'months'),
    recurrenceUnitYears: (n: number) => (n === 1 ? 'year' : 'years'),
    recurrenceFreqDaily: 'Daily',
    recurrenceFreqWeekly: 'Weekly',
    recurrenceFreqMonthly: 'Monthly',
    recurrenceFreqYearly: 'Yearly',
  },
} as const;
