// src/bot/handlers/message/types.ts
// Dependency bag of the message handler and the scene storage view it needs.

import type { AnyScene } from '@gramio/scenes';
import type { CalendarProposalRepository } from '../../../database/repositories/calendar-proposal.repository.ts';
import type { ChatHistoryRepository } from '../../../database/repositories/chat-history.repository.ts';
import type { ContactRepository } from '../../../database/repositories/contact.repository.ts';
import type { EditProposalRepository } from '../../../database/repositories/edit-proposal.repository.ts';
import type { EventReminderRepository } from '../../../database/repositories/event-reminder.repository.ts';
import type { FeedbackRepository } from '../../../database/repositories/feedback.repository.ts';
import type { GoogleCalendarRepository } from '../../../database/repositories/google-calendar.repository.ts';
import type { GroupChatRepository } from '../../../database/repositories/group-chat.repository.ts';
import type { GroupMemberRepository } from '../../../database/repositories/group-member.repository.ts';
import type { IntentRepository } from '../../../database/repositories/intent.repository.ts';
import type { InvitationRepository } from '../../../database/repositories/invitation.repository.ts';
import type { ParticipantRepository } from '../../../database/repositories/participant.repository.ts';
import type { SecretaryRepository } from '../../../database/repositories/secretary.repository.ts';
import type { SharedEventRepository } from '../../../database/repositories/shared-event.repository.ts';
import type { SharingSettingsRepository } from '../../../database/repositories/sharing-settings.repository.ts';
import type { UserRepository } from '../../../database/repositories/user.repository.ts';
import type {
  NotificationPreferencesRow,
  NotificationPreferencesUpdate,
  User,
  UserCallSettings,
} from '../../../database/types.ts';
import type { CalendarBotAgent } from '../../../services/ai/agent.ts';
import type { AgentContext } from '../../../services/ai/types.ts';
import type { BirthdayService } from '../../../services/birthday/birthday-service.ts';
import type { ConversationLogger } from '../../../services/conversation-logger.ts';
import type { EventService } from '../../../services/event/event-service.ts';
import type { GroupSessionManager } from '../../../services/group/group-session.ts';
import type { GroupMemberService } from '../../../services/group/member-service.ts';
import type { HolidayService } from '../../../services/holiday/holiday-service.ts';
import type { RenderService } from '../../../services/image/render-service.ts';
import type { AdminEditSession } from '../../../services/intent/admin-edit-session.ts';
import type { EventMentionStore } from '../../../services/intent/event-mention-store.ts';
import type { IntentExecutor } from '../../../services/intent/intent-executor.ts';
import type { IntentLearner } from '../../../services/intent/intent-learner.ts';
import type { IntentMatcher } from '../../../services/intent/intent-matcher.ts';
import type { NliClassifier } from '../../../services/nli/nli-classifier.ts';
import type { ScenePauseService } from '../../../services/scene-pause.ts';
import type { DeepLinkService } from '../../../services/sharing/deep-link-service.ts';
import type { InvitationService } from '../../../services/sharing/invitation-service.ts';
import type { PrivacyService } from '../../../services/sharing/privacy-service.ts';
import type { SharingService } from '../../../services/sharing/sharing-service.ts';
import type { KokoroTtsService } from '../../../services/voice/kokoro-tts-service.ts';
import type { SileroTtsService } from '../../../services/voice/silero-tts-service.ts';
import type { StressDictionary } from '../../../services/voice/stress-dictionary.ts';
import type { TranscriptionService } from '../../../services/voice/transcription-service.ts';
import type { WorkflowSessionStore } from '../../pipeline/types.ts';

interface SceneStorage {
  get(key: string): Promise<unknown>;
  delete(key: string): unknown;
}

export interface MessageHandlerDeps {
  agent: CalendarBotAgent;
  eventService: EventService;
  holidayService: HolidayService;
  chatHistory: ChatHistoryRepository;
  conversationLogger: ConversationLogger;
  userRepo: UserRepository;
  eventReminderRepo: EventReminderRepository;
  contactRepo?: ContactRepository;
  participantRepo?: ParticipantRepository;
  editProposalRepo?: EditProposalRepository;
  secretaryRepo?: SecretaryRepository;
  calendarProposalRepo?: CalendarProposalRepository;
  checkGroupMembership?: (chatId: number, userId: number) => Promise<boolean>;
  invitationService?: InvitationService;
  invitationRepo?: InvitationRepository;
  sharingService?: SharingService;
  sharingSettingsRepo?: SharingSettingsRepository;
  sharedEventRepo?: SharedEventRepository;
  privacyService?: PrivacyService;
  renderService?: RenderService;
  notificationPrefs?: {
    getPrefs(userId: number): NotificationPreferencesRow;
    update(userId: number, patch: NotificationPreferencesUpdate): void;
    ensureDefaults(userId: number): void;
  };
  /** Voice-call reminders; present only when the call queue runs (the shared MTProto service tier is on). */
  callQueue?: { enqueue(userId: number, text: string): Promise<void> };
  callSettingsRepo?: {
    get(userId: number): UserCallSettings | null;
    ensureDefaults(userId: number): void;
    setEnabled(userId: number, enabled: boolean): void;
    setLanguage(userId: number, lang: string): void;
  };
  googleCalendarRepo?: GoogleCalendarRepository;
  googleSchedulePush?: (
    userId: number,
    eventId: number,
    action: 'create' | 'update' | 'delete',
    opts?: { googleEventId?: string },
  ) => Promise<void>;
  googleScheduleParticipantPush?: (
    participantUserId: number,
    eventId: number,
    action: 'create' | 'update' | 'delete',
  ) => Promise<void>;
  deepLinkService?: DeepLinkService;
  sceneStorage: SceneStorage;
  botUsername?: string;
  botId?: number;
  groupSessions?: GroupSessionManager;
  groupMemberRepo?: GroupMemberRepository;
  groupChatRepo?: GroupChatRepository;
  groupMemberService?: GroupMemberService;
  transcriptionService?: TranscriptionService;
  botToken?: string;
  downloadVoiceBuffer?: (botToken: string, fileId: string) => Promise<Buffer>;
  stressDictionary?: StressDictionary;
  resolveUsername?: AgentContext['resolveUsername'];
  lookupTelegramUser?: AgentContext['lookupTelegramUser'];
  sileroTts?: SileroTtsService;
  kokoroTts?: KokoroTtsService;
  fallbackTts?: { synthesize: (text: string, lang: string) => Promise<Buffer> };
  sendVoice?: (chatId: number, audio: Buffer) => Promise<void>;
  // Persistent store for last-mentioned event context (Redis-backed or in-memory)
  eventMentionStore?: EventMentionStore;
  // Pipeline: intent matching
  intentMatcher?: IntentMatcher;
  intentRepo?: IntentRepository;
  intentExecutor?: IntentExecutor;
  workflowSessions?: WorkflowSessionStore;
  // Pipeline: intent learning
  intentLearner?: IntentLearner;
  // NLI semantic filter for group messages
  nliClassifier?: NliClassifier;
  // Pipeline: feedback routing
  feedbackRepo?: FeedbackRepository;
  // Admin reply sessions: adminId → { threadId, userId, chatId, topicThreadId }
  adminReplySession?: Map<number, { threadId: number; userId: number; chatId?: number; topicThreadId?: number }>;
  botAdminId?: number;
  sendMessageToUser?: (chatId: number, text: string) => Promise<void>;
  sendMessageToChat?: AgentContext['sendMessageToChat'];
  // Admin intent edit sessions
  adminEditSessions?: Map<number, AdminEditSession>;
  proposeTimeSessions?: Map<number, { invitationId: number }>;
  editMessage?: (chatId: number, messageId: number, text: string) => Promise<void>;
  notifyInviterProposal?: (
    invitationId: number,
    inviteeUser: User,
    formattedTime: string,
    eventTitle: string,
  ) => Promise<void>;
  birthdayService?: BirthdayService;
  userMemoryRepo?: import('../../../database/repositories/user-memory.repository.ts').UserMemoryRepository;
  broadcastEnqueuer?: import('../../../worker/broadcast-queue.ts').BroadcastEnqueuer;
  actionLogRepo?: import('../../../database/repositories/action-log.repository.ts').ActionLogRepository;
  telegramSessionRepo?: import('../../../database/repositories/telegram-session.repository.ts').TelegramSessionRepository;
  telegramMasterKey?: Buffer;
  featureUsageRepo?: import('../../../database/repositories/feature-usage.repository.ts').FeatureUsageRepository;
  domainEvents?: import('../../../services/scheduled/domain-event-bus.ts').DomainEventBus;
  chatHistoryIds?: Map<number, number>;
  scenePauseService?: ScenePauseService;
  scheduledCallService?: import('../../../services/scheduled/scheduled-ai-call.service.ts').ScheduledAiCallService;
  triggerService?: { repo: import('../../../services/scheduled/trigger.repository.ts').TriggerRepository };
  // Onboarding scene for mandatory timezone/language setup
  onboardingScene?: AnyScene;
  locationVerification?: import('../../../services/location/location-verification-service.ts').LocationVerificationService;
  addressCache?: import('../../../services/location/address-cache.ts').AddressCache;
  pendingGeoStore?: import('../../../services/location/pending-geo-store.ts').PendingGeoStore;
  weatherService?: import('../../../services/weather/weather-service.ts').WeatherService;
  aiRetryQueue?: import('../../../services/scheduled/types.ts').QueueAdapter;
  aiRetryJobStore?: import('../../../services/scheduled/types.ts').RetryJobStore;
}
