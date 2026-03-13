export interface Labels {
  today: string;
  tomorrow: string;
  noEvents: string;
  allDay: string;
  holiday: string;
  weekDaysShort: string[];
  weekDaysFull: string[];
  monthNames: string[];
}

const labelsDict: Record<string, Labels> = {
  ru: {
    today: "Сегодня",
    tomorrow: "Завтра",
    noEvents: "Нет событий",
    allDay: "Весь день",
    holiday: "Праздник",
    weekDaysShort: ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"],
    weekDaysFull: ["Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота", "Воскресенье"],
    monthNames: [
      "января", "февраля", "марта", "апреля", "мая", "июня",
      "июля", "августа", "сентября", "октября", "ноября", "декабря",
    ],
  },
  en: {
    today: "Today",
    tomorrow: "Tomorrow",
    noEvents: "No events",
    allDay: "All day",
    holiday: "Holiday",
    weekDaysShort: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
    weekDaysFull: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
    monthNames: [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December",
    ],
  },
};

export function getLabels(locale: string): Labels {
  return labelsDict[locale] ?? labelsDict.en;
}

export function pluralizeEvents(count: number, locale: string): string {
  if (locale === "ru") {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) return "событие";
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "события";
    return "событий";
  }
  return count === 1 ? "event" : "events";
}
