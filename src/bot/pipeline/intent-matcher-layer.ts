// src/bot/pipeline/intent-matcher-layer.ts

import type { IntentRepository } from '../../database/repositories/intent.repository.ts';
import type { User } from '../../database/types.ts';
import type { ToolResult } from '../../services/ai/types.ts';
import type { ConversationLogger } from '../../services/conversation-logger.ts';
import type { IntentExecutor } from '../../services/intent/intent-executor.ts';
import type { IntentMatcher } from '../../services/intent/intent-matcher.ts';
import { formatResponse } from '../../services/intent/response-formatter.ts';
import type { EventSummary } from '../../services/intent/variable-resolver.ts';
import { cmdLogger } from '../../utils/logger.ts';
import type { BotCommandContext } from '../types.ts';
import type { FeedbackThreadContext, GroupContext, PipelineResult } from './types.ts';

export interface WorkflowSession {
  intentId: number;
  stepIndex: number;
  stepResults: Record<string, unknown>;
  workflow: Record<string, unknown>;
  captures: Record<string, string>;
  createdAt: number;
}

export interface WorkflowSessionStore {
  get(chatId: number, userId: number): WorkflowSession | null;
  set(chatId: number, userId: number, session: WorkflowSession): void;
  delete(chatId: number, userId: number): void;
  /** Delete all sessions for a user across all chats (e.g. when user blocks the bot). */
  deleteByUser(userId: number): void;
}

export function createIntentMatcherLayer(
  matcher: IntentMatcher,
  intentRepo: IntentRepository,
  executor: IntentExecutor,
  toolExecutor: (toolName: string, input: unknown) => ToolResult | Promise<ToolResult>,
  workflowSessions: WorkflowSessionStore,
  notifyAdmin?: (text: string) => Promise<unknown>,
  getEventContext?: (
    userId: number,
    timezone: string,
  ) => Promise<{ lastAddedEvent?: EventSummary; lastMentionedEvent?: EventSummary }>,
  onEventMentioned?: (userId: number, eventId: number) => void,
  conversationLogger?: ConversationLogger,
) {
  return async (
    ctx: BotCommandContext,
    messageText: string,
    extra?: {
      feedbackContext?: FeedbackThreadContext;
      groupContext?: GroupContext;
      supplementMode?: boolean;
    },
  ): Promise<PipelineResult> => {
    const user = ctx.dbUser as User;
    const userId = user.telegram_id;
    const chatId = Number(ctx.chatId ?? userId);
    const groupCtx = extra?.groupContext;

    // 1. Check for active workflow session (resuming from ask_user).
    // TTL is enforced inside workflowSessions.get() — a non-null result is always fresh.
    const session = workflowSessions.get(chatId, userId);
    if (session) {
      workflowSessions.delete(chatId, userId);
      const eventCtx = getEventContext ? await getEventContext(user.telegram_id, user.timezone) : {};
      const result = await executor.run(
        session.workflow,
        session.captures,
        {
          timezone: user.timezone,
          language: user.language,
          username: user.username ?? undefined,
          firstName: user.first_name ?? undefined,
          userId: user.telegram_id,
          groupIsGroup: groupCtx?.isGroup ?? false,
          groupChatId: groupCtx?.groupChatId,
          ...eventCtx,
        },
        toolExecutor,
        {
          stepIndex: session.stepIndex,
          stepResults: session.stepResults,
          userAnswer: messageText.trim(),
        },
      );
      if (result.response) {
        await ctx.send(result.response);
      }
      return { handled: true };
    }

    // 2. Try matching
    const match = matcher.match(messageText);
    if (!match) return { handled: false };

    // 3. Load workflow from DB
    const intent = intentRepo.getById(match.intentId);
    if (!intent) return { handled: false };

    let workflow: Record<string, unknown>;
    try {
      workflow = JSON.parse(intent.workflow) as Record<string, unknown>;
    } catch {
      cmdLogger.error({ intentId: match.intentId }, 'Intent has invalid workflow JSON, skipping');
      return { handled: false };
    }

    // 4. Execute
    const eventCtx = getEventContext ? await getEventContext(user.telegram_id, user.timezone) : {};
    const result = await executor.run(
      workflow,
      match.captures,
      {
        timezone: user.timezone,
        language: user.language,
        username: user.username ?? undefined,
        firstName: user.first_name ?? undefined,
        userId: user.telegram_id,
        groupIsGroup: groupCtx?.isGroup ?? false,
        groupChatId: groupCtx?.groupChatId,
        ...eventCtx,
      },
      toolExecutor,
    );

    // 5. Handle suspension
    if (result.suspended && result.suspendedAt !== undefined) {
      workflowSessions.set(chatId, userId, {
        intentId: match.intentId,
        stepIndex: result.suspendedAt,
        stepResults: result.stepResults ?? {},
        workflow,
        captures: match.captures,
        createdAt: Date.now(),
      });
      if (result.response) {
        await ctx.send(result.response);
      }
      return { handled: true };
    }

    // 6. Fall through to AI agent on failure (e.g. unresolved variables, tool error)
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
      return { handled: false };
    }

    // 7. Persist last mentioned event for cross-request workflows
    if (result.mentionedEventId !== undefined) {
      onEventMentioned?.(userId, result.mentionedEventId);
    }

    // 8. Format and send response
    if (result.response) {
      const formatted =
        intent.format !== 'text'
          ? formatResponse(intent.format, result.response, user.timezone, user.language)
          : result.response;
      await ctx.send(formatted);
      conversationLogger?.logBotResponse(userId, formatted, chatId);
      return { handled: true, needsSupplement: true, supplementAutoResponse: formatted };
    }

    return { handled: true };
  };
}
