// src/bot/handlers/callback/types.ts
// Shared types for the callback router: handler signature, caller options and per-feature deps.

import type { AnyScene } from '@gramio/scenes';
import type { InlineKeyboard } from 'gramio';
import type { CalendarProposalRepository } from '../../../database/repositories/calendar-proposal.repository.ts';
import type { CallSettingsRepository } from '../../../database/repositories/call-settings.repository.ts';
import type { ChatHistoryRepository } from '../../../database/repositories/chat-history.repository.ts';
import type { ContactRepository } from '../../../database/repositories/contact.repository.ts';
import type { EditProposalRepository } from '../../../database/repositories/edit-proposal.repository.ts';
import type { EventRepository } from '../../../database/repositories/event.repository.ts';
import type { EventReminderRepository } from '../../../database/repositories/event-reminder.repository.ts';
import type { FeedbackRepository } from '../../../database/repositories/feedback.repository.ts';
import type { GoogleCalendarRepository } from '../../../database/repositories/google-calendar.repository.ts';
import type { GroupChatRepository } from '../../../database/repositories/group-chat.repository.ts';
import type { IntentRepository } from '../../../database/repositories/intent.repository.ts';
import type { InvitationRepository } from '../../../database/repositories/invitation.repository.ts';
import type { SecretaryRepository } from '../../../database/repositories/secretary.repository.ts';
import type { SharingSettingsRepository } from '../../../database/repositories/sharing-settings.repository.ts';
import type { UserRepository } from '../../../database/repositories/user.repository.ts';
import type { CreateEventData, UpdateEventData, User } from '../../../database/types.ts';
import type { EventService } from '../../../services/event/event-service.ts';
import type { GoogleOAuthService } from '../../../services/google/oauth.ts';
import type { HolidayService } from '../../../services/holiday/holiday-service.ts';
import type { ImageRenderer } from '../../../services/image/render-service.ts';
import type { AdminEditSession } from '../../../services/intent/admin-edit-session.ts';
import type { NotificationPreferencesService } from '../../../services/notification/preferences.ts';
import type { ScenePauseService } from '../../../services/scene-pause.ts';
import type { InvitationService } from '../../../services/sharing/invitation-service.ts';
import type { StressDictionary } from '../../../services/voice/stress-dictionary.ts';
import type { WeatherService } from '../../../services/weather/weather-service.ts';
import type { ParseMode } from '../../../utils/telegram.ts';
import type { DisconnectDeps } from '../../commands/disconnect-google.ts';
import type { BotCallbackContext } from '../../types.ts';
import type { AgentContinuationDeps } from '../agent-continuation.ts';

type HandlerFn = (
  ctx: BotCallbackContext,
  payload: string,
  parts: string[],
  user: User,
  data: string,
) => Promise<unknown>;

export interface CallbackHandlerOpts {
  calendarRepo?: GoogleCalendarRepository;
  disconnectDeps?: DisconnectDeps;
  onCalendarsDone?: (userId: number) => Promise<void>;
  renderService?: ImageRenderer;
  invitationService?: InvitationService;
  eventRepo?: EventRepository;
  chatHistoryRepo?: ChatHistoryRepository;
  /** Runs the AI on an `ai_btn` answer; the logging middleware already saved it to chat_history. */
  onAiButtonClick?: (userId: number, chatId: number, text: string) => Promise<void>;
  /** Runs the AI on a bot-composed turn (recipient confirmation), saving it to chat_history first. */
  agentContinuation?: AgentContinuationDeps;
  oauthDeps?: {
    oauthService: GoogleOAuthService;
    stateStore: { set(key: string, value: string, ttl: number): Promise<void> };
  };
  invitationNotifyDeps?: {
    userRepo: UserRepository;
    sendMessage: (
      chatId: number,
      text: string,
      options: { parse_mode: ParseMode; reply_markup?: InlineKeyboard },
    ) => Promise<void>;
    editMessage?: (chatId: number, messageId: number, text: string, markup?: InlineKeyboard) => Promise<void>;
    sendPhoto?: (chatId: number, photo: File) => Promise<void>;
    sendDocument?: (chatId: number, document: File, caption: string) => Promise<void>;
  };
  onboardingScene?: AnyScene;
  editProposalDeps?: {
    editProposalRepo: EditProposalRepository;
    sendMessage: (chatId: number, text: string, options?: { parse_mode: ParseMode }) => Promise<void>;
    enqueueSyncJob?: (job: { type: string; userId: number; eventId: number; action: string }) => Promise<void>;
  };
  /** Set only when the bot can place calls; without it /settings hides call reminders. */
  callSettingsRepo?: CallSettingsRepository;
  sharingSettingsRepo?: SharingSettingsRepository;
  feedbackDeps?: {
    feedbackRepo: FeedbackRepository;
    adminReplySession: Map<number, { threadId: number; userId: number; chatId?: number; topicThreadId?: number }>;
    sendMessage: (chatId: number, text: string) => Promise<void>;
    adminId?: number;
  };
  userRepo?: UserRepository;
  intentDeps?: {
    intentRepo: IntentRepository;
    intentMatcher?: { reload: () => void };
    adminEditSessions?: Map<number, AdminEditSession>;
    adminId?: number;
  };
  secretaryDeps?: SecretaryDeps;
  proposalDeps?: ProposalDeps;
  snoozeDeps?: SnoozeDeps;
  forceInviteDeps?: ForceInviteDeps;
  proposeTimeSessions?: Map<number, { invitationId: number }>;
  invitationRepo?: InvitationRepository;
  voiceDeps?: {
    sileroTts?: { synthesize: (text: string) => Promise<Buffer> };
    kokoroTts?: { synthesize: (text: string) => Promise<Buffer> };
    sendVoice: (chatId: number, audio: Buffer) => Promise<void>;
    stressDictionary?: StressDictionary;
  };
  contactRepo?: ContactRepository;
  timezoneScene?: AnyScene;
  connectTelegramScene?: AnyScene;
  telegramDeps?: {
    sessionRepo: import('../../../database/repositories/telegram-session.repository.ts').TelegramSessionRepository;
    masterKey: Buffer | null;
  };
  groupRepo?: GroupChatRepository;
  scenePauseDeps?: {
    sceneStorage: { get(key: string): Promise<unknown>; delete(key: string): unknown };
    scenePauseService: ScenePauseService;
  };
  triggerSync?: (userId: number) => Promise<void>;
  locationVerification?: import('../../../services/location/location-verification-service.ts').LocationVerificationService;
  pendingGeoStore?: import('../../../services/location/pending-geo-store.ts').PendingGeoStore;
  weatherService?: WeatherService;
}

export interface SnoozeDeps {
  reminderRepo: Pick<EventReminderRepository, 'insert' | 'getLastSentForEvent'>;
  eventRepo: Pick<EventRepository, 'findById'>;
}

export interface ForceInviteDeps {
  invitationService: InvitationService;
  invRepo: Pick<
    import('../../../database/repositories/invitation.repository.ts').InvitationRepository,
    'setMessageInfo'
  >;
  deepLinkService: import('../../../services/sharing/deep-link-service.ts').DeepLinkService;
  sendMessage: (
    chatId: number,
    text: string,
    options: { parse_mode: ParseMode; reply_markup?: InlineKeyboard },
  ) => Promise<{ message_id: number }>;
}

export interface SecretaryDeps {
  secretaryRepo: Pick<SecretaryRepository, 'findById' | 'updateStatus'>;
  userRepo: Pick<UserRepository, 'findByTelegramId'>;
  sendMessage: (chatId: number, text: string) => Promise<void>;
  editMessage: (chatId: number, messageId: number, text: string) => Promise<void>;
}

export interface ProposalDeps {
  proposalRepo: Pick<CalendarProposalRepository, 'findById' | 'updateStatus'>;
  eventService: {
    createEvent: (userId: number, data: Omit<CreateEventData, 'user_id'>) => { id: number; title?: string } | null;
    updateEvent: (id: number, userId: number, data: UpdateEventData) => { id: number } | null;
    deleteEvent: (id: number, userId: number) => boolean;
  };
  userRepo: Pick<UserRepository, 'findByTelegramId'>;
  sendMessage: (chatId: number, text: string) => Promise<void>;
  editMessage: (chatId: number, messageId: number, text: string) => Promise<void>;
}

export type CallbackDispatch = Map<string, HandlerFn>;

/** The services and optional deps every route group closes over; `opts` is the caller's raw options. */
export interface CallbackRouteDeps {
  eventService: EventService;
  editValueScene: AnyScene;
  holidayService: HolidayService;
  prefsService: NotificationPreferencesService;
  opts: CallbackHandlerOpts;
}
