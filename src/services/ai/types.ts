import type { InlineKeyboard, TelegramInlineKeyboardMarkup, TelegramMessage } from 'gramio';
import type { ActionLogRepository } from '../../database/repositories/action-log.repository.ts';
import type { CalendarProposalRepository } from '../../database/repositories/calendar-proposal.repository.ts';
import type { ChatHistoryRepository } from '../../database/repositories/chat-history.repository.ts';
import type { ContactRepository } from '../../database/repositories/contact.repository.ts';
import type { EditProposalRepository } from '../../database/repositories/edit-proposal.repository.ts';
import type { EventReminderRepository } from '../../database/repositories/event-reminder.repository.ts';
import type { FeatureUsageRepository } from '../../database/repositories/feature-usage.repository.ts';
import type { FeedbackRepository } from '../../database/repositories/feedback.repository.ts';
import type { GoogleCalendarRepository } from '../../database/repositories/google-calendar.repository.ts';
import type { GroupChatRepository } from '../../database/repositories/group-chat.repository.ts';
import type { GroupMemberRepository } from '../../database/repositories/group-member.repository.ts';
import type { InvitationRepository } from '../../database/repositories/invitation.repository.ts';
import type { ParticipantRepository } from '../../database/repositories/participant.repository.ts';
import type { SecretaryRepository } from '../../database/repositories/secretary.repository.ts';
import type { SharedEventRepository } from '../../database/repositories/shared-event.repository.ts';
import type { SharingSettingsRepository } from '../../database/repositories/sharing-settings.repository.ts';
import type { TelegramSessionRepository } from '../../database/repositories/telegram-session.repository.ts';
import type { UserRepository } from '../../database/repositories/user.repository.ts';
import type {
  EventOccurrence,
  NotificationPreferencesRow,
  NotificationPreferencesUpdate,
  User,
  UserCallSettings,
} from '../../database/types.ts';
import type { ParseMode } from '../../utils/telegram.ts';
import type { BirthdayService } from '../birthday/birthday-service.ts';
import type { ConversationLogger } from '../conversation-logger.ts';
import type { EventService } from '../event/event-service.ts';
import type { GroupMemberService } from '../group/member-service.ts';
import type { HolidayService } from '../holiday/holiday-service.ts';
import type { ImageRenderer } from '../image/render-service.ts';
import type { EventSummary } from '../intent/variable-resolver.ts';
import type { AddressCache } from '../location/address-cache.ts';
import type { LocationVerificationService } from '../location/location-verification-service.ts';
import type { DomainEventBus } from '../scheduled/domain-event-bus.ts';
import type { ScheduledAiCall, Trigger } from '../scheduled/types.ts';
import type { DeepLinkService } from '../sharing/deep-link-service.ts';
import type { InvitationService } from '../sharing/invitation-service.ts';
import type { PrivacyService } from '../sharing/privacy-service.ts';
import type { SharingService } from '../sharing/sharing-service.ts';
import type { StressDictionary } from '../voice/stress-dictionary.ts';
import type { WeatherService } from '../weather/weather-service.ts';

// ---------------------------------------------------------------------------
// Capability group interfaces — each group is optional as a whole;
// if present, all fields inside are guaranteed non-null.
// This forces callers to guard with `if (ctx.sharing)` once, after which
// TypeScript knows every field is defined — no per-field `?.` or `!`.
// ---------------------------------------------------------------------------

export interface SharingCapability {
  invitationService: InvitationService;
  invitationRepo: InvitationRepository;
  sharingService: SharingService;
  sharingSettingsRepo: SharingSettingsRepository;
  sharedEventRepo: SharedEventRepository;
  privacyService: PrivacyService;
  editProposalRepo: EditProposalRepository;
}

export interface SecretaryCapability {
  secretaryRepo: SecretaryRepository;
  /** Formatted line listing all calendars this user manages as secretary. */
  secretaryForLine: string | undefined;
  calendarProposalRepo: CalendarProposalRepository;
}

export interface GroupCapability {
  checkGroupMembership: (chatId: number, userId: number) => Promise<boolean>;
  groupChatRepo: GroupChatRepository;
  groupMemberRepo: GroupMemberRepository;
  groupMemberService: GroupMemberService;
}

export interface VoiceCapability {
  callQueue: { enqueue(userId: number, text: string): void };
  callSettingsRepo: {
    get(userId: number): UserCallSettings | null;
    ensureDefaults(userId: number): void;
    setEnabled(userId: number, enabled: boolean): void;
    setLanguage(userId: number, lang: string): void;
  };
  /** May be absent if the dictionary file failed to load (non-fatal). handleLookupStress guards for this. */
  stressDictionary?: StressDictionary;
}

export interface GoogleCapability {
  googleCalendarRepo: GoogleCalendarRepository;
  schedulePush?: (
    userId: number,
    eventId: number,
    action: 'create' | 'update' | 'delete',
    opts?: { googleEventId?: string },
  ) => Promise<void>;
  scheduleParticipantPush?: (
    participantUserId: number,
    eventId: number,
    action: 'create' | 'update' | 'delete',
  ) => Promise<void>;
}

export interface NotificationsCapability {
  notificationPrefs: {
    getPrefs(userId: number): NotificationPreferencesRow;
    update(userId: number, patch: NotificationPreferencesUpdate): void;
    ensureDefaults(userId: number): void;
  };
}

export interface FeedbackCapability {
  feedbackContext:
    | {
        threadId: number;
        subject: string;
        messages: { sender: string; text: string }[];
      }
    | undefined;
  feedbackRepo: FeedbackRepository;
  botAdminId: number;
}

export interface ScheduledCapability {
  scheduledCallService: import('../scheduled/scheduled-ai-call.service.ts').ScheduledAiCallService;
  triggerService: { repo: import('../scheduled/trigger.repository.ts').TriggerRepository };
  domainEvents?: DomainEventBus;
}

export interface SceneCapability {
  scenePauseState: import('../scene-pause.ts').ScenePauseState | undefined;
  scenePauseService: import('../scene-pause.ts').ScenePauseService;
}

export interface BirthdayCapability {
  birthdayService: BirthdayService;
  userMemoryRepo: import('../../database/repositories/user-memory.repository.ts').UserMemoryRepository;
}

export interface BroadcastCapability {
  /** Enqueue a single per-recipient broadcast. */
  enqueue: (data: import('../../worker/broadcast-queue.ts').BroadcastJobData) => Promise<void>;
  /** Enqueue multiple recipients in one Redis round-trip. */
  enqueueBatch: (items: import('../../worker/broadcast-queue.ts').BroadcastJobData[]) => Promise<void>;
  /** Register a batch for aggregated failure tracking (requires Redis). */
  registerBatch?: (
    batchId: string,
    meta: import('../../worker/broadcast-queue.ts').BroadcastBatchMeta,
  ) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Main context
// ---------------------------------------------------------------------------

export interface AgentContext {
  // Core — always present
  user: User;
  chatId: number;
  messageText: string;
  /** chat_history row ID of the incoming user message. Used to link action log → conversation. */
  chatHistoryId?: number;
  isGroup: boolean;
  eventService: EventService;
  holidayService: HolidayService;
  chatHistory: ChatHistoryRepository;
  conversationLogger: ConversationLogger;
  userRepo: UserRepository;
  eventReminderRepo: EventReminderRepository;

  // Standalone optionals (contextual, not capability groups)
  /** Telegram message_id of the incoming message being processed. Used for set_reaction. */
  incomingMessageId?: number;
  groupChatId?: number;
  groupTitle?: string;
  /** Telegram forum topic thread ID. Present when the message is inside a topic. */
  topicThreadId?: number;
  onBotResponse?: (messageId: number) => void;
  sender?: TelegramSender;
  /** Called after any successful tool call that references an event (by ID or creation). */
  onEventMentioned?: (eventId: number) => void;
  renderService?: ImageRenderer;
  deepLinkService?: DeepLinkService;
  botUsername?: string;
  /** Telegram file_id of the voice message that triggered this interaction. */
  voiceFileId?: string;
  sendMessageToChat?: (
    chatId: number,
    text: string,
    options?: { reply_markup?: InlineKeyboard | TelegramInlineKeyboardMarkup; message_thread_id?: number },
  ) => Promise<TelegramMessage>;
  resolveUsername?: (username: string) => Promise<{ id: number; firstName?: string; username?: string } | null>;
  /** Events in a ±2-week window around now, preloaded for pattern detection. */
  recentEventsWindow?: EventOccurrence[];
  /** Contact directory (also used by sharing, but independently configurable). */
  contactRepo?: ContactRepository;
  /** Event participant registry (used independently by events and sharing). */
  participantRepo?: ParticipantRepository;
  /** Type of the current message being processed. */
  inputMode?: 'text' | 'voice_message' | 'live_call';
  /** Set to true by end_call tool to hang up after TTS plays. */
  callEndRequested?: boolean;
  supplementMode?: boolean;
  /** The exact auto-response text that was sent by the intent matcher. Passed to supplement AI explicitly. */
  supplementAutoResponse?: string;
  /** Scene key storage — used by cancel_scene to delete the GramIO scene entry. Always wired from sceneStorage dep. */
  sceneStorage?: { delete(key: string): Promise<void> };
  actionLogRepo?: ActionLogRepository;
  featureUsageRepo?: FeatureUsageRepository;
  telegramSessionRepo?: TelegramSessionRepository;
  telegramMasterKey?: Buffer;

  // Capability groups
  sharing?: SharingCapability;
  secretary?: SecretaryCapability;
  group?: GroupCapability;
  voice?: VoiceCapability;
  google?: GoogleCapability;
  notifications?: NotificationsCapability;
  feedback?: FeedbackCapability;
  scheduled?: ScheduledCapability;
  scene?: SceneCapability;
  birthday?: BirthdayCapability;
  broadcast?: BroadcastCapability;
  locationVerification?: LocationVerificationService;
  addressCache?: AddressCache;
  pendingGeoStore?: import('../location/pending-geo-store.ts').PendingGeoStore;
  weatherService?: WeatherService;
  /** Preloaded address context for system prompt (loaded async before agent runs) */
  preloadedAddressContext?: string;
  /** Preloaded pending geo coordinates for the user (set by agent before run if pin is fresh) */
  preloadedPendingGeo?: { latitude: number; longitude: number } | null;
  /** When set, schedules a backoff retry of the current message. Delay is determined by retryAttempt. */
  retryEnqueue?: (messageText: string) => Promise<void>;
  /** True when the user explicitly addressed the bot (DM, @mention, "Бот,", reply to bot).
   *  False for keyword-only or session-continuation group messages.
   *  Stall phrases and retry queue fire only when true. */
  wasExplicitInvocation?: boolean;
  /** Retry attempt index: 0 or absent = original message, 1-3 = subsequent backoff retries.
   *  Stall phrase is suppressed on attempts > 0. */
  retryAttempt?: number;
}

export type TelegramSessionData =
  | { connected: false; dismissed_recently: boolean }
  | { connected: true; phone_masked: string; status: string };

/**
 * Must be `type`, not `interface` — needed for structural compatibility with
 * `ToolOutputValue` (the recursive `{ [k: string]: … }` index type) in
 * intent-executor's `ToolResultElement`. A named interface has no implicit
 * index signature and fails that assignability check.
 */
export type ContactMatch = {
  id: number;
  name: string;
  preferred_name: string | null;
  username: string | null;
  telegram_id: number | null;
  confidence: number;
};

/** Structured data from tool handlers for intent executor consumption. */
export type ToolResultData =
  | EventSummary
  | EventSummary[]
  | { telegram_id: number; name: string }
  | { matches: ContactMatch[] }
  | ScheduledAiCall[]
  | Trigger[]
  | TelegramSessionData
  | [];

/**
 * Result returned by every tool handler.
 *
 * IMPORTANT: `output` has two consumers:
 *   1. The AI agent, which reformulates it in natural language.
 *   2. The intent engine (IntentMatcherLayer), which sends it **directly** to the user
 *      via ctx.send() — no AI reformulation in between.
 *
 * Write `output` strings as if they will be shown verbatim to the user:
 *   - Address the user as "you" (second person), never "the user".
 *   - Keep them bilingual: use ctx.user.language to pick ru/en.
 */
export interface ToolResult {
  success: boolean;
  output?: string;
  error?: string;
  stopLoop?: boolean;
  /** A handoff is independent of the outer tool name (handlers may delegate). */
  awaitingInput?: { kind: 'chat' } | { kind: 'speech'; question: string };
  /** Direct execution evidence; never inferred from output or error prose. */
  mutationState?: 'not_applied' | 'uncertain' | 'confirmed';
  effect?:
    | { kind: 'invitation'; delivery: 'delivered' | 'manual_forward' | 'failed' }
    | { kind: 'attendance_declined' }
    | { kind: 'event_deleted' };

  /**
   * Agent-only instruction appended to the tool result seen by the AI.
   * Never shown to the user — the intent engine ignores this field entirely.
   */
  agentHint?: string;
  /**
   * Structured data for intent executor consumption.
   * Never sent to AI or user directly — side-channel for workflows.
   */
  data?: ToolResultData;
}

/**
 * Behavioral metadata attached directly to tool handler functions via
 * `handlerFn.meta = { ... }`. Read at runtime by the tool executor to
 * derive throttle exemption, action-log skipping, etc.
 *
 * When adding a new tool handler, set `.meta` right after the function
 * declaration — don't maintain separate lists.
 */
export interface ToolHandlerMeta {
  /** No side effects — exempt from cross-run throttle. */
  readonly?: boolean;
  /** Not worth logging as a user action (all readonly tools + UI/meta tools). */
  skipActionLog?: boolean;
  /** Tool always results in [SKIP] — no status message or tool label shown. */
  silent?: boolean;
  /**
   * Tool result must NOT be persisted to chat_history.
   * Use for meta/query tools whose output is derived from history itself —
   * storing their results would cause recursive embedding on subsequent calls.
   */
  skipPersist?: boolean;
}

export interface AgentConfig {
  debugLogger?: import('./debug-logger.ts').AiDebugLogger;
  summarizer?: import('./history-summarizer.ts').HistorySummarizer;
}

/**
 * Which RSVP keyboard an invitation message carries.
 *  - `personal`: the per-invitation Accept/Decline/Maybe/Propose keyboard (`inv:` callbacks),
 *    authorized against a single invitee.
 *  - `group`: the per-member Going / Not going keyboard (`grsvp:` callbacks) for a group target,
 *    where any member responds for themselves. Keyed by `eventId`, not the invitation id, because
 *    the invitation row stores the group chat id as its invitee — useless for member RSVP.
 */
export type InvitationKeyboardVariant = { kind: 'personal' } | { kind: 'group'; eventId: number };

export interface TelegramSender {
  sendMessage(chatId: number, text: string, parseMode?: ParseMode): Promise<{ message_id: number }>;
  sendMessageWithKeyboard?(
    chatId: number,
    text: string,
    keyboard: import('gramio').InlineKeyboard,
  ): Promise<{ message_id: number }>;
  editMessageText(chatId: number, messageId: number, text: string, parseMode?: ParseMode): Promise<void>;
  sendButtons?(
    chatId: number,
    text: string,
    buttons: string[],
    parseMode?: ParseMode,
    userId?: number,
  ): Promise<{ message_id: number }>;
  sendUserPicker?(chatId: number, text: string, requestId: number): Promise<{ message_id: number }>;
  sendPhoto?(chatId: number, photo: File): Promise<{ message_id: number }>;
  pinChatMessage?(chatId: number, messageId: number, options: { disable_notification: boolean }): Promise<true>;
  sendInvitation?(
    inviteeId: number,
    text: string,
    invitationId: number,
    lang?: string,
    variant?: InvitationKeyboardVariant,
  ): Promise<{ message_id: number } | null>;
  sendEditProposal?(creatorId: number, text: string, proposalId: number): Promise<{ message_id: number } | null>;
  sendAsUser?(userId: number, text: string, username?: string): Promise<boolean>;
  sendAsConnectedUser?(
    inviterId: number,
    targetId: number,
    text: string,
    username?: string,
    meta?: { invitationId?: number },
  ): Promise<boolean>;
  deleteMessage?(chatId: number, messageId: number): Promise<void>;
  setReaction?(chatId: number, messageId: number, emoji: string): Promise<void>;
  sendChatAction?(chatId: number, action: 'typing'): Promise<void>;
}
