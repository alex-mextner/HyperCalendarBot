// src/bot/handlers/message.handler.ts

import { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';
import type { GroupChatRepository } from '../../database/repositories/group-chat.repository.ts';
import type { UserRepository } from '../../database/repositories/user.repository.ts';
import type { CalendarEvent, User } from '../../database/types.ts';
import { type EventMentionStore, InMemoryEventMentionStore } from '../../services/intent/event-mention-store.ts';
import type { EventSummary } from '../../services/intent/variable-resolver.ts';
import { resolveCity } from '../../services/timezone/city-resolver.ts';
import { getTimezoneDisplay } from '../../services/timezone/timezone-service.ts';
import { cmdLogger } from '../../utils/logger.ts';
import { pendingDurationInput, pendingGroupTzInput } from '../commands/settings.ts';
import { createAiAgentLayer } from '../pipeline/ai-agent-layer.ts';
import { createFeedbackRouterLayer } from '../pipeline/feedback-router-layer.ts';
import { runPipeline } from '../pipeline/pipeline.ts';
import type { WorkflowSession, WorkflowSessionStore } from '../pipeline/types.ts';
import type { BotCommandContext } from '../types.ts';
import { isGroupRelevant, mentionsBot, startsWithCalendarAddress } from './group-message-filter.ts';
import { tryHandleAdminSessions } from './message/admin-sessions.ts';
import { buildAgentContextFactory } from './message/agent-context.ts';
import { createIntentLayerFor, type IntentLayerShared, rememberMentionedEvent } from './message/intent-layer.ts';
import { handlePrivateLocation } from './message/location-message.ts';
import { handleProposeTimeInput } from './message/propose-time.ts';
import { TG_API } from './message/telegram-api.ts';
import type { MessageHandlerDeps } from './message/types.ts';
import { handleVoiceMessage } from './message/voice-message.ts';

export { buildAgentContextFactory } from './message/agent-context.ts';
export { stripJsonFences } from './message/intent-edit.ts';
export type { MessageHandlerDeps } from './message/types.ts';

export function toEventSummary(event: CalendarEvent, timezone: string): EventSummary {
  const d = new TZDate(new Date(event.start_at), timezone);
  const summary: EventSummary = {
    id: event.id,
    title: event.title,
    date: format(d, 'yyyy-MM-dd'),
    all_day: Boolean(event.all_day),
  };
  if (!event.all_day) summary.time = format(d, 'HH:mm');
  if (event.end_at) summary.end_at = event.end_at;
  if (event.description) summary.description = event.description;
  if (event.location) summary.location = event.location;
  if (event.recurrence_rule) summary.recurrence_rule = event.recurrence_rule;
  return summary;
}

const DURATION_TTL_MS = 5 * 60 * 1000;

export async function tryHandleDurationInput(
  ctx: BotCommandContext,
  userId: number,
  text: string,
  userRepo: UserRepository,
): Promise<boolean> {
  const ts = pendingDurationInput.get(userId);
  if (ts === undefined) return false;

  if (Date.now() - ts > DURATION_TTL_MS) {
    pendingDurationInput.delete(userId);
    return false;
  }

  const trimmed = text.trim();
  const mins = Number.parseInt(trimmed, 10);
  const valid = Number.isInteger(mins) && mins > 0 && mins <= 1440 && trimmed === String(mins);

  if (!valid) {
    await ctx.send('Введите число минут от 1 до 1440 (например: 45)');
    return true;
  }

  pendingDurationInput.delete(userId);
  userRepo.update(userId, { default_event_duration_minutes: mins });
  const label = mins >= 60 && mins % 60 === 0 ? `${mins / 60}ч` : `${mins} мин`;
  await ctx.send(`✅ Длительность встреч по умолчанию: ${label}`);
  return true;
}

const GROUP_TZ_TTL_MS = 5 * 60 * 1000;

export async function tryHandleGroupTzInput(
  ctx: BotCommandContext,
  userId: number,
  text: string,
  groupChatRepo: GroupChatRepository,
  resolveCityFn: typeof resolveCity = resolveCity,
): Promise<boolean> {
  const entry = pendingGroupTzInput.get(userId);
  if (!entry) return false;

  if (Date.now() - entry.ts > GROUP_TZ_TTL_MS) {
    pendingGroupTzInput.delete(userId);
    return false;
  }

  const tz = await resolveCityFn(text.trim());
  pendingGroupTzInput.delete(userId);

  if (!tz) {
    await ctx.send(
      entry.lang === 'ru'
        ? 'Не удалось определить таймзону. Попробуйте ещё раз через /settings или введите код напрямую, например: Europe/Belgrade'
        : 'Could not determine timezone. Try again via /settings or enter the code directly, e.g. Europe/Belgrade',
    );
    return true;
  }

  groupChatRepo.setTimezone(entry.chatId, tz);
  await ctx.send(
    entry.lang === 'ru'
      ? `✅ Таймзона группы: ${getTimezoneDisplay(tz)}`
      : `✅ Group timezone: ${getTimezoneDisplay(tz)}`,
  );
  return true;
}

/** In-memory workflow sessions that expire five minutes after creation; the fallback when none are injected. */
function createInMemoryWorkflowSessions(): WorkflowSessionStore {
  const m = new Map<string, WorkflowSession>();
  const TTL = 5 * 60 * 1000;
  return {
    get: (chatId, userId) => {
      const s = m.get(`${chatId}:${userId}`);
      if (!s || Date.now() - s.createdAt >= TTL) {
        m.delete(`${chatId}:${userId}`);
        return null;
      }
      return s;
    },
    set: (chatId, userId, s) => m.set(`${chatId}:${userId}`, s),
    delete: (chatId, userId) => {
      m.delete(`${chatId}:${userId}`);
    },
    deleteByUser: (userId) => {
      for (const key of [...m.keys()]) {
        if (key.endsWith(`:${userId}`)) m.delete(key);
      }
    },
  };
}

/** Mandatory onboarding: redirect to setup if the user hasn't completed it (private chats only). */
async function redirectToOnboarding(ctx: BotCommandContext, user: User, deps: MessageHandlerDeps): Promise<boolean> {
  if (user.onboarding_completed || !deps.onboardingScene || ctx.chat.type !== 'private') return false;
  // Check if a scene is already active (e.g. onboarding already in progress)
  const activeScene = await deps.sceneStorage.get(`@gramio/scenes:${user.telegram_id}`);
  if (!activeScene) {
    await ctx.scene.enter(deps.onboardingScene);
  }
  return true;
}

/** Onboarding, voice and location messages: handled here, never as chat text. True when handled. */
async function handleNonTextMessage(ctx: BotCommandContext, user: User, deps: MessageHandlerDeps): Promise<boolean> {
  if (await redirectToOnboarding(ctx, user, deps)) return true;

  // Voice message → transcribe → pass to AI agent
  const voice = ctx.voice;
  if (voice && deps.transcriptionService && deps.botToken) {
    await handleVoiceMessage(ctx, user, { file_id: voice.fileId, duration: voice.duration }, deps);
    return true;
  }

  const location = ctx.location;
  if (location && ctx.chat.type === 'private') {
    await handlePrivateLocation(ctx, user, location, deps);
    return true;
  }
  return false;
}

/** An active wizard owns the input; only an explicitly paused one (e.g. via its Help action) falls through to AI. */
async function sceneOwnsInput(user: User, deps: MessageHandlerDeps): Promise<boolean> {
  const activeScene = await deps.sceneStorage.get(`@gramio/scenes:${user.telegram_id}`);
  if (!activeScene) return false;
  const isPaused = deps.scenePauseService ? (await deps.scenePauseService.get(user.telegram_id)) !== null : false;
  return !isPaused;
}

/** Propose-time session: invitee typing a new time in response to an invite (private chats only). */
async function tryHandleProposeTimeSession(
  ctx: BotCommandContext,
  text: string,
  user: User,
  deps: MessageHandlerDeps,
): Promise<boolean> {
  const proposeSession = deps.proposeTimeSessions?.get(user.telegram_id);
  if (!proposeSession) return false;
  deps.proposeTimeSessions?.delete(user.telegram_id);
  await handleProposeTimeInput(ctx, text, user, proposeSession, deps);
  return true;
}

interface GroupAdmission {
  /** The message matched no keyword but continues an active bot session in the group. */
  isGroupSessionMessage: boolean;
  /** Reply to the bot, @mention, direct address, or a bot-mention inflection; keyword-only and session messages are not. */
  wasExplicitInvocation: boolean;
}

/** A direct message is always an explicit invocation and never a group session continuation. */
const DIRECT_MESSAGE_ADMISSION: GroupAdmission = { isGroupSessionMessage: false, wasExplicitInvocation: true };

/** Track the sender as a group member (for fallback reminders) and sync their birthday data. */
function trackGroupSender(chatId: number, user: User, deps: MessageHandlerDeps): void {
  deps.groupMemberRepo?.upsert(chatId, user.telegram_id);
  deps.birthdayService
    ?.runBatchSync([
      {
        telegram_id: user.telegram_id,
        first_name: user.first_name,
        language: user.language,
        timezone: user.timezone,
      },
    ])
    .catch((err) => cmdLogger.error({ err, userId: user.telegram_id }, 'Birthday sync failed'));
}

/** Stage 2 of the group gate: the NLI classifier verifies that a keyword-matched message is calendar-related. */
async function rejectedByNli(text: string, chatId: number, deps: MessageHandlerDeps): Promise<boolean> {
  if (!deps.nliClassifier || text.length < 10) return false;
  if (await deps.nliClassifier.isCalendarRelated(text)) return false;
  cmdLogger.debug({ chatId, text: text.slice(0, 80) }, 'NLI rejected keyword-matched message');
  return true;
}

/**
 * Group relevance gate: only replies, mentions, calendar keywords and active sessions get through.
 * Returns null when the message was consumed or dropped.
 */
async function admitGroupMessage(
  ctx: BotCommandContext,
  user: User,
  text: string,
  chatId: number,
  deps: MessageHandlerDeps,
): Promise<GroupAdmission | null> {
  // Check pending group TZ input before relevance gate — the city name prompt
  // won't match any bot keyword, so it must be intercepted before the gate drops it
  if (deps.groupChatRepo && (await tryHandleGroupTzInput(ctx, user.telegram_id, text, deps.groupChatRepo))) return null;

  const isReplyToBot = deps.botId !== undefined && ctx.replyMessage?.from?.id === deps.botId;
  const botMention = deps.botUsername ? `@${deps.botUsername}` : '';
  trackGroupSender(chatId, user, deps);
  const hasSession = deps.groupSessions?.hasActiveSession(chatId) ?? false;

  let isGroupSessionMessage = false;
  if (!isReplyToBot && !isGroupRelevant(text, botMention)) {
    if (!hasSession) return null; // No trigger, no session — skip
    // Session active but no keyword — tick and keep typing indicator running
    deps.groupSessions?.tick(chatId);
    isGroupSessionMessage = true;
  }

  // Only keyword-matched messages are checked (not reply/session).
  if (!isGroupSessionMessage && !isReplyToBot && (await rejectedByNli(text, chatId, deps))) return null;

  const isExplicitMention = Boolean(botMention && text.includes(botMention));
  return {
    isGroupSessionMessage,
    wasExplicitInvocation: isReplyToBot || isExplicitMention || startsWithCalendarAddress(text) || mentionsBot(text),
  };
}

/** The "[Group: …, From: …] " header that tells the model who spoke in a group; empty elsewhere. */
function groupMessagePrefix(ctx: BotCommandContext, isGroup: boolean): string {
  const from = ctx.from;
  if (!isGroup || !from) return '';
  const senderName = from.firstName ?? from.username ?? 'Unknown';
  const groupName = ctx.chat.title ?? 'group';
  // GramIO's MessageContext exposes .id as the Telegram message_id via NodeMixinMetadata
  const msgIdPart = ctx.id ? `, msg_id:${ctx.id}` : '';
  return `[Group: ${groupName}, From: ${senderName}${msgIdPart}] `;
}

/** Keeps the group's bot session alive: refresh while one is active, otherwise open a new one. */
function groupSessionResponseTracker(
  deps: MessageHandlerDeps,
  chatId: number,
  userId: number,
): ((messageId: number) => void) | undefined {
  const sessions = deps.groupSessions;
  if (!sessions) return undefined;
  return (messageId) => {
    if (sessions.hasActiveSession(chatId)) {
      sessions.refresh(chatId, messageId);
    } else {
      sessions.activate(chatId, userId, messageId);
    }
  };
}

async function runPipelineWithTyping(run: () => Promise<void>, chatId: number, botToken: string): Promise<void> {
  const sendTyping = () =>
    fetch(`${TG_API}/bot${botToken}/sendChatAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
    }).catch((e: unknown) => cmdLogger.debug({ err: e }, 'sendChatAction typing failed'));
  sendTyping();
  const typingInterval = setInterval(sendTyping, 6000);
  try {
    await run();
  } finally {
    clearInterval(typingInterval);
  }
}

/** A plain-text message that passed every interception and gate, ready for the pipeline. */
interface TextTurn {
  ctx: BotCommandContext;
  user: User;
  text: string;
  chatId: number;
  chatTitle: string | undefined;
  isGroup: boolean;
  admission: GroupAdmission;
}

/** Text that no scene, session or group gate consumed; null when the message was handled or dropped. */
async function admitTextMessage(
  ctx: BotCommandContext,
  user: User,
  deps: MessageHandlerDeps,
): Promise<TextTurn | null> {
  const text = ctx.text as string | undefined;
  // Don't handle commands
  if (!text || text.startsWith('/')) return null;

  // Don't handle if a scene is active — @gramio/scenes handles those
  if (await sceneOwnsInput(user, deps)) return null;

  const chatId = ctx.chatId;
  if (!chatId) return null;

  const chat = ctx.chat;
  const isGroup = chat.type === 'group' || chat.type === 'supergroup';
  if (!isGroup && (await tryHandleProposeTimeSession(ctx, text, user, deps))) return null;

  const admission = isGroup ? await admitGroupMessage(ctx, user, text, Number(chatId), deps) : DIRECT_MESSAGE_ADMISSION;
  if (!admission) return null;
  return { ctx, user, text, chatId: Number(chatId), chatTitle: chat.title ?? undefined, isGroup, admission };
}

export function createMessageHandler(deps: MessageHandlerDeps) {
  const agentContextBuilder = buildAgentContextFactory(deps);
  const workflowSessions: WorkflowSessionStore = deps.workflowSessions ?? createInMemoryWorkflowSessions();
  const eventMentionStore: EventMentionStore = deps.eventMentionStore ?? new InMemoryEventMentionStore();

  const aiAgentLayer = createAiAgentLayer({
    agent: deps.agent,
    agentContextBuilder: (user, chatId, messageText, groupInfo, incomingMessageId) => {
      const ctx = agentContextBuilder(user, chatId, messageText, groupInfo, incomingMessageId);
      ctx.onEventMentioned = (eventId) => {
        rememberMentionedEvent(eventMentionStore, user.telegram_id, eventId, 'Failed to persist last mentioned event');
      };
      return ctx;
    },
    intentLearner: deps.intentLearner,
    scenePauseService: deps.scenePauseService,
    retryQueue: deps.aiRetryQueue,
    retryJobStore: deps.aiRetryJobStore,
  });

  // Static layers that don't require per-message context
  const staticLayers = [...(deps.feedbackRepo ? [createFeedbackRouterLayer(deps.feedbackRepo)] : []), aiAgentLayer];

  const notifyAdmin =
    deps.botAdminId && deps.sendMessageToUser
      ? (text: string) => deps.sendMessageToUser!(deps.botAdminId!, text)
      : undefined;

  const getEventContext = async (userId: number, timezone: string) => {
    const lastAdded = deps.eventService.getLatestCreated(userId);
    const mentionedId = await eventMentionStore.get(userId);
    const lastMentioned = mentionedId ? deps.eventService.getEvent(mentionedId, userId) : null;
    return {
      lastAddedEvent: lastAdded ? toEventSummary(lastAdded, timezone) : undefined,
      lastMentionedEvent: lastMentioned ? toEventSummary(lastMentioned, timezone) : undefined,
    };
  };

  const intentLayerShared: IntentLayerShared = {
    deps,
    agentContextBuilder,
    eventMentionStore,
    workflowSessions,
    notifyAdmin,
    getEventContext,
  };

  async function runMessagePipeline(turn: TextTurn, messageText: string): Promise<void> {
    const { ctx, user, chatId, chatTitle, isGroup, admission } = turn;
    const incomingMsgId = ctx.id;
    const intentLayer = createIntentLayerFor(intentLayerShared, {
      user,
      chatId,
      chatTitle,
      isGroup,
      messageText,
      incomingMessageId: incomingMsgId,
    });
    const layers = [...(intentLayer ? [intentLayer] : []), ...staticLayers];

    const groupContext = isGroup
      ? {
          isGroup: true as const,
          groupChatId: chatId,
          groupTitle: chatTitle,
          topicThreadId: ctx.threadId,
          onBotResponse: groupSessionResponseTracker(deps, chatId, user.telegram_id),
        }
      : undefined;

    cmdLogger.info(
      { userId: user.telegram_id, chatId, msgPreview: messageText.slice(0, 100) },
      '--- Message pipeline start ---',
    );

    const run = () =>
      runPipeline(ctx, messageText, layers, groupContext, incomingMsgId, admission.wasExplicitInvocation);
    if (admission.isGroupSessionMessage && deps.botToken) {
      await runPipelineWithTyping(run, chatId, deps.botToken);
    } else {
      await run();
    }
  }

  return async (ctx: BotCommandContext) => {
    const user = ctx.dbUser;
    if (!user) return;
    if (await handleNonTextMessage(ctx, user, deps)) return;

    const turn = await admitTextMessage(ctx, user, deps);
    if (!turn) return;

    const messageText = groupMessagePrefix(ctx, turn.isGroup) + turn.text;
    if (await tryHandleAdminSessions(ctx, user, messageText, deps)) return;
    if (!turn.isGroup && (await tryHandleDurationInput(ctx, user.telegram_id, turn.text, deps.userRepo))) return;

    await runMessagePipeline(turn, messageText);
  };
}
