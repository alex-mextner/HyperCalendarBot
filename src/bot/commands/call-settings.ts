// src/bot/commands/call-settings.ts

import { t } from '../../config/constants';
import type { CallSettingsRepository } from '../../database/repositories/call-settings.repository';
import type { BotCommandContext } from '../types';

export async function handleCallSettings(ctx: BotCommandContext, settingsRepo: CallSettingsRepository): Promise<void> {
  const user = ctx.dbUser;
  const lang = (user.language ?? 'en') as 'en' | 'ru';
  const userId = user.telegram_id;

  settingsRepo.ensureDefaults(userId);

  if (ctx.args === 'on') {
    settingsRepo.setEnabled(userId, true);
    await ctx.send(t(lang).call_settings_enabled);
    return;
  }

  if (ctx.args === 'off') {
    settingsRepo.setEnabled(userId, false);
    await ctx.send(t(lang).call_settings_disabled);
    return;
  }

  const settings = settingsRepo.get(userId)!;
  const text = [
    t(lang).call_settings_title,
    '',
    settings.enabled ? t(lang).call_settings_enabled : t(lang).call_settings_disabled,
    `Max daily: ${settings.max_daily_calls}`,
    '',
    '<code>/callsettings on</code> / <code>/callsettings off</code>',
  ].join('\n');
  await ctx.send(text, { parse_mode: 'HTML' });
}
