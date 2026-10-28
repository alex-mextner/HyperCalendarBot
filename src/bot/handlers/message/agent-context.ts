// src/bot/handlers/message/agent-context.ts
// Builds the per-request AgentContext (sender, repositories, chat-history ids) for the message handler.

import type { EventOccurrence, User } from '../../../database/types.ts';
import type { AgentContext } from '../../../services/ai/types.ts';
import { cmdLogger } from '../../../utils/logger.ts';
import type { MessageHandlerDeps } from './types.ts';

const SCHEDULE_CONTEXT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

interface AgentGroupInfo {
  isGroup: boolean;
  groupChatId?: number;
  groupTitle?: string;
  topicThreadId?: number;
  onBotResponse?: (messageId: number) => void;
  incomingMessageId?: number;
}

function describeSecretaryAccess(deps: MessageHandlerDeps, user: User): string | undefined {
  const activeFor = deps.secretaryRepo?.getActiveSecretaryFor(user.telegram_id) ?? [];
  if (activeFor.length === 0) return undefined;
  return activeFor
    .map((r) => {
      const owner = deps.userRepo.findByTelegramId(r.owner_id);
      const name = owner?.username ? `@${owner.username}` : `User ${r.owner_id}`;
      return `${name} (${r.permission === 'write' ? 'read+write' : 'read only'})`;
    })
    .join(', ');
}

/** Events two weeks either side of now, so the model knows the user's nearby schedule; empty on a read failure. */
function recentEventsWindow(deps: MessageHandlerDeps, user: User): EventOccurrence[] {
  try {
    const now = new Date();
    const start = new Date(now.getTime() - SCHEDULE_CONTEXT_WINDOW_MS).toISOString();
    const end = new Date(now.getTime() + SCHEDULE_CONTEXT_WINDOW_MS).toISOString();
    return deps.eventService.getEventsInRange(user.telegram_id, start, end);
  } catch (err) {
    cmdLogger.error({ err, userId: user.telegram_id }, 'Failed to build schedule context');
    return [];
  }
}

function sharingContext(deps: MessageHandlerDeps): AgentContext['sharing'] {
  if (
    !(
      deps.invitationService &&
      deps.invitationRepo &&
      deps.sharingService &&
      deps.sharingSettingsRepo &&
      deps.sharedEventRepo &&
      deps.privacyService &&
      deps.editProposalRepo
    )
  ) {
    return undefined;
  }
  return {
    invitationService: deps.invitationService,
    invitationRepo: deps.invitationRepo,
    sharingService: deps.sharingService,
    sharingSettingsRepo: deps.sharingSettingsRepo,
    sharedEventRepo: deps.sharedEventRepo,
    privacyService: deps.privacyService,
    editProposalRepo: deps.editProposalRepo,
  };
}

function secretaryContext(deps: MessageHandlerDeps, user: User): AgentContext['secretary'] {
  if (!(deps.secretaryRepo && deps.calendarProposalRepo)) return undefined;
  return {
    secretaryRepo: deps.secretaryRepo,
    secretaryForLine: describeSecretaryAccess(deps, user),
    calendarProposalRepo: deps.calendarProposalRepo,
  };
}

function groupContext(deps: MessageHandlerDeps): AgentContext['group'] {
  if (!(deps.checkGroupMembership && deps.groupChatRepo && deps.groupMemberRepo && deps.groupMemberService)) {
    return undefined;
  }
  return {
    checkGroupMembership: deps.checkGroupMembership,
    groupChatRepo: deps.groupChatRepo,
    groupMemberRepo: deps.groupMemberRepo,
    groupMemberService: deps.groupMemberService,
  };
}

function broadcastContext(deps: MessageHandlerDeps): AgentContext['broadcast'] {
  const enqueuer = deps.broadcastEnqueuer;
  if (!enqueuer) return undefined;
  return {
    enqueue: enqueuer.enqueue.bind(enqueuer),
    enqueueBatch: enqueuer.enqueueBatch.bind(enqueuer),
    registerBatch: enqueuer.registerBatch?.bind(enqueuer),
  };
}

/** The optional-capability sections: each is present only when every service it needs is wired. */
function optionalCapabilities(
  deps: MessageHandlerDeps,
  user: User,
): Pick<
  AgentContext,
  | 'sharing'
  | 'secretary'
  | 'group'
  | 'voice'
  | 'calls'
  | 'notifications'
  | 'google'
  | 'birthday'
  | 'broadcast'
  | 'feedback'
  | 'scheduled'
> {
  return {
    sharing: sharingContext(deps),
    secretary: secretaryContext(deps, user),
    group: groupContext(deps),
    voice: deps.stressDictionary ? { stressDictionary: deps.stressDictionary } : undefined,
    calls:
      deps.callQueue && deps.callSettingsRepo
        ? { callQueue: deps.callQueue, callSettingsRepo: deps.callSettingsRepo }
        : undefined,
    notifications: deps.notificationPrefs ? { notificationPrefs: deps.notificationPrefs } : undefined,
    google: deps.googleCalendarRepo
      ? {
          googleCalendarRepo: deps.googleCalendarRepo,
          schedulePush: deps.googleSchedulePush,
          scheduleParticipantPush: deps.googleScheduleParticipantPush,
        }
      : undefined,
    birthday:
      deps.birthdayService && deps.userMemoryRepo
        ? { birthdayService: deps.birthdayService, userMemoryRepo: deps.userMemoryRepo }
        : undefined,
    broadcast: broadcastContext(deps),
    feedback:
      deps.feedbackRepo && deps.botAdminId !== undefined
        ? { feedbackContext: undefined, feedbackRepo: deps.feedbackRepo, botAdminId: deps.botAdminId }
        : undefined,
    scheduled:
      deps.scheduledCallService && deps.triggerService
        ? { scheduledCallService: deps.scheduledCallService, triggerService: deps.triggerService }
        : undefined,
  };
}

export function buildAgentContextFactory(deps: MessageHandlerDeps) {
  return (
    user: User,
    chatId: number,
    messageText: string,
    groupInfo?: AgentGroupInfo,
    incomingMessageId?: number,
  ): AgentContext => ({
    user,
    chatId,
    messageText,
    incomingMessageId,
    isGroup: groupInfo?.isGroup ?? false,
    groupChatId: groupInfo?.groupChatId,
    groupTitle: groupInfo?.groupTitle,
    topicThreadId: groupInfo?.topicThreadId,
    onBotResponse: groupInfo?.onBotResponse,
    eventService: deps.eventService,
    holidayService: deps.holidayService,
    chatHistory: deps.chatHistory,
    conversationLogger: deps.conversationLogger,
    userRepo: deps.userRepo,
    eventReminderRepo: deps.eventReminderRepo,
    contactRepo: deps.contactRepo,
    participantRepo: deps.participantRepo,
    renderService: deps.renderService,
    deepLinkService: deps.deepLinkService,
    botUsername: deps.botUsername,
    resolveUsername: deps.resolveUsername,
    lookupTelegramUser: deps.lookupTelegramUser,
    sendMessageToChat: deps.sendMessageToChat,
    recentEventsWindow: groupInfo?.isGroup ? undefined : recentEventsWindow(deps, user),
    actionLogRepo: deps.actionLogRepo,
    telegramSessionRepo: deps.telegramSessionRepo,
    telegramMasterKey: deps.telegramMasterKey,
    chatHistoryId: deps.chatHistoryIds?.get(user.telegram_id),
    sceneStorage: {
      delete: async (key: string) => {
        await deps.sceneStorage.delete(key);
      },
    },
    ...optionalCapabilities(deps, user),
    locationVerification: deps.locationVerification,
    addressCache: deps.addressCache,
    pendingGeoStore: deps.pendingGeoStore,
    weatherService: deps.weatherService,
  });
}
