// src/bot/keyboards.ts
import { InlineKeyboard, Keyboard } from 'gramio';
import { CB, TZ_REGIONS } from '../config/constants.ts';
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
    .text(lang === 'ru' ? 'Описание' : 'Description', `${CB.EDIT_FIELD}:${eventId}:description`)
    .text(lang === 'ru' ? 'Место' : 'Location', `${CB.EDIT_FIELD}:${eventId}:location`)
    .row()
    .text(lang === 'ru' ? 'Отмена' : 'Cancel', `${CB.EDIT_FIELD}:cancel`);
}

export function recurringEditKeyboard(eventId: number, lang: 'en' | 'ru'): InlineKeyboard {
  return new InlineKeyboard()
    .text(lang === 'ru' ? 'Только это' : 'This only', `${CB.EVENT_RECURRENCE}:${eventId}:this`)
    .row()
    .text(lang === 'ru' ? 'Все будущие' : 'All future', `${CB.EVENT_RECURRENCE}:${eventId}:future`)
    .row()
    .text(lang === 'ru' ? 'Все вхождения' : 'All occurrences', `${CB.EVENT_RECURRENCE}:${eventId}:all`);
}

export function monthNavKeyboard(yearMonth: string): InlineKeyboard {
  const [y, m] = yearMonth.split('-').map(Number) as [number, number];
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return new InlineKeyboard().text('◀️', `${CB.MONTH_NAV}:${prev}`).text('▶️', `${CB.MONTH_NAV}:${next}`);
}

// ── Remove keyboard helper ──
export function removeKeyboard(): { reply_markup: { remove_keyboard: true } } {
  return { reply_markup: { remove_keyboard: true } };
}
