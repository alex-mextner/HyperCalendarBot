// src/bot/handlers/message/intent-layer.ts
// Wires the intent-matcher pipeline layer for one incoming message: the tool runner and mention tracking.

import type { User } from '../../../database/types.ts';
import { executeTool } from '../../../services/ai/tool-executor.ts';
import type { EventMentionStore } from '../../../services/intent/event-mention-store.ts';
import type { EventSummary } from '../../../services/intent/variable-resolver.ts';
import { cmdLogger } from '../../../utils/logger.ts';
import type { AgentContextBuilder } from '../../agent-context-factory.ts';
import { createIntentMatcherLayer } from '../../pipeline/intent-matcher-layer.ts';
import type { PipelineLayer, WorkflowSessionStore } from '../../pipeline/types.ts';
import type { MessageHandlerDeps } from './types.ts';

/** Longest intent-origin text that may stand in for the incoming message in the tool context. */
const MAX_ORIGIN_TEXT_LENGTH = 16000;

export type EventContextLoader = (
  userId: number,
  timezone: string,
) => Promise<{ lastAddedEvent?: EventSummary; lastMentionedEvent?: EventSummary }>;

/** Services every message shares, as opposed to the facts of one message. */
export interface IntentLayerShared {
  deps: MessageHandlerDeps;
  agentContextBuilder: AgentContextBuilder;
  eventMentionStore: EventMentionStore;
  workflowSessions: WorkflowSessionStore;
  notifyAdmin: ((text: string) => Promise<void>) | undefined;
  getEventContext: EventContextLoader;
}

/** Facts of the message being handled. */
export interface IntentMessageScope {
  user: User;
  chatId: number;
  chatTitle: string | undefined;
  isGroup: boolean;
  messageText: string;
  incomingMessageId: number | undefined;
}

/** Remembers the event the user just talked about; a store failure is logged, never raised. */
export function rememberMentionedEvent(
  store: EventMentionStore,
  userId: number,
  eventId: number,
  failureMessage: string,
): void {
  Promise.resolve(store.set(userId, eventId)).catch((err: unknown) => {
    cmdLogger.error({ err: err, userId }, failureMessage);
  });
}

function toolContextText(
  scope: IntentMessageScope,
  origin: { text: string; actorId: number; chatId: number } | undefined,
): string {
  const originIsHere =
    origin?.actorId === scope.user.telegram_id &&
    origin.chatId === scope.chatId &&
    origin.text.length <= MAX_ORIGIN_TEXT_LENGTH;
  return originIsHere ? origin.text : scope.messageText;
}

function runIntentTool(
  shared: IntentLayerShared,
  scope: IntentMessageScope,
  toolName: string,
  input: unknown,
  origin?: { text: string; actorId: number; chatId: number },
) {
  const { deps, agentContextBuilder, eventMentionStore } = shared;
  const { user, chatId, chatTitle, isGroup } = scope;
  const agentCtx = agentContextBuilder(
    user,
    chatId,
    toolContextText(scope, origin),
    { isGroup, groupChatId: isGroup ? chatId : undefined, groupTitle: chatTitle },
    scope.incomingMessageId,
  );
  // Inject sender so pick_users / ask_user / send_invitation work in intent context
  agentCtx.sender = deps.agent.getSender();
  // Seeded write workflows ask their own confirmation before any write step.
  agentCtx.toolOrigin = 'intent_workflow';
  // chatHistoryId is set via buildAgentContextFactory from deps.chatHistoryIds
  // Track which events the intent touches
  agentCtx.onEventMentioned = (eventId) => {
    rememberMentionedEvent(eventMentionStore, user.telegram_id, eventId, 'Failed to persist last mentioned event');
  };
  return executeTool(agentCtx, toolName, input);
}

/** The intent-matcher layer, present only when the matcher, its repository and executor are all wired. */
export function createIntentLayerFor(shared: IntentLayerShared, scope: IntentMessageScope): PipelineLayer | undefined {
  const { deps, workflowSessions, notifyAdmin, getEventContext, eventMentionStore } = shared;
  if (!(deps.intentMatcher && deps.intentRepo && deps.intentExecutor)) return undefined;
  return createIntentMatcherLayer(
    deps.intentMatcher,
    deps.intentRepo,
    deps.intentExecutor,
    (toolName, input, origin) => runIntentTool(shared, scope, toolName, input, origin),
    workflowSessions,
    notifyAdmin,
    getEventContext,
    (uid, eventId) => {
      rememberMentionedEvent(eventMentionStore, uid, eventId, 'Failed to persist last mentioned event from intent');
    },
    deps.actionLogRepo,
  );
}
