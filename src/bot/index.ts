// src/bot/index.ts
import { Bot } from 'gramio';
import { RATE_LIMIT, t } from '../config/constants.ts';
import type { DatabaseService } from '../database/index.ts';
import type { GoogleCalendarRepository } from '../database/repositories/google-calendar.repository.ts';
import type { User } from '../database/types.ts';
import { CalendarBotAgent } from '../services/ai/agent.ts';
import { createTelegramSender } from '../services/ai/telegram-sender.ts';
import type { AgentConfig } from '../services/ai/types.ts';
import { EventService } from '../services/event/event-service.ts';
import type { GoogleOAuthService } from '../services/google/oauth.ts';
import { HolidayService } from '../services/holiday/holiday-service.ts';
import type { RenderService } from '../services/image/render-service.ts';
import { NotificationPreferencesService } from '../services/notification/preferences.ts';
import { DeepLinkService } from '../services/sharing/deep-link-service.ts';
import { InlineService } from '../services/sharing/inline-service.ts';
import { InvitationService } from '../services/sharing/invitation-service.ts';
import { PrivacyService } from '../services/sharing/privacy-service.ts';
import { SharingService } from '../services/sharing/sharing-service.ts';
import { botLogger } from '../utils/logger.ts';
import { handleAdd } from './commands/add.ts';
import { handleGroupAgenda } from './commands/agenda.ts';
import { handleCallSettings } from './commands/call-settings.ts';
import { handleConnectGoogle } from './commands/connect-google.ts';
import { handleDelete } from './commands/delete.ts';
import { type DisconnectDeps, handleDisconnectGoogle } from './commands/disconnect-google.ts';
import { handleEdit } from './commands/edit.ts';
import { handleExport } from './commands/export.ts';
import { handleFree } from './commands/free.ts';
import { handleHelp } from './commands/help.ts';
import { handleHolidays } from './commands/holidays.ts';
import { handleImport } from './commands/import.ts';
import { handleInvitations } from './commands/invitations.ts';
import { handleInvite } from './commands/invite.ts';
import { handleMonth } from './commands/month.ts';
import { handleNotify } from './commands/notify.ts';
import { handlePing } from './commands/ping.ts';
import { handlePrivacy } from './commands/privacy.ts';
import { handleSearch } from './commands/search.ts';
import { handleSettings } from './commands/settings.ts';
import { handleShare } from './commands/share.ts';
import { handleStart } from './commands/start.ts';
import { handleTimezone } from './commands/timezone.ts';
import { handleToday } from './commands/today.ts';
import { handleTomorrow } from './commands/tomorrow.ts';
import { handleUnshare } from './commands/unshare.ts';
import { handleWeek } from './commands/week.ts';
import { createCallbackHandler } from './handlers/callback.handler.ts';
import { createChatMemberHandler } from './handlers/chat-member.handler.ts';
import { createInlineHandler } from './handlers/inline.handler.ts';
import { createMessageHandler } from './handlers/message.handler.ts';
import { createCallbackFallback } from './middleware/callback-fallback.ts';
import { RateLimiter } from './middleware/rate-limiter.ts';
import { createSceneCommandEscape } from './middleware/scene-command-escape.ts';
import { createUserResolver } from './middleware/user-resolver.ts';
import { createScenesPlugin } from './scenes/index.ts';
import type { BotCallbackContext, BotCommandContext } from './types.ts';

/**
 * GramIO's base Context class doesn't expose `from` or derived properties
 * in its type definition — they come from TargetMixin on specific update
 * contexts. We use a narrow interface and cast where needed.
 */
interface GramIOContextWithFrom {
  from?: { id: number };
}

interface GramIOContextWithDerived {
  dbUser?: User;
  send(text: string): Promise<unknown>;
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
) {
  const eventService = new EventService(db.events, db.reminders);
  const holidayService = new HolidayService(db.holidays);
  holidayService.refreshOnStartup();
  const prefsService = new NotificationPreferencesService(db.notificationPreferences);
  const rateLimiter = new RateLimiter({
    perMinute: RATE_LIMIT.MESSAGES_PER_MINUTE,
    cooldownMs: RATE_LIMIT.COOLDOWN_MS,
  });

  const deepLinkService = new DeepLinkService(db.deepLinks);
  const privacyService = new PrivacyService(db.sharingSettings);
  const invitationService = new InvitationService(db.invitations, db.events, db.sharingSettings);
  const sharingService = new SharingService(db.events, privacyService);
  const inlineService = new InlineService(eventService, privacyService);
  const scenesSetup = createScenesPlugin(db, eventService, token, !!googleDeps);

  const bot = new Bot(token);
  const telegramSender = createTelegramSender(bot);
  const agent = new CalendarBotAgent(aiConfig, telegramSender);

  bot
    .derive(createUserResolver(db))
    .use(async (context, next) => {
      const ctx = context as unknown as GramIOContextWithFrom;
      const userId = ctx.from?.id;
      if (!userId) return next();
      const { allowed, firstBlock } = rateLimiter.checkWithWarning(userId);
      if (!allowed) {
        if (firstBlock && 'send' in context) {
          const derived = context as unknown as GramIOContextWithDerived;
          const lang = (derived.dbUser?.language ?? 'en') as 'en' | 'ru';
          await derived.send(t(lang).rate_limited);
        }
        return;
      }
      return next();
    })
    .use(createSceneCommandEscape(scenesSetup.storage) as never)
    .use(createCallbackFallback(scenesSetup.storage) as never)
    .extend(scenesSetup.plugin)
    // Commands
    .command('start', (ctx) =>
      handleStart(
        ctx as unknown as BotCommandContext,
        scenesSetup.scenes.onboardingScene,
        deepLinkService,
        eventService,
      ),
    )
    .command('ping', (ctx) => handlePing(ctx as unknown as BotCommandContext))
    .command('help', (ctx) => handleHelp(ctx as unknown as BotCommandContext))
    .command('today', (ctx) =>
      handleToday(ctx as unknown as BotCommandContext, eventService, holidayService, renderService),
    )
    .command('tomorrow', (ctx) =>
      handleTomorrow(ctx as unknown as BotCommandContext, eventService, holidayService, renderService),
    )
    .command('week', (ctx) =>
      handleWeek(ctx as unknown as BotCommandContext, eventService, holidayService, renderService),
    )
    .command('month', (ctx) => handleMonth(ctx as unknown as BotCommandContext, eventService))
    .command('add', (ctx) =>
      handleAdd(ctx as unknown as BotCommandContext, eventService, scenesSetup.scenes.addEventScene),
    )
    .command('edit', (ctx) => handleEdit(ctx as unknown as BotCommandContext, eventService))
    .command('delete', (ctx) => handleDelete(ctx as unknown as BotCommandContext, eventService))
    .command('search', (ctx) => handleSearch(ctx as unknown as BotCommandContext, eventService))
    .command('free', (ctx) => handleFree(ctx as unknown as BotCommandContext, eventService, holidayService))
    .command('timezone', (ctx) => handleTimezone(ctx as unknown as BotCommandContext, scenesSetup.scenes.timezoneScene))
    .command('settings', (ctx) => handleSettings(ctx as unknown as BotCommandContext))
    .command('import', (ctx) => handleImport(ctx as unknown as BotCommandContext, scenesSetup.scenes.importScene))
    .command('export', (ctx) => handleExport(ctx as unknown as BotCommandContext, eventService))
    .command('holidays', (ctx) => handleHolidays(ctx as unknown as BotCommandContext, holidayService))
    .command('notify', (ctx) => handleNotify(ctx as unknown as BotCommandContext, prefsService))
    // Sharing commands
    .command('invite', (ctx) =>
      handleInvite(
        ctx as unknown as BotCommandContext,
        invitationService,
        eventService,
        db.invitations,
        deepLinkService,
        (chatId, text, options) =>
          bot.api.sendMessage({
            chat_id: chatId,
            text,
            parse_mode: options.parse_mode,
            reply_markup: options.reply_markup as never,
          }),
      ),
    )
    .command('invitations', (ctx) => handleInvitations(ctx as unknown as BotCommandContext, db.invitations, db.events))
    .command('privacy', (ctx) => handlePrivacy(ctx as unknown as BotCommandContext, db.sharingSettings))
    .command('share', (ctx) =>
      handleShare(ctx as unknown as BotCommandContext, eventService, privacyService, deepLinkService),
    )
    .command('unshare', (ctx) => handleUnshare(ctx as unknown as BotCommandContext, db.groupChats))
    .command('agenda', (ctx) => handleGroupAgenda(ctx as unknown as BotCommandContext, db.groupChats, db.events))
    // Voice call settings
    .command('callsettings', (ctx) => handleCallSettings(ctx as unknown as BotCommandContext, db.callSettings))
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
        db.groupChats,
        db.events,
        db.chatHistory,
        async (userId: number, chatId: number, text: string) => {
          const user = db.users.findByTelegramId(userId);
          if (!user) return;
          await agent.run({
            user,
            chatId,
            messageText: text,
            eventService,
            holidayService,
            chatHistory: db.chatHistory,
            userRepo: db.users,
            reminderRepo: db.reminders,
            contactRepo: db.contacts,
            invitationService,
            invitationRepo: db.invitations,
            sharingService,
            sharingSettingsRepo: db.sharingSettings,
            sharedEventRepo: db.sharedEvents,
            privacyService,
          });
        },
      )(ctx as unknown as BotCallbackContext),
    )
    // Inline queries (sharing via inline mode)
    .on('inline_query', (ctx) => createInlineHandler(inlineService, db.users, db.sharingSettings)(ctx as never))
    // Chat member updates (bot added/removed from groups)
    .on('my_chat_member', (ctx) => createChatMemberHandler(db.groupChats)(ctx as never))
    // Users shared from picker modal → send invitations
    .on('users_shared', async (ctx) => {
      const user = (ctx as unknown as { dbUser?: User }).dbUser;
      if (!user) return;
      const eventId = ctx.requestId;
      const selected = ctx.users;
      const lang = (user.language ?? 'en') as 'en' | 'ru';
      const results: string[] = [];

      for (const shared of selected) {
        const name = shared.firstName ?? shared.username ?? `id:${shared.userId}`;
        // Save to contacts
        if (db.contacts) {
          const existing = db.contacts.findByName(user.telegram_id, name);
          if (!existing) {
            db.contacts.add(user.telegram_id, name, shared.username, shared.userId);
          } else if (shared.username && !existing.username) {
            db.contacts.update(existing.id, { username: shared.username, telegram_id: shared.userId });
          }
        }
        // Send invitation
        if (invitationService) {
          const inv = invitationService.sendInvitation(eventId, user.telegram_id, shared.userId);
          results.push(inv.success ? `✅ ${name}` : `❌ ${name}: ${inv.error}`);
        } else {
          results.push(`❌ ${name}: invitations not configured`);
        }
      }

      const header = lang === 'ru' ? '📨 Приглашения:' : '📨 Invitations:';
      const resultText = `${header}\n${results.join('\n')}`;
      await (ctx as unknown as { send(text: string, opts?: Record<string, unknown>): Promise<void> }).send(resultText, {
        reply_markup: { remove_keyboard: true },
      });
      // Build context for AI: who was requested + what happened
      const selectedNames = selected.map((s) => s.firstName ?? s.username ?? `id:${s.userId}`).join(', ');
      const contextMsg = `[User picker result] Selected: ${selectedNames}. Results:\n${results.join('\n')}`;
      // Trigger AI to acknowledge/continue
      const chatId = (ctx as unknown as { chat?: { id: number } }).chat?.id;
      if (chatId) {
        agent
          .run({
            user,
            chatId,
            messageText: contextMsg,
            eventService,
            holidayService,
            chatHistory: db.chatHistory,
            userRepo: db.users,
            reminderRepo: db.reminders,
            contactRepo: db.contacts,
            invitationService,
            invitationRepo: db.invitations,
            sharingService,
            sharingSettingsRepo: db.sharingSettings,
            sharedEventRepo: db.sharedEvents,
            privacyService,
          })
          .catch((e) => botLogger.error({ error: String(e) }, 'AI continuation after users_shared failed'));
      }
    })
    // Free-text messages → AI agent (wizard routing handled by @gramio/scenes)
    .on('message', (ctx) =>
      createMessageHandler({
        agent,
        eventService,
        holidayService,
        chatHistory: db.chatHistory,
        userRepo: db.users,
        reminderRepo: db.reminders,
        contactRepo: db.contacts,
        invitationService,
        invitationRepo: db.invitations,
        sharingService,
        sharingSettingsRepo: db.sharingSettings,
        sharedEventRepo: db.sharedEvents,
        privacyService,
        renderService,
        sceneStorage: scenesSetup.storage,
        botUsername: process.env.BOT_USERNAME,
      })(ctx as unknown as BotCommandContext),
    )
    // Error handler
    .onError(({ context, kind, error }) => {
      botLogger.error({ kind, error: String(error) }, 'Bot error');
      try {
        if (context && 'send' in context) {
          const derived = context as unknown as GramIOContextWithDerived;
          const errLang = (derived.dbUser?.language ?? 'en') as 'en' | 'ru';
          derived.send(t(errLang).something_wrong);
        }
      } catch {}
    });

  // Google Calendar commands (registered after derive chain so dbUser is available)
  if (googleDeps) {
    bot
      .command('connect_google', (ctx) =>
        handleConnectGoogle(ctx as unknown as BotCommandContext, {
          oauthService: googleDeps.oauthService,
          stateStore: googleDeps.stateStore,
        }),
      )
      .command('disconnect_google', (ctx) => handleDisconnectGoogle(ctx as unknown as BotCommandContext));
  }

  return {
    bot,
    eventService,
    holidayService,
    prefsService,
    deepLinkService,
    privacyService,
    invitationService,
    sharingService,
    inlineService,
    db,
    renderService,
  };
}
