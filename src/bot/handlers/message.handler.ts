// src/bot/handlers/message.handler.ts

import type { ChatHistoryRepository } from '../../database/repositories/chat-history.repository.ts';
import type { ContactRepository } from '../../database/repositories/contact.repository.ts';
import type { GoogleCalendarRepository } from '../../database/repositories/google-calendar.repository.ts';
import type { InvitationRepository } from '../../database/repositories/invitation.repository.ts';
import type { ReminderRepository } from '../../database/repositories/reminder.repository.ts';
import type { SharedEventRepository } from '../../database/repositories/shared-event.repository.ts';
import type { SharingSettingsRepository } from '../../database/repositories/sharing-settings.repository.ts';
import type { UserRepository } from '../../database/repositories/user.repository.ts';
import type { User } from '../../database/types.ts';
import type { CalendarBotAgent } from '../../services/ai/agent.ts';
import type { AgentContext } from '../../services/ai/types.ts';
import type { EventService } from '../../services/event/event-service.ts';
import type { HolidayService } from '../../services/holiday/holiday-service.ts';
import type { RenderService } from '../../services/image/render-service.ts';
import type { InvitationService } from '../../services/sharing/invitation-service.ts';
import type { PrivacyService } from '../../services/sharing/privacy-service.ts';
import type { SharingService } from '../../services/sharing/sharing-service.ts';
import type { TranscriptionService } from '../../services/voice/transcription-service.ts';
import { cmdLogger } from '../../utils/logger.ts';
import type { BotCommandContext } from '../types.ts';

interface SceneStorage {
  get(key: string): Promise<unknown>;
}

export interface MessageHandlerDeps {
  agent: CalendarBotAgent;
  eventService: EventService;
  holidayService: HolidayService;
  chatHistory: ChatHistoryRepository;
  userRepo: UserRepository;
  reminderRepo: ReminderRepository;
  contactRepo?: ContactRepository;
  invitationService?: InvitationService;
  invitationRepo?: InvitationRepository;
  sharingService?: SharingService;
  sharingSettingsRepo?: SharingSettingsRepository;
  sharedEventRepo?: SharedEventRepository;
  privacyService?: PrivacyService;
  renderService?: RenderService;
  notificationPrefs?: AgentContext['notificationPrefs'];
  callQueue?: AgentContext['callQueue'];
  callSettingsRepo?: AgentContext['callSettingsRepo'];
  googleCalendarRepo?: GoogleCalendarRepository;
  sceneStorage: SceneStorage;
  botUsername?: string;
  transcriptionService?: TranscriptionService;
  botToken?: string;
}

// Full words/phrases for calendar-related keyword matching in groups.
// Uses word boundaries to avoid false positives (e.g., "планшет" ≠ "план").
const CALENDAR_KEYWORDS = [
  // RU — full words or long enough stems
  'событие',
  'события',
  'событий',
  'встреча',
  'встречу',
  'встречи',
  'встречаемся',
  'потусим',
  'потусить',
  'потусуем',
  'собираемся',
  'собираться',
  'планирую',
  'планируем',
  'запланируй',
  'запланировать',
  'напомни',
  'напоминание',
  'напомнить',
  'календарь',
  'календар',
  'расписание',
  'расписани',
  'когда',
  'во сколько',
  'перенеси',
  'перенести',
  'перенос',
  'отмени',
  'отменить',
  'отмена',
  'удали',
  'удалить',
  'завтра',
  'послезавтра',
  'сегодня',
  // EN — full words
  'event',
  'events',
  'meeting',
  'schedule',
  'scheduled',
  'reminder',
  'remind',
  'calendar',
  'appointment',
  'reschedule',
  'postpone',
  'tomorrow',
  'today',
];

const KEYWORD_PATTERN = new RegExp(`(?:^|\\s|[,.!?])(?:${CALENDAR_KEYWORDS.join('|')})(?:\\s|[,.!?]|$)`, 'i');

function isGroupRelevant(text: string, botUsername: string): boolean {
  if (botUsername && text.includes(`@${botUsername}`)) return true;
  return KEYWORD_PATTERN.test(text);
}

const TG_API = 'https://api.telegram.org';

async function downloadTelegramFile(botToken: string, fileId: string): Promise<Buffer> {
  const metaRes = await fetch(`${TG_API}/bot${botToken}/getFile?file_id=${fileId}`);
  const meta = (await metaRes.json()) as { ok: boolean; result?: { file_path: string } };
  if (!meta.ok || !meta.result?.file_path) {
    throw new Error('Failed to get file path from Telegram');
  }
  const fileRes = await fetch(`${TG_API}/file/bot${botToken}/${meta.result.file_path}`);
  if (!fileRes.ok) throw new Error(`Failed to download file: HTTP ${fileRes.status}`);
  return Buffer.from(await fileRes.arrayBuffer());
}

async function handleVoiceMessage(
  ctx: BotCommandContext,
  user: User,
  voice: { file_id: string; duration: number },
  deps: MessageHandlerDeps,
): Promise<void> {
  const chatId = ctx.chatId;
  if (!chatId) return;

  cmdLogger.info({ userId: user.telegram_id, duration: voice.duration }, 'Voice message received');

  const lang = user.language as 'en' | 'ru';

  try {
    const audioBuffer = await downloadTelegramFile(deps.botToken!, voice.file_id);
    const transcription = await deps.transcriptionService!.transcribe(audioBuffer);

    if (!transcription) {
      await ctx.send(lang === 'ru' ? 'Не удалось распознать речь.' : 'Could not recognize speech.');
      return;
    }

    cmdLogger.info({ userId: user.telegram_id, transcription: transcription.slice(0, 100) }, 'Voice transcribed');

    const agentContext: AgentContext = {
      user,
      chatId: Number(chatId),
      messageText: transcription,
      isVoiceMessage: true,
      eventService: deps.eventService,
      holidayService: deps.holidayService,
      chatHistory: deps.chatHistory,
      userRepo: deps.userRepo,
      reminderRepo: deps.reminderRepo,
      contactRepo: deps.contactRepo,
      invitationService: deps.invitationService,
      invitationRepo: deps.invitationRepo,
      sharingService: deps.sharingService,
      sharingSettingsRepo: deps.sharingSettingsRepo,
      sharedEventRepo: deps.sharedEventRepo,
      privacyService: deps.privacyService,
      renderService: deps.renderService,
      notificationPrefs: deps.notificationPrefs,
      callQueue: deps.callQueue,
      callSettingsRepo: deps.callSettingsRepo,
      googleCalendarRepo: deps.googleCalendarRepo,
    };

    await deps.agent.run(agentContext);
  } catch (error) {
    cmdLogger.error({ error: String(error), userId: user.telegram_id }, 'Voice transcription error');
    await ctx.send(lang === 'ru' ? 'Не удалось обработать голосовое сообщение.' : 'Could not process voice message.');
  }
}

export function createMessageHandler(deps: MessageHandlerDeps) {
  return async (ctx: BotCommandContext) => {
    const user = ctx.dbUser as User | undefined;
    if (!user) return;

    // Voice message → transcribe → pass to AI agent
    const voice = (ctx as unknown as { voice?: { file_id: string; duration: number } }).voice;
    if (voice && deps.transcriptionService && deps.botToken) {
      return handleVoiceMessage(ctx, user, voice, deps);
    }

    const text = ctx.text as string | undefined;
    if (!text) return;

    // Don't handle commands
    if (text.startsWith('/')) return;

    // Don't handle if a scene is active — @gramio/scenes handles those
    const sceneKey = `@gramio/scenes:${user.telegram_id}`;
    const activeScene = await deps.sceneStorage.get(sceneKey);
    if (activeScene) return;

    const chatId = ctx.chatId;
    if (!chatId) return;

    // In groups: only respond to replies, mentions, or calendar keywords
    const chat = (ctx as unknown as { chat?: { type: string; title?: string } }).chat;
    const isGroup = chat?.type === 'group' || chat?.type === 'supergroup';

    if (isGroup) {
      const reply = (ctx as unknown as { replyToMessage?: { from?: { id?: number } } }).replyToMessage;
      const isReplyToBot = reply?.from?.id !== undefined && deps.botUsername !== undefined;
      const botMention = deps.botUsername ? `@${deps.botUsername}` : '';

      if (!isReplyToBot && !isGroupRelevant(text, botMention)) {
        return; // Skip irrelevant group messages
      }
    }

    // Build context info for group messages
    const from = (ctx as unknown as { from?: { first_name?: string; username?: string } }).from;
    let messagePrefix = '';
    if (isGroup && from) {
      const senderName = from.first_name ?? from.username ?? 'Unknown';
      const groupName = chat?.title ?? 'group';
      messagePrefix = `[Group: ${groupName}, From: ${senderName}] `;
    }

    const agentContext: AgentContext = {
      user,
      chatId: Number(chatId),
      messageText: messagePrefix + text,
      eventService: deps.eventService,
      holidayService: deps.holidayService,
      chatHistory: deps.chatHistory,
      userRepo: deps.userRepo,
      reminderRepo: deps.reminderRepo,
      contactRepo: deps.contactRepo,
      invitationService: deps.invitationService,
      invitationRepo: deps.invitationRepo,
      sharingService: deps.sharingService,
      sharingSettingsRepo: deps.sharingSettingsRepo,
      sharedEventRepo: deps.sharedEventRepo,
      privacyService: deps.privacyService,
      renderService: deps.renderService,
      notificationPrefs: deps.notificationPrefs,
      callQueue: deps.callQueue,
      callSettingsRepo: deps.callSettingsRepo,
      googleCalendarRepo: deps.googleCalendarRepo,
    };

    cmdLogger.info({ userId: user.telegram_id, text, isGroup }, 'Routing to AI agent');

    try {
      await deps.agent.run(agentContext);
    } catch (error) {
      cmdLogger.error({ error: String(error), userId: user.telegram_id }, 'AI agent error');
      const lang = user.language as 'en' | 'ru';
      await ctx.send(
        lang === 'ru' ? 'Что-то пошло не так. Попробуйте ещё раз.' : 'Something went wrong. Please try again.',
      );
    }
  };
}
