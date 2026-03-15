import { t } from '../../config/constants.ts';
import type { SharingSettingsRepository } from '../../database/repositories/sharing-settings.repository.ts';
import type { Visibility } from '../../database/types.ts';
import type { BotCommandContext } from '../types.ts';

const VALID_LEVELS = new Set<Visibility>(['private', 'free_busy', 'full']);

export async function handlePrivacy(ctx: BotCommandContext, settingsRepo: SharingSettingsRepository): Promise<void> {
  const userId = ctx.dbUser.telegram_id;
  const lang = ctx.dbUser.language as 'en' | 'ru';

  settingsRepo.ensureDefaults(userId);
  const settings = settingsRepo.get(userId)!;

  if (!ctx.args || ctx.args.trim() === '') {
    const text = [
      t(lang).privacy_current(settings.default_visibility),
      '',
      `Inline mode: ${settings.inline_mode_enabled ? '\u2705' : '\u274C'}`,
      `${lang === 'ru' ? 'Приглашения' : 'Invitations'}: ${settings.allow_invitations ? '\u2705' : '\u274C'}`,
      '',
      '<code>/privacy default private|free_busy|full</code>',
    ].join('\n');
    await ctx.send(text, { parse_mode: 'HTML' });
    return;
  }

  const parts = ctx.args.trim().split(/\s+/);

  if (parts[0] === 'default' && parts[1]) {
    const level = parts[1] as Visibility;
    if (!VALID_LEVELS.has(level)) {
      const msg =
        lang === 'ru'
          ? 'Допустимые уровни: <code>private</code>, <code>free_busy</code>, <code>full</code>'
          : 'Valid levels: <code>private</code>, <code>free_busy</code>, <code>full</code>';
      await ctx.send(msg, { parse_mode: 'HTML' });
      return;
    }
    settingsRepo.update(userId, { default_visibility: level });
    const msg =
      lang === 'ru' ? `\u2705 Видимость по умолчанию: <b>${level}</b>` : `\u2705 Default visibility: <b>${level}</b>`;
    await ctx.send(msg, { parse_mode: 'HTML' });
    return;
  }

  // Fallback: show current settings with usage hint
  const text = [
    t(lang).privacy_current(settings.default_visibility),
    '',
    '<code>/privacy default private|free_busy|full</code>',
  ].join('\n');
  await ctx.send(text, { parse_mode: 'HTML' });
}
