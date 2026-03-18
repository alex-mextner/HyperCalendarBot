// src/bot/keyboards.ts
import { InlineKeyboard, Keyboard } from 'gramio';
import { CB, TZ_REGIONS, t } from '../config/constants.ts';
import type { Contact } from '../database/repositories/contact.repository.ts';
import type { CalendarEvent } from '../database/types.ts';
import { formatTime } from '../utils/date.ts';

// ── Onboarding ──

export function languageKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text('English', `${CB.ONBOARD_LANG}:en`).text('Русский', `${CB.ONBOARD_LANG}:ru`);
}

export function timezoneMethodKeyboard(lang: 'en' | 'ru'): Keyboard {
  const locationText = lang === 'ru' ? '📍 Отправить геолокацию' : '📍 Share Location';
  return new Keyboard().requestLocation(locationText).resized().oneTime();
}

export function timezoneManualKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  const regions = Object.keys(TZ_REGIONS);
  for (const region of regions) {
    kb.text(region, `${CB.ONBOARD_TZ_REGION}:${region}`);
  }
  return kb;
}

export function timezoneCitiesKeyboard(region: string): InlineKeyboard {
  const cities = TZ_REGIONS[region] ?? [];
  const kb = new InlineKeyboard();
  for (let i = 0; i < cities.length; i++) {
    const tz = cities[i]!;
    const city = tz.split('/').pop()!.replace(/_/g, ' ');
    kb.text(city, `${CB.ONBOARD_TZ}:${tz}`);
    if (i % 2 === 1) kb.row();
  }
  return kb;
}

export function timezoneConfirmKeyboard(lang: 'en' | 'ru'): InlineKeyboard {
  return new InlineKeyboard()
    .text(lang === 'ru' ? 'Да ✓' : 'Yes ✓', `${CB.ONBOARD_TZ}:confirm`)
    .text(lang === 'ru' ? 'Нет, вручную' : 'No, choose manually', `${CB.ONBOARD_TZ}:manual`);
}

export function countryKeyboard(countryCode: string | null, lang: 'en' | 'ru'): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (countryCode) {
    const label = lang === 'ru' ? `Да, ${countryCode}` : `Yes, ${countryCode}`;
    kb.text(label, `${CB.ONBOARD_COUNTRY}:${countryCode}`);
  }
  kb.text(lang === 'ru' ? 'Пропустить' : 'Skip', `${CB.ONBOARD_COUNTRY}:skip`);
  return kb;
}

// ── Event actions ──

export function eventActionsKeyboard(eventId: number, lang: 'en' | 'ru'): InlineKeyboard {
  return new InlineKeyboard()
    .text(lang === 'ru' ? '✏️ Редактировать' : '✏️ Edit', `${CB.EVENT_EDIT}:${eventId}`)
    .text(lang === 'ru' ? '🗑 Удалить' : '🗑 Delete', `${CB.EVENT_DELETE}:${eventId}`);
}

export function deleteConfirmKeyboard(eventId: number, lang: 'en' | 'ru'): InlineKeyboard {
  return new InlineKeyboard()
    .text(lang === 'ru' ? 'Да, удалить' : 'Yes, delete', `${CB.EVENT_DELETE_CONFIRM}:${eventId}`)
    .text(lang === 'ru' ? 'Отмена' : 'Cancel', `${CB.EVENT_DELETE}:cancel`);
}

export function eventPickerKeyboard(events: CalendarEvent[], timezone: string, prefix: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (let i = 0; i < events.length && i < 10; i++) {
    const e = events[i]!;
    const time = formatTime(e.start_at, timezone);
    kb.text(`${i + 1}. ${time} ${e.title.slice(0, 20)}`, `${prefix}:${e.id}`).row();
  }
  kb.text('Cancel', `${prefix}:cancel`);
  return kb;
}

export function editFieldKeyboard(eventId: number, lang: 'en' | 'ru'): InlineKeyboard {
  return new InlineKeyboard()
    .text(lang === 'ru' ? 'Название' : 'Title', `${CB.EDIT_FIELD}:${eventId}:title`)
    .text(lang === 'ru' ? 'Время' : 'Time', `${CB.EDIT_FIELD}:${eventId}:time`)
    .row()
    .text(lang === 'ru' ? 'Длительность' : 'Duration', `${CB.EDIT_FIELD}:${eventId}:duration`)
    .text(lang === 'ru' ? 'Описание' : 'Description', `${CB.EDIT_FIELD}:${eventId}:description`)
    .row()
    .text(lang === 'ru' ? 'Место' : 'Location', `${CB.EDIT_FIELD}:${eventId}:location`)
    .text(lang === 'ru' ? 'Отмена' : 'Cancel', `${CB.EDIT_FIELD}:cancel`);
}

export function recurringEditKeyboard(eventId: number, occurrenceDate: string, lang: 'en' | 'ru'): InlineKeyboard {
  return new InlineKeyboard()
    .text(lang === 'ru' ? 'Только это' : 'This only', `${CB.EVENT_RECURRENCE}:${eventId}:${occurrenceDate}:this`)
    .row()
    .text(lang === 'ru' ? 'Все будущие' : 'All future', `${CB.EVENT_RECURRENCE}:${eventId}:${occurrenceDate}:future`);
}

// Occurrence-aware event actions keyboard (for recurring event detail view)
export function eventActionsKeyboardOcc(eventId: number, occurrenceDate: string, lang: 'en' | 'ru'): InlineKeyboard {
  return new InlineKeyboard()
    .text(lang === 'ru' ? '✏️ Редактировать' : '✏️ Edit', `${CB.EVENT_EDIT}:${eventId}:${occurrenceDate}`)
    .text(lang === 'ru' ? '🗑 Удалить' : '🗑 Delete', `${CB.EVENT_DELETE}:${eventId}:${occurrenceDate}`);
}

// Recurrence selection for add-event scene
export function recurrenceKeyboard(lang: 'en' | 'ru'): InlineKeyboard {
  return new InlineKeyboard()
    .text(lang === 'ru' ? 'Не повторять' : "Don't repeat", `${CB.ADD_RECURRENCE}:none`)
    .row()
    .text(lang === 'ru' ? 'Каждый день' : 'Daily', `${CB.ADD_RECURRENCE}:DAILY`)
    .text(lang === 'ru' ? 'Каждую неделю' : 'Weekly', `${CB.ADD_RECURRENCE}:WEEKLY`)
    .row()
    .text(lang === 'ru' ? 'Каждый месяц' : 'Monthly', `${CB.ADD_RECURRENCE}:MONTHLY`)
    .text(lang === 'ru' ? 'Каждый год' : 'Yearly', `${CB.ADD_RECURRENCE}:YEARLY`)
    .row()
    .text(lang === 'ru' ? 'Другое...' : 'Custom...', `${CB.ADD_RECURRENCE}:custom`);
}

// Recurrence end for add-event scene
export function recurrenceEndKeyboard(lang: 'en' | 'ru'): InlineKeyboard {
  return new InlineKeyboard()
    .text(lang === 'ru' ? 'Бесконечно' : 'No end', `${CB.ADD_REC_END}:forever`)
    .row()
    .text(lang === 'ru' ? 'До даты' : 'Until date', `${CB.ADD_REC_END}:until`)
    .text(lang === 'ru' ? 'N повторений' : 'N times', `${CB.ADD_REC_END}:count`);
}

// Skip button for optional scene steps
export function skipKeyboard(lang: 'en' | 'ru', stepIndex: number): InlineKeyboard {
  return new InlineKeyboard().text(lang === 'ru' ? 'Пропустить' : 'Skip', `${CB.ADD_SKIP}:${stepIndex}`);
}

// Scope keyboard for recurring event edit/delete actions
export function recurrenceScopeKeyboard(
  prefix: string,
  eventId: number,
  occurrenceDate: string,
  lang: 'en' | 'ru',
): InlineKeyboard {
  return new InlineKeyboard()
    .text(lang === 'ru' ? 'Только это' : 'This only', `${prefix}:${eventId}:${occurrenceDate}:this`)
    .row()
    .text(lang === 'ru' ? 'Все будущие' : 'All future', `${prefix}:${eventId}:${occurrenceDate}:future`);
}

// ── Holiday keyboards ──

export function holidaysMenuKeyboard(lang: 'en' | 'ru'): InlineKeyboard {
  return new InlineKeyboard()
    .text(lang === 'ru' ? '+ Добавить' : '+ Add', `${CB.HOLIDAYS}:add`)
    .text(lang === 'ru' ? 'Управление' : 'Manage', `${CB.HOLIDAYS}:manage`)
    .row()
    .text(lang === 'ru' ? 'Ближайшие' : 'Upcoming', `${CB.HOLIDAYS}:list`);
}

export function holidayRegionKeyboard(regions: string[], lang: 'en' | 'ru'): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const region of regions) {
    kb.text(region, `${CB.HOLIDAYS}:add:${region}`).row();
  }
  kb.text(lang === 'ru' ? '← Назад' : '← Back', `${CB.HOLIDAYS}:menu`);
  return kb;
}

const COUNTRIES_PER_PAGE = 8;

export function holidayCountryKeyboard(
  countries: { code: string; name: string }[],
  region: string,
  page: number,
  lang: 'en' | 'ru',
): InlineKeyboard {
  const kb = new InlineKeyboard();
  const start = page * COUNTRIES_PER_PAGE;
  const slice = countries.slice(start, start + COUNTRIES_PER_PAGE);

  for (const c of slice) {
    kb.text(c.name, `${CB.HOLIDAYS}:sub:${c.code}`).row();
  }

  const totalPages = Math.ceil(countries.length / COUNTRIES_PER_PAGE);
  if (totalPages > 1) {
    if (page > 0) {
      kb.text('◀️', `${CB.HOLIDAYS}:add:${region}:${page - 1}`);
    }
    kb.text(`${page + 1}/${totalPages}`, `${CB.HOLIDAYS}:noop`);
    if (page < totalPages - 1) {
      kb.text('▶️', `${CB.HOLIDAYS}:add:${region}:${page + 1}`);
    }
    kb.row();
  }

  kb.text(lang === 'ru' ? '← Регионы' : '← Regions', `${CB.HOLIDAYS}:add`);
  return kb;
}

export function holidayManageListKeyboard(
  subs: { country_code: string; countryName: string; is_primary: number }[],
  lang: 'en' | 'ru',
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const sub of subs) {
    const primary = sub.is_primary ? ' ⭐' : '';
    kb.text(`${sub.countryName}${primary}`, `${CB.HOLIDAYS}:manage:${sub.country_code}`).row();
  }
  kb.text(lang === 'ru' ? '← Назад' : '← Back', `${CB.HOLIDAYS}:menu`);
  return kb;
}

export function holidayManageCountryKeyboard(
  countryCode: string,
  isPrimary: boolean,
  isNotifyOn: boolean,
  lang: 'en' | 'ru',
): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (!isPrimary) {
    kb.text(lang === 'ru' ? '⭐ Основная' : '⭐ Set Primary', `${CB.HOLIDAYS}:primary:${countryCode}`).row();
  }
  const notifyLabel = isNotifyOn
    ? lang === 'ru'
      ? '🔔 Уведомления: ВКЛ'
      : '🔔 Notifications: ON'
    : lang === 'ru'
      ? '🔕 Уведомления: ВЫКЛ'
      : '🔕 Notifications: OFF';
  kb.text(notifyLabel, `${CB.HOLIDAYS}:notify:${countryCode}`).row();
  kb.text(lang === 'ru' ? '🗑 Удалить' : '🗑 Remove', `${CB.HOLIDAYS}:remove:${countryCode}`).row();
  kb.text(lang === 'ru' ? '← Назад' : '← Back', `${CB.HOLIDAYS}:manage`);
  return kb;
}

export function monthNavKeyboard(yearMonth: string): InlineKeyboard {
  const [y, m] = yearMonth.split('-').map(Number) as [number, number];
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return new InlineKeyboard().text('◀️', `${CB.MONTH_NAV}:${prev}`).text('▶️', `${CB.MONTH_NAV}:${next}`);
}

// ── Notification keyboards ──

export function notifyMenuKeyboard(lang: 'en' | 'ru'): InlineKeyboard {
  const msgs = t(lang);
  return new InlineKeyboard()
    .text(msgs.notify_morning as string, `${CB.NOTIFY}:morning`)
    .text(msgs.notify_reminders as string, `${CB.NOTIFY}:reminders`)
    .row()
    .text(msgs.notify_evening as string, `${CB.NOTIFY}:evening`)
    .text(msgs.notify_quiet as string, `${CB.NOTIFY}:quiet`)
    .row();
}

export function notifyMorningKeyboard(enabled: boolean): InlineKeyboard {
  const kb = new InlineKeyboard();
  kb.text(enabled ? '❌ Disable' : '✅ Enable', `${CB.NOTIFY}:morning:toggle`);
  kb.text('🕐 Change Time', `${CB.NOTIFY}:morning:time`);
  kb.row();
  kb.text('← Back', `${CB.NOTIFY}:menu`);
  return kb;
}

export function notifyHourPickerKeyboard(section: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (let h = 5; h <= 12; h++) {
    kb.text(String(h).padStart(2, '0'), `${CB.NOTIFY}:${section}:hour:${String(h).padStart(2, '0')}`);
    if ((h - 4) % 4 === 0) kb.row();
  }
  for (let h = 13; h <= 23; h++) {
    kb.text(String(h).padStart(2, '0'), `${CB.NOTIFY}:${section}:hour:${String(h).padStart(2, '0')}`);
    if ((h - 12) % 4 === 0) kb.row();
  }
  kb.text('← Back', `${CB.NOTIFY}:${section}`);
  return kb;
}

export function notifyMinutePickerKeyboard(section: string, hour: string): InlineKeyboard {
  return new InlineKeyboard()
    .text(':00', `${CB.NOTIFY}:${section}:minute:${hour}:00`)
    .text(':15', `${CB.NOTIFY}:${section}:minute:${hour}:15`)
    .text(':30', `${CB.NOTIFY}:${section}:minute:${hour}:30`)
    .text(':45', `${CB.NOTIFY}:${section}:minute:${hour}:45`)
    .row()
    .text('← Back', `${CB.NOTIFY}:${section}:time`);
}

export function notifyReminderIntervalsKeyboard(activeIntervals: number[]): InlineKeyboard {
  const ALL = [0, 5, 15, 30, 60, 1440];
  const labels: Record<number, string> = {
    0: 'at start',
    5: '5min',
    15: '15min',
    30: '30min',
    60: '1hr',
    1440: '1day',
  };
  const kb = new InlineKeyboard();
  for (let i = 0; i < ALL.length; i++) {
    const m = ALL[i]!;
    const active = activeIntervals.includes(m);
    kb.text(`${labels[m]} ${active ? '✅' : '❌'}`, `${CB.NOTIFY}:reminders:toggle:${m}`);
    if ((i + 1) % 3 === 0) kb.row();
  }
  kb.row();
  kb.text('← Back', `${CB.NOTIFY}:menu`);
  return kb;
}

export function notifyEveningKeyboard(enabled: boolean): InlineKeyboard {
  const kb = new InlineKeyboard();
  kb.text(enabled ? '❌ Disable' : '✅ Enable', `${CB.NOTIFY}:evening:toggle`);
  kb.text('🕐 Change Time', `${CB.NOTIFY}:evening:time`);
  kb.row();
  kb.text('← Back', `${CB.NOTIFY}:menu`);
  return kb;
}

export function notifyQuietKeyboard(enabled: boolean): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (enabled) {
    kb.text('❌ Disable', `${CB.NOTIFY}:quiet:toggle`);
    kb.row();
    kb.text('🕐 Change Start', `${CB.NOTIFY}:quiet:start`);
    kb.text('🕐 Change End', `${CB.NOTIFY}:quiet:end`);
  } else {
    kb.text('✅ Enable', `${CB.NOTIFY}:quiet:toggle`);
  }
  kb.row();
  kb.text('← Back', `${CB.NOTIFY}:menu`);
  return kb;
}

// ── Invite keyboards ──

export function inviteContactPickerKeyboard(contacts: Contact[], eventId: number, lang: 'en' | 'ru'): InlineKeyboard {
  const kb = new InlineKeyboard();
  const withId = contacts.filter((c) => c.telegram_id !== null);
  for (const c of withId) {
    const name = c.preferred_name ?? c.name;
    const label = c.username ? `${name} @${c.username}` : name;
    kb.text(label.slice(0, 40), `${CB.INVITE_CONTACT}:${eventId}:${c.telegram_id}`).row();
  }
  kb.text(lang === 'ru' ? '👤 Другой пользователь' : '👤 Other user', `${CB.INVITE_CONTACT}:${eventId}:picker`).row();
  kb.text(lang === 'ru' ? '👥 Групповой чат' : '👥 Group chat', `${CB.INVITE_CONTACT}:${eventId}:chat`).row();
  kb.text(lang === 'ru' ? '❌ Отмена' : '❌ Cancel', `${CB.INVITE_CONTACT}:cancel`);
  return kb;
}

// ── Unshare keyboards ──

export function unsharePickerKeyboard(items: { eventId: number; title: string }[], lang: 'en' | 'ru'): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const item of items) {
    kb.text(item.title.slice(0, 40), `${CB.UNSHARE_PICK}:${item.eventId}`).row();
  }
  kb.text(lang === 'ru' ? '❌ Отмена' : '❌ Cancel', `${CB.UNSHARE_PICK}:cancel`);
  return kb;
}

// ── Remove keyboard helper ──
export function removeKeyboard(): { reply_markup: { remove_keyboard: true } } {
  return { reply_markup: { remove_keyboard: true } };
}
