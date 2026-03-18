// src/bot/commands/settings.ts
import { InlineKeyboard } from 'gramio';
import type { CallSettingsRepository } from '../../database/repositories/call-settings.repository.ts';
import type { SharingSettingsRepository } from '../../database/repositories/sharing-settings.repository.ts';
import type { UserRepository } from '../../database/repositories/user.repository.ts';
import type { User } from '../../database/types.ts';
import type { NotificationPreferencesService } from '../../services/notification/preferences.ts';
import { getTimezoneDisplay } from '../../services/timezone/timezone-service.ts';
import type { BotCallbackContext, BotCommandContext } from '../types.ts';

export function settingsCategoryKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🌍 Основные', 'stg:general')
    .text('🔔 Уведомления', 'stg:notifications')
    .row()
    .text('📞 Звонки', 'stg:calls')
    .text('🔒 Приватность', 'stg:privacy')
    .row()
    .text('🎤 Голос', 'stg:voice');
}

const VISIBILITIES = ['private', 'free_busy', 'full'] as const;
type Visibility = (typeof VISIBILITIES)[number];

function visLabel(v: string): string {
  if (v === 'free_busy') return 'Занят/свободен';
  if (v === 'full') return 'Полный доступ';
  return 'Приватно';
}

function backRow(kb: InlineKeyboard): InlineKeyboard {
  return kb.row().text('🔙 Назад', 'stg:back');
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
): { text: string; kb: InlineKeyboard } {
  const fmtTime = (on: boolean, time: string) => (on ? `✅ ${time}` : '❌');
  const fmtQuiet = (on: boolean, s: string | null, e: string | null) => (on && s && e ? `✅ ${s}–${e}` : '❌');
  const fmtInterval = (m: number) => (m === 0 ? 'в начале' : m >= 60 ? `${m / 60}ч` : `${m}мин`);

  const text = [
    '🔔 Уведомления',
    '',
    `Утренняя сводка: ${fmtTime(morningEnabled, morningTime)}`,
    '  Краткая повестка дня отправляется каждое утро.',
    `Вечерний обзор: ${fmtTime(eveningEnabled, eveningTime)}`,
    '  Список событий на завтра — удобно проверить перед сном.',
    `Тихие часы: ${fmtQuiet(quietEnabled, quietStart, quietEnd)}`,
    '  Напоминания и звонки не беспокоят в это время.',
    `Напоминания: ${intervals.map(fmtInterval).join(', ')}`,
    '  За сколько до события бот присылает напоминание.',
    '  Чтобы изменить — напишите AI: «напомни за 10 и 30 минут».',
  ].join('\n');

  const kb = backRow(
    new InlineKeyboard()
      .text(`${morningEnabled ? '✅' : '❌'} Утренняя сводка`, 'stg:toggle_morning')
      .row()
      .text(`${eveningEnabled ? '✅' : '❌'} Вечерний обзор`, 'stg:toggle_evening')
      .row()
      .text(`${quietEnabled ? '✅' : '❌'} Тихие часы`, 'stg:toggle_quiet'),
  );

  return { text, kb };
}

// ─── Calls ──────────────────────────────────────────────────────────────────

function buildCallsView(enabled: boolean): { text: string; kb: InlineKeyboard } {
  const text = [
    '📞 Голосовые звонки',
    '',
    `Звонки-напоминания: ${enabled ? '✅ Включены' : '❌ Отключены'}`,
    '  Бот позвонит вам перед событием и зачитает название.',
    '  Работает через Telegram-звонок — не нужен номер телефона.',
    '  Тихие часы распространяются и на звонки.',
  ].join('\n');
  const kb = backRow(
    new InlineKeyboard().text(enabled ? '❌ Отключить звонки' : '✅ Включить звонки', 'stg:toggle_calls'),
  );
  return { text, kb };
}

// ─── Privacy ────────────────────────────────────────────────────────────────

function buildPrivacyView(
  visibility: string,
  inlineEnabled: boolean,
  invitations: boolean,
): { text: string; kb: InlineKeyboard } {
  const visDesc: Record<string, string> = {
    private: 'Только вы видите свои события.',
    free_busy: 'Другие видят что вы заняты, но не что именно.',
    full: 'Другие видят названия и детали ваших событий.',
  };
  const text = [
    '🔒 Приватность',
    '',
    `Видимость событий: ${visLabel(visibility)}`,
    `  ${visDesc[visibility] ?? ''}`,
    `Инлайн-поиск: ${inlineEnabled ? '✅' : '❌'}`,
    '  Позволяет @HyperCalendarBot находить вас через inline-режим.',
    `Приглашения: ${invitations ? '✅' : '❌'}`,
    '  Разрешить другим пользователям приглашать вас на события.',
  ].join('\n');

  const kb = backRow(
    new InlineKeyboard()
      .text(`👁 Видимость: ${visLabel(visibility)} →`, 'stg:cycle_visibility')
      .row()
      .text(`${inlineEnabled ? '✅' : '❌'} Инлайн-поиск`, 'stg:toggle_inline')
      .row()
      .text(`${invitations ? '✅' : '❌'} Приглашения`, 'stg:toggle_invitations'),
  );

  return { text, kb };
}

// ─── Voice ──────────────────────────────────────────────────────────────────

function buildVoiceView(voiceEnabled: number | null): { text: string; kb: InlineKeyboard } {
  const status = voiceEnabled === null ? '❓ Не задано' : voiceEnabled === 1 ? '✅ Включены' : '❌ Отключены';
  const text = [
    '🎤 Голосовые ответы',
    '',
    `Голосовые ответы: ${status}`,
    '  Когда включено — бот отвечает на сообщения голосом (TTS).',
    '  Работает на русском и английском в зависимости от языка бота.',
    '  Текстовый ответ отправляется всегда, голос — дополнительно.',
  ].join('\n');
  const kb = backRow(
    new InlineKeyboard().text(
      voiceEnabled === 1 ? '❌ Отключить голосовые ответы' : '✅ Включить голосовые ответы',
      'stg:toggle_voice',
    ),
  );
  return { text, kb };
}

// ─── Command entry point ─────────────────────────────────────────────────────

export async function handleSettings(ctx: BotCommandContext): Promise<void> {
  await ctx.send('⚙️ Настройки / Settings', {
    reply_markup: settingsCategoryKeyboard(),
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
  if (subAction === 'back') {
    await ctx.answer();
    await ctx.editText('⚙️ Настройки / Settings', { reply_markup: settingsCategoryKeyboard() });
    return;
  }

  if (subAction === 'general') {
    const tzDisplay = getTimezoneDisplay(user.timezone);
    const lang = user.language ?? 'en';
    const country = user.country_code ?? '—';
    const text = [
      '🌍 Основные настройки',
      '',
      `Часовой пояс: ${tzDisplay}`,
      `Язык: ${lang}`,
      `Страна: ${country}`,
      '',
      'Изменить часовой пояс: /timezone',
    ].join('\n');
    await ctx.answer();
    await ctx.editText(text, { reply_markup: new InlineKeyboard().text('🔙 Назад', 'stg:back') });
    return;
  }

  // ─── Notifications ─────────────────────────────────────────────────────────

  if (subAction === 'toggle_morning') prefsService.toggleMorningAgenda(user.telegram_id);
  else if (subAction === 'toggle_evening') prefsService.toggleEveningReview(user.telegram_id);
  else if (subAction === 'toggle_quiet') prefsService.toggleQuietHours(user.telegram_id);

  if (
    subAction === 'notifications' ||
    subAction === 'toggle_morning' ||
    subAction === 'toggle_evening' ||
    subAction === 'toggle_quiet'
  ) {
    const prefs = prefsService.getOrCreate(user.telegram_id);
    const intervals = JSON.parse(prefs.default_reminder_intervals) as number[];
    const { text, kb } = buildNotificationsView(
      !!prefs.morning_agenda_enabled,
      prefs.morning_agenda_time,
      !!prefs.evening_review_enabled,
      prefs.evening_review_time,
      !!prefs.quiet_hours_enabled,
      prefs.quiet_hours_start,
      prefs.quiet_hours_end,
      intervals,
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
    const { text, kb } = buildCallsView(enabled);
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
    const { text, kb } = buildPrivacyView(visibility, inlineEnabled, invitations);
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
    const { text, kb } = buildVoiceView(currentUser.voice_response_enabled);
    await ctx.answer();
    await ctx.editText(text, { reply_markup: kb });
    return;
  }

  await ctx.answer();
}
