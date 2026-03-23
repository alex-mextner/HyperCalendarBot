// src/bot/index.ts
import { Bot, InlineKeyboard } from 'gramio';
import { agentDispatcher } from '../agent/dispatcher.ts';
import { agentRegistry } from '../agent/registry.ts';
import { CB, RATE_LIMIT, t } from '../config/constants.ts';
import type { EnvConfig } from '../config/env.ts';
import type { DatabaseService } from '../database/index.ts';
import { CalendarProposalRepository } from '../database/repositories/calendar-proposal.repository.ts';
import { FeedbackRepository } from '../database/repositories/feedback.repository.ts';
import type { GoogleCalendarRepository } from '../database/repositories/google-calendar.repository.ts';
import { IntentRepository } from '../database/repositories/intent.repository.ts';
import type { CreateEventData, UpdateEventData, User } from '../database/types.ts';
import { CalendarBotAgent } from '../services/ai/agent.ts';
import { createTelegramSender } from '../services/ai/telegram-sender.ts';
import type { AgentConfig, AgentContext } from '../services/ai/types.ts';
import { BirthdayService } from '../services/birthday/birthday-service.ts';
import { ConversationLogger } from '../services/conversation-logger.ts';
import { ConflictChecker } from '../services/event/conflict-checker.ts';
import { EventService } from '../services/event/event-service.ts';
import type { GoogleOAuthService } from '../services/google/oauth.ts';
import { GroupSessionManager } from '../services/group/group-session.ts';
import { GroupMemberService } from '../services/group/member-service.ts';
import { HolidayService } from '../services/holiday/holiday-service.ts';
import type { RenderService } from '../services/image/render-service.ts';
import type { EventMentionStore } from '../services/intent/event-mention-store.ts';
import { IntentExecutor } from '../services/intent/intent-executor.ts';
import { IntentLearner } from '../services/intent/intent-learner.ts';
import { IntentMatcher } from '../services/intent/intent-matcher.ts';
import { ReminderMaterializer } from '../services/notification/materializer.ts';
import { NotificationPreferencesService } from '../services/notification/preferences.ts';
import { ScenePauseService } from '../services/scene-pause.ts';
import type { DomainEventBus } from '../services/scheduled/domain-event-bus.ts';
import { ScheduledAiCallRepository } from '../services/scheduled/scheduled-ai-call.repository.ts';
import type { ScheduledAiCallService } from '../services/scheduled/scheduled-ai-call.service.ts';
import { TriggerRepository } from '../services/scheduled/trigger.repository.ts';
import type { AiMessageJobData } from '../services/scheduled/trigger.service.ts';
import { DeepLinkService } from '../services/sharing/deep-link-service.ts';
import { InlineService } from '../services/sharing/inline-service.ts';
import { InvitationService } from '../services/sharing/invitation-service.ts';
import { PrivacyService } from '../services/sharing/privacy-service.ts';
import { SharingService } from '../services/sharing/sharing-service.ts';
import type { SileroTtsService } from '../services/voice/silero-tts-service.ts';
import type { StressDictionary } from '../services/voice/stress-dictionary.ts';
import type { TranscriptionService } from '../services/voice/transcription-service.ts';
import { botLogger } from '../utils/logger.ts';
import { handleAdd } from './commands/add.ts';
import { handleBirthdays } from './commands/birthdays.ts';
import { createActivateCommand, createConnectCommand, createDisconnectCommand } from './commands/connect.command.ts';
import { handleConnectGoogle } from './commands/connect-google.ts';
import { handleDelete } from './commands/delete.ts';
import { type DisconnectDeps, handleDisconnectGoogle } from './commands/disconnect-google.ts';
import { handleEdit } from './commands/edit.ts';
import { handleFree } from './commands/free.ts';
import { handleHelp } from './commands/help.ts';
import { handleHolidays } from './commands/holidays.ts';
import { handleImport } from './commands/import.ts';
import { handleInvitations } from './commands/invitations.ts';
import { handleInvite } from './commands/invite.ts';
import { handleMonth } from './commands/month.ts';
import { handlePing } from './commands/ping.ts';
import { handleSearch } from './commands/search.ts';
import { handleSettings } from './commands/settings.ts';
import { handleShare } from './commands/share.ts';
import { handleStart } from './commands/start.ts';
import { handleToday } from './commands/today.ts';
import { handleTomorrow } from './commands/tomorrow.ts';
import { handleWeek } from './commands/week.ts';
import { createCallbackHandler, parseAiBtnPayload } from './handlers/callback.handler.ts';
import { type ChatMemberContext, createChatMemberHandler } from './handlers/chat-member.handler.ts';
import { createInlineHandler, type InlineQueryContext } from './handlers/inline.handler.ts';
import { buildAgentContextFactory, createMessageHandler } from './handlers/message.handler.ts';
import { createCallbackFallback } from './middleware/callback-fallback.ts';
import { RateLimiter } from './middleware/rate-limiter.ts';
import { createSceneCommandEscape } from './middleware/scene-command-escape.ts';
import { createUserResolver } from './middleware/user-resolver.ts';
import { runWithChatId } from './scenes/chat-scoped-storage.ts';
import { createScenesPlugin } from './scenes/index.ts';
import type { SceneKvStorage } from './scenes/storage.ts';
import type { BotCallbackContext, BotCommandContext } from './types.ts';

/** GramIO context properties not exposed on the base Context type. */
interface GramIOBaseContext {
  // Context.update is the raw TelegramUpdate object (public on Context base class)
  update?: {
    message?: { text?: string };
    edited_message?: { text?: string };
    callback_query?: { data?: string };
  };
  from?: { id: number };
  dbUser?: User;
  chatId?: number | bigint;
  send?: (text: string, opts?: Record<string, unknown>) => Promise<unknown>;
  editText?: (text: string, opts?: Record<string, unknown>) => Promise<unknown>;
}

export interface GoogleBotDeps {
  oauthService: GoogleOAuthService;
  stateStore: { set(key: string, value: string, ttl: number): Promise<void> };
  disconnectDeps: DisconnectDeps;
  calendarRepo: GoogleCalendarRepository;
  onCalendarsDone?: (userId: number) => Promise<void>;
}

export function createBot(
  token: string,
  db: DatabaseService,
  aiConfig: AgentConfig,
  googleDeps?: GoogleBotDeps,
  renderService?: RenderService,
  callQueue?: {
    enqueue(data: {
      userId: number;
      eventId: number;
      callLogId: number;
      ttsText: string;
      language: string;
    }): Promise<void>;
  },
  transcriptionService?: TranscriptionService,
  mtprotoSendAsUser?: (userId: number, text: string) => Promise<boolean>,
  stressDictionary?: StressDictionary,
  sileroTts?: SileroTtsService,
  kokoroTts?: import('./handlers/message.handler.ts').MessageHandlerDeps['kokoroTts'],
  fallbackTts?: import('./handlers/message.handler.ts').MessageHandlerDeps['fallbackTts'],
  mtprotoResolveUsername?: (username: string) => Promise<{ id: number; firstName?: string; username?: string } | null>,
  eventMentionStore?: EventMentionStore,
  domainEventBus?: DomainEventBus,
  pushAiMessage?: (data: AiMessageJobData) => Promise<void>,
  envConfig?: Pick<
    EnvConfig,
    | 'BOT_ADMIN_ID'
    | 'INTENT_LEARNER_DAILY_LIMIT'
    | 'BOT_USERNAME'
    | 'AGENT_DOWNLOAD_URL'
    | 'INLINE_BOT_TOKEN'
    | 'AI_FAST_MODEL'
  >,
) {
  const materializer = new ReminderMaterializer(db.eventReminders, db.notificationPreferences);
  const eventService = new EventService({
    eventRepo: db.events,
    reminderRepo: db.reminders,
    materializer,
    participantRepo: db.participants,
    onParticipantsNotify: (userIds, text) => {
      for (const uid of userIds) {
        bot.api.sendMessage({ chat_id: uid, text }).catch(() => {});
      }
    },
    domainEvents: domainEventBus,
  });
  const holidayService = new HolidayService(db.holidays);
  holidayService.refreshOnStartup();
  const birthdayService = new BirthdayService(
    db.events,
    db.birthdayMeta,
    db.eventReminders,
    db.notificationPreferences,
  );
  const groupSessions = new GroupSessionManager(db.groupSessions);
  const prefsService = new NotificationPreferencesService(db.notificationPreferences);
  const rateLimiter = new RateLimiter({
    perMinute: RATE_LIMIT.MESSAGES_PER_MINUTE,
    cooldownMs: RATE_LIMIT.COOLDOWN_MS,
  });

  const deepLinkService = new DeepLinkService(db.deepLinks);
  const privacyService = new PrivacyService(db.sharingSettings);
  const conflictChecker = new ConflictChecker(db.events);
  const invitationService = new InvitationService(
    db.invitations,
    db.events,
    db.sharingSettings,
    db.participants,
    conflictChecker,
    domainEventBus,
  );
  const sharingService = new SharingService(db.events, privacyService);
  const inlineService = new InlineService(eventService, privacyService);
  const scenesSetup = createScenesPlugin(
    db,
    eventService,
    token,
    !!googleDeps,
    prefsService,
    holidayService,
    envConfig?.AI_FAST_MODEL,
  );

  const intentRepo = new IntentRepository(db.db);
  const feedbackRepo = new FeedbackRepository(db.db);
  const calendarProposalRepo = new CalendarProposalRepository(db.db);
  const conversationLogger = new ConversationLogger(db.chatHistory);
  const kvStorage = scenesSetup.storage as SceneKvStorage;
  const scenePauseService = new ScenePauseService(kvStorage);
  const intentMatcher = new IntentMatcher();
  const intentExecutor = new IntentExecutor();
  const adminEditSessions = new Map<number, import('../services/intent/admin-edit-session.ts').AdminEditSession>();
  const adminReplySession = new Map<number, { threadId: number; userId: number }>();
  const proposeTimeSessions = new Map<number, { invitationId: number }>();

  // Load approved intents into matcher on startup
  intentMatcher.load(intentRepo.getApproved());

  const bot = new Bot(token);

  const checkGroupMembership = async (chatId: number, userId: number): Promise<boolean> => {
    try {
      const member = await bot.api.getChatMember({ chat_id: chatId, user_id: userId });
      return !['left', 'kicked'].includes(member.status);
    } catch {
      return false;
    }
  };

  const telegramSender = createTelegramSender(bot, {
    sendAsUser: mtprotoSendAsUser,
  });
  const agent = new CalendarBotAgent(aiConfig, telegramSender);
  const triggerRepo = new TriggerRepository(db.db);
  const scheduleRepo = new ScheduledAiCallRepository(db.db);
  const groupMemberService = new GroupMemberService(db.groupMembers, db.users);

  const botAdminId = envConfig?.BOT_ADMIN_ID;
  const intentLearnerDailyLimit = envConfig?.INTENT_LEARNER_DAILY_LIMIT ?? 100;

  const intentLearner =
    botAdminId && !Number.isNaN(botAdminId)
      ? new IntentLearner(intentRepo, {
          apiKey: aiConfig.apiKey,
          baseUrl: aiConfig.baseUrl,
          model: aiConfig.model,
          dailyLimit: intentLearnerDailyLimit,
          adminId: botAdminId,
          sendToAdmin: (text, replyMarkup) =>
            bot.api.sendMessage({
              chat_id: botAdminId,
              text,
              reply_markup: replyMarkup,
            }),
        })
      : undefined;

  const msgDeps = {
    agent,
    eventService,
    holidayService,
    chatHistory: db.chatHistory,
    conversationLogger,
    userRepo: db.users,
    reminderRepo: db.reminders,
    contactRepo: db.contacts,
    participantRepo: db.participants,
    editProposalRepo: db.editProposals,
    secretaryRepo: db.secretaries,
    calendarProposalRepo,
    checkGroupMembership,
    invitationService,
    invitationRepo: db.invitations,
    sharingService,
    sharingSettingsRepo: db.sharingSettings,
    sharedEventRepo: db.sharedEvents,
    privacyService,
    renderService,
    callSettingsRepo: db.callSettings as AgentContext['callSettingsRepo'],
    callQueue: callQueue
      ? {
          enqueue: (userId: number, text: string) => {
            const callLog = db.callLog.create({ user_id: userId, tts_text: text });
            const user = db.users.findByTelegramId(userId);
            return callQueue.enqueue({
              userId,
              eventId: 0,
              callLogId: callLog.id,
              ttsText: text,
              language: user?.language ?? 'ru',
            });
          },
        }
      : undefined,
    notificationPrefs: {
      getPrefs: (userId: number) => prefsService.getOrCreate(userId),
      update: (userId: number, patch: Record<string, unknown>) => db.notificationPreferences.update(userId, patch),
      ensureDefaults: (userId: number) => db.notificationPreferences.ensureDefaults(userId),
    },
    googleCalendarRepo: googleDeps?.calendarRepo,
    deepLinkService,
    sceneStorage: scenesSetup.storage,
    botUsername: envConfig?.BOT_USERNAME,
    botId: Number(token.split(':')[0]),
    groupSessions,
    groupMemberRepo: db.groupMembers,
    groupChatRepo: db.groupChats,
    groupMemberService,
    transcriptionService,
    botToken: token,
    stressDictionary,
    resolveUsername: mtprotoResolveUsername,
    sileroTts,
    kokoroTts,
    fallbackTts,
    sendVoice:
      sileroTts || kokoroTts || fallbackTts
        ? async (chatId: number, audio: Buffer) => {
            const file = new File([audio], 'reply.ogg', { type: 'audio/ogg' });
            await bot.api.sendVoice({ chat_id: chatId, voice: file });
          }
        : undefined,
    intentMatcher,
    intentRepo,
    intentExecutor,
    eventMentionStore: eventMentionStore ?? db.eventMentions,
    feedbackRepo,
    workflowSessions: db.workflowSessions,
    adminEditSessions,
    adminReplySession,
    intentLearner,
    aiCityModel: envConfig?.AI_FAST_MODEL,
    botAdminId,
    aiBaseUrl: aiConfig.baseUrl,
    aiApiKey: aiConfig.apiKey,
    aiModel: aiConfig.model,
    sendMessageToUser: (chatId: number, text: string) => bot.api.sendMessage({ chat_id: chatId, text }),
    proposeTimeSessions,
    birthdayService,
    userMemoryRepo: db.userMemory,
    agentRegistry,
    agentDispatcher,
    scheduledCallService: undefined as ScheduledAiCallService | undefined,
    triggerService: undefined as { repo: typeof triggerRepo } | undefined,
    domainEvents: domainEventBus,
    editMessage: async (chatId: number, messageId: number, text: string) => {
      await bot.api
        .editMessageText({ chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML' })
        .catch(() => {});
    },
    notifyInviterProposal: async (
      invitationId: number,
      inviteeUser: User,
      formattedTime: string,
      eventTitle: string,
    ) => {
      const inv = db.invitations.findById(invitationId);
      if (!inv) return;
      const inviter = db.users.findByTelegramId(inv.inviter_id);
      if (!inviter) return;
      const inviterLang = (inviter.language ?? 'en') as 'en' | 'ru';
      const keyboard = new InlineKeyboard()
        .text(t(inviterLang).invite_reschedule_btn, `${CB.INVITATION_ACTION}:reschedule:${invitationId}`)
        .text(t(inviterLang).invite_keep_btn, `${CB.INVITATION_ACTION}:dismiss:${invitationId}`);
      const name = inviteeUser.first_name ?? inviteeUser.username ?? `#${inviteeUser.telegram_id}`;
      await bot.api.sendMessage({
        chat_id: inv.inviter_id,
        text: t(inviterLang).invite_propose_notify(name, eventTitle, formattedTime),
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    },
    scenePauseService,
  };

  bot
    .derive(createUserResolver(db))
    .use((context, next) => {
      const ctx = context as GramIOBaseContext;
      return runWithChatId(ctx.chatId ? Number(ctx.chatId) : 0, next);
    })
    .use(async (context, next) => {
      const ctx = context as GramIOBaseContext;
      const userId = ctx.from?.id;
      if (!userId) return next();
      const { allowed, firstBlock } = rateLimiter.checkWithWarning(userId);
      if (!allowed) {
        if (firstBlock) {
          const lang = (ctx.dbUser?.language ?? 'en') as 'en' | 'ru';
          await ctx.send?.(t(lang).rate_limited);
        }
        return;
      }
      return next();
    })
    // Storage<Record<string, any>> is not assignable to Storage (unparameterized) due to generic invariance
    .use(createSceneCommandEscape(scenesSetup.storage))
    .use(createCallbackFallback(scenesSetup.storage))
    .use(async (context, next) => {
      // Context.update is public on GramIO's base Context class — single cast is valid.
      const ctx = context as GramIOBaseContext;

      const user = ctx.dbUser;
      if (!user) return next();

      const chatId = ctx.chatId ? Number(ctx.chatId) : undefined;
      const isPrivate = !chatId || chatId === user.telegram_id;
      const logChatId = isPrivate ? undefined : chatId;

      // Incoming text message (regular or command)
      const incomingText = ctx.update?.message?.text;
      if (incomingText) {
        if (incomingText.match(/^\/cal(\s|$)/)) {
          // /cal is an AI command — save args as plain user message, not a command event
          const calArgs = incomingText.replace(/^\/cal\s*/, '').trim();
          if (calArgs) conversationLogger.logUserMessage(user.telegram_id, calArgs, logChatId);
        } else if (incomingText.startsWith('/')) {
          const spaceIdx = incomingText.indexOf(' ');
          const cmdName = spaceIdx >= 0 ? incomingText.slice(0, spaceIdx) : incomingText;
          const cmdArgs = spaceIdx >= 0 ? incomingText.slice(spaceIdx + 1).trim() : undefined;
          conversationLogger.logCommand(user.telegram_id, cmdName, cmdArgs || undefined, logChatId);
        } else {
          conversationLogger.logUserMessage(user.telegram_id, incomingText, logChatId);
        }
      }

      // Edited message
      const editedText = ctx.update?.edited_message?.text;
      if (editedText) {
        conversationLogger.logEditedMessage(user.telegram_id, editedText, logChatId);
      }

      // Callback query (button press or ai_btn answer) — universal, no per-handler logging needed
      // ctx.update.callback_query.data is the callback data string
      const callbackData = ctx.update?.callback_query?.data;
      if (callbackData) {
        const firstColon = callbackData.indexOf(':');
        const action = firstColon >= 0 ? callbackData.slice(0, firstColon) : callbackData;
        const payload = firstColon >= 0 ? callbackData.slice(firstColon + 1) : '';

        if (action === 'ai_btn') {
          const { answerText } = parseAiBtnPayload(payload);
          conversationLogger.logUserMessage(user.telegram_id, answerText, logChatId);
        } else {
          conversationLogger.logButtonPress(user.telegram_id, action, payload || undefined, logChatId);
        }
      }

      // Wrap ctx.send and ctx.editText — logs every bot response (intent matcher, scenes, commands, callbacks)
      // Note: AI agent uses TelegramSender.sendMessage() directly; those are logged via logAiTurn
      const originalSend = ctx.send?.bind(ctx);
      if (originalSend) {
        (ctx as { send: typeof originalSend }).send = async (text, opts) => {
          const result = await originalSend(text, opts);
          conversationLogger.logBotResponse(user.telegram_id, text, logChatId);
          return result;
        };
      }

      const originalEditText = ctx.editText?.bind(ctx);
      if (originalEditText) {
        (ctx as { editText: typeof originalEditText }).editText = async (text, opts) => {
          const result = await originalEditText(text, opts);
          conversationLogger.logBotEdit(user.telegram_id, text, logChatId);
          return result;
        };
      }

      return next();
    })
    .extend(scenesSetup.plugin)
    // Commands
    .command('start', (ctx) =>
      handleStart(ctx as BotCommandContext, {
        onboardingScene: scenesSetup.scenes.onboardingScene,
        deepLinkService,
        eventService,
        invitationRepo: db.invitations,
        userRepo: db.users,
      }),
    )
    .command('ping', (ctx) => handlePing(ctx as BotCommandContext))
    .command('help', (ctx) => handleHelp(ctx as BotCommandContext))
    .command('today', (ctx) =>
      handleToday(ctx as BotCommandContext, eventService, holidayService, renderService, db.groupChats),
    )
    .command('tomorrow', (ctx) =>
      handleTomorrow(ctx as BotCommandContext, eventService, holidayService, renderService, db.groupChats),
    )
    .command('week', (ctx) =>
      handleWeek(ctx as BotCommandContext, eventService, holidayService, renderService, db.groupChats),
    )
    .command('month', (ctx) =>
      handleMonth(ctx as BotCommandContext, eventService, undefined, renderService, db.groupChats),
    )
    .command('add', (ctx) =>
      handleAdd(ctx as BotCommandContext, eventService, scenesSetup.scenes.addEventScene, db.groupChats),
    )
    .command('edit', (ctx) => handleEdit(ctx as BotCommandContext, eventService, db.groupChats))
    .command('delete', (ctx) => handleDelete(ctx as BotCommandContext, eventService, db.groupChats))
    .command('search', (ctx) => handleSearch(ctx as BotCommandContext, eventService, db.groupChats))
    .command('free', (ctx) => handleFree(ctx as BotCommandContext, eventService, holidayService, db.groupChats))
    .command('settings', (ctx) => handleSettings(ctx as BotCommandContext, db.groupChats))
    .command('import', (ctx) => handleImport(ctx as BotCommandContext, scenesSetup.scenes.importScene, db.groupChats))
    .command('holidays', (ctx) => handleHolidays(ctx as BotCommandContext, holidayService, db.groupChats))
    .command('birthdays', (ctx) =>
      handleBirthdays(ctx as BotCommandContext, birthdayService, db.groupChats, db.groupMembers),
    )
    // Sharing commands
    .command('invite', (ctx) =>
      handleInvite(ctx as BotCommandContext, {
        invitationService,
        eventService,
        invRepo: db.invitations,
        deepLinkService,
        groupRepo: db.groupChats,
        sendMessage: async (chatId, text, options) => {
          const sent = await bot.api.sendMessage({
            chat_id: chatId,
            text,
            parse_mode: options.parse_mode as 'HTML',
            reply_markup: options.reply_markup as Parameters<typeof bot.api.sendMessage>[0]['reply_markup'],
          });
          return { message_id: sent.message_id };
        },
      }),
    )
    .command('invitations', (ctx) => handleInvitations(ctx as BotCommandContext, db.invitations, db.events, db.users))
    .command('share', (ctx) =>
      handleShare(ctx as BotCommandContext, eventService, privacyService, deepLinkService, db.groupChats),
    )
    // AI agent via /cal command (works in groups and DMs)
    .command('cal', async (ctx) => {
      const calCtx = ctx as BotCommandContext;
      const user = calCtx.dbUser as User | undefined;
      if (!user) return;
      const text = (calCtx.args ?? '').trim();
      if (!text) {
        const lang = (user.language ?? 'en') as 'en' | 'ru';
        await calCtx.send(
          lang === 'ru'
            ? 'Напиши после /cal что хочешь. Например: /cal что завтра?'
            : "Type after /cal what you want. Example: /cal what's tomorrow?",
        );
        return;
      }
      const chat = calCtx.chat;
      const isGroup = chat?.type === 'group' || chat?.type === 'supergroup';
      const chatId = calCtx.chatId;
      if (!chatId) return;

      const groupInfo = isGroup
        ? {
            isGroup: true as const,
            groupChatId: Number(chatId),
            groupTitle: chat?.title ?? undefined,
            onBotResponse: (messageId: number) => {
              if (groupSessions.hasActiveSession(Number(chatId))) {
                groupSessions.refresh(Number(chatId), messageId);
              } else {
                groupSessions.activate(Number(chatId), user.telegram_id, messageId);
              }
            },
          }
        : undefined;
      await agent.run(buildAgentContextFactory(msgDeps)(user, Number(chatId), text, groupInfo));
    })
    // Callback queries
    .on('callback_query', (ctx) =>
      createCallbackHandler(
        eventService,
        scenesSetup.scenes.editValueScene,
        holidayService,
        prefsService,
        googleDeps?.calendarRepo,
        googleDeps?.disconnectDeps,
        googleDeps?.onCalendarsDone,
        renderService,
        invitationService,
        db.events,
        db.chatHistory,
        async (userId: number, chatId: number, text: string) => {
          const user = db.users.findByTelegramId(userId);
          if (!user) return;
          await agent.run(buildAgentContextFactory(msgDeps)(user, chatId, text));
        },
        googleDeps ? { oauthService: googleDeps.oauthService, stateStore: googleDeps.stateStore } : undefined,
        {
          userRepo: db.users,
          sendMessage: async (
            chatId: number,
            text: string,
            options: { parse_mode: string; reply_markup?: unknown },
          ) => {
            await bot.api.sendMessage({
              chat_id: chatId,
              text,
              parse_mode: options.parse_mode as 'HTML' | 'MarkdownV2' | 'Markdown',
              ...(options.reply_markup ? { reply_markup: options.reply_markup as Record<string, unknown> } : {}),
            } as Parameters<typeof bot.api.sendMessage>[0]);
          },
          editMessage: async (chatId: number, messageId: number, text: string, markup?: unknown) => {
            await bot.api
              .editMessageText({
                chat_id: chatId,
                message_id: messageId,
                text,
                parse_mode: 'HTML',
                ...(markup ? { reply_markup: markup as Record<string, unknown> } : {}),
              } as Parameters<typeof bot.api.editMessageText>[0])
              .catch(() => {});
          },
          sendPhoto: async (chatId: number, photo: File) => {
            await bot.api.sendPhoto({ chat_id: chatId, photo });
          },
        },
        scenesSetup.scenes.onboardingScene,
        undefined,
        db.callSettings,
        db.sharingSettings,
        {
          feedbackRepo,
          adminReplySession,
          sendMessage: (chatId, text) => bot.api.sendMessage({ chat_id: chatId, text }),
          adminId: botAdminId,
        },
        db.users,
        {
          intentRepo,
          intentMatcher: {
            reload: () => intentMatcher.load(intentRepo.getApproved()),
          },
          adminEditSessions,
        },
        {
          secretaryRepo: db.secretaries,
          userRepo: db.users,
          sendMessage: async (chatId: number, text: string) => {
            await bot.api.sendMessage({ chat_id: chatId, text });
          },
          editMessage: async (chatId: number, messageId: number, text: string) => {
            await bot.api.editMessageText({ chat_id: chatId, message_id: messageId, text });
          },
        },
        {
          proposalRepo: calendarProposalRepo,
          eventService: {
            createEvent: (userId: number, data: Omit<CreateEventData, 'user_id'>) =>
              eventService.createEvent({ ...data, user_id: userId }),
            updateEvent: (id: number, userId: number, data: UpdateEventData) =>
              eventService.updateEvent(id, userId, data),
            deleteEvent: (id: number, userId: number) => eventService.deleteEvent(id, userId),
          },
          userRepo: db.users,
          sendMessage: async (chatId: number, text: string) => {
            await bot.api.sendMessage({ chat_id: chatId, text });
          },
          editMessage: async (chatId: number, messageId: number, text: string) => {
            await bot.api.editMessageText({ chat_id: chatId, message_id: messageId, text });
          },
        },
        undefined, // snoozeDeps
        invitationService
          ? {
              invitationService,
              invRepo: db.invitations,
              deepLinkService,
              sendMessage: async (
                chatId: number,
                text: string,
                options: { parse_mode: string; reply_markup?: unknown },
              ) => {
                const sent = await bot.api.sendMessage({
                  chat_id: chatId,
                  text,
                  parse_mode: options.parse_mode as 'HTML',
                  reply_markup: options.reply_markup as Parameters<typeof bot.api.sendMessage>[0]['reply_markup'],
                });
                return { message_id: sent.message_id };
              },
            }
          : undefined,
        proposeTimeSessions,
        db.invitations,
        sileroTts || kokoroTts
          ? {
              sileroTts,
              kokoroTts,
              sendVoice: async (chatId: number, audio: Buffer) => {
                const file = new File([audio], 'message.mp3', { type: 'audio/mpeg' });
                await bot.api.sendVoice({ chat_id: chatId, voice: file });
              },
              stressDictionary,
            }
          : undefined,
        db.contacts,
        scenesSetup.scenes.timezoneScene,
        db.groupChats,
        {
          sceneStorage: kvStorage,
          scenePauseService,
        },
      )(ctx as BotCallbackContext),
    )
    // Chat member updates (bot added/removed from groups)
    .on('my_chat_member', (ctx) =>
      createChatMemberHandler(
        db.groupChats,
        (chatId, text) =>
          bot.api
            .sendMessage({ chat_id: chatId, text })
            .catch((err: unknown) => {
              botLogger.error({ chatId, err: err }, 'Failed to send group welcome');
            })
            .then(() => {}),
        (userId) => (db.users.findByTelegramId(userId)?.language ?? 'en') as 'en' | 'ru',
        async (chatId) => {
          try {
            return await bot.api.exportChatInviteLink({ chat_id: chatId });
          } catch {
            return null;
          }
        },
      )(ctx as ChatMemberContext),
    )
    // Private chat: user blocked the bot — clear pending workflow sessions
    .on('my_chat_member', (ctx) => {
      if (ctx.chat.type !== 'private') return;
      if (ctx.newChatMember.status !== 'kicked') return;
      db.workflowSessions.deleteByUser(ctx.from.id);
    })
    // Users shared from picker modal → send invitations
    .on('users_shared', async (ctx) => {
      const user = (ctx as { dbUser?: User }).dbUser;
      if (!user) return;
      const eventId = ctx.requestId;
      const selected = ctx.users;
      const lang = (user.language ?? 'en') as 'en' | 'ru';
      const results: string[] = [];

      for (const shared of selected) {
        const name = shared.firstName ?? shared.username ?? `id:${shared.userId}`;
        // Save/update contact (deduplicates by telegram_id/username)
        if (db.contacts) {
          db.contacts.upsert(user.telegram_id, name, shared.username, shared.userId);
        }
        // Send invitation + deliver Telegram notification
        if (invitationService) {
          const inv = invitationService.sendInvitation(eventId, user.telegram_id, shared.userId);
          if (inv.success && inv.invitation) {
            const event = eventService.getEvent(eventId, user.telegram_id);
            const inviterName = user.first_name ?? user.username ?? `User ${user.telegram_id}`;
            const invText = t(lang).invitation_received(event?.title ?? `Event #${eventId}`, inviterName);
            telegramSender.sendInvitation!(shared.userId, invText, inv.invitation.id)
              .then((sent) => {
                if (sent) db.invitations.setMessageInfo(inv.invitation!.id, sent.message_id, shared.userId);
              })
              .catch(() => {});
          }
          results.push(inv.success ? `✅ ${name}` : `❌ ${name}: ${inv.error}`);
        } else {
          results.push(`❌ ${name}: invitations not configured`);
        }
      }

      const header = lang === 'ru' ? '📨 Приглашения:' : '📨 Invitations:';
      const resultText = `${header}\n${results.join('\n')}`;
      await ctx.send(resultText, {
        reply_markup: { remove_keyboard: true },
      });
      // Build context for AI: who was requested + what happened
      const selectedDetails = selected
        .map((s) => {
          const name = s.firstName ?? s.username ?? `id:${s.userId}`;
          const parts = [name, `id:${s.userId}`];
          if (s.username) parts.push(`@${s.username}`);
          return parts.join(' ');
        })
        .join(', ');
      const contextMsg = `[User picker result] Invitations already sent by the bot — do NOT call send_invitation. Selected: ${selectedDetails}. Results:\n${results.join('\n')}\nIf the selected person's display name differs from how the user originally referred to them, call add_contact with preferred_name = the name the user used.`;
      // Trigger AI to acknowledge/continue
      const chatId = ctx.chatId;
      if (chatId) {
        agent
          .run(buildAgentContextFactory(msgDeps)(user, chatId, contextMsg))
          .catch((e) => botLogger.error({ err: e }, 'AI continuation after users_shared failed'));
      }
    })
    // Group chat shared from picker → send invitation to group chat
    .on('chat_shared', async (ctx) => {
      const user = (ctx as { dbUser?: User }).dbUser;
      if (!user) return;
      const eventId = ctx.requestId;
      const inviteeId = ctx.sharedChatId;
      if (!eventId || !inviteeId) return;
      const lang = (user.language ?? 'en') as 'en' | 'ru';
      if (invitationService) {
        const event = eventService.getEvent(eventId, user.telegram_id);
        const inviterName = user.first_name ?? user.username ?? `User ${user.telegram_id}`;
        const inv = invitationService.sendInvitation(eventId, user.telegram_id, inviteeId);
        if (inv.success && inv.invitation) {
          const invText = t(lang).invitation_received(event?.title ?? `Event #${eventId}`, inviterName);
          telegramSender.sendInvitation!(inviteeId, invText, inv.invitation.id)
            .then((sent) => {
              if (sent) db.invitations.setMessageInfo(inv.invitation!.id, sent.message_id, inviteeId);
            })
            .catch((e) => botLogger.error({ err: e, inviteeId }, 'chat_shared invitation delivery failed'));
        }
        const resultText = inv.success
          ? t(lang).invite_delivered(event?.title ?? `Event #${eventId}`)
          : `❌ ${inv.error}`;
        await ctx.send(resultText, { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } });
      }
    })
    // Free-text messages → AI agent (wizard routing handled by @gramio/scenes)
    .on('message', (ctx) => createMessageHandler(msgDeps)(ctx as BotCommandContext))
    // Error handler
    .onError(({ context, kind, error }) => {
      botLogger.error({ kind, err: error }, 'Bot error');
      try {
        if (context && 'send' in context) {
          const dbUser = 'dbUser' in context ? (context as { dbUser?: { language?: string } }).dbUser : undefined;
          const errLang = (dbUser?.language ?? 'en') as 'en' | 'ru';
          (context as { send(text: string): Promise<unknown> }).send(t(errLang).something_wrong);
        }
      } catch {}
    });

  // AI Assistant commands (not in setMyCommands — internal use only)
  const connectCommand = createConnectCommand(envConfig?.AGENT_DOWNLOAD_URL ?? '');
  const activateCommand = createActivateCommand(agentRegistry);
  const disconnectCommand = createDisconnectCommand(agentRegistry, db.users);
  bot
    .command('connect', (ctx) => connectCommand(ctx as Parameters<typeof connectCommand>[0]))
    .command('activate', (ctx) => activateCommand(ctx as Parameters<typeof activateCommand>[0]))
    .command('disconnect', (ctx) => disconnectCommand(ctx as Parameters<typeof disconnectCommand>[0]));

  // Google Calendar commands (registered after derive chain so dbUser is available)
  if (googleDeps) {
    bot
      .command('connect_google', (ctx) =>
        handleConnectGoogle(ctx as BotCommandContext, {
          oauthService: googleDeps.oauthService,
          stateStore: googleDeps.stateStore,
        }),
      )
      .command('disconnect_google', (ctx) => handleDisconnectGoogle(ctx as BotCommandContext));
  }

  // Inline bot: separate bot instance for inline queries (or fallback to main bot)
  const inlineBotToken = envConfig?.INLINE_BOT_TOKEN;
  let inlineBot: Bot | undefined;
  if (inlineBotToken) {
    inlineBot = new Bot(inlineBotToken);
    inlineBot
      .derive(createUserResolver(db))
      .on('inline_query', (ctx) =>
        createInlineHandler(inlineService, db.users, db.sharingSettings)(ctx as InlineQueryContext),
      )
      .onError(({ error }) => {
        botLogger.error({ err: error }, 'Inline bot error');
      });
  } else {
    // No separate inline bot — register on main bot
    bot.on('inline_query', (ctx) =>
      createInlineHandler(inlineService, db.users, db.sharingSettings)(ctx as InlineQueryContext),
    );
  }

  return {
    bot,
    inlineBot,
    eventService,
    holidayService,
    prefsService,
    deepLinkService,
    privacyService,
    invitationService,
    sharingService,
    inlineService,
    groupSessions,
    db,
    renderService,
    agentContextBuilder: buildAgentContextFactory(msgDeps),
    agent,
    intentMatcher,
    intentExecutor,
    scheduleRepo,
    triggerRepo,
    msgDeps,
    pushAiMessage,
  };
}
