import type { CalendarProposalRepository } from '../../database/repositories/calendar-proposal.repository.ts';
import type { ChatHistoryRepository } from '../../database/repositories/chat-history.repository.ts';
import type { ContactRepository } from '../../database/repositories/contact.repository.ts';
import type { EditProposalRepository } from '../../database/repositories/edit-proposal.repository.ts';
import type { FeedbackRepository } from '../../database/repositories/feedback.repository.ts';
import type { GoogleCalendarRepository } from '../../database/repositories/google-calendar.repository.ts';
import type { GroupChatRepository } from '../../database/repositories/group-chat.repository.ts';
import type { GroupMemberRepository } from '../../database/repositories/group-member.repository.ts';
import type { InvitationRepository } from '../../database/repositories/invitation.repository.ts';
import type { ParticipantRepository } from '../../database/repositories/participant.repository.ts';
import type { ReminderRepository } from '../../database/repositories/reminder.repository.ts';
import type { SecretaryRepository } from '../../database/repositories/secretary.repository.ts';
import type { SharedEventRepository } from '../../database/repositories/shared-event.repository.ts';
import type { SharingSettingsRepository } from '../../database/repositories/sharing-settings.repository.ts';
import type { UserRepository } from '../../database/repositories/user.repository.ts';
import type { User } from '../../database/types.ts';
import type { EventService } from '../event/event-service.ts';
import type { GroupMemberService } from '../group/member-service.ts';
import type { HolidayService } from '../holiday/holiday-service.ts';
import type { DeepLinkService } from '../sharing/deep-link-service.ts';
import type { InvitationService } from '../sharing/invitation-service.ts';
import type { PrivacyService } from '../sharing/privacy-service.ts';
import type { SharingService } from '../sharing/sharing-service.ts';
import type { StressDictionary } from '../voice/stress-dictionary.ts';

export interface AgentContext {
  user: User;
  chatId: number;
  messageText: string;
  isGroup: boolean;
  groupChatId?: number;
  groupTitle?: string;
  onBotResponse?: (messageId: number) => void;
  eventService: EventService;
  holidayService: HolidayService;
  chatHistory: ChatHistoryRepository;
  userRepo: UserRepository;
  reminderRepo: ReminderRepository;
  invitationService?: InvitationService;
  invitationRepo?: InvitationRepository;
  sharingService?: SharingService;
  sharingSettingsRepo?: SharingSettingsRepository;
  sharedEventRepo?: SharedEventRepository;
  privacyService?: PrivacyService;
  contactRepo?: ContactRepository;
  participantRepo?: ParticipantRepository;
  editProposalRepo?: EditProposalRepository;
  secretaryRepo?: SecretaryRepository;
  secretaryForLine?: string;
  calendarProposalRepo?: CalendarProposalRepository;
  checkGroupMembership?: (chatId: number, userId: number) => Promise<boolean>;
  sender?: TelegramSender;
  /** Called after any successful tool call that references an event (by ID or creation). */
  onEventMentioned?: (eventId: number) => void;
  renderService?: { renderDirect(opts: Record<string, unknown>): Promise<Buffer> };
  notificationPrefs?: {
    getPrefs(userId: number): Record<string, unknown>;
    update(userId: number, patch: Record<string, unknown>): void;
    ensureDefaults(userId: number): void;
  };
  callQueue?: { enqueue(userId: number, text: string): void };
  callSettingsRepo?: {
    get(userId: number): Record<string, unknown> | null;
    ensureDefaults(userId: number): void;
    setEnabled(userId: number, enabled: boolean): void;
    setLanguage(userId: number, lang: string): void;
  };
  groupChatRepo?: GroupChatRepository;
  groupMemberRepo?: GroupMemberRepository;
  groupMemberService?: GroupMemberService;
  googleCalendarRepo?: GoogleCalendarRepository;
  deepLinkService?: DeepLinkService;
  botUsername?: string;
  inputMode?: 'text' | 'voice_message' | 'live_call';
  stressDictionary?: StressDictionary;
  feedbackContext?: {
    threadId: number;
    subject: string;
    messages: { sender: string; text: string }[];
  };
  feedbackRepo?: FeedbackRepository;
  botAdminId?: number;
  sendMessageToChat?: (chatId: number, text: string, options?: Record<string, unknown>) => Promise<unknown>;
  resolveUsername?: (username: string) => Promise<{ id: number; firstName?: string; username?: string } | null>;
}

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
  /**
   * Agent-only instruction appended to the tool result seen by the AI.
   * Never shown to the user — the intent engine ignores this field entirely.
   */
  agentHint?: string;
  /**
   * Structured data for intent executor consumption.
   * Never sent to AI or user directly — side-channel for workflows.
   */
  data?: unknown;
}

export interface AgentConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface TelegramSender {
  sendMessage(chatId: number, text: string, parseMode?: string): Promise<{ message_id: number }>;
  sendMessageWithKeyboard?(
    chatId: number,
    text: string,
    keyboard: import('gramio').InlineKeyboard,
  ): Promise<{ message_id: number }>;
  editMessageText(chatId: number, messageId: number, text: string, parseMode?: string): Promise<void>;
  sendButtons?(
    chatId: number,
    text: string,
    buttons: string[],
    parseMode?: string,
    userId?: number,
  ): Promise<{ message_id: number }>;
  sendUserPicker?(chatId: number, text: string, requestId: number): Promise<{ message_id: number }>;
  sendPhoto?(chatId: number, photo: File): Promise<void>;
  sendInvitation?(
    inviteeId: number,
    text: string,
    invitationId: number,
    lang?: string,
  ): Promise<{ message_id: number } | null>;
  sendEditProposal?(creatorId: number, text: string, proposalId: number): Promise<{ message_id: number } | null>;
  sendAsUser?(userId: number, text: string, username?: string): Promise<boolean>;
  deleteMessage?(chatId: number, messageId: number): Promise<void>;
}
