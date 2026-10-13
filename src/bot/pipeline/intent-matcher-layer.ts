// src/bot/pipeline/intent-matcher-layer.ts

import type { ActionLogRepository } from '../../database/repositories/action-log.repository.ts';
import type { IntentRepository } from '../../database/repositories/intent.repository.ts';
import type { User } from '../../database/types.ts';
import type { ToolResult } from '../../services/ai/types.ts';
import type { IntentExecutor, MutationEvidence } from '../../services/intent/intent-executor.ts';
import type { IntentMatcher } from '../../services/intent/intent-matcher.ts';
import { formatResponse } from '../../services/intent/response-formatter.ts';
import { evidenceMessage, guardRuleTools, type RunTools } from '../../services/intent/rule-run-guard.ts';
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

/** One incoming message as the layer sees it. */
interface Turn {
  ctx: BotCommandContext;
  user: User;
  chatId: number;
  userId: number;
  groupCtx?: GroupContext;
  messageText: string;
}
/** Why a run stopped before its next step: logged with the run's write evidence. */
interface RunStop {
  intentId: number;
  userId: number;
  chatId: number;
  reason: 'rule_changed' | 'no_rule_identity';
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
  getEventContext?: (
    userId: number,
    timezone: string,
  ) => Promise<{ lastAddedEvent?: EventSummary; lastMentionedEvent?: EventSummary }>,
  onEventMentioned?: (userId: number, eventId: number) => void,
  actionLogRepo?: ActionLogRepository,
) {
  type Result = Awaited<ReturnType<IntentExecutor['run']>>;
  async function deliverResponse(ctx: BotCommandContext, plainText: string, removeKeyboard = false): Promise<void> {
    // formatResponse returns display text, not a trusted Telegram HTML document.
    const chunks = splitMessage(escapeHtml(plainText), 4000, 'HTML');
    for (const [index, chunk] of chunks.entries())
      await ctx.send(chunk, {
        parse_mode: 'HTML',
        ...(removeKeyboard && index === chunks.length - 1
          ? { reply_markup: { remove_keyboard: true, selective: true } }
          : {}),
      });
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
  /** Write evidence a suspended run recorded before it asked the user. */
  const suspendedEvidence = (session: WorkflowSession): MutationEvidence => {
    const stored = session.stepResults.__mutationEvidence;
    return stored === 'applied' || stored === 'unknown' ? stored : 'none';
  };
  /** `evidence` covers the whole run, including writes made before it was suspended. */
  async function refuseRun(
    ctx: BotCommandContext,
    language: string,
    stop: RunStop,
    evidence: MutationEvidence | undefined,
  ) {
    cmdLogger.warn({ ...stop, evidence }, 'Intent workflow stopped before running further steps');
    await ctx.send(evidenceMessage(language, evidence));
  }
  async function runContext(user: User, groupCtx: GroupContext | undefined) {
    const eventCtx = getEventContext ? await getEventContext(user.telegram_id, user.timezone) : {};
    return {
      timezone: user.timezone,
      language: user.language,
      username: user.username ?? undefined,
      firstName: user.first_name ?? undefined,
      userId: user.telegram_id,
      groupIsGroup: groupCtx?.isGroup ?? false,
      groupChatId: groupCtx?.groupChatId,
      ...eventCtx,
    };
  }
  async function resumeSession(turn: Turn, session: WorkflowSession): Promise<PipelineResult> {
    const { ctx, user, chatId, userId, groupCtx, messageText } = turn;
    // A session stored before rule identities existed carries none and is refused (fail closed).
    const { intentId, ruleFingerprint: fingerprint, sourceMessage } = session;
    // One read gives both the identity check and the format the response is rendered with.
    const row = intentRepo.getById(intentId);
    if (fingerprint === undefined || !row || intentRepo.runnableFingerprint(row) !== fingerprint) {
      workflowSessions.delete(chatId, userId);
      const reason = fingerprint === undefined ? 'no_rule_identity' : 'rule_changed';
      await refuseRun(ctx, user.language, { intentId, userId, chatId, reason }, suspendedEvidence(session));
      return { handled: true };
    }
    if (session.pendingPrompt && !session.pendingPrompt.delivered) {
      await deliverPrompt(ctx, chatId, userId, session);
      return { handled: true };
    }
    workflowSessions.delete(chatId, userId);
    const tools: RunTools =
      sourceMessage === undefined
        ? toolExecutor
        : (name, input) => toolExecutor(name, input, { text: sourceMessage, actorId: userId, chatId });
    const guard = guardRuleTools(intentRepo, intentId, fingerprint, tools);
    const result = await executor.run(session.workflow, session.captures, await runContext(user, groupCtx), guard.run, {
      stepIndex: session.stepIndex,
      stepResults: session.stepResults,
      userAnswer: messageText.trim(),
    });
    if (guard.changed()) {
      await refuseRun(
        ctx,
        user.language,
        { intentId, userId, chatId, reason: 'rule_changed' },
        result.mutationEvidence,
      );
      return { handled: true };
    }
    if (result.suspended && result.suspendedAt !== undefined) {
      await saveSuspension(ctx, chatId, userId, session, result);
      return { handled: true };
    }
    // The answer was consumed by the resumed workflow, so it cannot be replayed as a fresh request.
    // A failed run never shows its tool's text: that was written for the AI agent, not the user.
    if (!result.success) {
      cmdLogger.warn(
        { intentId, userId, errorCode: result.errorCode, evidence: result.mutationEvidence },
        'Resumed intent workflow failed',
      );
      if (notifyAdmin) {
        notifyAdmin(
          `⚠️ Resumed intent failed: ${row.canonical_name} (id=${intentId})\nAnswer: "${messageText}"\nError: ${result.errorCode ?? result.response ?? 'no response'}`,
        ).catch((err: unknown) => {
          cmdLogger.error({ err }, 'Failed to send resumed intent fail report to admin');
        });
      }
      await ctx.send(evidenceMessage(user.language, result.mutationEvidence));
      return { handled: true };
    }
    if (result.mentionedEventId !== undefined) onEventMentioned?.(userId, result.mentionedEventId);
    if (result.response) {
      // Same formatting as a first-pass match: a resumed workflow can end in a tool
      // whose text output is written for the AI agent, not for the user.
      const text = formatResponse(row.format, result.response, user.timezone, user.language, result.responseEvents);
      if (session.workflow.version === 2) {
        await deliverResponse(ctx, text, true);
      } else await ctx.send(text);
    }
    return { handled: true };
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
    if (session) return resumeSession({ ctx, user, chatId, userId, groupCtx, messageText }, session);

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
    const ruleFingerprint = intentRepo.runnableFingerprint(intent);
    if (ruleFingerprint === null) {
      cmdLogger.warn({ intentId: match.intentId }, 'Matched intent rule is no longer runnable, skipping');
      return { handled: false };
    }
    const guard = guardRuleTools(intentRepo, match.intentId, ruleFingerprint, toolExecutor);

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
    const result = await executor.run(workflow, match.captures, await runContext(user, groupCtx), guard.run);
    if (guard.changed()) {
      await refuseRun(
        ctx,
        user.language,
        { intentId: match.intentId, userId, chatId, reason: 'rule_changed' },
        result.mutationEvidence,
      );
      return { handled: true };
    }

    // 5. Handle suspension
    if (result.suspended && result.suspendedAt !== undefined) {
      await saveSuspension(
        ctx,
        chatId,
        userId,
        {
          intentId: match.intentId,
          ruleFingerprint,
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
        await ctx.send(evidenceMessage(user.language, result.mutationEvidence));
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
      if (workflow.version === 2) await deliverResponse(ctx, formatted);
      else await ctx.send(formatted);
      if (result.completeResponse) return { handled: true };
      return { handled: true, needsSupplement: true, supplementAutoResponse: formatted };
    }

    return { handled: true };
  };
}
