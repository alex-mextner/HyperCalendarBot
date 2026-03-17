// src/bot/handlers/message.handler.ts

import type { ChatHistoryRepository } from '../../database/repositories/chat-history.repository.ts';
import type { ContactRepository } from '../../database/repositories/contact.repository.ts';
import type { EditProposalRepository } from '../../database/repositories/edit-proposal.repository.ts';
import type { FeedbackRepository } from '../../database/repositories/feedback.repository.ts';
import type { GoogleCalendarRepository } from '../../database/repositories/google-calendar.repository.ts';
import type { IntentRepository } from '../../database/repositories/intent.repository.ts';
import type { InvitationRepository } from '../../database/repositories/invitation.repository.ts';
import type { ParticipantRepository } from '../../database/repositories/participant.repository.ts';
import type { ReminderRepository } from '../../database/repositories/reminder.repository.ts';
import type { SharedEventRepository } from '../../database/repositories/shared-event.repository.ts';
import type { SharingSettingsRepository } from '../../database/repositories/sharing-settings.repository.ts';
import type { UserRepository } from '../../database/repositories/user.repository.ts';
import type { User } from '../../database/types.ts';
import type { CalendarBotAgent } from '../../services/ai/agent.ts';
import type { AgentContext, ToolResult } from '../../services/ai/types.ts';
import type { EventService } from '../../services/event/event-service.ts';
import type { HolidayService } from '../../services/holiday/holiday-service.ts';
import type { RenderService } from '../../services/image/render-service.ts';
import type { IntentExecutor } from '../../services/intent/intent-executor.ts';
import type { IntentMatcher } from '../../services/intent/intent-matcher.ts';
import type { DeepLinkService } from '../../services/sharing/deep-link-service.ts';
import type { InvitationService } from '../../services/sharing/invitation-service.ts';
import type { PrivacyService } from '../../services/sharing/privacy-service.ts';
import type { SharingService } from '../../services/sharing/sharing-service.ts';
import type { SileroTtsService } from '../../services/voice/silero-tts-service.ts';
import { markStress, numbersToWords, stripMarkdown, transliterateEnglish } from '../../services/voice/stress-marker.ts';
import type { TranscriptionService } from '../../services/voice/transcription-service.ts';
import { cmdLogger } from '../../utils/logger.ts';
import { createAiAgentLayer } from '../pipeline/ai-agent-layer.ts';
import { createFeedbackRouterLayer } from '../pipeline/feedback-router-layer.ts';
import { createIntentMatcherLayer, type WorkflowSession } from '../pipeline/intent-matcher-layer.ts';
import { runPipeline } from '../pipeline/pipeline.ts';
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
  participantRepo?: ParticipantRepository;
  editProposalRepo?: EditProposalRepository;
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
  deepLinkService?: DeepLinkService;
  sceneStorage: SceneStorage;
  botUsername?: string;
  transcriptionService?: TranscriptionService;
  botToken?: string;
  stressDictionary?: AgentContext['stressDictionary'];
  sileroTts?: SileroTtsService;
  sendVoice?: (chatId: number, audio: Buffer) => Promise<void>;
  // Pipeline: intent matching
  intentMatcher?: IntentMatcher;
  intentRepo?: IntentRepository;
  intentExecutor?: IntentExecutor;
  intentToolExecutor?: (toolName: string, input: Record<string, unknown>) => ToolResult;
  workflowSessions?: Map<number, WorkflowSession>;
  // Pipeline: feedback routing
  feedbackRepo?: FeedbackRepository;
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
    throw new Error(`Failed to get file path from Telegram: ${JSON.stringify(meta)}`);
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
      participantRepo: deps.participantRepo,
      editProposalRepo: deps.editProposalRepo,
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
      deepLinkService: deps.deepLinkService,
      botUsername: deps.botUsername,
      stressDictionary: deps.stressDictionary,
    };

    const responseText = await deps.agent.run(agentContext);

    // Send voice reply if TTS is available
    if (responseText && deps.sileroTts && deps.sendVoice && deps.stressDictionary) {
      try {
        const plainText = stripMarkdown(responseText);
        const withNumbers = numbersToWords(plainText);
        const withStress = markStress(withNumbers, deps.stressDictionary);
        const stressedText = transliterateEnglish(withStress);
        cmdLogger.info({ userId: user.telegram_id, textLen: stressedText.length }, 'Synthesizing voice reply');
        const voiceBuffer = await deps.sileroTts.synthesize(stressedText);
        await deps.sendVoice(Number(chatId), voiceBuffer);
      } catch (ttsError) {
        cmdLogger.error({ error: String(ttsError), userId: user.telegram_id }, 'Voice reply TTS error');
      }
    }
  } catch (error) {
    cmdLogger.error({ error: String(error), userId: user.telegram_id }, 'Voice transcription error');
    await ctx.send(lang === 'ru' ? 'Не удалось обработать голосовое сообщение.' : 'Could not process voice message.');
  }
}

function buildAgentContextFactory(deps: MessageHandlerDeps) {
  return (user: User, chatId: number, messageText: string): AgentContext => ({
    user,
    chatId,
    messageText,
    eventService: deps.eventService,
    holidayService: deps.holidayService,
    chatHistory: deps.chatHistory,
    userRepo: deps.userRepo,
    reminderRepo: deps.reminderRepo,
    contactRepo: deps.contactRepo,
    participantRepo: deps.participantRepo,
    editProposalRepo: deps.editProposalRepo,
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
    deepLinkService: deps.deepLinkService,
    botUsername: deps.botUsername,
    stressDictionary: deps.stressDictionary,
  });
}

export function createMessageHandler(deps: MessageHandlerDeps) {
  const agentContextBuilder = buildAgentContextFactory(deps);
  const workflowSessions = deps.workflowSessions ?? new Map<number, WorkflowSession>();

  const aiAgentLayer = createAiAgentLayer({ agent: deps.agent, agentContextBuilder });

  const layers = [
    ...(deps.intentMatcher && deps.intentRepo && deps.intentExecutor && deps.intentToolExecutor
      ? [
          createIntentMatcherLayer(
            deps.intentMatcher,
            deps.intentRepo,
            deps.intentExecutor,
            deps.intentToolExecutor,
            workflowSessions,
          ),
        ]
      : []),
    ...(deps.feedbackRepo ? [createFeedbackRouterLayer(deps.feedbackRepo)] : []),
    aiAgentLayer,
  ];

  return async (ctx: BotCommandContext) => {
    const user = ctx.dbUser as User | undefined;
    if (!user) return;

    // Voice message → transcribe → pass to AI agent
    const voiceRaw = (
      ctx as unknown as {
        voice?: { payload?: { file_id: string; duration: number }; file_id?: string; duration?: number };
      }
    ).voice;
    const voicePayload = voiceRaw?.payload ?? voiceRaw;
    if (voicePayload?.file_id && deps.transcriptionService && deps.botToken) {
      return handleVoiceMessage(ctx, user, voicePayload as { file_id: string; duration: number }, deps);
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

    const messageText = messagePrefix + text;

    await runPipeline(ctx, messageText, layers);
  };
}
