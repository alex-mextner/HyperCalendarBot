// src/bot/pipeline/ai-agent-layer.ts

import { t } from '../../config/constants.ts';
import type { CalendarBotAgent } from '../../services/ai/agent.ts';
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

export function createAiAgentLayer(deps: AgentLayerDeps) {
  return async (
    ctx: BotCommandContext,
    messageText: string,
    extra?: {
      feedbackContext?: FeedbackThreadContext;
      groupContext?: GroupContext;
      incomingMessageId?: number;
      supplementMode?: boolean;
      supplementAutoResponse?: string;
      wasExplicitInvocation?: boolean;
      retryAttempt?: number;
    },
  ): Promise<PipelineResult> => {
    const user = ctx.dbUser;
    if (!user) return { handled: false };
    const chatId = ctx.chatId;
    if (!chatId) return { handled: false };

    const currentAttempt = extra?.retryAttempt ?? 0;

    // Cancel any pending retry when a fresh user message arrives
    if (currentAttempt === 0 && deps.retryJobStore && deps.retryQueue) {
      try {
        const pendingJobId = await deps.retryJobStore.get(user.telegram_id);
        if (pendingJobId) {
          await deps.retryQueue
            .removeJobById(pendingJobId)
            .catch((err: unknown) =>
              cmdLogger.warn({ err, userId: user.telegram_id }, 'Failed to cancel pending retry job'),
            );
          await deps.retryJobStore
            .del(user.telegram_id)
            .catch((err: unknown) =>
              cmdLogger.warn({ err, userId: user.telegram_id }, 'Failed to clear retry job store'),
            );
        }
      } catch (err: unknown) {
        cmdLogger.warn({ err, userId: user.telegram_id }, 'Failed to check pending retry job in store');
      }
    }

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
      const queue = deps.retryQueue;
      const jobStore = deps.retryJobStore;
      const lang = user.language as 'en' | 'ru';

      agentContext.retryEnqueue = async (msg: string) => {
        if (currentAttempt >= MAX_RETRY_ATTEMPTS) {
          // All retries exhausted — show graceful fail and clear Redis state
          await ctx.send(t(lang).agent_give_up());
          if (jobStore) await jobStore.del(user.telegram_id);
          return;
        }
        const delay = BACKOFF_DELAYS_MS[currentAttempt]!;
        const jobId = await queue.addDelayed(
          { userId: user.telegram_id, message: msg, source: 'trigger', retryAttempt: currentAttempt + 1 },
          delay,
        );
        if (jobStore) await jobStore.set(user.telegram_id, jobId);
      };
    }

    if (extra?.supplementMode) {
      agentContext.supplementMode = true;
      agentContext.supplementAutoResponse = extra.supplementAutoResponse;
    }

    agentContext.wasExplicitInvocation = extra?.wasExplicitInvocation ?? true;

    if (deps.scenePauseService) {
      const pauseState = await deps.scenePauseService.get(user.telegram_id);
      if (pauseState) {
        agentContext.scene = {
          scenePauseState: pauseState,
          scenePauseService: deps.scenePauseService,
        };
      }
    }

    cmdLogger.info(
      { userId: user.telegram_id, messageText, ...(extra?.supplementMode && { supplementMode: true }) },
      'Routing to AI agent',
    );

    try {
      const result = await deps.agent.run(agentContext);

      if (extra?.supplementMode) {
        const skipped = result.toolCalls.some((tc) => tc.name === 'supplement_skip');
        if (!skipped && result.responseText) {
          await ctx.send(result.responseText, { parse_mode: 'HTML' });
        }
        return { handled: true };
      }

      if (deps.intentLearner && result.toolCalls.length > 0) {
        deps.intentLearner.analyze(messageText, result.toolCalls, result.toolResults).catch((err: unknown) => {
          cmdLogger.error({ err: err }, 'IntentLearner error');
        });
      }
    } catch (error) {
      if (extra?.supplementMode) {
        cmdLogger.warn({ err: error, userId: user.telegram_id }, 'AI supplement error (suppressed)');
        return { handled: true };
      }
      cmdLogger.error({ err: error, userId: user.telegram_id }, 'AI agent error');
      const lang = user.language as 'en' | 'ru';
      await ctx.send(t(lang).something_wrong);
    }

    return { handled: true };
  };
}
