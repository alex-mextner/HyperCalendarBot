// src/bot/bot-wiring.ts
// Small builders that createBot() (src/bot/index.ts) uses to turn optional options into the
// adapters its handlers consume. Each one owns a single `if (option) …` decision so createBot
// itself stays a flat list of constructions. They are pure of ordering concerns: createBot decides
// WHEN to call them; none of them touches shared state beyond what it is handed.

import { Bot, InlineKeyboard, type TelegramInlineKeyboardMarkup } from 'gramio';
import { CB, t } from '../config/constants.ts';
import type { EnvConfig } from '../config/env.ts';
import type { DatabaseService } from '../database/index.ts';
import type { IntentRepository } from '../database/repositories/intent.repository.ts';
import { IntentLearner } from '../services/intent/intent-learner.ts';
import type { InlineService } from '../services/sharing/inline-service.ts';
import { createConnectedUserSender } from '../services/telegram-session/connected-user-sender.ts';
import type { ServiceTier } from '../services/telegram-session/service-tier.ts';
import { formatSessionLoss } from '../services/telegram-session/session-loss.ts';
import { botLogger } from '../utils/logger.ts';
import type { CallRequest } from '../worker/call-queue.ts';
import { createInlineHandler } from './handlers/inline.handler.ts';
import type { MessageHandlerDeps } from './handlers/message.handler.ts';
import { createUserResolver } from './middleware/user-resolver.ts';

/** The env keys createBot reads; the caller passes the whole `EnvConfig` or just these. */
export type BotEnvConfig = Pick<
  EnvConfig,
  'BOT_ADMIN_ID' | 'INTENT_LEARNER_DAILY_LIMIT' | 'BOT_USERNAME' | 'INLINE_BOT_TOKEN' | 'TELEGRAM_SESSION_MASTER_KEY'
>;

/** Sends a message to `targetId` from the inviter's own connected Telegram account. */
export type SendAsConnectedUser = (
  inviterId: number,
  targetId: number,
  text: string,
  username?: string,
  meta?: { invitationId?: number },
) => Promise<boolean>;

type SessionExpiredHandler = NonNullable<Parameters<typeof createConnectedUserSender>[0]['onSessionExpired']>;
type TimezoneDetectedHandler = NonNullable<Parameters<typeof createConnectedUserSender>[0]['onTimezoneDetected']>;
type TzConsentHandler = NonNullable<Parameters<typeof createConnectedUserSender>[0]['onTzConsentNeeded']>;

type SendMessageReplyMarkup = Parameters<Bot['api']['sendMessage']>[0]['reply_markup'];

const DEFAULT_INTENT_LEARNER_DAILY_LIMIT = 100;

function userLanguage(db: DatabaseService, userId: number): 'en' | 'ru' {
  return db.users.findByTelegramId(userId)?.language ?? 'en';
}

function createTimezoneDetectedPrompt(bot: Bot, db: DatabaseService): TimezoneDetectedHandler {
  return (userId, detection) => {
    const s = t(userLanguage(db, userId)).connectTelegram;
    const kb = new InlineKeyboard()
      .text('\u2705', `${CB.CT_TZ_UPDATE}:${detection.detectedTimezone}`)
      .text('\u274c', CB.CT_TZ_SKIP);
    bot.api
      .sendMessage({
        chat_id: userId,
        text: s.tzDetected(detection.region, detection.detectedTimezone),
        reply_markup: kb as SendMessageReplyMarkup,
      })
      .catch((err: unknown) => botLogger.warn({ err, userId }, 'Failed to send tz update prompt'));
  };
}

function createTzConsentPrompt(bot: Bot, db: DatabaseService): TzConsentHandler {
  return (userId) => {
    const s = t(userLanguage(db, userId)).connectTelegram;
    const kb = new InlineKeyboard().text(s.tzConsentYes, CB.CT_TZ_CONSENT_YES).text(s.tzConsentNo, CB.CT_TZ_CONSENT_NO);
    bot.api
      .sendMessage({
        chat_id: userId,
        text: s.tzConsentPrompt,
        reply_markup: kb as SendMessageReplyMarkup,
      })
      .catch((err: unknown) => botLogger.warn({ err, userId }, 'Failed to send tz consent prompt'));
  };
}

function createSessionExpiredNotice(bot: Bot, db: DatabaseService): SessionExpiredHandler {
  return (userId, reason) => {
    bot.api
      .sendMessage({ chat_id: userId, text: formatSessionLoss(userLanguage(db, userId), reason) })
      .catch((err: unknown) => botLogger.warn({ err, userId }, 'Failed to send session expired notification'));
  };
}

/** Hex master key for stored Telegram sessions, or null when the feature is not configured. */
export function resolveTelegramMasterKey(hexKey: string | undefined): Buffer | null {
  return hexKey ? Buffer.from(hexKey, 'hex') : null;
}

/** Sender that posts from the inviter's own Telegram session; undefined without a master key. */
export function buildConnectedUserSender(
  bot: Bot,
  db: DatabaseService,
  masterKey: Buffer | null,
): SendAsConnectedUser | undefined {
  if (!masterKey) return undefined;
  return createConnectedUserSender({
    sessionRepo: db.telegramSessions,
    masterKey,
    notifLogRepo: db.notificationLog,
    getUserTimezone: (userId) => db.users.findByTelegramId(userId)?.timezone ?? 'UTC',
    onTimezoneDetected: createTimezoneDetectedPrompt(bot, db),
    onTzConsentNeeded: createTzConsentPrompt(bot, db),
    onSessionExpired: createSessionExpiredNotice(bot, db),
  });
}

/**
 * Learner that proposes new intents to the administrator. Absent when no admin id is configured
 * or when the catalogue is managed (an admin-curated basis must not be fed by the learner).
 */
export function buildIntentLearner(
  bot: Bot,
  intentRepo: IntentRepository,
  envConfig: Partial<BotEnvConfig>,
): IntentLearner | undefined {
  const adminId = envConfig.BOT_ADMIN_ID;
  if (!adminId || Number.isNaN(adminId) || intentRepo.isManagedBasis()) return undefined;
  return new IntentLearner(intentRepo, {
    dailyLimit: envConfig.INTENT_LEARNER_DAILY_LIMIT ?? DEFAULT_INTENT_LEARNER_DAILY_LIMIT,
    adminId,
    sendToAdmin: async (text, replyMarkup) => {
      await bot.api.sendMessage({
        chat_id: adminId,
        text,
        reply_markup: replyMarkup,
      });
    },
  });
}

/** Adapts the call queue to the handler-facing `(userId, text)` shape; undefined when calls are off. */
export function buildCallQueueAdapter(
  callQueue: { enqueue(data: CallRequest): Promise<void> } | undefined,
  db: DatabaseService,
): MessageHandlerDeps['callQueue'] {
  if (!callQueue) return undefined;
  return {
    enqueue: (userId: number, text: string) =>
      callQueue.enqueue({
        userId,
        ttsText: text,
        language: userLanguage(db, userId),
      }),
  };
}

/** Voice-reply sender, present only when some TTS backend is configured. */
export function buildReplyVoiceSender(bot: Bot, hasTtsBackend: boolean): MessageHandlerDeps['sendVoice'] {
  if (!hasTtsBackend) return undefined;
  return async (chatId: number, audio: Buffer) => {
    const file = new File([audio], 'reply.ogg', { type: 'audio/ogg' });
    await bot.api.sendVoice({ chat_id: chatId, voice: file });
  };
}

/** Username/user lookups through the MTProto service account, set only while the tier is enabled. */
export function resolveServiceTierLookups(
  serviceTier: ServiceTier,
): Pick<MessageHandlerDeps, 'resolveUsername' | 'lookupTelegramUser'> {
  if (!serviceTier.enabled) return { resolveUsername: undefined, lookupTelegramUser: undefined };
  return { resolveUsername: serviceTier.resolveUsername, lookupTelegramUser: serviceTier.lookupUser };
}

/** Rich-text send used by the message handlers; mirrors `bot.api.sendMessage` for chat replies. */
export function buildChatMessageSender(bot: Bot): MessageHandlerDeps['sendMessageToChat'] {
  return async (
    chatId: number,
    text: string,
    options?: {
      reply_markup?: InlineKeyboard | TelegramInlineKeyboardMarkup;
      message_thread_id?: number;
    },
  ) => {
    const result = await bot.api.sendMessage({
      chat_id: chatId,
      text,
      ...(options?.reply_markup ? { reply_markup: options.reply_markup } : {}),
      ...(options?.message_thread_id ? { message_thread_id: options.message_thread_id } : {}),
    });
    return result;
  };
}

/**
 * Inline queries go to a dedicated bot when a token is configured (returned), otherwise they are
 * registered on the main bot (returns undefined).
 */
export function setupInlineQueries(
  bot: Bot,
  inlineBotToken: string | undefined,
  db: DatabaseService,
  inlineService: InlineService,
): Bot | undefined {
  if (!inlineBotToken) {
    // No separate inline bot — register on main bot
    bot.on('inline_query', (ctx) => createInlineHandler(inlineService, db.users, db.sharingSettings)(ctx));
    return undefined;
  }
  const inlineBot = new Bot(inlineBotToken);
  inlineBot
    .derive(createUserResolver(db))
    .on('inline_query', (ctx) => createInlineHandler(inlineService, db.users, db.sharingSettings)(ctx))
    .onError(({ error }) => {
      botLogger.error({ err: error }, 'Inline bot error');
    });
  return inlineBot;
}
