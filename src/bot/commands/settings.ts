// src/bot/commands/settings.ts
import { InlineKeyboard } from 'gramio';
import type { CallSettingsRepository } from '../../database/repositories/call-settings.repository.ts';
import type { SharingSettingsRepository } from '../../database/repositories/sharing-settings.repository.ts';
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

function backKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text('🔙 Назад', 'stg:back');
}

export async function handleSettings(ctx: BotCommandContext): Promise<void> {
  await ctx.send('⚙️ Настройки / Settings', {
    reply_markup: settingsCategoryKeyboard(),
  });
}

export async function handleSettingsCallback(
  ctx: BotCallbackContext,
  user: User,
  subAction: string,
  prefsService: NotificationPreferencesService,
  callSettingsRepo?: CallSettingsRepository,
  sharingSettingsRepo?: SharingSettingsRepository,
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
    const text = `🌍 Основные настройки\n\nЧасовой пояс: ${tzDisplay}\nЯзык: ${lang}\nСтрана: ${country}`;
    await ctx.answer();
    await ctx.editText(text, { reply_markup: backKeyboard() });
    return;
  }

  if (subAction === 'notifications') {
    const prefs = prefsService.getOrCreate(user.telegram_id);
    const intervals = JSON.parse(prefs.default_reminder_intervals) as number[];
    const morning = prefs.morning_agenda_enabled
      ? `✅ ${prefs.morning_agenda_time}`
      : '❌';
    const evening = prefs.evening_review_enabled
      ? `✅ ${prefs.evening_review_time}`
      : '❌';
    const quiet = prefs.quiet_hours_enabled
      ? `✅ ${prefs.quiet_hours_start}–${prefs.quiet_hours_end}`
      : '❌';
    const text = [
      '🔔 Уведомления',
      '',
      `Утренняя сводка: ${morning}`,
      `Вечерний обзор: ${evening}`,
      `Тихие часы: ${quiet}`,
      `Напоминания: [${intervals.join(', ')}] мин`,
    ].join('\n');
    await ctx.answer();
    await ctx.editText(text, { reply_markup: backKeyboard() });
    return;
  }

  if (subAction === 'calls') {
    let enabled = false;
    let lang = user.language ?? 'ru';
    if (callSettingsRepo) {
      callSettingsRepo.ensureDefaults(user.telegram_id);
      const settings = callSettingsRepo.get(user.telegram_id);
      if (settings) {
        enabled = !!settings.enabled;
        lang = settings.language;
      }
    }
    const text = `📞 Голосовые звонки\n\nВключено: ${enabled ? '✅' : '❌'}\nЯзык TTS: ${lang}`;
    await ctx.answer();
    await ctx.editText(text, { reply_markup: backKeyboard() });
    return;
  }

  if (subAction === 'privacy') {
    let visibility = 'private';
    let inlineEnabled = false;
    let invitations = false;
    if (sharingSettingsRepo) {
      sharingSettingsRepo.ensureDefaults(user.telegram_id);
      const settings = sharingSettingsRepo.get(user.telegram_id);
      if (settings) {
        visibility = settings.default_visibility;
        inlineEnabled = !!settings.inline_mode_enabled;
        invitations = !!settings.allow_invitations;
      }
    }
    const text = [
      '🔒 Приватность',
      '',
      `Видимость: ${visibility}`,
      `Поиск инлайн: ${inlineEnabled ? '✅' : '❌'}`,
      `Приглашения: ${invitations ? '✅' : '❌'}`,
    ].join('\n');
    await ctx.answer();
    await ctx.editText(text, { reply_markup: backKeyboard() });
    return;
  }

  if (subAction === 'voice') {
    const text = '🎤 Голосовые ответы\n\nГолосовые ответы: ❌ (не настроено)';
    await ctx.answer();
    await ctx.editText(text, { reply_markup: backKeyboard() });
    return;
  }

  await ctx.answer();
}
