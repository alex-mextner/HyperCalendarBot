// Wording of the answers an intent rule gives without the AI: agenda lines, free windows, clocks, settings, contacts.
// Kept next to the renderers (not in config/constants.ts) because every phrase here is composed with the day parts
// from human-time.ts, and a Russian and an English sentence need different word order, not a translated string.
// Russian uses «ты» forms; every phrase starts with the most informative words.
import { toLang } from '../../config/constants.ts';
import { ruPlural } from '../event/formatters.ts';
import type { HumanDayParts } from './human-time.ts';

export type CalendarKind = 'personal' | 'group' | 'selected';
export type ConfirmedWrite = 'created' | 'updated' | 'deleted';
export type SettingsCategory = 'general' | 'notifications' | 'calls' | 'privacy' | 'voice';

export interface AnswerWording {
  allDay: string;
  /** Tail of a clock range that ends on a later day: "(до ср 7 октября)". */
  endsOn: (day: string) => string;
  /** First line of a list read from a calendar that is not the user's own; null for the user's own. */
  calendarLead: (kind: CalendarKind) => string | null;
  /** "в твоём календаре" — where an empty answer says it looked. */
  inCalendar: (kind: CalendarKind) => string;
  /** "На завтра, вт 6 октября," / "For tomorrow, Tue Oct 6,": the day an empty answer is about, capitalised. */
  forDayHeading: (day: HumanDayParts) => string;
  /** "завтра, вт 6 октября" / "в пт 9 октября": a day in the middle of a sentence. */
  onDay: (day: HumanDayParts) => string;
  freeWindows: (day: HumanDayParts, windows: string) => string;
  freeAllDay: string;
  freeNowhere: (day: HumanDayParts, calendar: string) => string;
  noFreeWindowsInline: string;
  confirmed: (write: ConfirmedWrite, title: string, when: string) => string;
  eventCard: {
    place: string;
    description: string;
    repeats: string;
    repeatsEvery: Record<string, string>;
    repeatsOften: string;
  };
  timeNow: (place: string | null, clock: string, date: string, offset: string, zoneName: string | null) => string;
  timeAt: (place: string | null, clock: string, date: string, offset: string, zoneName: string | null) => string;
  timeInZone: (zone: string) => string;
  timeDifference: (hours: number) => string;
  contactsHeading: (count: number) => string;
  contactFound: string;
  contactsFound: string;
  contactApproximate: string;
  holidaysHeading: string;
  secretary: {
    mine: string;
    forOthers: string;
    none: string;
    permission: { read: string; write: string };
    status: { [status: string]: string };
    invited: string;
    deliveryFailed: string;
    done: string;
  };
  settings: SettingsWording;
  botInfo: (developer: string | null) => string;
  /** A tool answered with data in a shape this renderer does not know; never a JSON dump. */
  unknownShape: string;
  done: string;
  emptyList: string;
  /** A learned rule's list format came back empty and no day or calendar is known to name. */
  nothingFound: string;
}

export interface SettingsWording {
  heading: string;
  /** Heading of an answer about one category: "Твои настройки (уведомления):". */
  headingFor: (category: string) => string;
  categories: { [category in SettingsCategory]: string };
  yes: string;
  no: string;
  unset: string;
  at: (time: string) => string;
  /** 90 → "1 ч 30 мин"; the same short units in every list so a number never needs a plural form. */
  durationShort: (minutes: number) => string;
  quietRange: (from: string, to: string) => string;
  before: (duration: string) => string;
  language: { [code: string]: string };
  visibility: { [value: string]: string };
  labels: { [key: string]: string };
}

function shortDuration(minutes: number, hourUnit: string, minuteUnit: string): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} ${minuteUnit}`;
  return rest === 0 ? `${hours} ${hourUnit}` : `${hours} ${hourUnit} ${rest} ${minuteUnit}`;
}

const ruWords: AnswerWording = {
  allDay: 'весь день',
  endsOn: (day) => `(до ${day})`,
  calendarLead: (kind) =>
    kind === 'group' ? 'Календарь группы:' : kind === 'selected' ? 'Выбранный календарь:' : null,
  inCalendar: (kind) =>
    kind === 'group' ? 'в календаре группы' : kind === 'selected' ? 'в выбранном календаре' : 'в твоём календаре',
  forDayHeading: (day) => `На ${day.relative ? `${day.relative}, ` : ''}${day.calendar},`,
  onDay: (day) => (day.relative ? `${day.relative}, ${day.calendar}` : `в ${day.calendar}`),
  freeWindows: (day, windows) =>
    `Свободно ${day.relative ? `${day.relative}, ${day.calendar}` : `в ${day.calendar}`}: ${windows}.`,
  freeAllDay: 'весь день',
  freeNowhere: (day, calendar) =>
    `На ${day.relative ? `${day.relative}, ` : ''}${day.calendar}, ${calendar} нет свободных окон: день занят целиком.`,
  noFreeWindowsInline: 'свободных окон нет',
  confirmed: (write, title, when) =>
    `${write === 'created' ? 'Событие создано' : write === 'updated' ? 'Событие обновлено' : 'Событие удалено'}: «${title}» — ${when}.`,
  eventCard: {
    place: 'Место',
    description: 'Описание',
    repeats: 'Повторяется',
    repeatsEvery: { DAILY: 'каждый день', WEEKLY: 'каждую неделю', MONTHLY: 'каждый месяц', YEARLY: 'каждый год' },
    repeatsOften: 'регулярно',
  },
  timeNow: (place, clock, date, offset, zoneName) =>
    `Сейчас ${place ? `в ${place} ` : ''}${clock}, ${date} (${zoneName ? `${zoneName}, ` : ''}${offset}).`,
  timeAt: (place, clock, date, offset, zoneName) =>
    `${place ? `В ${place} ` : 'В этом поясе '}${clock}, ${date} (${zoneName ? `${zoneName}, ` : ''}${offset}).`,
  timeInZone: (zone) => `поясе ${zone}`,
  timeDifference: (hours) => `Разница между поясами — ${hours} ${ruPlural(Math.round(hours), 'час', 'часа', 'часов')}.`,
  contactsHeading: (count) => `Контакты (${count}):`,
  contactFound: 'Нашёл контакт:',
  contactsFound: 'Нашёл несколько контактов:',
  contactApproximate: 'Нашёл похожий контакт:',
  holidaysHeading: 'Ближайшие праздники:',
  secretary: {
    mine: 'Твои секретари:',
    forOthers: 'Ты секретарь у:',
    none: 'У тебя нет секретарей, и ты никому не секретарь.',
    permission: { read: 'просмотр', write: 'просмотр и редактирование' },
    status: { pending: 'ждёт ответа', active: 'доступ открыт', declined: 'отказал' },
    invited: 'Отправил приглашение. Доступ появится, когда человек его примет.',
    deliveryFailed: 'Не удалось доставить приглашение: человек ещё не запускал бота.',
    done: 'Готово.',
  },
  settings: {
    heading: 'Твои настройки:',
    headingFor: (category) => `Твои настройки (${category}):`,
    categories: {
      general: 'Общие',
      notifications: 'Уведомления',
      calls: 'Звонки',
      privacy: 'Приватность',
      voice: 'Голос',
    },
    yes: 'да',
    no: 'нет',
    unset: 'не задано',
    at: (time) => `в ${time}`,
    durationShort: (minutes) => shortDuration(minutes, 'ч', 'мин'),
    quietRange: (from, to) => `с ${from} до ${to}`,
    before: (duration) => `за ${duration}`,
    language: { ru: 'русский', en: 'английский' },
    visibility: { private: 'приватные', free_busy: 'видно только занятость', full: 'видны полностью' },
    labels: {
      timezone: 'Часовой пояс',
      language: 'Язык',
      country_code: 'Страна',
      default_event_duration_minutes: 'Длительность события по умолчанию',
      morning_agenda_enabled: 'Утренняя сводка',
      evening_review_enabled: 'Вечерний обзор',
      quiet_hours_enabled: 'Тихие часы',
      default_reminder_intervals: 'Напоминания по умолчанию',
      enabled: 'Звонки от бота',
      max_daily_calls: 'Звонков в день не больше',
      important_only: 'Звонить только по важному',
      default_visibility: 'Видимость событий по умолчанию',
      inline_mode_enabled: 'Инлайн-режим',
      allow_invitations: 'Приглашения от других',
      share_location: 'Показывать место приглашённым',
      share_description: 'Показывать описание приглашённым',
      voice_response_enabled: 'Голосовые ответы',
    },
  },
  botInfo: (developer) =>
    [
      'Кроме обычных календарных команд я умею:',
      '• Голосовые сообщения: пришли голосовое — я расшифрую и пойму его.',
      '• Голосовые ответы: включи их в настройках, и я буду отвечать голосом (удобно за рулём или на кухне).',
      '• Групповые чаты: добавь меня в группу с друзьями — там появятся общие календари.',
      '• Обратная связь: напиши «нашёл баг» или «хочу предложить идею», и я передам это разработчику.',
      ...(developer ? [`• Разработчик: ${developer}`] : []),
    ].join('\n'),
  unknownShape: 'Данные получил, но показать их в читаемом виде не смог.',
  done: 'Готово.',
  emptyList: 'Подходящих событий в календаре нет.',
  nothingFound: 'Ничего не нашёл.',
};

const enWords: AnswerWording = {
  allDay: 'all day',
  endsOn: (day) => `(until ${day})`,
  calendarLead: (kind) => (kind === 'group' ? 'Group calendar:' : kind === 'selected' ? 'Selected calendar:' : null),
  inCalendar: (kind) =>
    kind === 'group' ? 'in the group calendar' : kind === 'selected' ? 'in the selected calendar' : 'in your calendar',
  forDayHeading: (day) => `For ${day.relative ? `${day.relative}, ` : ''}${day.calendar},`,
  onDay: (day) => (day.relative ? `${day.relative}, ${day.calendar}` : `on ${day.calendar}`),
  freeWindows: (day, windows) =>
    `Free ${day.relative ? `${day.relative}, ${day.calendar}` : `on ${day.calendar}`}: ${windows}.`,
  freeAllDay: 'all day',
  freeNowhere: (day, calendar) =>
    `For ${day.relative ? `${day.relative}, ` : ''}${day.calendar}, there are no free windows ${calendar}: the day is fully booked.`,
  noFreeWindowsInline: 'no free windows',
  confirmed: (write, title, when) => `Event ${write}: “${title}” — ${when}.`,
  eventCard: {
    place: 'Where',
    description: 'Notes',
    repeats: 'Repeats',
    repeatsEvery: { DAILY: 'every day', WEEKLY: 'every week', MONTHLY: 'every month', YEARLY: 'every year' },
    repeatsOften: 'regularly',
  },
  timeNow: (place, clock, date, offset, zoneName) =>
    `${place ? `Right now in ${place} it's` : "It's"} ${clock}, ${date} (${zoneName ? `${zoneName}, ` : ''}${offset}).`,
  timeAt: (place, clock, date, offset, zoneName) =>
    `${place ? `In ${place} it's` : 'In that zone it is'} ${clock}, ${date} (${zoneName ? `${zoneName}, ` : ''}${offset}).`,
  timeInZone: (zone) => zone,
  timeDifference: (hours) => `The zones are ${hours} ${hours === 1 ? 'hour' : 'hours'} apart.`,
  contactsHeading: (count) => `Contacts (${count}):`,
  contactFound: 'Found a contact:',
  contactsFound: 'Found several contacts:',
  contactApproximate: 'Found a similar contact:',
  holidaysHeading: 'Upcoming holidays:',
  secretary: {
    mine: 'Your secretaries:',
    forOthers: "You're a secretary for:",
    none: "You have no secretaries, and you're nobody's secretary.",
    permission: { read: 'view', write: 'view and edit' },
    status: { pending: 'waiting for a reply', active: 'access granted', declined: 'declined' },
    invited: 'Invitation sent. Access starts when they accept it.',
    deliveryFailed: "I couldn't deliver the invitation: that person hasn't started the bot yet.",
    done: 'Done.',
  },
  settings: {
    heading: 'Your settings:',
    headingFor: (category) => `Your settings (${category}):`,
    categories: {
      general: 'General',
      notifications: 'Notifications',
      calls: 'Calls',
      privacy: 'Privacy',
      voice: 'Voice',
    },
    yes: 'yes',
    no: 'no',
    unset: 'not set',
    at: (time) => `at ${time}`,
    durationShort: (minutes) => shortDuration(minutes, 'h', 'min'),
    quietRange: (from, to) => `from ${from} to ${to}`,
    before: (duration) => `${duration} before`,
    language: { ru: 'Russian', en: 'English' },
    visibility: { private: 'private', free_busy: 'busy time only', full: 'fully visible' },
    labels: {
      timezone: 'Time zone',
      language: 'Language',
      country_code: 'Country',
      default_event_duration_minutes: 'Default event length',
      morning_agenda_enabled: 'Morning agenda',
      evening_review_enabled: 'Evening review',
      quiet_hours_enabled: 'Quiet hours',
      default_reminder_intervals: 'Default reminders',
      enabled: 'Calls from the bot',
      max_daily_calls: 'Calls per day, at most',
      important_only: 'Call only for important things',
      default_visibility: 'Default event visibility',
      inline_mode_enabled: 'Inline mode',
      allow_invitations: 'Invitations from others',
      share_location: 'Show the place to invitees',
      share_description: 'Show the notes to invitees',
      voice_response_enabled: 'Voice replies',
    },
  },
  botInfo: (developer) =>
    [
      'Besides the usual calendar commands, I can:',
      '• Voice messages: send a voice message and I will transcribe and understand it.',
      '• Voice replies: turn them on in settings and I will answer by voice (handy while driving or cooking).',
      '• Group chats: add me to a group with friends to share calendars.',
      '• Feedback: say “found a bug” or “want to suggest a feature” and I will pass it to the developer.',
      ...(developer ? [`• Developer: ${developer}`] : []),
    ].join('\n'),
  unknownShape: 'I got the data but could not show it in a readable form.',
  done: 'Done.',
  emptyList: 'No matching events in the calendar.',
  nothingFound: 'Nothing found.',
};

export function wordingFor(language: string): AnswerWording {
  return toLang(language) === 'ru' ? ruWords : enWords;
}
