// src/bot/handlers/message.handler.ts

import type { ChatHistoryRepository } from '../../database/repositories/chat-history.repository.ts';
import type { ContactRepository } from '../../database/repositories/contact.repository.ts';
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
  sceneStorage: SceneStorage;
  botUsername?: string;
}

// Stems for calendar-related keywords (RU + EN), matched case-insensitively
const CALENDAR_STEMS = [
  // RU
  'событ',
  'встреч',
  'потус',
  'собира',
  'планир',
  'план',
  'напомн',
  'календар',
  'расписан',
  'запис',
  'запланир',
  'когда',
  'во сколько',
  'локаци',
  'место',
  'адрес',
  'завтра',
  'послезавтра',
  'сегодня',
  'в понедельник',
  'во вторник',
  'в среду',
  'в четверг',
  'в пятницу',
  'в субботу',
  'в воскресенье',
  'перенес',
  'отмен',
  'удали',
  'измен',
  'сдвин',
  // EN
  'event',
  'meet',
  'schedul',
  'remind',
  'calendar',
  'plan',
  'appoint',
  'when',
  'where',
  'location',
  'tomorrow',
  'today',
  'cancel',
  'reschedul',
  'postpon',
];

const STEM_PATTERN = new RegExp(CALENDAR_STEMS.join('|'), 'i');

function isGroupRelevant(text: string, botUsername: string): boolean {
  // Direct mention
  if (text.includes(`@${botUsername}`)) return true;
  // Calendar keyword match
  return STEM_PATTERN.test(text);
}

export function createMessageHandler(deps: MessageHandlerDeps) {
  return async (ctx: BotCommandContext) => {
    const user = ctx.dbUser as User | undefined;
    if (!user) return;

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
