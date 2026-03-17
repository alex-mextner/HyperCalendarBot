// src/bot/pipeline/feedback-router-layer.ts

import type { FeedbackRepository } from '../../database/repositories/feedback.repository.ts';
import type { User } from '../../database/types.ts';
import type { BotCommandContext } from '../types.ts';
import type { PipelineResult } from './types.ts';

export function createFeedbackRouterLayer(feedbackRepo: FeedbackRepository) {
  return async (ctx: BotCommandContext): Promise<PipelineResult> => {
    const user = ctx.dbUser as User;
    const thread = feedbackRepo.getOpenThreadForUser(user.telegram_id);

    if (!thread) return { handled: false };

    const messages = feedbackRepo.getMessages(thread.id);
    const recentMessages = messages.slice(-10).map((m) => ({ sender: m.sender, text: m.text }));

    return {
      handled: false,
      feedbackContext: {
        threadId: thread.id,
        subject: thread.subject,
        messages: recentMessages,
      },
    };
  };
}
