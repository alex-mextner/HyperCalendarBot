// src/bot/pipeline/ai-agent-layer.ts

import { t, toLang } from '../../config/constants.ts';
import type { User } from '../../database/types.ts';
import { agentGiveUpMessage, type CalendarBotAgent } from '../../services/ai/agent.ts';
import type { AgentContext } from '../../services/ai/types.ts';
import type { IntentLearner } from '../../services/intent/intent-learner.ts';
import type { ScenePauseService } from '../../services/scene-pause.ts';
import type { AiMessageJobData, RetryJobStore } from '../../services/scheduled/types.ts';
import { cmdLogger } from '../../utils/logger.ts';
import type { AgentContextBuilder } from '../agent-context-factory.ts';
import type { BotCommandContext } from '../types.ts';
import type { FeedbackThreadContext, GroupContext, PipelineResult } from './types.ts';

/** Backoff delays for successive retry attempts (index = currentAttempt, 0-based). */
const BACKOFF_DELAYS_MS = [30_000, 60_000, 120_000] as const;
const MAX_RETRY_ATTEMPTS = BACKOFF_DELAYS_MS.length;

export interface AgentLayerDeps {
  agent: CalendarBotAgent;
  agentContextBuilder: AgentContextBuilder;
  intentLearner?: IntentLearner;
  scenePauseService?: ScenePauseService;
  retryQueue?: {
    addDelayed(data: AiMessageJobData, delayMs: number): Promise<string>;
    removeJobById(jobId: string): Promise<void>;
  };
  retryJobStore?: RetryJobStore;
}

interface AgentLayerExtra {
  feedbackContext?: FeedbackThreadContext;
  groupContext?: GroupContext;
  incomingMessageId?: number;
  supplementMode?: boolean;
  supplementAutoResponse?: string;
  wasExplicitInvocation?: boolean;
  retryAttempt?: number;
}

export function createAiAgentLayer(deps: AgentLayerDeps) {
  /** Cancel any pending retry when a fresh user message arrives. */
  async function cancelPendingRetry(userId: number): Promise<void> {
    const { retryJobStore, retryQueue } = deps;
    if (!retryJobStore || !retryQueue) return;
    try {
      const pendingJobId = await retryJobStore.get(userId);
      if (!pendingJobId) return;
      await retryQueue
        .removeJobById(pendingJobId)
        .catch((err: unknown) => cmdLogger.warn({ err, userId }, 'Failed to cancel pending retry job'));
      await retryJobStore
        .del(userId)
        .catch((err: unknown) => cmdLogger.warn({ err, userId }, 'Failed to clear retry job store'));
    } catch (err: unknown) {
      cmdLogger.warn({ err, userId }, 'Failed to check pending retry job in store');
    }
  }

  function createRetryEnqueue(
    queue: NonNullable<AgentLayerDeps['retryQueue']>,
    ctx: BotCommandContext,
    user: User,
    currentAttempt: number,
  ): (msg: string) => Promise<boolean> {
    const jobStore = deps.retryJobStore;
    const lang = toLang(user.language);

    return async (msg) => {
      if (currentAttempt >= MAX_RETRY_ATTEMPTS) {
        // All retries exhausted — close the loop on whatever the bot promised
        // earlier, then clear Redis state.
        const giveUp = agentGiveUpMessage(user.telegram_id, lang);
        if (giveUp) await ctx.send(giveUp);
        // Best effort: the give-up line is out, so the answer stays "gave up" whatever Redis says.
        await jobStore?.del(user.telegram_id).catch((err: unknown) => {
          cmdLogger.warn({ err, userId: user.telegram_id }, 'Failed to clear retry job store');
        });
        return false;
      }
      const delay = BACKOFF_DELAYS_MS[currentAttempt]!;
      const jobId = await queue.addDelayed(
        { userId: user.telegram_id, message: msg, source: 'trigger', retryAttempt: currentAttempt + 1 },
        delay,
      );
      // The job is stored and will run: the cancellation pointer is written in the background, so a
      // slow or lost pointer write can neither hold back nor turn this into "not scheduled".
      void jobStore?.set(user.telegram_id, jobId).catch((err: unknown) => {
        cmdLogger.warn(
          { err, userId: user.telegram_id, jobId },
          'Retry scheduled but its cancellation pointer was not saved',
        );
      });
      return true;
    };
  }

  async function attachScenePause(agentContext: AgentContext, userId: number): Promise<void> {
    if (!deps.scenePauseService) return;
    const pauseState = await deps.scenePauseService.get(userId);
    if (pauseState) {
      agentContext.scene = {
        scenePauseState: pauseState,
        scenePauseService: deps.scenePauseService,
      };
    }
  }

  async function runAgent(
    agentContext: AgentContext,
    ctx: BotCommandContext,
    user: User,
    messageText: string,
    extra: AgentLayerExtra | undefined,
  ): Promise<void> {
    try {
      const result = await deps.agent.run(agentContext);

      if (extra?.supplementMode) {
        const skipped = result.toolCalls.some((tc) => tc.name === 'supplement_skip');
        if (!skipped && result.responseText) {
          await ctx.send(result.responseText, { parse_mode: 'HTML' });
        }
        return;
      }

      if (deps.intentLearner && result.toolCalls.length > 0) {
        deps.intentLearner.analyze(messageText, result.toolCalls, result.toolResults).catch((err: unknown) => {
          cmdLogger.error({ err: err }, 'IntentLearner error');
        });
      }
    } catch (error) {
      if (extra?.supplementMode) {
        cmdLogger.warn({ err: error, userId: user.telegram_id }, 'AI supplement error (suppressed)');
        return;
      }
      cmdLogger.error({ err: error, userId: user.telegram_id }, 'AI agent error');
      await ctx.send(t(toLang(user.language)).something_wrong);
    }
  }

  return async (ctx: BotCommandContext, messageText: string, extra?: AgentLayerExtra): Promise<PipelineResult> => {
    const user = ctx.dbUser;
    if (!user) return { handled: false };
    const chatId = ctx.chatId;
    if (!chatId) return { handled: false };

    const currentAttempt = extra?.retryAttempt ?? 0;

    if (currentAttempt === 0) await cancelPendingRetry(user.telegram_id);

    const agentContext = deps.agentContextBuilder(
      user,
      Number(chatId),
      messageText,
      extra?.groupContext,
      extra?.incomingMessageId,
    );

    if (extra?.feedbackContext && agentContext.feedback) {
      agentContext.feedback.feedbackContext = extra.feedbackContext;
    }

    agentContext.retryAttempt = currentAttempt;

    if (deps.retryQueue) {
      agentContext.retryEnqueue = createRetryEnqueue(deps.retryQueue, ctx, user, currentAttempt);
    }

    if (extra?.supplementMode) {
      agentContext.supplementMode = true;
      agentContext.supplementAutoResponse = extra.supplementAutoResponse;
    }

    agentContext.wasExplicitInvocation = extra?.wasExplicitInvocation ?? true;

    await attachScenePause(agentContext, user.telegram_id);

    cmdLogger.info(
      { userId: user.telegram_id, messageText, ...(extra?.supplementMode && { supplementMode: true }) },
      'Routing to AI agent',
    );

    await runAgent(agentContext, ctx, user, messageText, extra);
    return { handled: true };
  };
}
