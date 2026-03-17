// src/bot/pipeline/ai-agent-layer.ts

import type { User } from '../../database/types.ts';
import type { CalendarBotAgent } from '../../services/ai/agent.ts';
import type { AgentContext } from '../../services/ai/types.ts';
import { cmdLogger } from '../../utils/logger.ts';
import type { BotCommandContext } from '../types.ts';
import type { FeedbackThreadContext, PipelineResult } from './types.ts';

export interface AgentLayerDeps {
  agent: CalendarBotAgent;
  agentContextBuilder: (user: User, chatId: number, messageText: string) => AgentContext;
}

export function createAiAgentLayer(deps: AgentLayerDeps) {
  return async (
    ctx: BotCommandContext,
    messageText: string,
    extra?: { feedbackContext?: FeedbackThreadContext },
  ): Promise<PipelineResult> => {
    const user = ctx.dbUser as User;
    const chatId = ctx.chatId;
    if (!chatId) return { handled: false };

    const agentContext = deps.agentContextBuilder(user, Number(chatId), messageText);

    // If there is an open feedback thread, pass the context for future use
    // (actual system prompt injection will be wired in a later task)
    if (extra?.feedbackContext) {
      agentContext.feedbackContext = extra.feedbackContext;
    }

    cmdLogger.info({ userId: user.telegram_id, messageText }, 'Routing to AI agent');

    try {
      await deps.agent.run(agentContext);
    } catch (error) {
      cmdLogger.error({ error: String(error), userId: user.telegram_id }, 'AI agent error');
      const lang = user.language as 'en' | 'ru';
      await ctx.send(
        lang === 'ru' ? 'Что-то пошло не так. Попробуйте ещё раз.' : 'Something went wrong. Please try again.',
      );
    }

    return { handled: true };
  };
}
