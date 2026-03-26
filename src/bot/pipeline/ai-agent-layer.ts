// src/bot/pipeline/ai-agent-layer.ts

import { t } from '../../config/constants.ts';
import type { User } from '../../database/types.ts';
import type { CalendarBotAgent } from '../../services/ai/agent.ts';
import type { IntentLearner } from '../../services/intent/intent-learner.ts';
import type { ScenePauseService } from '../../services/scene-pause.ts';
import { cmdLogger } from '../../utils/logger.ts';
import type { AgentContextBuilder } from '../agent-context-factory.ts';
import type { BotCommandContext } from '../types.ts';
import type { FeedbackThreadContext, GroupContext, PipelineResult } from './types.ts';

export interface AgentLayerDeps {
  agent: CalendarBotAgent;
  agentContextBuilder: AgentContextBuilder;
  intentLearner?: IntentLearner;
  scenePauseService?: ScenePauseService;
}

export function createAiAgentLayer(deps: AgentLayerDeps) {
  return async (
    ctx: BotCommandContext,
    messageText: string,
    extra?: {
      feedbackContext?: FeedbackThreadContext;
      groupContext?: GroupContext;
      supplementMode?: boolean;
      supplementAutoResponse?: string;
    },
  ): Promise<PipelineResult> => {
    const user = ctx.dbUser as User;
    const chatId = ctx.chatId;
    if (!chatId) return { handled: false };

    const agentContext = deps.agentContextBuilder(user, Number(chatId), messageText, extra?.groupContext);

    if (extra?.feedbackContext && agentContext.feedback) {
      agentContext.feedback.feedbackContext = extra.feedbackContext;
    }

    if (extra?.supplementMode) {
      agentContext.supplementMode = true;
      agentContext.supplementAutoResponse = extra.supplementAutoResponse;
    }

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
