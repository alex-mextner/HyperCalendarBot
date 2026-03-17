// src/bot/handlers/message.handler.ts

import { InlineKeyboard } from 'gramio';
import type { ChatHistoryRepository } from '../../database/repositories/chat-history.repository.ts';
import type { ContactRepository } from '../../database/repositories/contact.repository.ts';
import type { EditProposalRepository } from '../../database/repositories/edit-proposal.repository.ts';
import type { FeedbackRepository } from '../../database/repositories/feedback.repository.ts';
import type { GoogleCalendarRepository } from '../../database/repositories/google-calendar.repository.ts';
import type { GroupMemberRepository } from '../../database/repositories/group-member.repository.ts';
import type { IntentRepository } from '../../database/repositories/intent.repository.ts';
import type { InvitationRepository } from '../../database/repositories/invitation.repository.ts';
import type { ParticipantRepository } from '../../database/repositories/participant.repository.ts';
import type { ReminderRepository } from '../../database/repositories/reminder.repository.ts';
import type { SharedEventRepository } from '../../database/repositories/shared-event.repository.ts';
import type { SharingSettingsRepository } from '../../database/repositories/sharing-settings.repository.ts';
import type { UserRepository } from '../../database/repositories/user.repository.ts';
import type { User } from '../../database/types.ts';
import type { CalendarBotAgent } from '../../services/ai/agent.ts';
import { executeTool } from '../../services/ai/tool-executor.ts';
import type { AgentContext, ToolResult } from '../../services/ai/types.ts';
import type { EventService } from '../../services/event/event-service.ts';
import { sendAdminReplyToUser } from '../../services/feedback/admin-messenger.ts';
import type { GroupSessionManager } from '../../services/group/group-session.ts';
import type { HolidayService } from '../../services/holiday/holiday-service.ts';
import type { RenderService } from '../../services/image/render-service.ts';
import { type AdminEditSession, isSessionExpired } from '../../services/intent/admin-edit-session.ts';
import type { IntentExecutor } from '../../services/intent/intent-executor.ts';
import type { IntentLearner } from '../../services/intent/intent-learner.ts';
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
  botId?: number;
  groupSessions?: GroupSessionManager;
  groupMemberRepo?: GroupMemberRepository;
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
  // Pipeline: intent learning
  intentLearner?: IntentLearner;
  // Pipeline: feedback routing
  feedbackRepo?: FeedbackRepository;
  // Admin reply sessions: adminId → { threadId, userId }
  adminReplySession?: Map<number, { threadId: number; userId: number }>;
  botAdminId?: number;
  sendMessageToUser?: (chatId: number, text: string) => Promise<unknown>;
  // Admin intent edit sessions
  adminEditSessions?: Map<number, AdminEditSession>;
  aiBaseUrl?: string;
  aiApiKey?: string;
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
      isGroup: false,
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

    const { responseText } = await deps.agent.run(agentContext);

    // Send voice reply if TTS is available and user has opted in
    if (
      responseText &&
      user.voice_response_enabled === 1 &&
      deps.sileroTts &&
      deps.sendVoice &&
      deps.stressDictionary
    ) {
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

    // One-time opt-in prompt for users who have never been asked
    if (user.voice_response_enabled === null) {
      const keyboard = new InlineKeyboard()
        .text('Да, хочу', 'voice_prompt:yes')
        .text('Нет, только текстом', 'voice_prompt:no');
      await ctx.send('🎤 Хочешь получать голосовые ответы?\nУдобно за рулём, на кухне или на ходу.', {
        reply_markup: keyboard,
      });
    }
  } catch (error) {
    cmdLogger.error({ error: String(error), userId: user.telegram_id }, 'Voice transcription error');
    await ctx.send(lang === 'ru' ? 'Не удалось обработать голосовое сообщение.' : 'Could not process voice message.');
  }
}

function buildAgentContextFactory(deps: MessageHandlerDeps) {
  return (user: User, chatId: number, messageText: string, groupInfo?: { isGroup: boolean; groupChatId?: number; groupTitle?: string; onBotResponse?: (messageId: number) => void }): AgentContext => ({
    user,
    chatId,
    messageText,
    isGroup: groupInfo?.isGroup ?? false,
    groupChatId: groupInfo?.groupChatId,
    groupTitle: groupInfo?.groupTitle,
    onBotResponse: groupInfo?.onBotResponse,
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

const INTENT_EDIT_SYSTEM_PROMPT = `You are a JSON editor for intent objects.
Given a current intent JSON and admin instructions, return ONLY a valid JSON object with updated fields.
Only include fields that should change: phrases (string[]), trigger_words (string[]), pattern (string|null), workflow (object), format (string).
Do not include id, canonical_name, status, source_message, created_at.`;

async function handleIntentEditInstruction(
  ctx: BotCommandContext,
  instruction: string,
  session: AdminEditSession,
  deps: MessageHandlerDeps,
): Promise<void> {
  const intentRepo = deps.intentRepo;
  if (!intentRepo) {
    await ctx.send('Intent repository not configured.');
    return;
  }

  const intent = intentRepo.getById(session.intentId);
  if (!intent) {
    await ctx.send(`Intent #${session.intentId} not found.`);
    return;
  }

  const currentJson = JSON.stringify({
    phrases: JSON.parse(intent.phrases),
    trigger_words: JSON.parse(intent.trigger_words),
    pattern: intent.pattern,
    workflow: JSON.parse(intent.workflow),
    format: intent.format,
  });

  try {
    const apiKey = deps.aiApiKey ?? '';
    const baseUrl = deps.aiBaseUrl ?? 'https://api.anthropic.com';

    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: INTENT_EDIT_SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `Current intent:\n${currentJson}\n\nAdmin instructions: ${instruction}`,
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`AI API error: ${response.status}`);
    }

    const data = (await response.json()) as { content: { type: string; text: string }[] };
    const text = data.content.find((c) => c.type === 'text')?.text;
    if (!text) throw new Error('Empty AI response');

    const updated = JSON.parse(text) as Partial<{
      phrases: string[];
      trigger_words: string[];
      pattern: string | null;
      workflow: Record<string, unknown>;
      format: string;
    }>;

    intentRepo.update(session.intentId, {
      ...(updated.phrases !== undefined && { phrases: updated.phrases }),
      ...(updated.trigger_words !== undefined && { trigger_words: updated.trigger_words }),
      ...(updated.pattern !== undefined && { pattern: updated.pattern ?? undefined }),
      ...(updated.workflow !== undefined && { workflow: updated.workflow }),
      ...(updated.format !== undefined && { format: updated.format }),
    });

    const fresh = intentRepo.getById(session.intentId)!;
    const preview = [
      `✏️ Intent #${fresh.id} updated: <b>${fresh.canonical_name}</b>`,
      `Phrases: ${(JSON.parse(fresh.phrases) as string[]).map((p) => `"${p}"`).join(', ')}`,
      fresh.pattern ? `Pattern: ${fresh.pattern}` : 'Pattern: none',
      `Workflow: ${fresh.workflow}`,
      `Format: ${fresh.format}`,
    ].join('\n');

    const { InlineKeyboard } = await import('gramio');
    const kb = new InlineKeyboard()
      .text('✅ Accept', `intent_accept:${fresh.id}`)
      .text('✏️ Edit', `intent_edit:${fresh.id}`)
      .text('❌ Reject', `intent_reject:${fresh.id}`);

    await ctx.send(preview, { parse_mode: 'HTML', reply_markup: kb });
  } catch (error) {
    cmdLogger.error({ error: String(error) }, 'Intent edit instruction failed');
    await ctx.send(`Failed to process edit: ${String(error)}`);
  }
}

export function createMessageHandler(deps: MessageHandlerDeps) {
  const agentContextBuilder = buildAgentContextFactory(deps);
  const workflowSessions = deps.workflowSessions ?? new Map<number, WorkflowSession>();

  const aiAgentLayer = createAiAgentLayer({
    agent: deps.agent,
    agentContextBuilder,
    intentLearner: deps.intentLearner,
  });

  // Static layers that don't require per-message context
  const staticLayers = [...(deps.feedbackRepo ? [createFeedbackRouterLayer(deps.feedbackRepo)] : []), aiAgentLayer];

  // Intent layer is built statically when a custom tool executor is provided,
  // or dynamically per-message using agentContextBuilder when it's absent.
  const staticIntentLayer =
    deps.intentMatcher && deps.intentRepo && deps.intentExecutor && deps.intentToolExecutor
      ? createIntentMatcherLayer(
          deps.intentMatcher,
          deps.intentRepo,
          deps.intentExecutor,
          deps.intentToolExecutor,
          workflowSessions,
        )
      : undefined;

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
      const isReplyToBot = deps.botId !== undefined && reply?.from?.id === deps.botId;
      const botMention = deps.botUsername ? `@${deps.botUsername}` : '';

      // Track member for fallback reminders
      if (deps.groupMemberRepo) {
        deps.groupMemberRepo.upsert(Number(chatId), user.telegram_id);
      }

      const hasSession = deps.groupSessions?.hasActiveSession(Number(chatId)) ?? false;

      if (!isReplyToBot && !isGroupRelevant(text, botMention)) {
        if (!hasSession) return; // No trigger, no session — skip
        // Session active but no keyword — tick and continue to AI
        deps.groupSessions!.tick(Number(chatId));
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

    // Admin reply session: if the admin has an active reply session, forward the message to the user
    if (
      deps.botAdminId &&
      user.telegram_id === deps.botAdminId &&
      deps.adminReplySession &&
      deps.feedbackRepo &&
      deps.sendMessageToUser
    ) {
      const session = deps.adminReplySession.get(user.telegram_id);
      if (session) {
        deps.adminReplySession.delete(user.telegram_id);
        const thread = deps.feedbackRepo.getThread(session.threadId);
        if (thread) {
          deps.feedbackRepo.addMessage({
            thread_id: session.threadId,
            sender: 'admin',
            text: messageText,
          });
          sendAdminReplyToUser(deps.sendMessageToUser, session.userId, messageText, thread.subject).catch(
            (e: unknown) => {
              cmdLogger.error({ error: String(e) }, 'Failed to deliver admin reply to user');
            },
          );
          await ctx.send('Reply sent.');
        }
        return;
      }
    }

    // Admin intent edit session: if admin has an active edit session, process as edit instruction
    if (deps.botAdminId && user.telegram_id === deps.botAdminId && deps.adminEditSessions) {
      const editSession = deps.adminEditSessions.get(user.telegram_id);
      if (editSession) {
        deps.adminEditSessions.delete(user.telegram_id);
        if (isSessionExpired(editSession)) {
          await ctx.send('Edit session expired. Please click Edit again.');
          return;
        }
        await handleIntentEditInstruction(ctx, messageText, editSession, deps);
        return;
      }
    }

    // Build per-message intent layer if no static one exists (tool executor requires user context)
    const intentLayer =
      staticIntentLayer ??
      (deps.intentMatcher && deps.intentRepo && deps.intentExecutor
        ? createIntentMatcherLayer(
            deps.intentMatcher,
            deps.intentRepo,
            deps.intentExecutor,
            (toolName, input) =>
              executeTool(agentContextBuilder(user, Number(ctx.chatId!), messageText), toolName, input),
            workflowSessions,
          )
        : undefined);

    const layers = [...(intentLayer ? [intentLayer] : []), ...staticLayers];

    const groupContext = isGroup
      ? {
          isGroup: true as const,
          groupChatId: Number(chatId),
          groupTitle: chat?.title ?? undefined,
          onBotResponse: deps.groupSessions
            ? (messageId: number) => {
                if (deps.groupSessions!.hasActiveSession(Number(chatId))) {
                  deps.groupSessions!.refresh(Number(chatId), messageId);
                } else {
                  deps.groupSessions!.activate(Number(chatId), user.telegram_id, messageId);
                }
              }
            : undefined,
        }
      : undefined;

    await runPipeline(ctx, messageText, layers, groupContext);
  };
}
