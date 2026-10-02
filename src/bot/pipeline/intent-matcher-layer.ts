// src/bot/pipeline/intent-matcher-layer.ts

import { t, toLang } from '../../config/constants.ts';
import type { ActionLogRepository } from '../../database/repositories/action-log.repository.ts';
import type { CalendarEvent } from '../../database/types.ts';
import type { IntentRepository } from '../../database/repositories/intent.repository.ts';
import type { ToolResult } from '../../services/ai/types.ts';
import type { EventService } from '../../services/event/event-service.ts';
import type {
  EventReferenceStore,
  ReferenceContext,
  ReferenceScope,
} from '../../services/intent/event-reference-store.ts';
import type { IntentExecutor } from '../../services/intent/intent-executor.ts';
import type { IntentMatcher } from '../../services/intent/intent-matcher.ts';
import { formatResponse } from '../../services/intent/response-formatter.ts';
import type { EventSummary, UserContext } from '../../services/intent/variable-resolver.ts';
import { type Workflow, WorkflowSchema } from '../../services/intent/workflow-schema.ts';
import { jsonCodec } from '../../utils/json-codec.ts';
import { cmdLogger } from '../../utils/logger.ts';
import { escapeHtml, splitMessage } from '../../utils/telegram.ts';
import type { BotCommandContext } from '../types.ts';
import type {
  FeedbackThreadContext,
  GroupContext,
  PipelineResult,
  WorkflowSession,
  WorkflowSessionStore,
} from './types.ts';

const WorkflowCodec = jsonCodec(WorkflowSchema);

/** Where a message was said: the reference scope plus the bot message it replies to, if any. */
export interface ReferenceWhere extends ReferenceScope {
  replyToBotMessageId?: number;
}

export type IntentEventContext = {
  lastAddedEvent?: EventSummary;
  lastMentionedEvent?: EventSummary;
  references?: ReferenceContext;
};

/**
 * Event context for one message. The last mentioned event and every other reference come from
 * this actor's evidence in this chat and topic, re-read with the access rule get_event applies
 * (own calendar in a private chat, the group calendar in a group); nothing crosses chats.
 */
export function createEventContextResolver(deps: {
  eventService: Pick<EventService, 'getEvent' | 'getEventForGroup' | 'getLatestCreated'>;
  store: EventReferenceStore;
  toSummary: (event: CalendarEvent, timezone: string) => EventSummary;
}): (userId: number, timezone: string, where: ReferenceWhere) => Promise<IntentEventContext> {
  return async (userId, timezone, where) => {
    const lastAdded = deps.eventService.getLatestCreated(userId);
    const verify = (eventId: number): EventSummary | null => {
      const event =
        where.chatId === userId
          ? deps.eventService.getEvent(eventId, userId)
          : deps.eventService.getEventForGroup(eventId, where.chatId);
      return event ? deps.toSummary(event, timezone) : null;
    };
    const references = deps.store.resolve(where, verify, { replyToMessageId: where.replyToBotMessageId });
    return {
      lastAddedEvent: lastAdded ? deps.toSummary(lastAdded, timezone) : undefined,
      lastMentionedEvent: references.it?.status === 'one' ? references.it.event : undefined,
      references,
    };
  };
}

function referenceWhere(ctx: BotCommandContext, userId: number, chatId: number): ReferenceWhere {
  const reply = ctx.replyMessage;
  return {
    actorId: userId,
    chatId,
    ...(ctx.threadId !== undefined ? { threadId: ctx.threadId } : {}),
    ...(reply?.from?.isBot() ? { replyToBotMessageId: reply.id } : {}),
  };
}

export function createIntentMatcherLayer(
  matcher: IntentMatcher,
  intentRepo: IntentRepository,
  executor: IntentExecutor,
  toolExecutor: (
    toolName: string,
    input: unknown,
    origin?: { text: string; actorId: number; chatId: number },
  ) => ToolResult | Promise<ToolResult>,
  workflowSessions: WorkflowSessionStore,
  notifyAdmin?: (text: string) => Promise<void>,
  getEventContext?: (userId: number, timezone: string, where: ReferenceWhere) => Promise<IntentEventContext>,
  onEventMentioned?: (userId: number, eventId: number) => void,
  actionLogRepo?: ActionLogRepository,
  referenceStore?: EventReferenceStore,
) {
  type Result = Awaited<ReturnType<IntentExecutor['run']>>;
  /** Returns the ID of the last message sent, so a later reply to it can name the events it showed. */
  async function deliverResponse(
    ctx: BotCommandContext,
    plainText: string,
    removeKeyboard = false,
  ): Promise<number | undefined> {
    // formatResponse returns display text, not a trusted Telegram HTML document.
    const chunks = splitMessage(escapeHtml(plainText), 4000, 'HTML');
    let sentId: number | undefined;
    for (const [index, chunk] of chunks.entries()) {
      const sent = await ctx.send(chunk, {
        parse_mode: 'HTML',
        ...(removeKeyboard && index === chunks.length - 1
          ? { reply_markup: { remove_keyboard: true, selective: true } }
          : {}),
      });
      sentId = sent?.id;
    }
    return sentId;
  }
  /**
   * Choices the response offered become the presented list, and the sent message is mapped to
   * every event evidenced during this run. Recording failures never affect the delivered answer.
   */
  function recordDelivery(where: ReferenceWhere, result: Result, sentId: number | undefined, since: number): void {
    if (!referenceStore) return;
    try {
      if (result.presentedEventIds?.length)
        referenceStore.record(
          where,
          { kind: 'list', tool: 'intent_choices', eventIds: result.presentedEventIds },
          { source: 'intent' },
        );
      if (sentId !== undefined) referenceStore.tagBotMessage(where, sentId, since);
    } catch (err) {
      cmdLogger.warn({ err, userId: where.actorId }, 'Failed to record intent event references');
    }
  }
  async function deliverPrompt(
    ctx: BotCommandContext,
    chatId: number,
    userId: number,
    session: WorkflowSession,
  ): Promise<void> {
    const prompt = session.pendingPrompt;
    if (!prompt) return;
    const chunks = splitMessage(escapeHtml(prompt.text), 4000, 'HTML');
    for (const [index, text] of chunks.entries())
      await ctx.send(text, {
        parse_mode: 'HTML',
        ...(index === chunks.length - 1 && prompt.options
          ? {
              reply_markup: {
                keyboard: prompt.options.map((text) => [{ text }]),
                one_time_keyboard: true,
                resize_keyboard: true,
                selective: true,
              },
            }
          : {}),
      });
    workflowSessions.set(chatId, userId, { ...session, pendingPrompt: { ...prompt, delivered: true } });
  }
  /**
   * A failed run must never replay the user's request through the AI once a write may
   * have happened. Only a failure with no write evidence is safe to hand over.
   */
  async function deliverTerminalFailure(ctx: BotCommandContext, language: string, result: Result): Promise<void> {
    const messages = t(toLang(language)).intentWorkflow;
    await ctx.send(result.mutationEvidence === 'applied' ? messages.appliedIncomplete : messages.outcomeUnknown);
  }
  async function userContextFor(
    user: NonNullable<BotCommandContext['dbUser']>,
    groupCtx: GroupContext | undefined,
    where: ReferenceWhere,
  ): Promise<UserContext> {
    const eventCtx = getEventContext ? await getEventContext(user.telegram_id, user.timezone, where) : {};
    return {
      timezone: user.timezone,
      language: user.language,
      username: user.username ?? undefined,
      firstName: user.first_name ?? undefined,
      userId: user.telegram_id,
      groupIsGroup: groupCtx?.isGroup ?? false,
      groupChatId: groupCtx?.groupChatId,
      defaultEventMinutes: user.default_event_duration_minutes,
      ...eventCtx,
    };
  }
  async function saveSuspension(
    ctx: BotCommandContext,
    chatId: number,
    userId: number,
    session: WorkflowSession,
    result: Result,
  ): Promise<void> {
    const next: WorkflowSession = {
      ...session,
      stepIndex: result.suspendedAt!,
      stepResults: result.stepResults ?? {},
      createdAt: Date.now(),
    };
    if (next.workflow.version === 2 && result.response)
      next.pendingPrompt = { text: result.response, options: result.responseOptions, delivered: false };
    workflowSessions.set(chatId, userId, next);
    if (next.pendingPrompt) await deliverPrompt(ctx, chatId, userId, next);
    else if (result.response) await ctx.send(result.response);
  }
  return async (
    ctx: BotCommandContext,
    messageText: string,
    extra?: {
      feedbackContext?: FeedbackThreadContext;
      groupContext?: GroupContext;
      supplementMode?: boolean;
    },
  ): Promise<PipelineResult> => {
    const user = ctx.dbUser;
    if (!user) return { handled: false };
    const userId = user.telegram_id;
    const chatId = Number(ctx.chatId ?? userId);
    const groupCtx = extra?.groupContext;
    const where = referenceWhere(ctx, userId, chatId);

    // 1. Check for active workflow session (resuming from ask_user).
    // TTL is enforced inside workflowSessions.get() — a non-null result is always fresh.
    const session = workflowSessions.get(chatId, userId);
    if (session) {
      if (session.pendingPrompt && !session.pendingPrompt.delivered) {
        await deliverPrompt(ctx, chatId, userId, session);
        return { handled: true };
      }
      workflowSessions.delete(chatId, userId);
      const startedAt = Date.now();
      const result = await executor.run(
        session.workflow,
        session.captures,
        await userContextFor(user, groupCtx, where),
        session.sourceMessage === undefined
          ? toolExecutor
          : (name, input) => toolExecutor(name, input, { text: session.sourceMessage!, actorId: userId, chatId }),
        {
          stepIndex: session.stepIndex,
          stepResults: session.stepResults,
          userAnswer: messageText.trim(),
        },
      );
      if (result.suspended && result.suspendedAt !== undefined) {
        await saveSuspension(ctx, chatId, userId, session, result);
        return { handled: true };
      }
      // The answer was consumed by the resumed workflow, so it cannot be replayed as a fresh request.
      if (!result.success && result.mutationEvidence !== undefined) {
        cmdLogger.warn(
          { intentId: session.intentId, userId, errorCode: result.errorCode, evidence: result.mutationEvidence },
          'Resumed intent workflow failed',
        );
        if (result.mutationEvidence === 'none') await ctx.send(t(toLang(user.language)).intentWorkflow.failedUnchanged);
        else await deliverTerminalFailure(ctx, user.language, result);
        return { handled: true };
      }
      if (result.response) {
        // Same formatting as a first-pass match: a resumed workflow can end in a tool
        // whose text output is written for the AI agent, not for the user.
        const format = intentRepo.getById(session.intentId)?.format ?? 'text';
        const text = formatResponse(format, result.response, user.timezone, user.language, result.responseEvents);
        const sentId =
          session.workflow.version === 2 ? await deliverResponse(ctx, text, true) : (await ctx.send(text))?.id;
        recordDelivery(where, result, sentId, startedAt);
      }
      return { handled: true };
    }

    // 2. Try matching
    const match = matcher.match(messageText);
    if (!match) return { handled: false };

    // 3. Load workflow from DB
    const intent = intentRepo.getById(match.intentId);
    if (!intent) return { handled: false };

    const workflowResult = WorkflowCodec.safeParse(intent.workflow);
    if (!workflowResult.success) {
      cmdLogger.error({ intentId: match.intentId }, 'Intent has invalid workflow JSON, skipping');
      return { handled: false };
    }
    const workflow: Workflow = workflowResult.data;

    // Log intent match to action log
    if (actionLogRepo) {
      actionLogRepo.insert({
        user_id: userId,
        chat_id: chatId,
        action_type: 'intent_match',
        action_name: intent.canonical_name,
        message_id: ctx.id,
        input_summary: messageText.slice(0, 200),
      });
    }

    // 4. Execute
    const startedAt = Date.now();
    const result = await executor.run(
      workflow,
      match.captures,
      await userContextFor(user, groupCtx, where),
      toolExecutor,
    );

    // 5. Handle suspension
    if (result.suspended && result.suspendedAt !== undefined) {
      await saveSuspension(
        ctx,
        chatId,
        userId,
        {
          intentId: match.intentId,
          stepIndex: result.suspendedAt,
          stepResults: result.stepResults ?? {},
          workflow,
          captures: match.captures,
          sourceMessage: messageText,
          createdAt: Date.now(),
        },
        result,
      );
      return { handled: true };
    }

    // 6. Fall through to AI agent on failure with no write evidence (e.g. unresolved variables, read error)
    if (!result.success) {
      cmdLogger.warn(
        { intentId: match.intentId, userId, error: result.response },
        'Intent workflow step failed, falling through to AI agent',
      );
      if (notifyAdmin) {
        notifyAdmin(
          `⚠️ Intent failed: ${intent.canonical_name} (id=${match.intentId})\nMessage: "${messageText}"\nError: ${result.response ?? 'no response'}`,
        ).catch((err: unknown) => {
          cmdLogger.error({ err: err }, 'Failed to send intent fail report to admin');
        });
      }
      if (result.mutationEvidence === 'applied' || result.mutationEvidence === 'unknown') {
        await deliverTerminalFailure(ctx, user.language, result);
        return { handled: true };
      }
      return { handled: false };
    }

    // 7. Persist last mentioned event for cross-request workflows
    if (result.mentionedEventId !== undefined) {
      onEventMentioned?.(userId, result.mentionedEventId);
    }

    // 8. Format and send response
    if (result.response) {
      const formatted = formatResponse(
        intent.format,
        result.response,
        user.timezone,
        user.language,
        result.responseEvents,
      );
      // ctx.send is wrapped in bot/index.ts and already writes this to chat history;
      // the supplement agent reads the text from supplementAutoResponse, not from history.
      const sentId = workflow.version === 2 ? await deliverResponse(ctx, formatted) : (await ctx.send(formatted))?.id;
      recordDelivery(where, result, sentId, startedAt);
      return { handled: true, needsSupplement: true, supplementAutoResponse: formatted };
    }

    return { handled: true };
  };
}
