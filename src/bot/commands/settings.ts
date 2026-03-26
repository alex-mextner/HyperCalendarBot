// src/bot/commands/settings.ts
import { InlineKeyboard } from 'gramio';
import { z } from 'zod';
import { CB, t } from '../../config/constants.ts';
import type { CallSettingsRepository } from '../../database/repositories/call-settings.repository.ts';
import type { GroupChatRepository } from '../../database/repositories/group-chat.repository.ts';
import type { SharingSettingsRepository } from '../../database/repositories/sharing-settings.repository.ts';
import type { UserRepository } from '../../database/repositories/user.repository.ts';
import type { User } from '../../database/types.ts';
import type { NotificationPreferencesService } from '../../services/notification/preferences.ts';
import { getTimezoneDisplay } from '../../services/timezone/timezone-service.ts';
import { jsonCodec } from '../../utils/json-codec.ts';
import { getGroupId, isGroup } from '../group-context.ts';
import { countryPickerKeyboard, reminderIntervalsKeyboard } from '../keyboards.ts';
import type { BotCallbackContext, BotCommandContext } from '../types.ts';

const NumberArrayCodec = jsonCodec(z.array(z.number()));

export const pendingDurationInput = new Map<number, number>(); // userId → timestamp
export const pendingGroupTzInput = new Map<number, { chatId: number; ts: number; lang: 'en' | 'ru' }>(); // userId → { chatId, ts, lang }

export function settingsCategoryKeyboard(lang: 'en' | 'ru'): InlineKeyboard {
  const s = t(lang).settings;
  return new InlineKeyboard()
    .text(s.categoryGeneral, 'stg:general')
    .text(s.categoryNotifications, 'stg:notifications')
    .row()
    .text(s.categoryCalls, 'stg:calls')
    .text(s.categoryPrivacy, 'stg:privacy')
    .row()
    .text(s.categoryVoice, 'stg:voice')
    .row()
    .text(s.close, 'stg:close');
}

const VISIBILITIES = ['private', 'free_busy', 'full'] as const;
type Visibility = (typeof VISIBILITIES)[number];

function visLabel(v: string, lang: 'en' | 'ru'): string {
  const s = t(lang).settings;
  if (v === 'free_busy') return s.visibilityFreeBusy;
  if (v === 'full') return s.visibilityFull;
  return s.visibilityPrivate;
}

function backRow(kb: InlineKeyboard, lang: 'en' | 'ru'): InlineKeyboard {
  return kb.row().text(t(lang).settings.back, 'stg:back');
}

function fmtReminderInterval(m: number, lang: 'en' | 'ru'): string {
  const s = t(lang).settings;
  if (m === 0) return s.reminderAtStart;
  if (m >= 60) return lang === 'ru' ? `${m / 60}ч` : `${m / 60}h`;
  return lang === 'ru' ? `${m}мин` : `${m}min`;
}

// ─── General ─────────────────────────────────────────────────────────────────

export function buildGeneralText(
  tzDisplay: string,
  lang: string,
  country: string,
  defaultDurationMinutes: number,
): string {
  const ru = lang === 'ru';
  const durationLabel =
    defaultDurationMinutes >= 60 && defaultDurationMinutes % 60 === 0
      ? `${defaultDurationMinutes / 60}${ru ? 'ч' : 'h'}`
      : `${defaultDurationMinutes}${ru ? ' мин' : ' min'}`;
  return [
    ru ? '🌍 Основные настройки' : '🌍 General settings',
    '',
    `${ru ? 'Часовой пояс' : 'Timezone'}: ${tzDisplay}`,
    `${ru ? 'Язык' : 'Language'}: ${lang === 'ru' ? '🇷🇺 Русский' : '🇬🇧 English'}`,
    `${ru ? 'Страна' : 'Country'}: ${country}`,
    `${ru ? 'Длительность встреч' : 'Event duration'}: ${durationLabel}`,
    `  ${ru ? 'По умолчанию, если не указано время окончания.' : 'Default if no end time is specified.'}`,
  ].join('\n');
}

export function buildGeneralView(user: User): { text: string; kb: InlineKeyboard } {
  const tzDisplay = getTimezoneDisplay(user.timezone);
  const lang = (user.language ?? 'en') as 'en' | 'ru';
  const country = user.country_code ?? '—';
  const duration = user.default_event_duration_minutes ?? 60;
  const ru = lang === 'ru';
  const durationLabel =
    duration >= 60 && duration % 60 === 0 ? `${duration / 60}${ru ? 'ч' : 'h'}` : `${duration}${ru ? ' мин' : ' min'}`;
  const text = buildGeneralText(tzDisplay, lang, country, duration);
  const kb = new InlineKeyboard()
    .text(ru ? '🕐 Часовой пояс' : '🕐 Timezone', 'stg:change_tz')
    .row()
    .text(lang === 'ru' ? '✅ 🇷🇺 Русский' : '🇷🇺 Русский', 'stg:set_lang:ru')
    .text(lang === 'en' ? '✅ 🇬🇧 English' : '🇬🇧 English', 'stg:set_lang:en')
    .row()
    .text(ru ? '🏳️ Страна' : '🏳️ Country', 'stg:show_countries')
    .row()
    .text(ru ? `⏱ Длительность: ${durationLabel}` : `⏱ Duration: ${durationLabel}`, 'stg:edit_duration')
    .row()
    .text(ru ? '🔙 Назад' : '🔙 Back', 'stg:back');
  return { text, kb };
}

export function buildDurationView(currentMinutes: number, lang: 'en' | 'ru'): { text: string; kb: InlineKeyboard } {
  const ru = lang === 'ru';
  const fmt = (m: number) => (m >= 60 && m % 60 === 0 ? `${m / 60}${ru ? 'ч' : 'h'}` : `${m}${ru ? ' мин' : ' min'}`);
  const mark = (m: number) => (m === currentMinutes ? `✅ ${fmt(m)}` : fmt(m));
  const text = [
    ru ? '⏱ Длительность встреч по умолчанию' : '⏱ Default event duration',
    '',
    `${ru ? 'Текущая' : 'Current'}: ${fmt(currentMinutes)}`,
    ru ? 'Выберите или введите число минут:' : 'Select or type minutes:',
  ].join('\n');
  const kb = new InlineKeyboard()
    .text(mark(15), 'stg:set_duration:15')
    .text(mark(30), 'stg:set_duration:30')
    .text(mark(60), 'stg:set_duration:60')
    .row()
    .text(ru ? '🔙 Назад' : '🔙 Back', 'stg:general');
  return { text, kb };
}

// ─── Notifications ──────────────────────────────────────────────────────────

function buildNotificationsView(
  morningEnabled: boolean,
  morningTime: string,
  eveningEnabled: boolean,
  eveningTime: string,
  quietEnabled: boolean,
  quietStart: string | null,
  quietEnd: string | null,
  intervals: number[],
  lang: 'en' | 'ru',
): { text: string; kb: InlineKeyboard } {
  const s = t(lang).settings;
  const fmtTime = (on: boolean, time: string) => (on ? `✅ ${time}` : '❌');
  const fmtQuiet = (on: boolean, ss: string | null, e: string | null) => (on && ss && e ? `✅ ${ss}–${e}` : '❌');

  const text = [
    s.notificationsTitle,
    '',
    `${s.morningAgenda}: ${fmtTime(morningEnabled, morningTime)}`,
    `  ${s.morningAgendaDesc}`,
    `${s.eveningReview}: ${fmtTime(eveningEnabled, eveningTime)}`,
    `  ${s.eveningReviewDesc}`,
    `${s.quietHours}: ${fmtQuiet(quietEnabled, quietStart, quietEnd)}`,
    `  ${s.quietHoursDesc}`,
    `${s.reminders}: ${intervals.map((m) => fmtReminderInterval(m, lang)).join(', ')}`,
    `  ${s.remindersDesc}`,
  ].join('\n');

  const kb = backRow(
    new InlineKeyboard()
      .text(`${morningEnabled ? '✅' : '❌'} ${s.toggleMorning}`, 'stg:toggle_morning')
      .row()
      .text(`${eveningEnabled ? '✅' : '❌'} ${s.toggleEvening}`, 'stg:toggle_evening')
      .row()
      .text(`${quietEnabled ? '✅' : '❌'} ${s.toggleQuiet}`, 'stg:toggle_quiet')
      .row()
      .text(s.editReminders, 'stg:edit_reminders'),
    lang,
  );

  return { text, kb };
}

function buildReminderIntervalsView(intervals: number[], lang: 'en' | 'ru'): { text: string; kb: InlineKeyboard } {
  const s = t(lang).settings;
  const active =
    intervals.length > 0 ? intervals.map((m) => fmtReminderInterval(m, lang)).join(', ') : s.reminderIntervalsNone;
  const text = [s.reminderIntervalsTitle, '', s.reminderIntervalsActive(active), `  ${s.reminderIntervalsHint}`].join(
    '\n',
  );
  return { text, kb: reminderIntervalsKeyboard(intervals, lang) };
}

// ─── Calls ──────────────────────────────────────────────────────────────────

function buildCallsView(enabled: boolean, lang: 'en' | 'ru'): { text: string; kb: InlineKeyboard } {
  const s = t(lang).settings;
  const text = [
    s.callsTitle,
    '',
    enabled ? s.callsEnabled : s.callsDisabled,
    `  ${s.callsDesc1}`,
    `  ${s.callsDesc2}`,
    `  ${s.callsDesc3}`,
  ].join('\n');
  const kb = backRow(
    new InlineKeyboard().text(enabled ? s.toggleCallsDisable : s.toggleCallsEnable, 'stg:toggle_calls'),
    lang,
  );
  return { text, kb };
}

// ─── Privacy ────────────────────────────────────────────────────────────────

function buildPrivacyView(
  visibility: string,
  inlineEnabled: boolean,
  invitations: boolean,
  lang: 'en' | 'ru',
): { text: string; kb: InlineKeyboard } {
  const s = t(lang).settings;
  const visDesc: Record<string, string> = {
    private: s.visibilityPrivateDesc,
    free_busy: s.visibilityFreeBusyDesc,
    full: s.visibilityFullDesc,
  };
  const text = [
    s.privacyTitle,
    '',
    `${s.visibilityLabel}: ${visLabel(visibility, lang)}`,
    `  ${visDesc[visibility] ?? ''}`,
    `${s.inlineSearch}: ${inlineEnabled ? '✅' : '❌'}`,
    `  ${s.inlineSearchDesc}`,
    `${s.invitations}: ${invitations ? '✅' : '❌'}`,
    `  ${s.invitationsDesc}`,
  ].join('\n');

  const kb = backRow(
    new InlineKeyboard()
      .text(s.cycleVisibility(visLabel(visibility, lang)), 'stg:cycle_visibility')
      .row()
      .text(`${inlineEnabled ? '✅' : '❌'} ${s.inlineSearch}`, 'stg:toggle_inline')
      .row()
      .text(`${invitations ? '✅' : '❌'} ${s.invitations}`, 'stg:toggle_invitations'),
    lang,
  );

  return { text, kb };
}

// ─── Voice ──────────────────────────────────────────────────────────────────

function buildVoiceView(voiceEnabled: number | null, lang: 'en' | 'ru'): { text: string; kb: InlineKeyboard } {
  const s = t(lang).settings;
  const status = voiceEnabled === null ? s.voiceNotSet : voiceEnabled === 1 ? s.voiceEnabled : s.voiceDisabled;
  const text = [
    s.voiceTitle,
    '',
    `${s.voiceStatus}: ${status}`,
    `  ${s.voiceDesc1}`,
    `  ${s.voiceDesc2}`,
    `  ${s.voiceDesc3}`,
  ].join('\n');
  const kb = backRow(
    new InlineKeyboard().text(voiceEnabled === 1 ? s.toggleVoiceDisable : s.toggleVoiceEnable, 'stg:toggle_voice'),
    lang,
  );
  return { text, kb };
}

// ─── Group settings ──────────────────────────────────────────────────────────

async function handleGroupSettings(ctx: BotCommandContext, groupRepo: GroupChatRepository): Promise<void> {
  const user = ctx.dbUser;
  if (!user) return;
  const lang = (user.language ?? 'en') as 'en' | 'ru';
  const groupId = getGroupId(ctx);
  if (groupId === null) return;
  const group = groupRepo.findByChatId(groupId);

  const tz = group?.timezone ?? (lang === 'ru' ? '❌ не задана' : '❌ not set');
  const country = group?.country ?? (lang === 'ru' ? '❌ не задана' : '❌ not set');

  const text =
    lang === 'ru'
      ? `⚙️ <b>Настройки группы</b>\n\n🌍 Таймзона: <code>${tz}</code>\n🏳️ Страна: <code>${country}</code>`
      : `⚙️ <b>Group settings</b>\n\n🌍 Timezone: <code>${tz}</code>\n🏳️ Country: <code>${country}</code>`;

  const kb = new InlineKeyboard().text(
    lang === 'ru' ? '🌍 Изменить таймзону' : '🌍 Change timezone',
    `${CB.GROUP_SETTINGS_TZ}:select`,
  );

  await ctx.send(text, { parse_mode: 'HTML', reply_markup: kb });
}

// ─── Command entry point ─────────────────────────────────────────────────────

export async function handleSettings(ctx: BotCommandContext, groupRepo: GroupChatRepository): Promise<void> {
  if (isGroup(ctx)) {
    await handleGroupSettings(ctx, groupRepo);
    return;
  }
  const user = ctx.dbUser as User;
  const lang = (user.language ?? 'en') as 'en' | 'ru';
  await ctx.send(t(lang).settings.title, {
    reply_markup: settingsCategoryKeyboard(lang),
  });
}

// ─── Callback handler ────────────────────────────────────────────────────────

export async function handleSettingsCallback(
  ctx: BotCallbackContext,
  user: User,
  subAction: string,
  prefsService: NotificationPreferencesService,
  callSettingsRepo?: CallSettingsRepository,
  sharingSettingsRepo?: SharingSettingsRepository,
  userRepo?: UserRepository,
): Promise<void> {
  const lang = (user.language ?? 'en') as 'en' | 'ru';

  if (subAction === 'close') {
    await ctx.answer();
    await ctx.message?.delete();
    return;
  }

  if (subAction === 'back') {
    await ctx.answer();
    await ctx.editText(t(lang).settings.title, { reply_markup: settingsCategoryKeyboard(lang) });
    return;
  }

  if (
    subAction === 'general' ||
    subAction.startsWith('set_lang:') ||
    subAction.startsWith('set_country:') ||
    subAction === 'show_countries'
  ) {
    let currentUser = user;

    if (subAction.startsWith('set_lang:') && userRepo) {
      const newLang = subAction.split(':')[1] as 'en' | 'ru';
      const updated = userRepo.update(currentUser.telegram_id, { language: newLang });
      if (updated) currentUser = updated;
    }
    if (subAction.startsWith('set_country:') && userRepo) {
      const code = subAction.split(':')[1]!;
      const updated = userRepo.update(currentUser.telegram_id, { country_code: code });
      if (updated) currentUser = updated;
    }

    if (subAction === 'show_countries') {
      const currentLang = (currentUser.language ?? 'en') as 'en' | 'ru';
      await ctx.answer();
      await ctx.editText(t(currentLang).settings.showCountries, {
        reply_markup: countryPickerKeyboard(currentUser.country_code, currentLang),
      });
      return;
    }

    const { text, kb } = buildGeneralView(currentUser);
    await ctx.answer();
    await ctx.editText(text, { reply_markup: kb });
    return;
  }

  // ─── Notifications ─────────────────────────────────────────────────────────

  if (subAction === 'toggle_morning') prefsService.toggleMorningAgenda(user.telegram_id);
  else if (subAction === 'toggle_evening') prefsService.toggleEveningReview(user.telegram_id);
  else if (subAction === 'toggle_quiet') prefsService.toggleQuietHours(user.telegram_id);

  if (subAction === 'edit_reminders' || subAction.startsWith('toggle_reminder:')) {
    const prefs = prefsService.getOrCreate(user.telegram_id);
    let intervals = NumberArrayCodec.parse(prefs.default_reminder_intervals);

    if (subAction.startsWith('toggle_reminder:')) {
      const val = Number.parseInt(subAction.split(':')[1]!, 10);
      if (intervals.includes(val)) {
        intervals = intervals.filter((x) => x !== val);
      } else {
        intervals = [...intervals, val].sort((a, b) => a - b);
      }
      prefsService.updateDefaultIntervals(user.telegram_id, intervals);
    }

    const { text, kb } = buildReminderIntervalsView(intervals, lang);
    await ctx.answer();
    await ctx.editText(text, { reply_markup: kb });
    return;
  }

  if (
    subAction === 'notifications' ||
    subAction === 'toggle_morning' ||
    subAction === 'toggle_evening' ||
    subAction === 'toggle_quiet'
  ) {
    const prefs = prefsService.getOrCreate(user.telegram_id);
    const intervals = NumberArrayCodec.parse(prefs.default_reminder_intervals);
    const { text, kb } = buildNotificationsView(
      !!prefs.morning_agenda_enabled,
      prefs.morning_agenda_time,
      !!prefs.evening_review_enabled,
      prefs.evening_review_time,
      !!prefs.quiet_hours_enabled,
      prefs.quiet_hours_start,
      prefs.quiet_hours_end,
      intervals,
      lang,
    );
    await ctx.answer();
    await ctx.editText(text, { reply_markup: kb });
    return;
  }

  // ─── Calls ─────────────────────────────────────────────────────────────────

  if (subAction === 'calls' || subAction === 'toggle_calls') {
    let enabled = false;
    if (callSettingsRepo) {
      callSettingsRepo.ensureDefaults(user.telegram_id);
      if (subAction === 'toggle_calls') {
        const cur = callSettingsRepo.get(user.telegram_id);
        callSettingsRepo.setEnabled(user.telegram_id, !cur?.enabled);
      }
      enabled = !!callSettingsRepo.get(user.telegram_id)?.enabled;
    }
    const { text, kb } = buildCallsView(enabled, lang);
    await ctx.answer();
    await ctx.editText(text, { reply_markup: kb });
    return;
  }

  // ─── Privacy ───────────────────────────────────────────────────────────────

  if (sharingSettingsRepo) {
    sharingSettingsRepo.ensureDefaults(user.telegram_id);
    if (subAction === 'cycle_visibility') {
      const cur = (sharingSettingsRepo.get(user.telegram_id)?.default_visibility ?? 'private') as Visibility;
      const next = VISIBILITIES[(VISIBILITIES.indexOf(cur) + 1) % VISIBILITIES.length];
      sharingSettingsRepo.update(user.telegram_id, { default_visibility: next });
    } else if (subAction === 'toggle_inline') {
      const cur = sharingSettingsRepo.get(user.telegram_id);
      sharingSettingsRepo.update(user.telegram_id, { inline_mode_enabled: cur?.inline_mode_enabled ? 0 : 1 });
    } else if (subAction === 'toggle_invitations') {
      const cur = sharingSettingsRepo.get(user.telegram_id);
      sharingSettingsRepo.update(user.telegram_id, { allow_invitations: cur?.allow_invitations ? 0 : 1 });
    }
  }

  if (
    subAction === 'privacy' ||
    subAction === 'cycle_visibility' ||
    subAction === 'toggle_inline' ||
    subAction === 'toggle_invitations'
  ) {
    let visibility = 'private';
    let inlineEnabled = false;
    let invitations = false;
    if (sharingSettingsRepo) {
      const settings = sharingSettingsRepo.get(user.telegram_id);
      if (settings) {
        visibility = settings.default_visibility;
        inlineEnabled = !!settings.inline_mode_enabled;
        invitations = !!settings.allow_invitations;
      }
    }
    const { text, kb } = buildPrivacyView(visibility, inlineEnabled, invitations, lang);
    await ctx.answer();
    await ctx.editText(text, { reply_markup: kb });
    return;
  }

  // ─── Voice ─────────────────────────────────────────────────────────────────

  let currentUser = user;
  if (subAction === 'toggle_voice' && userRepo) {
    const toggled = user.voice_response_enabled === 1 ? 0 : 1;
    userRepo.update(user.telegram_id, { voice_response_enabled: toggled });
    currentUser = userRepo.findByTelegramId(user.telegram_id) ?? user;
  }

  if (subAction === 'voice' || subAction === 'toggle_voice') {
    const { text, kb } = buildVoiceView(currentUser.voice_response_enabled, lang);
    await ctx.answer();
    await ctx.editText(text, { reply_markup: kb });
    return;
  }

  if (subAction === 'edit_duration') {
    const duration = user.default_event_duration_minutes ?? 60;
    const { text, kb } = buildDurationView(duration, lang);
    pendingDurationInput.set(user.telegram_id, Date.now());
    await ctx.answer();
    await ctx.editText(text, { reply_markup: kb });
    return;
  }

  if (subAction.startsWith('set_duration:') && userRepo) {
    const mins = Number.parseInt(subAction.split(':')[1]!, 10);
    if (mins > 0 && mins <= 1440) {
      userRepo.update(user.telegram_id, { default_event_duration_minutes: mins });
      pendingDurationInput.delete(user.telegram_id);
    }
    const updated = userRepo.findByTelegramId(user.telegram_id) ?? user;
    const updatedLang = (updated.language ?? 'en') as 'en' | 'ru';
    const { text, kb } = buildDurationView(updated.default_event_duration_minutes ?? 60, updatedLang);
    await ctx.answer();
    await ctx.editText(text, { reply_markup: kb });
    return;
  }

  await ctx.answer();
}
