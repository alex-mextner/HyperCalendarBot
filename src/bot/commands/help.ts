// src/bot/commands/help.ts
import type { BotCommandContext } from '../types.ts';

const HELP_EN = `📖 <b>HyperCalendar Commands</b>

📅 <b>Schedule Views</b>
  /today — today's events
  /tomorrow — tomorrow's events
  /week — 7-day overview
  /month — monthly calendar

✏️ <b>Manage Events</b>
  /add — create event
  /edit — modify event
  /delete — remove event
  /search — find events

⚙️ <b>Settings</b>
  /settings — all preferences

📤 <b>Import/Export</b>
  /import — import .ics file

🌍 <b>Holidays</b>
  /holidays — manage holiday subscriptions
  /holidays list — upcoming holidays

📡 <b>Google Calendar</b>
  /connect_google — connect Google Calendar
  /disconnect_google — disconnect Google Calendar

🔧 <b>Other</b>
  /free — find free time slots
  /ping — check bot status
  /help — this message`;

const HELP_RU = `📖 <b>Команды HyperCalendar</b>

📅 <b>Расписание</b>
  /today — события сегодня
  /tomorrow — события завтра
  /week — обзор на 7 дней
  /month — месячный календарь

✏️ <b>Управление</b>
  /add — создать событие
  /edit — редактировать
  /delete — удалить
  /search — поиск событий

⚙️ <b>Настройки</b>
  /settings — все настройки

📤 <b>Импорт/Экспорт</b>
  /import — импорт .ics

🌍 <b>Праздники</b>
  /holidays — управление праздниками
  /holidays list — ближайшие праздники

📡 <b>Google Calendar</b>
  /connect_google — подключить Google Calendar
  /disconnect_google — отключить Google Calendar

🔧 <b>Другое</b>
  /free — свободные слоты
  /ping — проверка бота
  /help — это сообщение`;

export async function handleHelp(ctx: BotCommandContext): Promise<void> {
  const lang = ctx.dbUser?.language ?? 'en';
  await ctx.send(lang === 'ru' ? HELP_RU : HELP_EN, { parse_mode: 'HTML' });
}
