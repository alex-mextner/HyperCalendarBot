// src/bot/commands/connect-google.ts
import { InlineKeyboard } from 'gramio';
import type { Lang } from '../../config/constants.ts';
import { t } from '../../config/constants.ts';
import type { GoogleOAuthService } from '../../services/google/oauth.ts';
import { cmdLogger } from '../../utils/logger.ts';
import { isGroup } from '../group-context.ts';
import type { BotCommandContext } from '../types.ts';

interface OAuthStateStore {
  set(stateId: string, payload: string, ttlSeconds: number): Promise<void>;
}

interface ConnectGoogleDeps {
  oauthService: GoogleOAuthService;
  stateStore: OAuthStateStore;
}

export async function handleConnectGoogle(ctx: BotCommandContext, deps: ConnectGoogleDeps): Promise<void> {
  if (isGroup(ctx)) {
    const lang = (ctx.dbUser?.language ?? 'en') as Lang;
    await ctx.send(
      lang === 'ru'
        ? '🔗 Google Calendar подключается только в личном чате'
        : '🔗 Connect Google Calendar in private chat with the bot',
    );
    return;
  }

  const dbUser = ctx.dbUser;
  if (!dbUser) return;
  const lang = (dbUser.language ?? 'en') as Lang;
  const userId = dbUser.telegram_id;

  if (!deps.oauthService.isConfigured()) {
    await ctx.send(t(lang).gcal_not_configured);
    return;
  }

  if (dbUser.google_refresh_token_enc) {
    await ctx.send(t(lang).gcal_already_connected);
    return;
  }

  const stateId = crypto.randomUUID();
  await deps.stateStore.set(
    `oauth:state:${stateId}`,
    JSON.stringify({ telegram_user_id: userId, created_at: Date.now() }),
    300,
  );

  const authUrl = deps.oauthService.generateAuthUrl(stateId);
  const keyboard = new InlineKeyboard().url(t(lang).gcal_connect_button, authUrl);

  await ctx.send(t(lang).gcal_connect_prompt, { reply_markup: keyboard });
  cmdLogger.info({ userId }, '/connect_google initiated');
}
