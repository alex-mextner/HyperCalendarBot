// src/bot/handlers/notify-callback.ts
// Handles inline keyboard callbacks for notification preferences (CB.NOTIFY / 'nf:' prefix).

import type { Lang } from '../../config/constants.ts';
import { MSG } from '../../config/constants.ts';
import type { User } from '../../database/types.ts';
import type { NotificationPreferencesService } from '../../services/notification/preferences.ts';
import {
  notifyEveningKeyboard,
  notifyHourPickerKeyboard,
  notifyMenuKeyboard,
  notifyMinutePickerKeyboard,
  notifyMorningKeyboard,
  notifyQuietKeyboard,
  notifyReminderIntervalsKeyboard,
} from '../keyboards.ts';
import type { BotCallbackContext } from '../types.ts';

function buildMenuText(prefsService: NotificationPreferencesService, userId: number, lang: Lang): string {
  const prefs = prefsService.getOrCreate(userId);
  const msgs = MSG[lang];
  const intervals = JSON.parse(prefs.default_reminder_intervals) as number[];
  const lines = [
    msgs.notify_menu,
    '',
    msgs.notify_morning_status(!!prefs.morning_agenda_enabled, prefs.morning_agenda_time),
    msgs.notify_intervals_label(intervals),
    msgs.notify_evening_status(!!prefs.evening_review_enabled, prefs.evening_review_time),
    msgs.notify_quiet_status(
      !!prefs.quiet_hours_enabled,
      prefs.quiet_hours_start ?? '23:00',
      prefs.quiet_hours_end ?? '07:00',
    ),
  ];
  return lines.join('\n');
}

export async function handleNotifyCallback(
  ctx: BotCallbackContext,
  prefsService: NotificationPreferencesService,
  user: User,
  payload: string,
): Promise<void> {
  const lang = (user.language ?? 'en') as Lang;
  const parts = payload.split(':');
  const section = parts[0]!;
  const action = parts[1];

  if (section === 'menu') {
    await ctx.answer();
    const text = buildMenuText(prefsService, user.telegram_id, lang);
    await ctx.editText(text, { parse_mode: 'HTML', reply_markup: notifyMenuKeyboard(lang) });
    return;
  }

  if (section === 'morning') {
    await handleMorningSection(ctx, prefsService, user, lang, action, parts);
    return;
  }

  if (section === 'evening') {
    await handleEveningSection(ctx, prefsService, user, lang, action, parts);
    return;
  }

  if (section === 'reminders') {
    await handleRemindersSection(ctx, prefsService, user, lang, action, parts);
    return;
  }

  if (section === 'quiet') {
    await handleQuietSection(ctx, prefsService, user, lang, action);
    return;
  }

  if (section === 'quiet_start' || section === 'quiet_end') {
    await handleQuietTimePicker(ctx, prefsService, user, lang, section, action, parts);
    return;
  }

  await ctx.answer();
}

async function handleMorningSection(
  ctx: BotCallbackContext,
  prefsService: NotificationPreferencesService,
  user: User,
  lang: Lang,
  action: string | undefined,
  parts: string[],
): Promise<void> {
  const msgs = MSG[lang];

  if (!action) {
    await ctx.answer();
    const prefs = prefsService.getOrCreate(user.telegram_id);
    await ctx.editText(
      `${msgs.notify_morning}\n\n${msgs.notify_morning_status(!!prefs.morning_agenda_enabled, prefs.morning_agenda_time)}`,
      { reply_markup: notifyMorningKeyboard(!!prefs.morning_agenda_enabled, lang) },
    );
    return;
  }

  if (action === 'toggle') {
    prefsService.toggleMorningAgenda(user.telegram_id);
    await ctx.answer({ text: msgs.notify_updated });
    const prefs = prefsService.getOrCreate(user.telegram_id);
    await ctx.editText(
      `${msgs.notify_morning}\n\n${msgs.notify_morning_status(!!prefs.morning_agenda_enabled, prefs.morning_agenda_time)}`,
      { reply_markup: notifyMorningKeyboard(!!prefs.morning_agenda_enabled, lang) },
    );
    return;
  }

  if (action === 'time') {
    await ctx.answer();
    await ctx.editText(msgs.notify_pick_hour, { reply_markup: notifyHourPickerKeyboard('morning', lang) });
    return;
  }

  if (action === 'hour') {
    const hour = parts[2]!;
    await ctx.answer();
    await ctx.editText(msgs.notify_pick_minute, { reply_markup: notifyMinutePickerKeyboard('morning', hour, lang) });
    return;
  }

  if (action === 'minute') {
    const hour = parts[2]!;
    const minute = parts[3]!;
    const time = `${hour}:${minute}`;
    prefsService.updateMorningTime(user.telegram_id, time);
    await ctx.answer({ text: msgs.notify_updated });
    const prefs = prefsService.getOrCreate(user.telegram_id);
    await ctx.editText(
      `${msgs.notify_morning}\n\n${msgs.notify_morning_status(!!prefs.morning_agenda_enabled, prefs.morning_agenda_time)}`,
      { reply_markup: notifyMorningKeyboard(!!prefs.morning_agenda_enabled, lang) },
    );
    return;
  }

  await ctx.answer();
}

async function handleEveningSection(
  ctx: BotCallbackContext,
  prefsService: NotificationPreferencesService,
  user: User,
  lang: Lang,
  action: string | undefined,
  parts: string[],
): Promise<void> {
  const msgs = MSG[lang];

  if (!action) {
    await ctx.answer();
    const prefs = prefsService.getOrCreate(user.telegram_id);
    await ctx.editText(
      `${msgs.notify_evening}\n\n${msgs.notify_evening_status(!!prefs.evening_review_enabled, prefs.evening_review_time)}`,
      { reply_markup: notifyEveningKeyboard(!!prefs.evening_review_enabled, lang) },
    );
    return;
  }

  if (action === 'toggle') {
    prefsService.toggleEveningReview(user.telegram_id);
    await ctx.answer({ text: msgs.notify_updated });
    const prefs = prefsService.getOrCreate(user.telegram_id);
    await ctx.editText(
      `${msgs.notify_evening}\n\n${msgs.notify_evening_status(!!prefs.evening_review_enabled, prefs.evening_review_time)}`,
      { reply_markup: notifyEveningKeyboard(!!prefs.evening_review_enabled, lang) },
    );
    return;
  }

  if (action === 'time') {
    await ctx.answer();
    await ctx.editText(msgs.notify_pick_hour, { reply_markup: notifyHourPickerKeyboard('evening', lang) });
    return;
  }

  if (action === 'hour') {
    const hour = parts[2]!;
    await ctx.answer();
    await ctx.editText(msgs.notify_pick_minute, { reply_markup: notifyMinutePickerKeyboard('evening', hour, lang) });
    return;
  }

  if (action === 'minute') {
    const hour = parts[2]!;
    const minute = parts[3]!;
    const time = `${hour}:${minute}`;
    prefsService.updateEveningTime(user.telegram_id, time);
    await ctx.answer({ text: msgs.notify_updated });
    const prefs = prefsService.getOrCreate(user.telegram_id);
    await ctx.editText(
      `${msgs.notify_evening}\n\n${msgs.notify_evening_status(!!prefs.evening_review_enabled, prefs.evening_review_time)}`,
      { reply_markup: notifyEveningKeyboard(!!prefs.evening_review_enabled, lang) },
    );
    return;
  }

  await ctx.answer();
}

async function handleRemindersSection(
  ctx: BotCallbackContext,
  prefsService: NotificationPreferencesService,
  user: User,
  lang: Lang,
  action: string | undefined,
  parts: string[],
): Promise<void> {
  const msgs = MSG[lang];

  const showMenu = async () => {
    const intervals = prefsService.resolveDefaultIntervals(user.telegram_id);
    await ctx.editText(`${msgs.notify_reminders}\n\n${msgs.notify_intervals_label(intervals)}`, {
      reply_markup: notifyReminderIntervalsKeyboard(intervals, lang),
    });
  };

  if (!action) {
    await ctx.answer();
    await showMenu();
    return;
  }

  if (action === 'toggle') {
    const minutes = Number(parts[2]);
    const intervals = prefsService.resolveDefaultIntervals(user.telegram_id);
    const idx = intervals.indexOf(minutes);
    if (idx >= 0) {
      intervals.splice(idx, 1);
    } else {
      intervals.push(minutes);
      intervals.sort((a, b) => a - b);
    }
    prefsService.updateDefaultIntervals(user.telegram_id, intervals);
    await ctx.answer({ text: msgs.notify_updated });
    await showMenu();
    return;
  }

  await ctx.answer();
}

async function handleQuietSection(
  ctx: BotCallbackContext,
  prefsService: NotificationPreferencesService,
  user: User,
  lang: Lang,
  action: string | undefined,
): Promise<void> {
  const msgs = MSG[lang];

  const showMenu = async () => {
    const prefs = prefsService.getOrCreate(user.telegram_id);
    await ctx.editText(
      `${msgs.notify_quiet}\n\n${msgs.notify_quiet_status(!!prefs.quiet_hours_enabled, prefs.quiet_hours_start ?? '23:00', prefs.quiet_hours_end ?? '07:00')}`,
      { reply_markup: notifyQuietKeyboard(!!prefs.quiet_hours_enabled, lang) },
    );
  };

  if (!action) {
    await ctx.answer();
    await showMenu();
    return;
  }

  if (action === 'toggle') {
    prefsService.toggleQuietHours(user.telegram_id);
    const prefs = prefsService.getOrCreate(user.telegram_id);
    if (prefs.quiet_hours_enabled && !prefs.quiet_hours_start) {
      prefsService.updateQuietHoursStart(user.telegram_id, '23:00');
      prefsService.updateQuietHoursEnd(user.telegram_id, '07:00');
    }
    await ctx.answer({ text: msgs.notify_updated });
    await showMenu();
    return;
  }

  if (action === 'start') {
    await ctx.answer();
    await ctx.editText(msgs.notify_pick_hour, { reply_markup: notifyHourPickerKeyboard('quiet_start', lang) });
    return;
  }

  if (action === 'end') {
    await ctx.answer();
    await ctx.editText(msgs.notify_pick_hour, { reply_markup: notifyHourPickerKeyboard('quiet_end', lang) });
    return;
  }

  await ctx.answer();
}

async function handleQuietTimePicker(
  ctx: BotCallbackContext,
  prefsService: NotificationPreferencesService,
  user: User,
  lang: Lang,
  section: string,
  action: string | undefined,
  parts: string[],
): Promise<void> {
  const msgs = MSG[lang];

  if (action === 'hour') {
    const hour = parts[2]!;
    await ctx.answer();
    await ctx.editText(msgs.notify_pick_minute, { reply_markup: notifyMinutePickerKeyboard(section, hour, lang) });
    return;
  }

  if (action === 'minute') {
    const hour = parts[2]!;
    const minute = parts[3]!;
    const time = `${hour}:${minute}`;
    if (section === 'quiet_start') {
      prefsService.updateQuietHoursStart(user.telegram_id, time);
    } else {
      prefsService.updateQuietHoursEnd(user.telegram_id, time);
    }
    await ctx.answer({ text: msgs.notify_updated });
    const prefs = prefsService.getOrCreate(user.telegram_id);
    await ctx.editText(
      `${msgs.notify_quiet}\n\n${msgs.notify_quiet_status(!!prefs.quiet_hours_enabled, prefs.quiet_hours_start ?? '23:00', prefs.quiet_hours_end ?? '07:00')}`,
      { reply_markup: notifyQuietKeyboard(!!prefs.quiet_hours_enabled, lang) },
    );
    return;
  }

  await ctx.answer();
}
