// src/bot/commands/disconnect-google.ts
import { InlineKeyboard } from 'gramio';
import type { Lang } from '../../config/constants.ts';
import { CB, t } from '../../config/constants.ts';
import type { EnvConfig } from '../../config/env.ts';
import type { EventRepository } from '../../database/repositories/event.repository.ts';
import type { GoogleCalendarRepository } from '../../database/repositories/google-calendar.repository.ts';
import type { GoogleSyncRepository } from '../../database/repositories/google-sync.repository.ts';
import type { UserRepository } from '../../database/repositories/user.repository.ts';
import type { GoogleOAuthService } from '../../services/google/oauth.ts';
import { decrypt } from '../../utils/crypto.ts';
import { cmdLogger } from '../../utils/logger.ts';
import { isGroup } from '../group-context.ts';
import type { BotCommandContext } from '../types.ts';

export interface DisconnectDeps {
  config: EnvConfig;
  oauthService: GoogleOAuthService;
  userRepo: UserRepository;
  eventRepo: EventRepository;
  syncRepo: GoogleSyncRepository;
  calendarRepo: GoogleCalendarRepository;
  stopWatchChannels?: (userId: number) => Promise<void>;
}

export async function handleDisconnectGoogle(ctx: BotCommandContext): Promise<void> {
  if (isGroup(ctx)) {
    const lang = (ctx.dbUser?.language ?? 'en') as Lang;
    await ctx.send(
      lang === 'ru'
        ? '🔗 Google Calendar отключается только в личном чате'
        : '🔗 Disconnect Google Calendar in private chat with the bot',
    );
    return;
  }

  const lang = (ctx.dbUser.language ?? 'en') as Lang;

  if (!ctx.dbUser.google_refresh_token_enc) {
    await ctx.send(t(lang).gcal_not_configured);
    return;
  }

  const keyboard = new InlineKeyboard()
    .text(t(lang).gcal_disconnect_yes, `${CB.GCAL}:disconnect:yes`)
    .text(t(lang).gcal_disconnect_no, `${CB.GCAL}:disconnect:no`);

  await ctx.send(t(lang).gcal_disconnect_confirm, { reply_markup: keyboard });
}

export async function executeDisconnect(userId: number, deps: DisconnectDeps): Promise<void> {
  if (deps.stopWatchChannels) {
    await deps.stopWatchChannels(userId);
  }

  const user = deps.userRepo.findByTelegramId(userId);
  if (user?.google_refresh_token_enc && deps.config.ENCRYPTION_KEY) {
    const refreshToken = decrypt(user.google_refresh_token_enc, deps.config.ENCRYPTION_KEY);
    await deps.oauthService.revokeToken(refreshToken);
  }

  deps.calendarRepo.deleteWatchChannelsForUser(userId);
  deps.calendarRepo.deleteUserCalendars(userId);
  deps.syncRepo.deleteSyncState(userId);

  deps.userRepo.clearGoogleToken(userId);

  deps.eventRepo.clearGoogleSync(userId);

  cmdLogger.info({ userId }, 'Google Calendar disconnected');
}
