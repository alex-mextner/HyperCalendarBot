// src/bot/commands/google-status.ts
import { InlineKeyboard } from 'gramio';
import type { Lang } from '../../config/constants.ts';
import { CB, t } from '../../config/constants.ts';
import type { GoogleCalendarRepository } from '../../database/repositories/google-calendar.repository.ts';
import type { GoogleSyncRepository } from '../../database/repositories/google-sync.repository.ts';
import { googleCalendarColorEmoji } from '../../services/google/calendar-colors.ts';
import { isGroup } from '../group-context.ts';
import type { BotCommandContext } from '../types.ts';

interface GoogleStatusDeps {
  syncRepo: GoogleSyncRepository;
  calendarRepo: GoogleCalendarRepository;
}

/** Human-readable sync age: "just now", "30 min", "2 hr", "3 d" */
export function formatSyncAge(isoString: string | null | undefined, lang: string): string {
  if (!isoString) return lang === 'ru' ? 'ещё нет' : 'not yet';
  const diffMs = Date.now() - new Date(isoString).getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return lang === 'ru' ? 'только что' : 'just now';
  if (diffMin < 60) return `${diffMin} ${lang === 'ru' ? 'мин' : 'min'}`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} ${lang === 'ru' ? 'ч' : 'hr'}`;
  const diffDays = Math.floor(diffHr / 24);
  return `${diffDays} ${lang === 'ru' ? 'д' : 'd'}`;
}

export async function handleGoogleStatus(ctx: BotCommandContext, deps: GoogleStatusDeps): Promise<void> {
  if (isGroup(ctx)) return;

  const user = ctx.dbUser;
  if (!user) return;
  const lang = (user.language ?? 'en') as Lang;
  const userId = user.telegram_id;

  const syncState = deps.syncRepo.getSyncState(userId);

  if (!syncState || !user.google_refresh_token_enc) {
    await ctx.send(t(lang).gcal_status_not_connected);
    return;
  }

  if (syncState.status === 'revoked') {
    await ctx.send(t(lang).gcal_revoked);
    return;
  }

  const calendars = deps.calendarRepo.getCalendars(userId);

  const lines: string[] = [];
  lines.push(`🔗 Google Calendar — ${t(lang).gcal_status_connected}`);
  lines.push('');

  if (calendars.length === 0) {
    lines.push(lang === 'ru' ? 'Нет подключённых календарей.' : 'No calendars found.');
  } else {
    for (const cal of calendars) {
      const check = cal.sync_enabled ? '✅' : '⬜';
      const dot = googleCalendarColorEmoji(cal.color) || '📅';
      const primary = cal.is_primary ? ' ★' : '';
      const ageStr = cal.sync_enabled
        ? formatSyncAge(cal.last_synced_at, lang)
        : lang === 'ru'
          ? 'отключён'
          : 'disabled';
      lines.push(`${check} ${dot} ${cal.calendar_name}${primary} — ${ageStr}`);
    }
  }

  const keyboard = new InlineKeyboard()
    .text(t(lang).gcal_status_sync_btn, `${CB.GCAL}:sync`)
    .text(t(lang).gcal_status_calendars_btn, `${CB.GCAL}:cal:open`);

  await ctx.send(lines.join('\n'), { reply_markup: keyboard });
}
