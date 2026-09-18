// src/bot/pipeline/intent-matcher-layer.ts

import type { ActionLogRepository } from '../../database/repositories/action-log.repository.ts';
import type { IntentRepository } from '../../database/repositories/intent.repository.ts';
import type { ToolResult } from '../../services/ai/types.ts';
import type { IntentExecutor } from '../../services/intent/intent-executor.ts';
import type { IntentMatcher } from '../../services/intent/intent-matcher.ts';
import { formatResponse } from '../../services/intent/response-formatter.ts';
import type { EventSummary } from '../../services/intent/variable-resolver.ts';
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

export function createIntentMatcherLayer(
  matcher: IntentMatcher,
  intentRepo: IntentRepository,
  executor: IntentExecutor,
  toolExecutor: (toolName: string, input: unknown) => ToolResult | Promise<ToolResult>,
  workflowSessions: WorkflowSessionStore,
  notifyAdmin?: (text: string) => Promise<void>,
  getEventContext?: (
    userId: number,
    timezone: string,
  ) => Promise<{ lastAddedEvent?: EventSummary; lastMentionedEvent?: EventSummary }>,
  onEventMentioned?: (userId: number, eventId: number) => void,
  actionLogRepo?: ActionLogRepository,
) {
  type Result = Awaited<ReturnType<IntentExecutor['run']>>;
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

    // 1. Check for active workflow session (resuming from ask_user).
    // TTL is enforced inside workflowSessions.get() — a non-null result is always fresh.
    const session = workflowSessions.get(chatId, userId);
    if (session) {
      if (session.pendingPrompt && !session.pendingPrompt.delivered) {
        await deliverPrompt(ctx, chatId, userId, session);
        return { handled: true };
      }
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
      if (result.suspended && result.suspendedAt !== undefined) {
        await saveSuspension(ctx, chatId, userId, session, result);
        return { handled: true };
      }
      if (result.response) {
        // Same formatting as a first-pass match: a resumed workflow can end in a tool
        // whose text output is written for the AI agent, not for the user.
        const format = intentRepo.getById(session.intentId)?.format ?? 'text';
        const text = formatResponse(format, result.response, user.timezone, user.language, result.responseEvents);
        if (session.workflow.version === 2) {
          const chunks = splitMessage(text, 4000, 'HTML');
          for (const [index, chunk] of chunks.entries())
            await ctx.send(chunk, {
              parse_mode: 'HTML',
              ...(index === chunks.length - 1 ? { reply_markup: { remove_keyboard: true, selective: true } } : {}),
            });
        } else await ctx.send(text);
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
          createdAt: Date.now(),
        },
        result,
      );
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
      const formatted = formatResponse(
        intent.format,
        result.response,
        user.timezone,
        user.language,
        result.responseEvents,
      );
      // ctx.send is wrapped in bot/index.ts and already writes this to chat history;
      // the supplement agent reads the text from supplementAutoResponse, not from history.
      await ctx.send(formatted);
      return { handled: true, needsSupplement: true, supplementAutoResponse: formatted };
    }

    return { handled: true };
  };
}
