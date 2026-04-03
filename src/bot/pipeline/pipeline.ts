// src/bot/pipeline/pipeline.ts

import { cmdLogger } from '../../utils/logger.ts';
import type { BotCommandContext } from '../types.ts';
import type { FeedbackThreadContext, GroupContext, PipelineLayer } from './types.ts';

export async function runPipeline(
  ctx: BotCommandContext,
  messageText: string,
  layers: PipelineLayer[],
  groupContext?: GroupContext,
  incomingMessageId?: number,
): Promise<void> {
  let feedbackContext: FeedbackThreadContext | undefined;
  let supplementMode = false;
  let supplementAutoResponse: string | undefined;

  for (const layer of layers) {
    try {
      const result = await layer(ctx, messageText, {
        feedbackContext,
        groupContext,
        incomingMessageId,
        supplementMode,
        supplementAutoResponse,
      });
      if (result.handled) {
        if ('needsSupplement' in result) {
          supplementMode = true;
          supplementAutoResponse = result.supplementAutoResponse;
          continue;
        }
        return;
      }
      if ('feedbackContext' in result) {
        feedbackContext = result.feedbackContext;
      }
    } catch (err) {
      cmdLogger.error({ err, chatId: ctx.chatId, text: messageText.slice(0, 80) }, 'Pipeline layer threw unexpectedly');
      throw err; // re-throw for bot.onError() to handle user notification
    }
  }
}
